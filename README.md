# Stoa Quote Bot — webhook edition

The always-on edition of [@Stoatrade_bot](https://t.me/Stoatrade_bot):
`/quote` and `/check` for Robinhood Chain tokens via
[Stoa](https://stoadex.com)'s public API, running as a single
Cloudflare Worker.

## Why a webhook edition

The original bot (Python, long polling) has to stay running 24/7 on a
server; whenever that process dies, the bot is silent until restarted.
This edition has no process at all: Telegram delivers each message to
the Worker's webhook URL, the Worker wakes just long enough to answer,
then sleeps again. Nothing to keep alive.

## How it answers without holding the bot token

Telegram lets a webhook handler reply by returning the API call as the
HTTP response body (`{"method": "sendMessage", ...}`), and Telegram
executes it on delivery. So the Worker needs no bot token. The token
stays on the operator's server and is used exactly once — to call
`setWebhook` with a shared `secret_token`. Telegram then sends that
secret in a header on every update and the Worker checks it.

## Commands

- `/quote <token> [amount]` — buy a token with ETH (default 0.1 ETH)
- `/quote <sellToken> <buyToken> <amount>` — any pair
- `/check <token>` — safety check (taxes, can it be sold, holders)
- `/help` — usage

Every quote carries a button to the pre-filled swap on Stoa naming the
builder's address as referrer, per Stoa's referral docs.

## Files

- `worker.js` — the whole bot (Stoa client, formatting, webhook handler)
- `wrangler.toml` — Worker config (`stoa-quote-bot`)
- `test.mjs` — local logic test with recorded API payloads
  (`node test.mjs`; the reply texts are byte-identical to the Python
  edition's for the same fixtures)

## Deploy

1. Create the Worker (`stoa-quote-bot`) in the Cloudflare dashboard and
   paste `worker.js`, or run `wrangler deploy`.
2. Set the Worker variable `WEBHOOK_SECRET` to a long random value.
3. From any machine holding the bot token, register the webhook:
   `setWebhook` with `url=https://<worker>/webhook` and
   `secret_token=<the same WEBHOOK_SECRET>`, then `setMyCommands` as
   in the original bot.
4. Send `/quote BULL` in the group — the bot answers.

MIT — community project, not affiliated with Stoa.
