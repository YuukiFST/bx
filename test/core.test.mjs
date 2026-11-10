// End-to-end tests of the bx command line against a headless Chrome and the fixture server.
// Each test names its source: a row of PLAN.md section 3 or a line of the command surface in section 4.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertGolden, startBench } from "./harness.mjs";

let bench;
before(async () => { bench = await startBench(); });
after(() => bench.stop());

// PLAN.md section 3: "the page was read before its data rendered" -> "every action waits for the page to settle before it returns"
// PLAN.md phase 1 check: "a chain that reads the late content returns it without any explicit wait"
test("open returns after data that renders 1 s late, with no explicit wait", async () => {
  const s = await bench.session();
  assertGolden("late-content", bench.transcript(await s.bx(["open", "FIXTURE/", "+", "text", "#late", "+", "text", "#invoices"])));
  s.cleanup();
});

// PLAN.md section 4, command surface: open, url, eval, text; "bx <step> [+ <step> ...]"
test("open, url, eval and text chained in one invocation", async () => {
  const s = await bench.session();
  const run = await s.bx(["open", "FIXTURE/other.html", "+", "url", "+", "eval", "({ sum: 1 + 1, list: ['a'] })", "+", "eval", "undefined", "+", "text", "+", "text", "h1"]);
  assertGolden("core-chain", bench.transcript(run));
  s.cleanup();
});

// PLAN.md section 4, principle 3: "a failed step stops the chain with a non-zero exit code"
test("a failed step stops the chain, names the steps not run and exits 1", async () => {
  const s = await bench.session();
  const run = await s.bx(["open", "FIXTURE/other.html", "+", "eval", "missingFunction()", "+", "text", "h1", "+", "url"]);
  assertGolden("failed-step", bench.transcript(run));
  s.cleanup();
});

// PLAN.md section 4, principle 3 ("nothing succeeds silently") applied to open
test("open fails on an HTTP error status", async () => {
  const s = await bench.session();
  assertGolden("open-http-error", bench.transcript(await s.bx(["open", "FIXTURE/missing.html", "+", "text"])));
  s.cleanup();
});

// PLAN.md section 4, settle rule: "Hitting the cap is reported on the output line and makes the step fail unless --no-settle was given"
test("a page that never goes idle fails at the cap, and passes with --no-settle", async () => {
  const s = await bench.session();
  const capped = await s.bx(["open", "FIXTURE/busy.html", "+", "text"], { BX_TIMEOUT_MS: "1000" });
  const noSettle = await s.bx(["--no-settle", "open", "FIXTURE/busy.html", "+", "text"], { BX_TIMEOUT_MS: "1000" });
  assertGolden("settle-cap", `${bench.transcript(capped)}\n=== with --no-settle\n${bench.transcript(noSettle)}`);
  s.cleanup();
});

// PLAN.md section 4, state: "A small state file per session ... keeps the target id of the tab in use"
test("the next invocation stays on the same tab after another tab opens", async () => {
  const s = await bench.session();
  await s.bx(["open", "FIXTURE/other.html"]);
  await s.newTab();
  assertGolden("same-tab", bench.transcript(await s.bx(["url"])));
  s.cleanup();
});

// PLAN.md section 4, docs: "`docs/bx.md`, at most 1,500 characters"; "`bx --help` prints the same text"; "A test fails when the file passes 1,500 characters"
test("docs/bx.md has at most 1,500 characters and bx --help prints it", async () => {
  const docs = readFileSync(new URL("../docs/bx.md", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  assert.ok(docs.length <= 1500, `docs/bx.md has ${docs.length} characters`);
  const s = await bench.session();
  const help = await s.bx(["--help"]);
  assert.deepEqual({ code: help.code, stdout: help.stdout.replaceAll("\r\n", "\n") }, { code: 0, stdout: docs });
  s.cleanup();
});
