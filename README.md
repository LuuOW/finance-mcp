# finance-mcp

Personal finance MCP that runs on Cloudflare Workers. Single-tenant.
Passkey-bootstrapped: you register a passkey *once* via a one-time admin link,
and from then on adding the connector to Grok / Claude.ai / ChatGPT is just
OAuth + a passkey tap.

Live at **https://money.ask-meridian.uk**.

The chat-side LLM never sees a key — bearer tokens are short-lived OAuth
artifacts, the actual Binance API key + Mercado Pago CVU + Coinbase address
all live in worker secrets.

## Why this design

The chat-side LLM cannot ever invoke a passkey. So the trust boundary has to
be a browser session you control. The flow:

1. **Admin (you, once)** — POST to `/admin/create-registration-link` with a
   secret header. Returns a one-time URL valid for 1 hour.
2. **You** — open the URL once on the device that owns the passkey. Browser
   prompts for biometric. After registration the URL self-destructs (deleted
   from KV).
3. **Connector setup (Grok / ChatGPT / Claude)** — paste the `/mcp` URL.
   Connector redirects to `/authorize`. You see a single page asking for a
   passkey tap.
4. **Daily use** — Grok holds the bearer; you just chat. No further passkey
   taps.

After step 2, no part of step 3+ ever asks you for a password or fresh
registration.

## Tools

