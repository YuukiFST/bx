#!/usr/bin/env node
// bx: a browser CLI for AI coding agents.
// One invocation connects to a running Chrome over CDP, runs a chain of steps and exits.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const VERSION = "0.2.0";
const CDP_URL = (process.env.BX_CDP_URL ?? "http://127.0.0.1:9222").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.BX_TIMEOUT_MS ?? 15000);
const SETTLE_QUIET_MS = 150;
// React shows a Suspense fallback for about 300 ms before it reveals content that is already there (measured: 240 to 320 ms
// with no request and no DOM change), so after a DOM change the page counts as quiet only past that gap
const DOM_QUIET_AFTER_CHANGE_MS = 400;
const SETTLE_CAP_MS = Math.min(10000, TIMEOUT_MS);
// a DOM that keeps changing this long with no request in flight is an animation, not a page still loading
const DOM_CHURN_MS = Math.min(2000, SETTLE_CAP_MS);
const NEW_TAB_WAIT_MS = 2000;
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

const isNavigationError = (e) => /context was destroyed|Cannot find context|navigated or closed/i.test(e.message);

// ---------- settle rule ----------

function trackNetwork(cdp) {
  const net = { inflight: new Map(), lastEventAt: 0, documentStatus: new Map() };
  cdp.on("Network.requestWillBeSent", (p) => {
    if (STREAMING_REQUEST_TYPES.has(p.type)) return;
    net.inflight.set(p.requestId, { url: p.request.url, loaderId: p.loaderId });
    net.lastEventAt = Date.now();
  });
  // Chrome sends no end event for some requests of the document being left (seen on Next.js link prefetches),
  // so once the main frame commits a new document, its predecessor's requests stop counting.
  cdp.on("Page.frameNavigated", ({ frame }) => {
    if (frame.parentId) return;
    for (const [requestId, request] of net.inflight) {
      if (request.loaderId !== frame.loaderId) net.inflight.delete(requestId);
    }
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

// In the page: `window.__bx` holds what must outlive one call: the refs of the last snap, the field being filled,
// whether the last click or key press arrived, and a clock of the last DOM change.
function bxPageStore() {
  if (window.__bx) return window.__bx;
  const mutationClock = { lastAt: performance.now(), count: 0 };
  const observer = new MutationObserver(() => {
    mutationClock.lastAt = performance.now();
    mutationClock.count += 1;
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  return (window.__bx = { refs: [], mutationClock });
}

function busyReason(tab) {
  const urls = [...tab.net.inflight.values()].map((request) => request.url);
  if (urls.length === 0) return "the DOM keeps changing";
  return `${urls.length} request(s) in flight: ${urls.slice(0, 3).join(" ")}`;
}

// Settled: the document is loaded, no request was in flight for SETTLE_QUIET_MS, and the DOM is quiet:
// unchanged since the action for SETTLE_QUIET_MS, or DOM_QUIET_AFTER_CHANGE_MS past its last change.
// With --no-settle only the document load is awaited. Returns null, or the reason the page is still busy at the cap.
// A page whose requests ended but whose DOM never goes quiet (a ticker, an animation) counts as settled after DOM_CHURN_MS,
// and the step's output line says the page was still changing.
async function settle(tab) {
  const deadline = Date.now() + SETTLE_CAP_MS;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return busyReason(tab);
    if (!tab.noSettle && tab.net.inflight.size > 0) {
      await sleep(5);
      continue;
    }
    const domQuiet = inPage(tab, "whenDomQuiet", tab.noSettle ? 0 : DOM_QUIET_AFTER_CHANGE_MS, tab.noSettle ? 0 : SETTLE_QUIET_MS).catch((e) => {
      if (isNavigationError(e)) return false;
      throw e;
    });
    const churnWait = tab.noSettle ? left : Math.min(left, DOM_CHURN_MS);
    const waitStart = Date.now();
    const quiet = await Promise.race([domQuiet, sleep(churnWait).then(() => "cap")]);
    if (quiet === "cap") {
      domQuiet.catch(() => {});
      if (tab.noSettle) return "the document did not finish loading";
      const networkIdleAllWait = tab.net.inflight.size === 0 && tab.net.lastEventAt <= waitStart;
      if (networkIdleAllWait && (await documentLoaded(tab))) {
        tab.stillChanging = true;
        return null;
      }
      continue;
    }
    if (quiet && tab.noSettle) return null;
    if (quiet && tab.net.inflight.size === 0 && Date.now() - tab.net.lastEventAt >= SETTLE_QUIET_MS) return null;
    if (!quiet) await sleep(5);
  }
}

const documentLoaded = (tab) => pageEval(tab, "document.readyState === 'complete'").catch((e) => {
  if (isNavigationError(e)) return false;
  throw e;
});

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

async function stepText(tab, [selector]) {
  const r = await inPage(tab, "text", selector ?? null);
  if (r.error) throw new StepError(r.error);
  return r.text;
}

// ---------- in the page: targets, tables, snapshot ----------

// Evaluated in the page on every call that needs it.
function bxPageLib(store) {
  const { mutationClock } = store;
  // an action starts here: a DOM left unchanged from now on needs no long quiet
  const markAction = () => {
    store.actionAt = performance.now();
    store.changesAtAction = mutationClock.count;
  };
  const whenDomQuiet = (afterChangeMs, unchangedMs) => new Promise((done) => {
    const check = () => {
      const unchanged = store.actionAt !== undefined && mutationClock.count === store.changesAtAction;
      const quietAt = unchanged ? store.actionAt + unchangedMs : mutationClock.lastAt + afterChangeMs;
      const left = quietAt - performance.now();
      if (left <= 0) return done(true);
      setTimeout(check, left);
    };
    if (document.readyState === "complete") check();
    else addEventListener("load", check, { once: true });
  });
  const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
  const FILLABLE = "input:not([type=hidden],[type=button],[type=submit],[type=reset],[type=image],[type=checkbox],[type=radio],[type=file]), textarea, select, [contenteditable=''], [contenteditable=true]";
  const INTERACTIVE = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=switch], [role=combobox], [role=textbox], [role=searchbox], [role=option], [contenteditable=''], [contenteditable=true], [onclick], [tabindex]:not([tabindex='-1'])";
  const TYPED_INPUT = /^(text|search|email|url|tel|password|number)$/;
  const TABLES = "table, [role=table], [role=grid]";
  const FILE_FIELDS = "input[type=file]";
  const isVisible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";

  // querySelectorAll that also enters open shadow roots, in tree order
  let shadowRootsOnPage;
  const pageHasShadowRoots = () => (shadowRootsOnPage ??= [...document.querySelectorAll("*")].some((el) => el.shadowRoot));
  const all = (selector) => {
    if (!pageHasShadowRoots()) return [...document.querySelectorAll(selector)];
    const found = [];
    const visit = (parent) => {
      for (const el of parent.children) {
        if (el.matches(selector)) found.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
        visit(el);
      }
    };
    visit(document);
    return found;
  };
  const containsAcrossShadow = (el, node) => {
    for (let up = node; up; up = up.parentNode ?? up.host) if (up === el) return true;
    return false;
  };
  const elementAtPoint = (x, y) => {
    let top = document.elementFromPoint(x, y);
    for (let inner; top?.shadowRoot && (inner = top.shadowRoot.elementFromPoint(x, y)) && inner !== top; top = inner);
    return top;
  };
  // innerText stops at a shadow root, so the text inside the shadow roots under the element is appended
  const textOf = (root) => {
    if (!pageHasShadowRoots()) return root.innerText;
    const hosts = all("*").filter((el) => el.shadowRoot && containsAcrossShadow(root, el));
    const shadowTexts = hosts.flatMap((host) => [...host.shadowRoot.children]).filter((child) => !/^(style|script)$/.test(child.localName)).map((child) => child.innerText);
    return [root.innerText, ...shadowTexts].join("\n");
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.localName;
    if (tag === "input") return { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", search: "searchbox", range: "slider", file: "file" }[el.type] ?? "textbox";
    return { a: "link", select: "combobox", textarea: "textbox", summary: "button" }[tag] ?? (el.isContentEditable ? "textbox" : tag);
  };
  const labelText = (label) => {
    const copy = label.cloneNode(true);
    for (const control of copy.querySelectorAll("input, select, textarea, button")) control.remove();
    return copy.textContent;
  };
  // accessible name, label, placeholder, visible text: every string a name may match, best first
  const namesOf = (el) => {
    const names = [el.getAttribute("aria-label")];
    for (const id of (el.getAttribute("aria-labelledby") ?? "").split(/\s+/)) names.push(id && el.getRootNode().getElementById(id)?.innerText);
    for (const label of el.labels ?? []) names.push(labelText(label));
    if (el.localName === "input" && /^(button|submit|reset)$/.test(el.type)) names.push(el.value);
    if (!/^(input|select|textarea)$/.test(el.localName)) names.push(el.innerText, el.querySelector("img[alt]")?.alt);
    names.push(el.placeholder, el.title, el.getAttribute("alt"));
    return [...new Set(names.map(norm).filter(Boolean))];
  };
  const describe = (el) => `${roleOf(el)} ${JSON.stringify(namesOf(el)[0] ?? "")}`;
  const refOf = (el) => {
    let i = store.refs.indexOf(el);
    if (i < 0) i = store.refs.push(el) - 1;
    return `@${i + 1}`;
  };
  const listed = (elements, limit = 5) => elements.slice(0, limit).map((el) => `${refOf(el)} ${describe(el)}`).join(", ");
  const innermost = (hits) => hits.filter((el) => !hits.some((other) => other !== el && containsAcrossShadow(el, other)));

  // elements with no semantics that still look clickable: exact visible text and a pointer cursor
  const pointerElements = (wanted) => innermost(all("*").filter((el) => (
    !/^(html|body)$/.test(el.localName) && el.textContent.length < 300 && norm(el.textContent).toLowerCase() === wanted && isVisible(el) && getComputedStyle(el).cursor === "pointer"
  )));

  const PURPOSES = {
    click: { selector: INTERACTIVE, noun: "element" },
    fill: { selector: FILLABLE, noun: "field" },
    upload: { selector: FILE_FIELDS, noun: "file field" },
  };
  const MISS_LIST_LIMIT = 15;

  const findByName = (target, purpose) => {
    const wanted = norm(target).toLowerCase();
    const { selector, noun } = PURPOSES[purpose];
    // a file field is often hidden behind a styled button, so it is found even when it is not visible
    const named = all(selector).filter((el) => purpose === "upload" || isVisible(el)).map((el) => ({ el, names: namesOf(el).map((n) => n.toLowerCase()) }));
    const levels = [(n) => n === wanted, (n) => n.startsWith(wanted)];
    for (const matches of levels) {
      const hits = innermost(named.filter((c) => c.names.some(matches)).map((c) => c.el));
      if (hits.length === 1) return { el: hits[0] };
      if (hits.length > 1) return { error: `${hits.length} elements match "${target}": ${listed(hits)}; pick one by @ref` };
    }
    const pointers = purpose === "click" ? pointerElements(wanted) : [];
    if (pointers.length === 1) return { el: pointers[0] };
    if (pointers.length > 1) return { error: `${pointers.length} elements match "${target}": ${listed(pointers)}; pick one by @ref` };
    const near = named.filter((c) => c.names.some((n) => n.includes(wanted))).map((c) => c.el);
    const miss = `no ${noun} named "${target}" at ${location.href}`;
    if (near.length) return { error: `${miss}; similar: ${listed(near)}` };
    if (location.href === "about:blank") return { error: `${miss}: the tab is empty, start the chain with open <url>` };
    if (named.length === 0) return { error: `${miss}: the page has no ${noun}` };
    const more = named.length > MISS_LIST_LIMIT ? `, and ${named.length - MISS_LIST_LIMIT} more (snap lists all)` : "";
    return { error: `${miss}; the page has: ${listed(named.map((c) => c.el), MISS_LIST_LIMIT)}${more}` };
  };

  const find = (target, purpose) => {
    if (target.startsWith("@")) {
      const el = store.refs[Number(target.slice(1)) - 1];
      if (!el) return { error: `no ref ${target}; run snap` };
      return el.isConnected ? { el } : { error: `ref ${target} left the page; run snap again` };
    }
    if (!target.startsWith("css=")) return findByName(target, purpose);
    const found = all(target.slice(4));
    if (found.length === 1) return { el: found[0] };
    return { error: found.length ? `${found.length} elements match ${target}: ${listed(found)}` : `no element matches ${target}` };
  };

  // the point of the element a click or a hover goes to; a click also records whether it arrived
  const preparePointer = (target, isClick) => {
    markAction();
    const { el, error } = find(target, "click");
    if (error) return { error };
    if (isClick && (el.disabled || el.getAttribute("aria-disabled") === "true")) return { error: `${describe(el)} is disabled` };
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const box = el.getClientRects()[0];
    if (!box) return { error: `${describe(el)} is not visible` };
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const top = elementAtPoint(x, y);
    const reaches = top && (containsAcrossShadow(el, top) || top.closest("label")?.control === el);
    if (!reaches) return { error: `${describe(el)} is covered by ${top ? describe(top) : "nothing: it is off screen"}` };
    if (!isClick) return { x, y, label: describe(el) };
    store.arrived = false;
    addEventListener("click", () => { store.arrived = true; }, { capture: true, once: true });
    return { x, y, label: describe(el) };
  };

  const prepareUpload = (target) => {
    markAction();
    const { el, error } = find(target, "upload");
    if (error) return { error };
    if (!el.matches(FILE_FIELDS)) return { error: `${describe(el)} is not a file field` };
    if (el.disabled) return { error: `${describe(el)} is disabled` };
    store.field = el;
    return { label: describe(el) };
  };
  const uploadedFileNames = () => [...(store.field?.files ?? [])].map((uploaded) => uploaded.name);

  const prepareFill = (target, text) => {
    markAction();
    const { el, error } = find(target, "fill");
    if (error) return { error };
    if (!el.matches(FILLABLE)) return { error: `${describe(el)} is not a field` };
    if (el.disabled || el.readOnly) return { error: `${describe(el)} is ${el.disabled ? "disabled" : "read-only"}` };
    store.field = el;
    const label = describe(el);
    const secret = el.type === "password";
    if (el.localName === "select") {
      const wanted = norm(text).toLowerCase();
      const option = [...el.options].find((o) => norm(o.label).toLowerCase() === wanted) ?? [...el.options].find((o) => o.value === text);
      if (!option) return { error: `${label} has no option "${text}"; options: ${[...el.options].slice(0, 12).map((o) => norm(o.label)).join(" | ")}` };
      el.value = option.value;
      for (const type of ["input", "change"]) el.dispatchEvent(new Event(type, { bubbles: true }));
      return { label, expected: norm(option.label), typed: false };
    }
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.focus();
    if (el.getRootNode().activeElement !== el) return { error: `${label} did not take the focus` };
    if (el.isContentEditable) getSelection().selectAllChildren(el);
    else if (TYPED_INPUT.test(el.type) || el.localName === "textarea") el.select();
    else return { label, expected: text, secret, typed: false, direct: true };
    return { label, expected: text, secret, typed: true };
  };

  // for the input types that cannot be typed into: date, time, color, range
  const setFieldValue = (text) => {
    const el = store.field;
    const proto = el.localName === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
    for (const type of ["input", "change"]) el.dispatchEvent(new Event(type, { bubbles: true }));
  };

  const fieldValue = () => {
    const el = store.field;
    if (!el?.isConnected) return { gone: true };
    if (el.localName === "select") return { value: norm(el.selectedOptions[0]?.label) };
    return { value: el.isContentEditable ? el.innerText.trim() : el.value };
  };

  const expectKey = () => {
    markAction();
    store.arrived = false;
    addEventListener("keydown", () => { store.arrived = true; }, { capture: true, once: true });
  };

  const hasText = (wanted) => document.body !== null && norm(textOf(document.body)).toLowerCase().includes(norm(wanted).toLowerCase());
  const text = (selector) => {
    const root = selector ? all(selector)[0] : (all("main")[0] ?? document.body);
    if (!root) return { error: `no element matches ${selector}` };
    return { text: textOf(root).split("\n").map((line) => line.trim()).filter(Boolean).join("\n") };
  };

  const cellText = (cell) => {
    const text = norm(cell.innerText);
    const control = text ? null : cell.querySelector("input, select, textarea");
    if (!control) return text;
    if (/^(checkbox|radio)$/.test(control.type)) return control.checked ? "[x]" : "[ ]";
    return norm(control.localName === "select" ? control.selectedOptions[0]?.label : control.value);
  };
  const rowsOf = (table) => [...table.querySelectorAll("tr, [role=row]")]
    .filter((row) => row.closest(TABLES) === table && isVisible(row))
    .map((row) => [...row.querySelectorAll("th, td, [role=columnheader], [role=rowheader], [role=cell], [role=gridcell]")].filter((cell) => cell.closest("tr, [role=row]") === row).map(cellText))
    .filter((cells) => cells.length > 0);
  const tableTitle = (table) => {
    const own = norm(table.caption?.innerText ?? table.getAttribute("aria-label"));
    if (own) return own;
    for (let node = table; node && node !== document.body; node = node.parentElement) {
      for (let before = node.previousElementSibling; before; before = before.previousElementSibling) {
        if (/^h[1-6]$/.test(before.localName)) return norm(before.innerText);
      }
    }
    return "";
  };

  const table = (pick) => {
    const tables = all(TABLES).filter(isVisible);
    let chosen = tables[0];
    if (pick === null && tables.length > 1) {
      const lines = tables.map((t, i) => {
        const rows = rowsOf(t);
        return `  table ${i + 1} ${JSON.stringify(tableTitle(t))} ${rows.length} rows: ${(rows[0] ?? []).join(" | ")}`;
      });
      return { error: `${tables.length} tables on the page; give the number:\n${lines.join("\n")}` };
    }
    if (pick !== null && /^\d+$/.test(pick)) chosen = tables[Number(pick) - 1];
    else if (pick !== null) {
      const found = all(pick)[0];
      chosen = found?.matches(TABLES) ? found : found?.querySelector(TABLES);
    }
    if (!chosen) return { error: pick === null ? "no table on the page" : `no table ${pick}; the page has ${tables.length} table(s)` };
    return { tsv: rowsOf(chosen).map((cells) => cells.join("\t")).join("\n") };
  };

  const snap = () => {
    store.refs = [];
    const lines = all(INTERACTIVE).filter(isVisible).map((el) => {
      let line = `${refOf(el)} ${describe(el)}`;
      if (el.matches(FILLABLE) && el.type !== "password" && el.localName !== "select" && el.value) line += ` = ${JSON.stringify(el.value)}`;
      if (el.localName === "select") line += ` = ${JSON.stringify(norm(el.selectedOptions[0]?.label))}`;
      if (el.checked) line += " checked";
      if (el.disabled) line += " disabled";
      return line;
    });
    return lines.join("\n");
  };

  return { markAction, whenDomQuiet, preparePointer, prepareFill, prepareUpload, uploadedFileNames, setFieldValue, fieldValue, expectKey, arrived: () => store.arrived, hasText, text, table, snap };
}

const inPage = (tab, method, ...args) => pageEval(tab, `(${bxPageLib})((${bxPageStore})()).${method}(${args.map((a) => JSON.stringify(a)).join(",")})`);

// A click or key press must reach the page. A navigation it caused replaces the page, which proves the same.
async function assertInputArrived(tab, what) {
  const arrived = await pageEval(tab, "window.__bx?.arrived ?? true").catch((e) => {
    if (isNavigationError(e)) return true;
    throw e;
  });
  if (!arrived) throw new StepError(`${what} did not reach the page`);
}

// ---------- steps that act ----------

const pageTargetIds = async (tab) => (await tab.cdp.send("Target.getTargets")).targetInfos.filter((t) => t.type === "page").map((t) => t.targetId);

// The tab a click opened (target=_blank, window.open), or undefined. The chain goes on in it, as the user's eyes would.
async function tabOpenedByClick(tab, tabsBefore) {
  if (!tab.windowOpened) return undefined;
  tab.windowOpened = false;
  const deadline = Date.now() + NEW_TAB_WAIT_MS;
  for (;;) {
    const opened = (await pageTargetIds(tab)).find((id) => !tabsBefore.includes(id));
    if (opened || Date.now() >= deadline) return opened;
    await sleep(50);
  }
}

async function stepClick(tab, [target]) {
  const [prepared, tabsBefore] = await Promise.all([inPage(tab, "preparePointer", target, true), pageTargetIds(tab)]);
  if (prepared.error) throw new StepError(prepared.error);
  const mouse = { x: prepared.x, y: prepared.y, button: "left", clickCount: 1 };
  await tab.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: prepared.x, y: prepared.y });
  await tab.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...mouse });
  await tab.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...mouse });
  await assertInputArrived(tab, "the click");
  await settleOrFail(tab);
  const opened = await tabOpenedByClick(tab, tabsBefore);
  if (!opened) return `click ${prepared.label}`;
  await useTab(tab, opened);
  await settleOrFail(tab);
  return `click ${prepared.label} -> new tab ${await pageEval(tab, "location.href")}`;
}

