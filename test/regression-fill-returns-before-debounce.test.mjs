// Regression: fill returned before a debounced search ran, so the next step read the list of before the fill.
// Found with the shop app of Flashwright (150 ms debounce): the read after the fill returned [] in 6 of 6 runs of bx 0.2.0.
// The fixture waits 300 ms, inside the 500 ms bx follows, because at 150 ms the bug is a race on a page with no request.
// Confirmed by the user on 2026-11-24 (PLAN-E2E.md, decision D4, item 2).
import { after, before, test } from "node:test";
import { assertGolden, startBench } from "./harness.mjs";

let bench;
before(async () => { bench = await startBench(); });
after(() => bench.stop());

test("fill returns after a search that waits 300 ms for the typing to stop", async () => {
  const s = await bench.session();
  const run = await s.bx(["open", "FIXTURE/debounced-search.html", "+", "fill", "Find city", "Bel", "+", "text", "#matches"]);
  assertGolden("regression-fill-returns-before-debounce", bench.transcript(run));
  s.cleanup();
});