Eight tools shipped today, all backed by signed Binance USD-M / Spot calls
through the [binance-proxy](https://github.com/LuuOW/binance-proxy) Fly
sidecar (so the call egresses from a Bright Data static residential IP that
Binance has whitelisted on the API key).

| Tool | Pattern | What it does |
|---|---|---|
| `get_balances` | read | Spot wallet — USDC, ARS, and any other non-zero asset |
| `prepare_convert` | quote | Convert one asset to another inside Binance (e.g. USDC→ARS). Returns `quote_id`, rate, receive amount. Quote expires in ~10s. |
| `confirm_convert` | execute | Execute a previously-prepared convert. Counts against the daily cap. |
| `prepare_withdraw_usdc` | quote | Quote a USDC withdrawal to your saved Coinbase wallet (Ethereum mainnet). Returns network fee + ETA. |
| `confirm_withdraw_usdc` | execute | Execute the prepared USDC withdrawal. Counts against the daily cap. |
| `prepare_withdraw_ars` | quote | Quote an ARS withdrawal to your saved Mercado Pago CVU. Returns Binance's fiat fee. |
| `confirm_withdraw_ars` | execute | Execute the prepared ARS withdrawal. Counts against the daily cap. |
| `list_recent_transfers` | read | Last 50 confirmed transfers from the audit log — "what did I move this week?" |

Every write is **prepare → confirm** so the LLM has to plan an action,
present the numbers, and only execute on a second tool call. Confirms
increment a daily out-of-pocket counter; once it hits `MAX_DAILY_OUT_USD`,
further confirms refuse until the next UTC day. All confirms also append to
the KV audit log used by `list_recent_transfers`.

Destinations are **allowlisted** at deploy time (one Coinbase address, one
MP CVU). The LLM cannot withdraw to an arbitrary address — only the saved
ones. Adding new destinations is a worker-secret rotation, not a tool call.

## Endpoints

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET  | `/` | status (counts passkeys) | public |
| POST | `/admin/create-registration-link` | mint one-time URL | `X-Admin-Secret` |
| GET  | `/register/:token` | passkey registration page | one-time link |
| POST | `/register/:token/options` | WebAuthn registration options | one-time link |
| POST | `/register/:token/verify` | verify + store passkey, **destroy link** | one-time link |
| GET  | `/authorize` | OAuth start (renders passkey login) | client_id |
| POST | `/login/options`, `/login/verify` | WebAuthn auth step | challenge key |
| GET  | `/authorize/complete` | issues OAuth code, redirects | passed login |
| POST | `/token` | code → bearer (PKCE) | OAuth client |
| POST | `/mcp` | MCP JSON-RPC | Bearer |

## Deploy

```bash
# 1. Install deps
npm install

# 2. Create a KV namespace
npx wrangler kv namespace create VAULT_KV
npx wrangler kv namespace create VAULT_KV --preview
# Paste both ids into wrangler.toml

# 3. Set the public origin / RP_ID in wrangler.toml [vars] to your subdomain.

# 4. Set secrets — auth + Binance + destinations
npx wrangler secret put ADMIN_SECRET            # pick a long random string
npx wrangler secret put USER_ID                 # e.g. "lucas"
npx wrangler secret put OAUTH_CLIENT_ID         # arbitrary, e.g. "grok"
npx wrangler secret put BINANCE_API_KEY         # Binance API key (whitelist BD egress IP)
npx wrangler secret put BINANCE_API_SECRET      # Binance API secret
npx wrangler secret put DEST_COINBASE_USDC      # your saved Coinbase USDC address
npx wrangler secret put DEST_MERCADOPAGO_CVU    # your saved MP CVU
npx wrangler secret put MAX_DAILY_OUT_USD       # daily cap, e.g. "500"
npx wrangler secret put BINANCE_PROXY_URL       # https://your-proxy.fly.dev
npx wrangler secret put BINANCE_PROXY_SECRET    # shared secret with the proxy

# 5. Deploy
npx wrangler deploy
```

Add a route or DNS record so `your-subdomain.tld` points at the worker.

## Bootstrap your first passkey

```bash
ADMIN_SECRET="<the secret you set>"
ORIGIN="https://your-subdomain.tld"

curl -sX POST -H "X-Admin-Secret: $ADMIN_SECRET" \
  $ORIGIN/admin/create-registration-link
# → { "url": "https://your-subdomain.tld/register/<token>", "expires_in": 3600 }
```

Open the URL once on the device with the passkey (Mac / iPhone / Android /
hardware key). Click *Register passkey*, do the biometric. The URL is now
dead.

## Connect to Grok / Claude / ChatGPT

Paste these in the connector setup dialog:

| Field | Value |
|---|---|
| Server URL | `https://your-subdomain.tld/mcp` |
| Authorization endpoint | `https://your-subdomain.tld/authorize` |
| Token endpoint | `https://your-subdomain.tld/token` |
| Client ID | whatever you set as `OAUTH_CLIENT_ID` |
| Client secret | (empty) |
| Token auth method | `none` (PKCE only) |
| Scopes | `read` |

Click *Authorize*. The page shows a *Sign in with passkey* button. Tap it,
biometric, done. Grok now has a bearer token; you never see this flow again.

## Architecture notes

The Binance calls don't reach Binance directly from the worker. Cloudflare
edge IPs are geo-blocked from `api.binance.com` for AR-resolved requests,
and even where they aren't, every CF edge has a different IP — Binance's
"whitelist this IP for this API key" model needs a *single* fixed IP. So
the worker forwards signed requests to a tiny Node sidecar on Fly
(`binance-proxy`) which CONNECT-tunnels them through Bright Data's static
residential proxy. The Binance API key whitelists that one BD egress IP
forever.

The worker still does the HMAC-SHA256 signing itself (Web Crypto in
Workers) — the proxy is a transport, not a credential holder. The proxy
also strips `Fly-*` and `X-Forwarded-*` headers before forwarding so
Binance's CloudFront doesn't see them and 403.

A long-form walkthrough of the architecture is at
[ask-meridian.uk/blog/finance-mcp-binance-fly-bright-data](https://ask-meridian.uk/blog/finance-mcp-binance-fly-bright-data/).

## Adding a new tool

`src/tools.ts` has the `TOOLS` array (the schemas) and a `callTool` switch
that dispatches by name. Adding a tool is:

1. Append a new entry to `TOOLS` with name + description + JSON schema.
2. Add a `case "your_tool":` branch in the `callTool` switch.
3. Implement the handler — it gets the `BinanceClient` already wired
   through the proxy.

Write tools should follow the **prepare → confirm** pattern — the LLM
plans, you (or a downstream check) confirm, the daily cap kills runaway
calls.

## Threat model summary

This design accepts that a leaked OAuth token = up to `MAX_DAILY_OUT_USD`
of damage before the daily cap kills further transfers and you notice the
audit-log entries. That's the tradeoff for a frictionless chat experience.

What's mitigated:
- **No arbitrary destinations.** Withdrawals only go to the two pre-saved
  addresses (Coinbase USDC + MP CVU). Changing destination = worker secret
  rotation, not a tool call.
- **Daily cap.** Hard ceiling on USD-equivalent moved per UTC day.
- **Audit log.** Every confirm appends to KV; `list_recent_transfers`
  surfaces it. You see anomalies the next time you query balances.
- **Single-tenant.** One `USER_ID`, one passkey. Bootstrap registration is
  refused after the first passkey is bound.

What isn't:
- The bearer is valid for 1 hour without re-auth. Higher-value transfers
  should be implemented as separate tools that *do* require a per-call
  passkey link (similar to the bootstrap flow), reusing the WebAuthn
  machinery already here. Not built yet — daily cap is the load-bearing
  control today.

## Source

- This worker — `src/`
- Sidecar — [github.com/LuuOW/binance-proxy](https://github.com/LuuOW/binance-proxy)
- Architecture writeup — [ask-meridian.uk/blog/finance-mcp-binance-fly-bright-data](https://ask-meridian.uk/blog/finance-mcp-binance-fly-bright-data/)