async function stepHover(tab, [target]) {
  const prepared = await inPage(tab, "preparePointer", target, false);
  if (prepared.error) throw new StepError(prepared.error);
  await tab.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: prepared.x, y: prepared.y });
  await settleOrFail(tab);
  return `hover ${prepared.label}`;
}

async function stepUpload(tab, [target, file]) {
  const path = resolve(file);
  if (!existsSync(path)) throw new StepError(`no file at ${path}`);
  const prepared = await inPage(tab, "prepareUpload", target);
  if (prepared.error) throw new StepError(prepared.error);
  const field = await tab.cdp.send("Runtime.evaluate", { expression: "window.__bx.field" });
  await tab.cdp.send("DOM.setFileInputFiles", { files: [path], objectId: field.result.objectId });
  await settleOrFail(tab);
  const names = await inPage(tab, "uploadedFileNames").catch((e) => {
    if (isNavigationError(e)) return [basename(path)];
    throw e;
  });
  if (names.join() !== basename(path)) throw new StepError(`${prepared.label} holds ${JSON.stringify(names)} after the upload, not the file given`);
  return `upload ${prepared.label} = ${names[0]}`;
}

async function stepFill(tab, [target, text]) {
  const prepared = await inPage(tab, "prepareFill", target, text);
  if (prepared.error) throw new StepError(prepared.error);
  if (prepared.direct) await inPage(tab, "setFieldValue", text);
  else if (prepared.typed && text === "") await pressKey(tab, "Delete");
  else if (prepared.typed) await tab.cdp.send("Input.insertText", { text });
  await settleOrFail(tab);
  const field = await inPage(tab, "fieldValue");
  if (field.gone) throw new StepError(`${prepared.label} left the page while it was filled`);
  if (field.value !== prepared.expected) throw new StepError(`${prepared.label} holds ${JSON.stringify(field.value)} after the fill, not the text given`);
  const shown = prepared.secret ? `(${text.length} characters, hidden)` : JSON.stringify(field.value);
  return `fill ${prepared.label} = ${shown}`;
}

