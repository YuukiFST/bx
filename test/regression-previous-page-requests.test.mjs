// Regression: open failed at the settle cap because requests of the PREVIOUS page stayed "in flight".
// Found by the browser-tools-bench battery (sweep task, route /configuracoes/unidades): Next.js link prefetches
// of the page being left never get a loadingFinished or loadingFailed event, so the next open waited 10 s and failed.
import { after, before, test } from "node:test";
import { assertGolden, startBench } from "./harness.mjs";

let bench;
before(async () => { bench = await startBench(); });
after(() => bench.stop());

test("open settles on the new page while a request of the page it left is still open", async () => {
  const s = await bench.session();
  await s.bx(["--no-settle", "open", "FIXTURE/polling.html"]);
  const run = await s.bx(["open", "FIXTURE/other.html", "+", "text", "h1"], { BX_TIMEOUT_MS: "3000" });
  assertGolden("regression-previous-page-requests", bench.transcript(run));
  s.cleanup();
});
