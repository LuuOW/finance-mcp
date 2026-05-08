# finance-mcp

Personal finance MCP that runs on Cloudflare Workers. Single-tenant. Passkey-bootstrapped:
you register a passkey *once* via a one-time admin link, and from then on adding the
connector to Grok / Claude.ai / ChatGPT is just OAuth + a passkey tap.

This repo currently ships **only the auth bootstrap and OAuth scaffolding** — the actual
finance tools (`get_balances`, `prepare_withdraw_usdc`, etc.) are added later.

## Why this design

The chat-side LLM cannot ever invoke a passkey. So the trust boundary has to be a
browser session you control. The flow:

1. **Admin (you, once)** — POST to `/admin/create-registration-link` with a secret header.
   Returns a one-time URL valid for 1 hour.
2. **You** — open the URL once on the device that owns the passkey. Browser prompts
   for biometric. After registration the URL self-destructs (deleted from KV).
3. **Connector setup (Grok / ChatGPT / Claude)** — paste the `/mcp` URL. Connector
   redirects to `/authorize`. You see a single page asking for a passkey tap.
4. **Daily use** — Grok holds the bearer; you just chat. No further passkey taps.

After step 2, no part of step 3+ ever asks you for a password or fresh registration.

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

# 4. Set secrets
npx wrangler secret put ADMIN_SECRET     # pick a long random string
npx wrangler secret put USER_ID          # e.g. "lucas"
npx wrangler secret put OAUTH_CLIENT_ID  # arbitrary, e.g. "grok"

# 5. Deploy
npx wrangler deploy
```

Add a route or DNS record so `vault.your-domain.tld` points at the worker.

## Bootstrap your first passkey

```bash
ADMIN_SECRET="<the secret you set>"
ORIGIN="https://vault.your-domain.tld"

curl -sX POST -H "X-Admin-Secret: $ADMIN_SECRET" \
  $ORIGIN/admin/create-registration-link
# → { "url": "https://vault.your-domain.tld/register/<token>", "expires_in": 3600 }
```

Open the URL once on the device with the passkey (Mac / iPhone / Android / hardware key).
Click *Register passkey*, do the biometric. The URL is now dead.

## Connect to Grok / Claude / ChatGPT

Paste these in the connector setup dialog:

| Field | Value |
|---|---|
| Server URL | `https://vault.your-domain.tld/mcp` |
| Authorization endpoint | `https://vault.your-domain.tld/authorize` |
| Token endpoint | `https://vault.your-domain.tld/token` |
| Client ID | whatever you set as `OAUTH_CLIENT_ID` |
| Client secret | (empty) |
| Token auth method | `none` (PKCE only) |
| Scopes | `read` |

Click *Authorize*. The page shows a *Sign in with passkey* button. Tap it, biometric,
done. Grok now has a bearer token; you never see this flow again.

## Adding finance tools

Edit `src/index.ts` — the `/mcp` handler currently returns `{tools: []}`. Add a
`tools/call` branch that dispatches to handlers in a new `src/tools/*.ts`. Each
write tool should:

1. Check the bearer scopes,
2. Read the daily-cap counter from KV,
3. Refuse if cap exceeded,
4. Execute the Binance API call signed with `BINANCE_API_KEY` / `BINANCE_API_SECRET`
   (set as worker secrets),
5. Increment the daily counter,
6. Send a notification email (Cloudflare Email Routing or external).

Hard caps + allowlist destinations + email log are the load-bearing security in this
no-per-tx-passkey model.

## Threat model summary

This design accepts that a leaked OAuth token = up to `MAX_DAILY_OUT` of damage
before the daily cap kills further transfers and you notice the email. That's the
tradeoff for a frictionless chat experience. Higher-value transfers should be
implemented as separate tools that *do* require a per-call passkey link (similar
to the bootstrap flow), reusing the WebAuthn machinery here.
