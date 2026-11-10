#!/usr/bin/env node
// bx: a browser CLI for AI coding agents.
// One invocation connects to a running Chrome over CDP, runs a chain of steps and exits.
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERSION = "0.1.0";
const CDP_URL = (process.env.BX_CDP_URL ?? "http://127.0.0.1:9222").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.BX_TIMEOUT_MS ?? 15000);
const SETTLE_QUIET_MS = 150;
const SETTLE_CAP_MS = Math.min(10000, TIMEOUT_MS);
const STATE_FILE = join(tmpdir(), `bx-${process.env.BX_SESSION ?? "default"}.json`);
// requests that stay open by design never count as "in flight"
const STREAMING_REQUEST_TYPES = new Set(["EventSource", "WebSocket", "Ping", "Media"]);

class StepError extends Error {}
class UsageError extends Error {}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// ---------- CDP ----------

function openWebSocket(wsUrl) {
  const ws = new WebSocket(wsUrl);
  return new Promise((ok, fail) => {
    ws.onopen = () => ok(ws);
    ws.onerror = () => fail(new Error(`cannot connect to ${wsUrl}`));
  });
}

function cdpClient(ws) {
  let lastId = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (!d.id) return listeners.get(d.method)?.(d.params);
    const call = pending.get(d.id);
    if (!call) return;
    pending.delete(d.id);
    clearTimeout(call.timer);
    if (d.error) call.fail(new StepError(`${call.method}: ${d.error.message}`));
    else call.ok(d.result);
  };
  ws.onclose = () => {
    for (const call of pending.values()) call.fail(new StepError("Chrome closed the connection (tab closed or Chrome exited)"));
    pending.clear();
  };
  const send = (method, params = {}) => new Promise((ok, fail) => {
    const id = (lastId += 1);
    const timer = setTimeout(() => {
      pending.delete(id);
      fail(new StepError(`Chrome did not answer ${method} in ${TIMEOUT_MS + 5000} ms`));
    }, TIMEOUT_MS + 5000);
    pending.set(id, { ok, fail, method, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, on: (method, fn) => listeners.set(method, fn) };
}

const pageWsUrl = (targetId) => `${CDP_URL.replace(/^http/, "ws")}/devtools/page/${targetId}`;

async function pickTabId() {
  let targets;
  try {
    targets = await (await fetch(`${CDP_URL}/json/list`)).json();
  } catch {
    throw new StepError(`no Chrome answers at ${CDP_URL} (BX_CDP_URL); start Chrome with --remote-debugging-port`);
  }
  const page = targets.find((t) => t.type === "page" && !/^(devtools|chrome-extension):/.test(t.url));
  if (page) return page.id;
  return (await (await fetch(`${CDP_URL}/json/new?about:blank`, { method: "PUT" })).json()).id;
}

// The tab of the previous invocation is reused; its id is in the state file, so the usual attach is one WebSocket and no HTTP call.
async function attachTab(state) {
  if (state.targetId) {
    try {
      return cdpClient(await openWebSocket(pageWsUrl(state.targetId)));
    } catch {
      state.targetId = undefined;
    }
  }
  state.targetId = await pickTabId();
  return cdpClient(await openWebSocket(pageWsUrl(state.targetId)));
}

function readState() {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return state.cdp === CDP_URL ? state : { cdp: CDP_URL };
  } catch {
    return { cdp: CDP_URL };
  }
}

// ---------- page access ----------

const firstLine = (s) => String(s).split("\n")[0];

async function pageEval(tab, expression) {
  const r = await tab.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new StepError(firstLine(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
}

// runs a function of this file inside the page; arguments and result cross as JSON
const pageCall = (tab, fn, ...args) => pageEval(tab, `(${fn})(${args.map((a) => JSON.stringify(a)).join(",")})`);

const isNavigationError = (e) => /context was destroyed|Cannot find context|navigated or closed/i.test(e.message);

// ---------- settle rule ----------

function trackNetwork(cdp) {
  const net = { inflight: new Map(), lastEventAt: 0, documentStatus: new Map() };
  cdp.on("Network.requestWillBeSent", (p) => {
    if (STREAMING_REQUEST_TYPES.has(p.type)) return;
    net.inflight.set(p.requestId, p.request.url);
    net.lastEventAt = Date.now();
  });
  const requestEnded = (p) => {
    if (net.inflight.delete(p.requestId)) net.lastEventAt = Date.now();
  };
  cdp.on("Network.loadingFinished", requestEnded);
  cdp.on("Network.loadingFailed", requestEnded);
  cdp.on("Network.responseReceived", (p) => {
    if (p.type === "Document") net.documentStatus.set(p.requestId, p.response.status);
  });
  return net;
}

function whenDomQuietInPage(quietMs) {
  return new Promise((done) => {
    const watch = () => {
      if (quietMs === 0) return done(true);
      let timer;
      const finish = () => {
        observer.disconnect();
        done(true);
      };
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(finish, quietMs);
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(finish, quietMs);
    };
    if (document.readyState === "complete") watch();
    else addEventListener("load", watch, { once: true });
  });
}

function busyReason(tab) {
  const urls = [...tab.net.inflight.values()];
  if (urls.length === 0) return "the DOM keeps changing";
  return `${urls.length} request(s) in flight: ${urls.slice(0, 3).join(" ")}`;
}

// Settled: the document is loaded, and for SETTLE_QUIET_MS no request was in flight and the DOM did not change.
// With --no-settle only the document load is awaited. Returns null, or the reason the page is still busy at the cap.
async function settle(tab) {
  const quietMs = tab.noSettle ? 0 : SETTLE_QUIET_MS;
  const deadline = Date.now() + SETTLE_CAP_MS;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return busyReason(tab);
    if (!tab.noSettle && tab.net.inflight.size > 0) {
      await sleep(5);
      continue;
    }
    const domQuiet = pageCall(tab, whenDomQuietInPage, quietMs).catch((e) => {
      if (isNavigationError(e)) return false;
      throw e;
    });
    const quiet = await Promise.race([domQuiet, sleep(left).then(() => "cap")]);
    if (quiet === "cap") {
      domQuiet.catch(() => {});
      return tab.noSettle ? "the document did not finish loading" : busyReason(tab);
    }
    if (quiet && tab.noSettle) return null;
    if (quiet && tab.net.inflight.size === 0 && Date.now() - tab.net.lastEventAt >= quietMs) return null;
    if (!quiet) await sleep(5);
  }
}

async function settleOrFail(tab) {
  const busy = await settle(tab);
  if (busy) throw new StepError(`page not settled after ${SETTLE_CAP_MS} ms (${busy}); use "wait <text>" with --no-settle`);
}

// ---------- steps ----------

async function stepOpen(tab, [url]) {
  const nav = await tab.cdp.send("Page.navigate", { url: /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `http://${url}` });
  if (nav.errorText) throw new StepError(`${nav.errorText} at ${url}`);
  await settleOrFail(tab);
  const page = await pageEval(tab, "({ url: location.href, title: document.title })");
  const status = tab.net.documentStatus.get(nav.loaderId);
  if (status >= 400) throw new StepError(`HTTP ${status} at ${page.url}`);
  return `open ${page.url} "${page.title}"`;
}

const stepUrl = (tab) => pageEval(tab, "location.href");

async function stepEval(tab, [js]) {
  const value = await pageEval(tab, js);
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function textInPage(selector) {
  const root = selector ? document.querySelector(selector) : (document.querySelector("main") ?? document.body);
  if (!root) return { error: `no element matches ${selector}` };
  const lines = root.innerText.split("\n").map((line) => line.trim());
  return { text: lines.filter(Boolean).join("\n") };
}

async function stepText(tab, [selector]) {
  const r = await pageCall(tab, textInPage, selector ?? null);
  if (r.error) throw new StepError(r.error);
  return r.text;
}

// settles: the step changes the page and waits for it to settle. front: the step needs a visible, focused tab.
const STEPS = {
  open: { usage: "open <url>", minArgs: 1, maxArgs: 1, settles: true, front: true, run: stepOpen },
  url: { usage: "url", minArgs: 0, maxArgs: 0, run: stepUrl },
  eval: { usage: "eval <js>", minArgs: 1, maxArgs: 1, run: stepEval },
  text: { usage: "text [selector]", minArgs: 0, maxArgs: 1, run: stepText },
};

// ---------- command line ----------

function parseChain(argv) {
  const chain = [[]];
  for (const arg of argv) {
    if (arg === "+") chain.push([]);
    else chain.at(-1).push(arg);
  }
  return chain.map(([name, ...args]) => {
    const step = STEPS[name];
    if (!step) throw new UsageError(name ? `unknown step "${name}"; steps: ${Object.keys(STEPS).join(" ")}` : `empty step next to "+"`);
    if (args.length < step.minArgs || args.length > step.maxArgs) throw new UsageError(`usage: ${step.usage} (got ${args.length} argument(s); quote text that has spaces)`);
    return { name, args, step };
  });
}

const stepLabel = ({ name, args }) => [name, ...args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a))].join(" ");

async function prepareTab(tab, chain) {
  const { cdp } = tab;
  const setup = [cdp.send("Page.enable")];
  cdp.on("Page.javascriptDialogOpening", (p) => {
    tab.out.push(`dialog ${p.type} ${JSON.stringify(p.message)} accepted`);
    cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
  });
  if (chain.some((s) => s.step.settles)) setup.push(cdp.send("Network.enable"));
  if (chain.some((s) => s.step.front)) {
    setup.push(cdp.send("Page.bringToFront"), cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }));
  }
  await Promise.all(setup);
}

