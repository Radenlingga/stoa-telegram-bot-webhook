// Local logic test for worker.js — stubs the Stoa API with recorded
// real payloads and feeds synthetic Telegram updates to the worker's
// fetch handler. Run: node test.mjs
import { readFileSync } from "node:fs";
import worker from "./worker.js";

const secret = readFileSync(
  new URL("./webhook-secret.txt", import.meta.url),
  "utf8"
).trim();
const tokensCache = JSON.parse(
  readFileSync("/home/hatch/workspace/stoa-bot/tokens-cache.json", "utf8")
);
const quoteBull = JSON.parse(
  readFileSync(new URL("./fixture-quote-bull.json", import.meta.url), "utf8")
);
const safetyBull = JSON.parse(
  readFileSync(new URL("./fixture-safety-bull.json", import.meta.url), "utf8")
);

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (obj) =>
    new Response(JSON.stringify(obj), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  if (u.includes("/api/v1/tokens")) return json({ chains: [tokensCache.chain_info] });
  if (u.includes("/api/v1/quote")) return json(quoteBull);
  if (u.includes("/api/safety/")) return json(safetyBull);
  throw new Error("unexpected fetch: " + u);
};

const env = { WEBHOOK_SECRET: secret };
async function post(update, withSecret = true) {
  const headers = { "Content-Type": "application/json" };
  if (withSecret) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  const req = new Request("https://example.workers.dev/webhook", {
    method: "POST",
    headers,
    body: JSON.stringify(update),
  });
  return worker.fetch(req, env);
}
let chatSeq = 1000;
const msg = (text) => ({
  update_id: 1,
  // unique chat per message: the bot throttles one chat to one command
  // per 1.5 s (same as the Python version), which would eat later tests
  message: { message_id: 1, chat: { id: chatSeq++, type: "group" }, text },
});

let pass = 0,
  fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log("PASS", name);
  } else {
    fail++;
    console.log("FAIL", name, extra);
  }
}

// 1. wrong secret -> 401
let r = await post(msg("/help"), false);
check("rejects missing secret", r.status === 401, "status " + r.status);

// 2. /quote BULL -> quote text + swap button with referrer
r = await post(msg("/quote BULL"));
let body = JSON.parse(await r.text());
check("quote method", body.method === "sendMessage");
check("quote chat set", typeof body.chat_id === "number");
check(
  "quote text shape",
  body.text.includes("0.1 ETH →") && body.text.includes("BULL") &&
    body.text.includes("Min received:") && body.text.includes("Route:"),
  body.text
);
const btn = body.reply_markup?.inline_keyboard?.[0]?.[0];
check("quote button label", btn?.text === "🔀 Swap on Stoa", JSON.stringify(btn));
check(
  "quote button link",
  !!btn && btn.url.startsWith("https://stoadex.com/trade?") &&
    btn.url.includes("ref=0x893f754C451fe7Edf459eb24abEF473190101446") &&
    btn.url.includes("amount=0.1"),
  btn?.url
);

// 3. /check BULL -> safety text
r = await post(msg("/check BULL"));
body = JSON.parse(await r.text());
check(
  "check text shape",
  body.text.includes("BULL safety check — verdict: ok") &&
    body.text.includes("Buy: ok · Sell: ok"),
  body.text
);

// 4. unknown token
r = await post(msg("/quote NOPE123"));
body = JSON.parse(await r.text());
check("unknown token", body.text.startsWith("Unknown token: NOPE123"), body.text);

// 5. /help
r = await post(msg("/help"));
body = JSON.parse(await r.text());
check("help text", body.text.includes("Stoa Quote Bot") && body.text.includes("/quote"));

// 6. bad amount
r = await post(msg("/quote BULL abc"));
body = JSON.parse(await r.text());
check("bad amount", body.text.includes("doesn't parse"), body.text);

// 7. non-command message -> plain ok, no payload
r = await post(msg("hello group"));
check("non-command ignored", (await r.text()) === "ok");

// 8. /check native -> explanatory reply
r = await post(msg("/check ETH"));
body = JSON.parse(await r.text());
check("check native", body.text.includes("native gas token"), body.text);

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