const NAMED_KEYS = {
  Enter: [13, "\r"], Tab: [9], Escape: [27], Backspace: [8], Delete: [46], Space: [32, " "],
  ArrowLeft: [37], ArrowUp: [38], ArrowRight: [39], ArrowDown: [40], PageUp: [33], PageDown: [34], End: [35], Home: [36],
};
const KEY_MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

function keyEvent(spec) {
  const parts = spec.length > 1 ? spec.split("+") : [spec];
  const name = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    if (!KEY_MODIFIERS[part]) throw new StepError(`unknown modifier "${part}"; modifiers: ${Object.keys(KEY_MODIFIERS).join(" ")}`);
    modifiers |= KEY_MODIFIERS[part];
  }
  if (NAMED_KEYS[name]) {
    const [windowsVirtualKeyCode, text] = NAMED_KEYS[name];
    return { modifiers, key: name === "Space" ? " " : name, code: name, windowsVirtualKeyCode, text };
  }
  if ([...name].length !== 1) throw new StepError(`unknown key "${name}"; keys: one character, or ${Object.keys(NAMED_KEYS).join(" ")}`);
  const upper = name.toUpperCase();
  const code = /[A-Z]/.test(upper) ? `Key${upper}` : /\d/.test(name) ? `Digit${name}` : "";
  const text = modifiers & ~KEY_MODIFIERS.Shift ? undefined : name;
  return { modifiers, key: name, code, windowsVirtualKeyCode: upper.charCodeAt(0), text };
}

