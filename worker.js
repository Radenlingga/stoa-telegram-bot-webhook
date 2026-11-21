// Stoa Quote Bot — webhook edition (Cloudflare Workers).
//
// Same bot as the long-polling Python version (~/workspace/stoa-bot):
// /quote and /check for Robinhood Chain tokens via Stoa's public API,
// swap links naming the builder as referrer.
//
// How it answers without a bot token: Telegram lets a webhook handler
// reply by returning the API call as the HTTP response body
// ({"method": "sendMessage", ...}). Telegram executes it on delivery.
// The bot token therefore never leaves the operator's server — it is
// only used there, once, to register this webhook (setWebhook) with a
// shared secret; Telegram then sends that secret in a header on every
// update and this worker checks it.
//
// Secrets/configuration (Worker environment):
//   WEBHOOK_SECRET — the shared secret registered with setWebhook.

const API_BASE = "https://stoadex.com/api/v1";
const SAFETY_BASE = "https://stoadex.com/api/safety";
const CHAIN = "robinhood";
const REFERRER = "0x893f754C451fe7Edf459eb24abEF473190101446";
const NATIVE = "native";
const DEFAULT_QUOTE_ETH = "0.1";
const UA = { "User-Agent": "stoa-telegram-bot/1.0 (+https://stoadex.com/build)" };

