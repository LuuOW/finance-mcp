// finance-mcp — main router
//
// Bootstrap flow:
//   1. Admin: POST /admin/create-registration-link  → one-time URL
//   2. User opens URL once → registers passkey → URL self-destructs
//   3. Add connector to Grok → OAuth via /authorize → passkey login → bearer issued
//   4. Grok calls /mcp with bearer; tools run

import {
  type Env,
  getRegLink,
  consumeRegLink,
  createRegLink,
  listPasskeys,
  randomToken,
  getOAuthToken,
} from "./storage"
import {
  registrationOptions,
  verifyRegistration,
  authenticationOptions,
  verifyAuthentication,
} from "./webauthn"
import {
  parseAuthorizeQuery,
  issueAuthorizationCode,
  exchangeCodeForToken,
} from "./auth"
import { registrationPage, loginPage, statusPage } from "./pages"
import { TOOLS, callTool } from "./tools"

// Pending /authorize requests, keyed by challengeKey, awaiting passkey login.
// Stored in KV so the popup → callback survives across requests.
async function savePendingAuthorize(env: Env, key: string, query: URLSearchParams) {
  await env.VAULT_KV.put(`pending-auth:${key}`, query.toString(), { expirationTtl: 300 })
}
async function consumePendingAuthorize(env: Env, key: string): Promise<URLSearchParams | null> {
  const raw = await env.VAULT_KV.get(`pending-auth:${key}`)
  if (!raw) return null
  await env.VAULT_KV.delete(`pending-auth:${key}`)
  return new URLSearchParams(raw)
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const p = url.pathname

    try {
      // ── CORS preflight ─────────────────────────────────────────
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() })
      }

      // ── OAuth 2.0 Authorization Server Metadata (RFC 8414) ─────
      // Grok / Claude.ai / ChatGPT introspect this to discover endpoints.
      if (p === "/.well-known/oauth-authorization-server" && req.method === "GET") {
        return jsonCors({
          issuer: env.ORIGIN,
          authorization_endpoint: `${env.ORIGIN}/authorize`,
          token_endpoint: `${env.ORIGIN}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["read"],
        })
      }

      // ── OAuth 2.0 Protected Resource Metadata (RFC 9728) ───────
      if (p === "/.well-known/oauth-protected-resource" && req.method === "GET") {
        return jsonCors({
          resource: `${env.ORIGIN}/mcp`,
          authorization_servers: [env.ORIGIN],
          scopes_supported: ["read"],
          bearer_methods_supported: ["header"],
        })
      }

      // ── Status / root ──────────────────────────────────────────
      if (p === "/" && req.method === "GET") {
        const passkeys = await listPasskeys(env, env.USER_ID)
        return html(statusPage({ passkeysRegistered: passkeys.length }))
      }

      // ── Admin: create one-time registration link ───────────────
      if (p === "/admin/create-registration-link" && req.method === "POST") {
        if (req.headers.get("x-admin-secret") !== env.ADMIN_SECRET) {
          return new Response("forbidden", { status: 403 })
        }
        const token = await createRegLink(env, env.USER_ID)
        return Response.json({
          url: `${env.ORIGIN}/register/${token}`,
          expires_in: 3600,
        })
      }

      // ── Registration: GET page ─────────────────────────────────
      const regMatch = p.match(/^\/register\/([A-Za-z0-9_-]+)$/)
      if (regMatch && req.method === "GET") {
        const token = regMatch[1]
        const link = await getRegLink(env, token)
        if (!link || link.used || link.expires_at < Date.now()) {
          return new Response("link expired or already used", { status: 410 })
        }
        return html(registrationPage(token))
      }

      // ── Registration: POST options ─────────────────────────────
      const regOptsMatch = p.match(/^\/register\/([A-Za-z0-9_-]+)\/options$/)
      if (regOptsMatch && req.method === "POST") {
        const token = regOptsMatch[1]
        const link = await getRegLink(env, token)
        if (!link || link.used) return new Response("link expired", { status: 410 })
        const opts = await registrationOptions(env, env.USER_ID, token)
        return Response.json(opts)
      }

      // ── Registration: POST verify ──────────────────────────────
      const regVerifyMatch = p.match(/^\/register\/([A-Za-z0-9_-]+)\/verify$/)
      if (regVerifyMatch && req.method === "POST") {
        const token = regVerifyMatch[1]
        const link = await getRegLink(env, token)
        if (!link || link.used) return new Response("link expired", { status: 410 })
        const body = await req.json()
        const result = await verifyRegistration(env, env.USER_ID, token, body as never)
        if (result.ok) {
          // Self-destruct the link
          await consumeRegLink(env, token)
        }
        return Response.json(result)
      }

      // ── OAuth /authorize ───────────────────────────────────────
      if (p === "/authorize" && req.method === "GET") {
        const parsed = parseAuthorizeQuery(url)
        if ("error" in parsed) return new Response(parsed.error, { status: 400 })
        if (parsed.client_id !== env.OAUTH_CLIENT_ID) {
          return new Response("unknown client_id", { status: 400 })
        }
        const passkeys = await listPasskeys(env, env.USER_ID)
        if (passkeys.length === 0) {
          return new Response(
            "no passkey registered. Generate a registration link first.",
            { status: 412 },
          )
        }
        // Stash the request and render the login page; user authenticates via passkey,
        // then /login/verify completes the auth and redirects.
        const challengeKey = randomToken(16)
        await savePendingAuthorize(env, challengeKey, url.searchParams)
        const callbackUrl = `/authorize/complete?key=${challengeKey}`
        return html(loginPage(callbackUrl, challengeKey))
      }

      // /login/options + /login/verify are the WebAuthn step on the login page.
      if (p === "/login/options" && req.method === "POST") {
        const key = url.searchParams.get("key") ?? ""
        if (!key) return new Response("missing key", { status: 400 })
        const opts = await authenticationOptions(env, env.USER_ID, key)
        return Response.json(opts)
      }

      if (p === "/login/verify" && req.method === "POST") {
        const key = url.searchParams.get("key") ?? ""
        if (!key) return new Response("missing key", { status: 400 })
        const body = await req.json()
        const result = await verifyAuthentication(env, env.USER_ID, key, body as never)
        if (!result.ok) return Response.json(result, { status: 401 })
        // Mark this challengeKey as authenticated so /authorize/complete will issue the code.
        await env.VAULT_KV.put(`login-pass:${key}`, "1", { expirationTtl: 60 })
        return Response.json({ ok: true })
      }

      // /authorize/complete: called by browser after successful passkey login.
      // Issues the OAuth code and 302's to redirect_uri with ?code=&state=
      if (p === "/authorize/complete" && req.method === "GET") {
        const key = url.searchParams.get("key") ?? ""
        const passed = await env.VAULT_KV.get(`login-pass:${key}`)
        if (!passed) return new Response("login required", { status: 401 })
        await env.VAULT_KV.delete(`login-pass:${key}`)
        const params = await consumePendingAuthorize(env, key)
        if (!params) return new Response("expired", { status: 410 })
        const queryUrl = new URL("http://x/?" + params.toString())
        const parsed = parseAuthorizeQuery(queryUrl)
        if ("error" in parsed) return new Response(parsed.error, { status: 400 })
        const code = await issueAuthorizationCode(env, parsed)
        const redirect = new URL(parsed.redirect_uri)
        redirect.searchParams.set("code", code)
        redirect.searchParams.set("state", parsed.state)
        return Response.redirect(redirect.toString(), 302)
      }

      // ── OAuth /token ───────────────────────────────────────────
      if (p === "/token" && req.method === "POST") {
        const body = new URLSearchParams(await req.text())
        return exchangeCodeForToken(env, body)
      }

      // ── MCP endpoint (bearer-protected) ────────────────────────
      if (p === "/mcp" && (req.method === "POST" || req.method === "GET")) {
        const auth = req.headers.get("authorization") ?? ""
        const m = auth.match(/^Bearer\s+(.+)$/i)
        if (!m) return new Response("unauthorized", { status: 401 })
        const tok = await getOAuthToken(env, m[1])
        if (!tok) return new Response("unauthorized", { status: 401 })

        // Minimal placeholder: respond to MCP initialize + tools/list.
        // Real finance tools are added later, behind this same bearer check.
        if (req.method === "POST") {
          const rpc = (await req.json()) as { jsonrpc: string; id: number | string; method: string }
          if (rpc.method === "initialize") {
            return Response.json({
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                protocolVersion: "2024-11-05",
                serverInfo: { name: "finance-mcp", version: "0.1.0" },
                capabilities: { tools: {} },
              },
            })
          }
          if (rpc.method === "tools/list") {
            return Response.json({
              jsonrpc: "2.0",
              id: rpc.id,
              result: { tools: TOOLS },
            })
          }
          if (rpc.method === "tools/call") {
            const params = (rpc as unknown as {
              params: { name: string; arguments?: Record<string, unknown> }
            }).params
            try {
              const out = await callTool(env as Parameters<typeof callTool>[0], params.name, params.arguments ?? {})
              return Response.json({
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
                  isError: false,
                },
              })
            } catch (e) {
              return Response.json({
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  content: [{ type: "text", text: `error: ${(e as Error).message}` }],
                  isError: true,
                },
              })
            }
          }
          if (rpc.method === "notifications/initialized") {
            return new Response(null, { status: 204 })
          }
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -32601, message: `method ${rpc.method} not implemented` },
          })
        }
        return new Response("ok", { status: 200 })
      }

      return new Response("not found", { status: 404 })
    } catch (e) {
      console.error(e)
      return new Response("internal error: " + (e as Error).message, { status: 500 })
    }
  },
}

function html(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } })
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
  }
}

function jsonCors(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...corsHeaders(),
    },
  })
}