async function pressKey(tab, spec) {
  const event = keyEvent(spec);
  await tab.cdp.send("Input.dispatchKeyEvent", { type: event.text ? "keyDown" : "rawKeyDown", ...event });
  await tab.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...event, text: undefined });
}

async function stepPress(tab, [key]) {
  keyEvent(key);
  await inPage(tab, "expectKey");
  await pressKey(tab, key);
  await assertInputArrived(tab, "the key press");
  await settleOrFail(tab);
  return `press ${key}`;
}

async function stepWait(tab, [text]) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const visible = await inPage(tab, "hasText", text).catch((e) => {
      if (isNavigationError(e)) return false;
      throw e;
    });
    if (visible) return `wait ${JSON.stringify(text)} visible`;
    if (Date.now() >= deadline) throw new StepError(`the text is not visible after ${TIMEOUT_MS} ms`);
    await sleep(50);
  }
}

async function stepTable(tab, [pick]) {
  const r = await inPage(tab, "table", pick ?? null);
  if (r.error) throw new StepError(r.error);
  return r.tsv;
}

const stepSnap = async (tab) => (await inPage(tab, "snap")) || "(no interactive element)";

const applyViewport = (tab, { width, height }) => tab.cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

// Emulation ends when this invocation detaches, so the size goes in the state file and prepareTab applies it again.
async function stepViewport(tab, [size]) {
  if (size === "reset") {
    await tab.cdp.send("Emulation.clearDeviceMetricsOverride");
    tab.state.viewport = undefined;
  } else {
    const [, width, height] = /^(\d+)x(\d+)$/.exec(size) ?? [];
    if (!width) throw new StepError(`"${size}" is not a size; write 390x844, or reset`);
    tab.state.viewport = { width: Number(width), height: Number(height) };
    await inPage(tab, "markAction");
    await applyViewport(tab, tab.state.viewport);
  }
  await settleOrFail(tab);
  const actual = await pageEval(tab, "`${innerWidth}x${innerHeight}`");
  if (size !== "reset" && actual !== size) throw new StepError(`the page is ${actual} after the change`);
  return `viewport ${actual}`;
}

