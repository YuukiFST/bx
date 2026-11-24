// Regression: click failed at the settle cap when the page did not read the body of a fetch response.
// Found with the shop app of Flashwright: its login looks only at the status, Chrome then sends no Network.loadingFinished,
// and the click failed with "page not settled after 10000 ms (1 request(s) in flight)" in 6 of 6 runs of bx 0.2.0.
// Confirmed by the user on 2026-11-24 (PLAN-E2E.md, decision D4, item 1).
import { after, before, test } from "node:test";
import { assertGolden, startBench } from "./harness.mjs";

let bench;
before(async () => { bench = await startBench(); });
after(() => bench.stop());

test("click returns when the page leaves the body of the response unread", async () => {
  const s = await bench.session();
  const run = await s.bx(["open", "FIXTURE/unread-response.html", "+", "click", "Enter", "+", "text", "#status"], { BX_TIMEOUT_MS: "3000" });
  assertGolden("regression-click-fails-on-unread-response", bench.transcript(run));
  s.cleanup();
});
