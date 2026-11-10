// Serves the pages of test/fixture and three small APIs:
//   /api/late    answers after 1 s (data that renders late)
//   /api/search  echoes the query after 200 ms
//   /api/never   never answers (a page that never goes idle)
// Standalone: node test/fixture-server.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const LATE_MS = 1000;
const SEARCH_MS = 200;

const sendJson = (res, body) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function handle(req, res) {
  const url = new URL(req.url, "http://fixture");
  if (url.pathname === "/api/never") return;
  if (url.pathname === "/api/late") {
    const body = { message: "late content ready", invoices: [{ number: "NF 1", amount: "R$ 1.234,56" }, { number: "NF 2", amount: "R$ 78,90" }] };
    return setTimeout(sendJson, LATE_MS, res, body);
  }
  if (url.pathname === "/api/search") {
    const message = `searched: "${url.searchParams.get("q")}" status: "${url.searchParams.get("status")}"`;
    return setTimeout(sendJson, SEARCH_MS, res, { message });
  }
  const page = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (!/^[a-z-]+\.html$/.test(page)) return res.writeHead(404).end("not found");
  try {
    const html = await readFile(new URL(`./fixture/${page}`, import.meta.url));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  } catch {
    res.writeHead(404, { "content-type": "text/html" }).end("<title>missing</title><main><h1>Not found</h1></main>");
  }
}

export function startFixtureServer(port = 0) {
  const server = createServer(handle);
  return new Promise((ok) => {
    server.listen(port, "127.0.0.1", () => {
      ok({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => { server.closeAllConnections(); server.close(); },
      });
    });
  });
}

if (import.meta.main) {
  const { url } = await startFixtureServer(Number(process.argv[2] ?? 0));
  console.log(`fixture at ${url}`);
}