async function stepShot(tab, [file]) {
  if (/^[A-Za-z]:[^\\/]/.test(file)) throw new StepError(`the path lost its backslashes in the shell; write it with / or in quotes`);
  const { data } = await tab.cdp.send("Page.captureScreenshot", { format: "png" });
  const png = Buffer.from(data, "base64");
  try {
    mkdirSync(dirname(resolve(file)), { recursive: true });
    writeFileSync(file, png);
  } catch (e) {
    throw new StepError(`cannot write the file: ${e.message}`);
  }
  return `shot ${file} ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
}

const CONSOLE_LIMIT = 50;

// Chrome replays the messages of the current document when Runtime and Log are enabled, so messages from before this invocation are listed too.
function recordConsole(tab) {
  tab.consoleLines = [];
  const textOf = (arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? arg.type;
  tab.cdp.on("Runtime.consoleAPICalled", (p) => tab.consoleLines.push(`[${p.type}] ${p.args.map(textOf).join(" ")}`));
  tab.cdp.on("Runtime.exceptionThrown", (p) => tab.consoleLines.push(`[exception] ${firstLine(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text)}`));
  tab.cdp.on("Log.entryAdded", (p) => tab.consoleLines.push(`[${p.entry.level}] ${p.entry.text}${p.entry.url ? ` ${p.entry.url}` : ""}`));
  return [tab.cdp.send("Runtime.enable"), tab.cdp.send("Log.enable")];
}

async function stepConsole(tab) {
  await pageEval(tab, "1");
  const lines = tab.consoleLines;
  if (lines.length === 0) return "(no console message)";
  const omitted = lines.length - CONSOLE_LIMIT;
  return (omitted > 0 ? `(${omitted} earlier messages omitted)\n` : "") + lines.slice(-CONSOLE_LIMIT).join("\n");
}

// settles: the step changes the page and waits for it to settle. front: the step needs a visible, focused tab.
const STEPS = {
  open: { usage: "open <url>", minArgs: 1, maxArgs: 1, settles: true, front: true, run: stepOpen },
  click: { usage: "click <target>", minArgs: 1, maxArgs: 1, settles: true, front: true, run: stepClick },
  hover: { usage: "hover <target>", minArgs: 1, maxArgs: 1, settles: true, front: true, run: stepHover },
  fill: { usage: "fill <target> <text>", minArgs: 2, maxArgs: 2, settles: true, front: true, run: stepFill },
  upload: { usage: "upload <target> <file>", minArgs: 2, maxArgs: 2, settles: true, front: true, run: stepUpload },
  press: { usage: "press <key>", minArgs: 1, maxArgs: 1, settles: true, front: true, run: stepPress },
  wait: { usage: "wait <text>", minArgs: 1, maxArgs: 1, run: stepWait },
  text: { usage: "text [selector]", minArgs: 0, maxArgs: 1, run: stepText },
  table: { usage: "table [n|selector]", minArgs: 0, maxArgs: 1, run: stepTable },
  snap: { usage: "snap", minArgs: 0, maxArgs: 0, run: stepSnap },
  viewport: { usage: "viewport <w>x<h>|reset", minArgs: 1, maxArgs: 1, settles: true, front: true, run: stepViewport },
  shot: { usage: "shot <file>", minArgs: 1, maxArgs: 1, front: true, run: stepShot },
  eval: { usage: "eval <js>", minArgs: 1, maxArgs: 1, run: stepEval },
  console: { usage: "console", minArgs: 0, maxArgs: 0, run: stepConsole },
  url: { usage: "url", minArgs: 0, maxArgs: 0, run: stepUrl },
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

async function prepareTab(tab) {
  const { cdp, chain } = tab;
  tab.net = trackNetwork(cdp);
  // the clock of DOM changes starts with every document this invocation loads
  const setup = [cdp.send("Page.enable"), cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${bxPageStore})()` })];
  cdp.on("Page.javascriptDialogOpening", (p) => {
    tab.out.push(`dialog ${p.type} ${JSON.stringify(p.message)} accepted`);
    cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
  });
  cdp.on("Page.windowOpen", () => { tab.windowOpened = true; });
  if (tab.state.viewport) setup.push(applyViewport(tab, tab.state.viewport));
  if (chain.some((s) => s.name === "console")) setup.push(...recordConsole(tab));
  if (chain.some((s) => s.step.settles)) setup.push(cdp.send("Network.enable"));
  if (chain.some((s) => s.step.front)) {
    setup.push(cdp.send("Page.bringToFront"), cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }));
  }
  await Promise.all(setup);
}

// moves the rest of the chain, and the next invocations, to another tab
async function useTab(tab, targetId) {
  tab.state.targetId = targetId;
  tab.cdp = cdpClient(await openWebSocket(pageWsUrl(targetId)));
  await prepareTab(tab);
}

async function runChain(chain, noSettle, out) {
  const state = readState();
  const savedState = JSON.stringify(state);
  const tab = { cdp: await attachTab(state), state, chain, noSettle, out, stillChanging: false, windowOpened: false };
  await prepareTab(tab);
  try {
    for (const [i, s] of chain.entries()) {
      try {
        const line = await s.step.run(tab, s.args);
        out.push(tab.stillChanging ? `${line} (the page was still changing: wait <text> before reading it)` : line);
        tab.stillChanging = false;
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
