// End-to-end tests of the interaction and reading steps.
// Each test names its source: a row of PLAN.md section 3, a line of the command surface in section 4, or the phase 2 check.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertGolden, startBench } from "./harness.mjs";

let bench;
before(async () => { bench = await startBench(); });
after(() => bench.stop());

// PLAN.md section 3: "page.text runs table cells together and the agent split them wrong" ->
//   "table prints one row per line, one cell per tab, header first"
// PLAN.md section 4: "several tables and no argument is an error that lists them"
test("table prints TSV, header first, and lists the tables when the choice is ambiguous", async () => {
  const s = await bench.session();
  const ambiguous = await s.bx(["open", "FIXTURE/", "+", "table"]);
  const picked = await s.bx(["table", "1", "+", "table", "#invoices"]);
  assertGolden("table", `${bench.transcript(ambiguous)}\n=== table 1 + table #invoices\n${bench.transcript(picked)}`);
  s.cleanup();
});

// PLAN.md section 3: "input sent to a background tab" -> "bring the tab to front, emulate focus, read the value back after fill"
// PLAN.md phase 2 check: "a fill into a background tab"
test("fill into a tab that went to the background types the text and reads it back", async () => {
  const s = await bench.session();
  await s.bx(["open", "FIXTURE/"]);
  await s.newTab();
  // headless Chrome takes input in a hidden tab, so the page states whether it was visible and focused when the text arrived
  const run = await s.bx(["fill", "Search term", "Alfa & Co", "+", "fill", "Status", "Active", "+", "click", "Search", "+", "text", "#echo", "+", "text", "#typed-while"]);
  assertGolden("fill-background-tab", bench.transcript(run));
  s.cleanup();
});

// PLAN.md section 4: "fill <target> <text>: focus, replace the value, read it back; mismatch is an error"
test("fill fails when the field ends with another value than the text given", async () => {
  const s = await bench.session();
  assertGolden("fill-mismatch", bench.transcript(await s.bx(["open", "FIXTURE/", "+", "fill", "Plate", "abc1d23", "+", "url"])));
  s.cleanup();
});

// PLAN.md section 4: "No match, or more than one match at the same level, is an error that lists up to 5 candidates with their roles;
//   bx never picks one by guessing"; "exact match before prefix match"; "A <target> is ... @ref from snap"
// PLAN.md phase 2 check: "the ambiguous-name error"
test("names: exact before prefix, ambiguity and no match are errors, a listed @ref resolves", async () => {
  const s = await bench.session();
  const exact = await s.bx(["open", "FIXTURE/", "+", "click", "Delete", "+", "text", "#echo"]);
  const ambiguous = await s.bx(["click", "Save"]);
  const byRef = await s.bx(["click", "@2", "+", "text", "#echo"]);
  const none = await s.bx(["click", "Nothing here"]);
  assertGolden("names", [exact, ambiguous, byRef, none].map(bench.transcript).join("\n=== next run\n"));
  s.cleanup();
});

// PLAN.md section 4: "snap: compact list of interactive elements: role, name, ref"; "css=<selector>"
test("snap lists role, name and ref, and both a ref and css= act on the element", async () => {
  const s = await bench.session();
  const snap = await s.bx(["open", "FIXTURE/", "+", "snap"]);
  const act = await s.bx(["click", "@12", "+", "text", "#echo", "+", "click", "css=#delete-all", "+", "text", "#echo"]);
  assertGolden("snap", `${bench.transcript(snap)}\n=== click @12 + click css=#delete-all\n${bench.transcript(act)}`);
  s.cleanup();
});

// PLAN.md section 4: "wait <text>: wait until the text is visible"; "press <key>: key press on the focused element"
test("wait returns once a timer-rendered text shows, and press reaches the page", async () => {
  const s = await bench.session();
  const run = await s.bx(["open", "FIXTURE/", "+", "click", "Show slow panel", "+", "wait", "Slow panel shown", "+", "press", "x", "+", "text", "#keys"]);
  const timeout = await s.bx(["wait", "never shown"], { BX_TIMEOUT_MS: "500" });
  assertGolden("wait-press", `${bench.transcript(run)}\n=== wait for a text that never shows\n${bench.transcript(timeout)}`);
  s.cleanup();
});

// PLAN.md section 3: "resize 390 844 gave 500 px" -> "viewport through device-metrics emulation, and shot prints the PNG size"
// PLAN.md section 4: "viewport <w>x<h>: device-metrics emulation, kept across invocations"
test("viewport 390x844 holds across invocations and shot prints the PNG size", async () => {
  const s = await bench.session();
  const dir = mkdtempSync(join(tmpdir(), "bx-shot-"));
  const file = join(dir, "mobile.png").replaceAll("\\", "/");
  await s.bx(["open", "FIXTURE/other.html", "+", "viewport", "390x844"]);
  const later = await s.bx(["open", "FIXTURE/other.html", "+", "eval", "innerWidth", "+", "shot", file]);
  const png = readFileSync(file);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [390, 844]);
  rmSync(dir, { recursive: true, force: true });
  const reset = await s.bx(["viewport", "1366x768", "+", "eval", "innerWidth"]);
  const transcript = `${bench.transcript(later)}\n=== viewport 1366x768\n${bench.transcript(reset)}`;
  assertGolden("viewport-shot", transcript.replaceAll(file, "SHOT"));
  s.cleanup();
});

// PLAN.md section 4: "console: console messages seen in this invocation or recorded in the page"
test("console lists messages from the page script and from an earlier invocation", async () => {
  const s = await bench.session();
  await s.bx(["open", "FIXTURE/other.html", "+", "eval", "console.error('MARK-earlier')"]);
  assertGolden("console", bench.transcript(await s.bx(["eval", "console.warn('MARK-now')", "+", "console"])));
  s.cleanup();
});