async function runChain(chain, noSettle, out) {
  const state = readState();
  const savedState = JSON.stringify(state);
  const cdp = await attachTab(state);
  const tab = { cdp, state, noSettle, out, net: trackNetwork(cdp) };
  await prepareTab(tab, chain);
  try {
    for (const [i, s] of chain.entries()) {
      try {
        out.push(await s.step.run(tab, s.args));
      } catch (e) {
        if (!(e instanceof StepError)) throw e;
        const notRun = chain.slice(i + 1).map(stepLabel);
        return `bx: ${stepLabel(s)}: ${e.message}` + (notRun.length ? `\nbx: not run: ${notRun.join(" + ")}` : "");
      }
    }
    return null;
  } finally {
    if (JSON.stringify(state) !== savedState) writeFileSync(STATE_FILE, JSON.stringify(state));
  }
}

function finish(code, stdout, stderr) {
  const exit = () => process.exit(code);
  const writeErr = () => (stderr ? process.stderr.write(`${stderr}\n`, exit) : exit());
  if (stdout) process.stdout.write(`${stdout}\n`, writeErr);
  else writeErr();
}

async function main(argv) {
  const flags = [];
  while (argv[0]?.startsWith("--")) flags.push(argv.shift());
  const unknown = flags.find((f) => !["--help", "--version", "--no-settle"].includes(f));
  if (unknown) return finish(2, "", `bx: unknown flag ${unknown}; see bx --help`);
  if (flags.includes("--version")) return finish(0, VERSION, "");
  if (flags.includes("--help") || argv.length === 0) {
    const docs = readFileSync(new URL("./docs/bx.md", import.meta.url), "utf8").trimEnd();
    return finish(flags.includes("--help") ? 0 : 2, docs, "");
  }
  const out = [];
  try {
    const chain = parseChain(argv);
    const failure = await runChain(chain, flags.includes("--no-settle"), out);
    finish(failure ? 1 : 0, out.join("\n"), failure ?? "");
  } catch (e) {
    if (e instanceof UsageError) return finish(2, "", `bx: ${e.message}`);
    if (e instanceof StepError) return finish(1, out.join("\n"), `bx: ${e.message}`);
    finish(1, out.join("\n"), `bx: internal error: ${e.stack ?? e}`);
  }
}

main(process.argv.slice(2));
