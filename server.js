// Portable Node host for the Stoa Quote Bot webhook edition.
//
// worker.js is written for fetch-handler platforms (Cloudflare
// Workers). This adapter runs the exact same handler on any plain
// Node host (Altare Apps, a VPS, ...): it converts each HTTP request
// to a fetch Request, calls the worker, and writes the response back.
//
// Environment: PORT (default 8080), WEBHOOK_SECRET (same value that
// is registered with Telegram's setWebhook).
import http from "node:http";
import worker from "./worker.js";

const port = Number(process.env.PORT || 8080);
const env = { WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "" };

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = `http://${req.headers.host || "localhost"}${req.url}`;
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    const response = await worker.fetch(request, env);
    const out = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, {
      "Content-Type": response.headers.get("Content-Type") || "text/plain",
    });
    res.end(out);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("internal error");
  }
});

server.listen(port, () => {
  console.log(`stoa-quote-bot webhook listening on :${port}`);
});
