// End-to-end tests of what bx 0.2.0 added.
// Source of each test: the user's request of 2026-11-10 to improve bx to the maximum, made on the list of gaps of bx 0.1.0
// reported to them in the same conversation; each test quotes the item of that list it covers.
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertGolden, startBench } from "./harness.mjs";

let bench;
before(async () => { bench = await startBench(); });
after(() => bench.stop());

// "Settle on pages with animation: the MutationObserver counts attribute changes, so a spinner or a clock
//  leads to the 10 s cap and the step fails."
test("open of a page whose DOM never goes quiet succeeds and says the page was still changing", async () => {
  const s = await bench.session();
  assertGolden("still-changing", bench.transcript(await s.bx(["open", "FIXTURE/ticker.html", "+", "text", "h1"])));
  s.cleanup();
});

// "No support for iframes and shadow DOM in name resolution, table and text." (the shadow DOM half)
test("names, fill, click, text, table and snap reach elements inside a shadow root", async () => {
  const s = await bench.session();
  const run = await s.bx(["open", "FIXTURE/widgets.html", "+", "fill", "Note", "ok by Ana", "+", "click", "Approve", "+", "text", "#echo", "+", "wait", "Card inside a shadow root", "+", "table", "+", "snap"]);
  assertGolden("shadow-root", bench.transcript(run));
  s.cleanup();
});

// "New tabs: a click that opens target=_blank is not followed."
test("a click that opens a new tab moves the chain and the next invocation to that tab", async () => {
  const s = await bench.session();
  const run = await s.bx(["open", "FIXTURE/widgets.html", "+", "click", "Open report", "+", "text", "h1"]);
  const next = await s.bx(["url"]);
  assertGolden("new-tab", `${bench.transcript(run)}\n=== next invocation: url\n${bench.transcript(next)}`);
  s.cleanup();
});

// "Missing steps: hover, file upload."
test("hover shows what the page shows under the pointer", async () => {
  const s = await bench.session();
  assertGolden("hover", bench.transcript(await s.bx(["open", "FIXTURE/widgets.html", "+", "hover", "Help", "+", "text", "#tip"])));
  s.cleanup();
});

// "Missing steps: hover, file upload."
test("upload attaches a file to a hidden file field found by its label, and fails on a missing file", async () => {
  const s = await bench.session();
  const sample = fileURLToPath(new URL("./fixture/upload-sample.txt", import.meta.url));
  const run = await s.bx(["open", "FIXTURE/widgets.html", "+", "upload", "Attachment", sample, "+", "text", "#echo"]);
  const missing = await s.bx(["upload", "Attachment", `${sample}.missing`]);
  const transcript = `${bench.transcript(run)}\n=== upload of a file that does not exist\n${bench.transcript(missing)}`;
  assertGolden("upload", transcript.replaceAll(sample, "SAMPLE"));
  s.cleanup();
});
