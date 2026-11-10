// Test support: a headless Chrome on its own port, the fixture server, and a runner for the bx command line.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { startFixtureServer } from "./fixture-server.mjs";

const BX_FILE = fileURLToPath(new URL("../bx.mjs", import.meta.url));
const CHROME_CANDIDATES = [
  process.env.BX_TEST_CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const freePort = () => new Promise((ok) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => ok(port));
  });
});

async function startChrome() {
  const chromeFile = CHROME_CANDIDATES.find((file) => file && existsSync(file));
  assert.ok(chromeFile, "no Chrome found; set BX_TEST_CHROME to the Chrome executable");
  const port = await freePort();
  const profileDir = mkdtempSync(join(tmpdir(), "bx-test-chrome-"));
  const chrome = spawn(chromeFile, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--window-size=1200,800", "about:blank"], { stdio: "ignore" });
  const cdpUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    if (await fetch(`${cdpUrl}/json/version`).then((r) => r.ok, () => false)) break;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  // Browser.close ends the helper processes too; killing the main process leaves them holding the profile directory
  const stop = async () => {
    const exited = new Promise((ok) => chrome.once("exit", ok));
    const { webSocketDebuggerUrl } = await (await fetch(`${cdpUrl}/json/version`)).json();
    const ws = new WebSocket(webSocketDebuggerUrl);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    await Promise.race([exited, new Promise((ok) => setTimeout(ok, 5000))]);
    chrome.kill();
    for (let attempt = 1; ; attempt += 1) {
      try {
        return rmSync(profileDir, { recursive: true, force: true });
      } catch (e) {
        if (attempt === 40) throw e;
        await new Promise((ok) => setTimeout(ok, 250));
      }
    }
  };
  return { cdpUrl, stop };
}

// One Chrome and one fixture server for a test file. Each test gets its own tab and its own bx session.
export async function startBench() {
  const [chrome, fixture] = await Promise.all([startChrome(), startFixtureServer()]);
  let sessions = 0;
  const stateFiles = [];

  const newTab = async () => (await (await fetch(`${chrome.cdpUrl}/json/new?about:blank`, { method: "PUT" })).json()).id;

  const session = async () => {
    sessions += 1;
    const env = { ...process.env, BX_CDP_URL: chrome.cdpUrl, BX_SESSION: `test-${process.pid}-${sessions}` };
    await newTab();
    // runs `bx <args>`; the text "FIXTURE" in an argument stands for the fixture's base URL
    const bx = (args, extraEnv = {}) => new Promise((ok) => {
      const argv = args.map((a) => a.replaceAll("FIXTURE", fixture.url));
      execFile(process.execPath, [BX_FILE, ...argv], { env: { ...env, ...extraEnv } }, (error, stdout, stderr) => {
        ok({ code: error ? error.code : 0, stdout, stderr });
      });
    });
    const stateFile = join(tmpdir(), `bx-${env.BX_SESSION}.json`);
    stateFiles.push(stateFile);
    return { bx, newTab, cleanup: () => rmSync(stateFile, { force: true }) };
  };

  // the transcript of a run, with the fixture's random port masked
  const transcript = ({ code, stdout, stderr }) => {
    const mask = (s) => s.replaceAll(fixture.url, "FIXTURE").replaceAll("\r\n", "\n");
    return `exit code: ${code}\n--- stdout\n${mask(stdout)}--- stderr\n${mask(stderr)}`;
  };

  const stop = async () => {
    for (const file of stateFiles) rmSync(file, { force: true });
    fixture.close();
    await chrome.stop();
  };
  return { session, transcript, stop };
}

// Compares with test/golden/<name>.txt; BX_UPDATE_GOLDEN=1 rewrites the file instead.
export function assertGolden(name, actual) {
  const file = fileURLToPath(new URL(`./golden/${name}.txt`, import.meta.url));
  if (process.env.BX_UPDATE_GOLDEN) return writeFileSync(file, actual);
  assert.equal(actual, readFileSync(file, "utf8").replaceAll("\r\n", "\n"));
}