// ---------------------------------------------------------------- errors
class StoaError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- helpers
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toWei(amountHuman, decimals) {
  if (!/^\d+(\.\d+)?$/.test(amountHuman)) throw new Error("bad amount");
  const [whole, fracRaw = ""] = amountHuman.split(".");
  const frac = (fracRaw + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

function fromWei(amountWei, decimals) {
  let v = BigInt(amountWei);
  const sign = v < 0n ? "-" : "";
  if (v < 0n) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  const wholeS = whole.toLocaleString("en-US");
  if (frac === 0n) return sign + wholeS;
  const fracS = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${wholeS}.${fracS}`;
}

function trimAmt(amount) {
  if (!amount.includes(".")) return amount;
  let [whole, frac] = amount.split(".");
  frac = frac.replace(/0+$/, "");
  if (frac.length > 6) frac = frac.slice(0, 6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// ---------------------------------------------------------------- Stoa API
async function stoaGet(url) {
  let resp;
  try {
    resp = await fetch(url, { headers: UA });
  } catch (e) {
    throw new StoaError(`Stoa API unreachable: ${e.message}`);
  }
  const text = await resp.text();
  if (resp.status === 200) {
    try {
      return JSON.parse(text);
    } catch {
      throw new StoaError("Stoa API unreachable: bad JSON");
    }
  }
  let msg = `HTTP ${resp.status}`;
  try {
    const body = JSON.parse(text);
    msg = body.error || JSON.stringify(body);
  } catch { /* keep HTTP msg */ }
  throw new StoaError(String(msg), resp.status);
}

// In-isolate caches (best effort, same TTLs as the Python version).
let tokensCache = null; // {at, info}
const safetyCache = new Map(); // addr -> {at, data}

async function tokens() {
  const now = Date.now();
  if (tokensCache && now - tokensCache.at < 300_000) return tokensCache.info;
  try {
    const data = await stoaGet(`${API_BASE}/tokens?chain=${CHAIN}`);
    const info = (data.chains || []).find((c) => c.chain === CHAIN) || {};
    tokensCache = { at: now, info };
    return info;
  } catch (e) {
    if (tokensCache) return tokensCache.info; // a stale list beats no answer
    throw e;
  }
}

async function resolveToken(query) {
  const q = query.trim();
  if (q.toLowerCase() === "eth" || q.toLowerCase() === "native") {
    const info = await tokens();
    const native = info.native || {};
    return {
      address: NATIVE,
      symbol: native.symbol || "ETH",
      name: "Ether (native)",
      decimals: 18,
    };
  }
  if (q.startsWith("0x") && q.length === 42) {
    const info = await tokens();
    for (const tok of info.tokens || []) {
      if (tok.address.toLowerCase() === q.toLowerCase()) return { ...tok };
    }
    return { address: q, symbol: null, name: null, decimals: 18 };
  }
  const info = await tokens();
  const list = info.tokens || [];
  for (const tok of list) {
    if (tok.symbol.toLowerCase() === q.toLowerCase()) return { ...tok };
  }
  for (const tok of list) {
    if (
      (tok.name && tok.name.toLowerCase().includes(q.toLowerCase())) ||
      tok.symbol.toLowerCase().includes(q.toLowerCase())
    ) {
      return { ...tok };
    }
  }
  return null;
}

async function quote(sellToken, buyToken, amountWei) {
  const params = new URLSearchParams({
    chain: CHAIN,
    sellToken,
    buyToken,
    amount: amountWei.toString(),
    referrer: REFERRER,
  });
  return stoaGet(`${API_BASE}/quote?${params}`);
}

async function safety(tokenAddress) {
  const key = tokenAddress.toLowerCase();
  const now = Date.now();
  const cached = safetyCache.get(key);
  if (cached && now - cached.at < 60_000) return cached.data;
  const data = await stoaGet(`${SAFETY_BASE}/${CHAIN}/${tokenAddress}`);
  safetyCache.set(key, { at: now, data });
  return data;
}

function swapLink(sellToken, buyToken, amountHuman) {
  const params = new URLSearchParams({
    chain: CHAIN,
    sell: sellToken,
    buy: buyToken,
    ref: REFERRER,
  });
  if (amountHuman) params.set("amount", amountHuman);
  return `https://stoadex.com/trade?${params}`;
}

// ---------------------------------------------------------------- formats
function formatQuote(sell, buy, amountHuman, q) {
  const amountOut = trimAmt(fromWei(q.amountOut, buy.decimals ?? 18));
  const minOut = trimAmt(fromWei(q.minOut, buy.decimals ?? 18));
  const sellSym = sell.symbol || "ETH";
  const buySym = buy.symbol || "token";
  const inWei = BigInt(q.amountIn);
  const outWei = BigInt(q.amountOut);
  let unitPrice = "";
  if (inWei > 0n) {
    const rate =
      Number(outWei) / 10 ** (buy.decimals ?? 18) /
      (Number(inWei) / 10 ** (sell.decimals ?? 18));
    let rateS = rate.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
    const [w, f] = rateS.split(".");
    rateS = Number(w).toLocaleString("en-US") + (f ? "." + f : "");
    unitPrice = `\nRate: 1 ${esc(sellSym)} ≈ ${rateS} ${esc(buySym)}`;
  }
  const legs = (q.route && q.route.legs) || [];
  const venues = [...new Set(legs.map((l) => l.name || "venue"))].join(", ") || "—";
  const impact = q.priceImpactPct;
  const impactS =
    typeof impact === "number" ? `${Number(impact.toPrecision(4))}%` : "—";
  const link = swapLink(sell.address, buy.address, amountHuman);
  const text =
    `💱 <b>${esc(amountHuman)} ${esc(sellSym)} → ${esc(amountOut)} ${esc(buySym)}</b>\n` +
    `Min received: ${esc(minOut)} ${esc(buySym)} (0.5% slippage)${unitPrice}\n` +
    `Route: ${esc(venues)} · Price impact: ${esc(impactS)}\n` +
    `Quote valid ~${q.validForSeconds ?? 30}s — re-check before swapping.`;
  return [text, link];
}

const VERDICT_EMOJI = {
  ok: "✅",
  caution: "⚠️",
  warning: "⚠️",
  danger: "🚫",
  blocked: "🚫",
};

function formatCheck(s, fallbackSymbol) {
  const verdict = String(s.verdict ?? "unknown");
  const emoji = VERDICT_EMOJI[verdict.toLowerCase()] || "❔";
  const sym = s.symbol || fallbackSymbol || "token";
  const test = s.test || {};
  const lines = [
    `${emoji} <b>${esc(sym)} safety check — verdict: ${esc(verdict)}</b>`,
  ];
  if (s.token) lines.push(`<code>${esc(s.token)}</code>`);
  if (test.buyOk != null || test.sellOk != null) {
    lines.push(
      `Buy: ${test.buyOk ? "ok" : "FAILS"} · Sell: ${test.sellOk ? "ok" : "FAILS"}`
    );
  }
  if (test.buyTaxPct != null || test.sellTaxPct != null) {
    lines.push(`Taxes: buy ${test.buyTaxPct}%, sell ${test.sellTaxPct}%`);
  }
  if (test.roundTripPct != null) {
    lines.push(`Round trip (buy+sell): ${test.roundTripPct}%`);
  }
  if (s.creatorPct != null) {
    lines.push(`Creator holds: ${s.creatorPct}% of supply`);
  }
  if (s.top10Pct != null) {
    lines.push(`Top 10 holders: ${s.top10Pct}% of supply`);
  }
  if (test.why) lines.push(`Note: ${esc(test.why)}`);
  for (const note of s.notes || []) lines.push(`• ${esc(note)}`);
  lines.push("Source: Stoa token safety check (simulated buy/sell on-chain).");
  return lines.join("\n");
}

const HELP_TEXT =
  "<b>Stoa Quote Bot</b> — quotes &amp; safety checks for Robinhood Chain tokens, via Stoa.\n\n" +
  "<b>/quote &lt;token&gt; [amount]</b> — buy a token with ETH (default 0.1 ETH)\n" +
  "Examples:\n" +
  "• <code>/quote BULL</code>\n" +
  "• <code>/quote BULL 0.5</code> — buy with 0.5 ETH\n" +
  "• <code>/quote 0x3076…3eff</code> — by contract address\n" +
  "• <code>/quote BULL USDG 1000</code> — sell 1000 BULL for USDG\n\n" +
  "<b>/check &lt;token&gt;</b> — safety check (taxes, can it be sold, holder concentration)\n" +
  "Example: <code>/check BULL</code>\n\n" +
  "Every quote links to the swap on Stoa. Prices move fast — the quote is a snapshot.";

// ---------------------------------------------------------------- bot logic
// A reply is the Telegram API call returned as the webhook response.
function reply(chatId, text, button) {
  const payload = {
    method: "sendMessage",
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (button) {
    payload.reply_markup = {
      inline_keyboard: [[{ text: button[0], url: button[1] }]],
    };
  }
  return payload;
}

function stoaErrorReply(chatId, e) {
  let msg;
  if (e.status === 422) {
    msg = "No route for that swap right now (no liquidity or pair on Stoa's venues).";
  } else if (e.status === 429) {
    msg = "Stoa's API rate limit hit — try again in a few seconds.";
  } else if (e.status === 400) {
    msg = `Stoa rejected the request: ${esc(e.message)}`;
  } else {
    msg = "Stoa's API is briefly unavailable — try again in a moment.";
  }
  return reply(chatId, msg);
}

async function cmdQuote(chatId, args) {
  if (!args.length) {
    return reply(chatId, "Usage: <code>/quote &lt;token&gt; [amount]</code> — see /help");
  }
  try {
    let sell, buy, amountHuman;
    if (args.length >= 3) {
      sell = await resolveToken(args[0]);
      buy = await resolveToken(args[1]);
      amountHuman = args[2];
      if (!sell || !buy) {
        const bad = !sell ? args[0] : args[1];
        return reply(chatId, `Unknown token: ${esc(bad)}. Try a symbol from Stoa's list or a contract address.`);
      }
    } else {
      buy = await resolveToken(args[0]);
      if (!buy) {
        return reply(chatId, `Unknown token: ${esc(args[0])}. Try a symbol from Stoa's list or a contract address.`);
      }
      sell = await resolveToken("native");
      amountHuman = args.length === 2 ? args[1] : DEFAULT_QUOTE_ETH;
    }
    let amountWei;
    try {
      amountWei = toWei(amountHuman, sell.decimals ?? 18);
    } catch {
      return reply(chatId, "That amount doesn't parse — use something like 0.1 or 250.");
    }
    if (amountWei <= 0n) return reply(chatId, "Amount must be more than zero.");
    const q = await quote(sell.address, buy.address, amountWei);
    if (!buy.symbol) {
      buy.symbol = buy.address !== NATIVE ? (await safety(buy.address)).symbol : "ETH";
    }
    if (!sell.symbol) {
      sell.symbol = sell.address !== NATIVE ? (await safety(sell.address)).symbol : "ETH";
    }
    const [text, link] = formatQuote(sell, buy, amountHuman, q);
    return reply(chatId, text, ["🔀 Swap on Stoa", link]);
  } catch (e) {
    if (e instanceof StoaError) return stoaErrorReply(chatId, e);
    throw e;
  }
}

async function cmdCheck(chatId, args) {
  if (!args.length) {
    return reply(chatId, "Usage: <code>/check &lt;token&gt;</code> — see /help");
  }
  try {
    const tok = await resolveToken(args[0]);
    if (!tok) {
      return reply(chatId, `Unknown token: ${esc(args[0])}. Try a symbol from Stoa's list or a contract address.`);
    }
    if (tok.address === NATIVE) {
      return reply(chatId, "ETH is the native gas token — nothing to check. Try a token symbol or contract address.");
    }
    const s = await safety(tok.address);
    return reply(chatId, formatCheck(s, tok.symbol));
  } catch (e) {
    if (e instanceof StoaError) return stoaErrorReply(chatId, e);
    throw e;
  }
}

const chatLast = new Map(); // best-effort per-chat throttle (1.5 s)

async function handleMessage(msg) {
  const text = (msg.text || "").trim();
  const chatId = msg.chat && msg.chat.id;
  if (chatId == null || !text.startsWith("/")) return null;
  const now = Date.now();
  if (now - (chatLast.get(chatId) || 0) < 1500) return null;
  chatLast.set(chatId, now);
  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();
  const args = parts.slice(1);
  try {
    if (cmd === "/start" || cmd === "/help") return reply(chatId, HELP_TEXT);
    if (cmd === "/quote") return await cmdQuote(chatId, args);
    if (cmd === "/check") return await cmdCheck(chatId, args);
    return null; // unknown commands are ignored quietly (busy groups)
  } catch {
    return reply(chatId, "Something glitched on my side — try again in a moment.");
  }
}

// ---------------------------------------------------------------- worker
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Stoa Quote Bot (webhook edition) — alive.", {
        headers: { "Content-Type": "text/plain" },
      });
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("not found", { status: 404 });
    }
    if (env.WEBHOOK_SECRET) {
      const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (got !== env.WEBHOOK_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const msg = update.message || update.edited_message;
    if (!msg) return new Response("ok");
    const payload = await handleMessage(msg);
    if (!payload) return new Response("ok");
    return new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
