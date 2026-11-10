// Regression: click returned while the screen it opened still showed its loading fallback.
// Found in the Haiku pilot runs of browser-tools-bench on 2026-11-10: after `click "Inscrições"` (a Next.js client-side
// navigation) the next step saw 0 inputs on /inscricoes in 5 of 6 runs, so `fill "Buscar"` failed with "no field named"
// and `snap` listed only the menu. The app shows the route's loading skeleton at about 90 ms, its request ends at about
// 120 ms, and React reveals the content only 240 to 320 ms after the skeleton (its Suspense fallback throttle), with no
// request in flight and no DOM change in between; the settle rule took 150 ms of quiet as settled.
import { after, before, test } from "node:test";
import { assertGolden, startBench } from "./harness.mjs";

let bench;
before(async () => { bench = await startBench(); });
after(() => bench.stop());

test("click returns after the content that replaces a loading fallback 320 ms later", async () => {
  const s = await bench.session();
  const run = await s.bx(["open", "FIXTURE/throttled-reveal.html", "+", "click", "Open orders", "+", "fill", "Order number", "77", "+", "text", "#screen"]);
  assertGolden("regression-click-returns-on-loading-fallback", bench.transcript(run));
  s.cleanup();
});
