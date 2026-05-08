// OAuth 2.1 + PKCE handler.
// /authorize — kicks off flow, requires passkey login on the same page
// /token     — exchanges code for bearer token (verifies PKCE)

import {
  type Env,
  saveOAuthCode,
  consumeOAuthCode,
  saveOAuthToken,
  randomToken,
  base64urlEncode,
} from "./storage"

export interface AuthorizeQuery {
  response_type: string
  client_id: string
  redirect_uri: string
  state: string
  code_challenge: string
  code_challenge_method: string
  scope?: string
}

export function parseAuthorizeQuery(url: URL): AuthorizeQuery | { error: string } {
  const q = url.searchParams
  const required = [
    "response_type",
    "client_id",
    "redirect_uri",
    "state",
    "code_challenge",
    "code_challenge_method",
  ]
  for (const k of required) {
    if (!q.get(k)) return { error: `missing ${k}` }
  }
  if (q.get("response_type") !== "code") return { error: "response_type must be code" }
  if (q.get("code_challenge_method") !== "S256") return { error: "PKCE S256 required" }
  return {
    response_type: q.get("response_type")!,
    client_id: q.get("client_id")!,
    redirect_uri: q.get("redirect_uri")!,
    state: q.get("state")!,
    code_challenge: q.get("code_challenge")!,
    code_challenge_method: q.get("code_challenge_method")!,
    scope: q.get("scope") ?? undefined,
  }
}

export async function issueAuthorizationCode(
  env: Env,
  query: AuthorizeQuery,
): Promise<string> {
  const code = randomToken(32)
  await saveOAuthCode(env, code, {
    user_id: env.USER_ID,
    code_challenge: query.code_challenge,
    code_challenge_method: query.code_challenge_method,
    redirect_uri: query.redirect_uri,
    scopes: (query.scope ?? "read").split(/\s+/).filter(Boolean),
    expires_at: Date.now() + 60_000,
  })
  return code
}

// ─── /token — code → bearer ─────────────────────────────────────────
export async function exchangeCodeForToken(
  env: Env,
  body: URLSearchParams,
): Promise<Response> {
  const grant = body.get("grant_type")
  if (grant !== "authorization_code") {
    return jsonError(400, "unsupported_grant_type", "expected authorization_code")
  }
  const code = body.get("code") ?? ""
  const codeVerifier = body.get("code_verifier") ?? ""
  const redirectUri = body.get("redirect_uri") ?? ""
  const clientId = body.get("client_id") ?? ""

  const rec = await consumeOAuthCode(env, code)
  if (!rec) return jsonError(400, "invalid_grant", "code unknown or used")
  if (rec.expires_at < Date.now()) return jsonError(400, "invalid_grant", "code expired")
  if (rec.redirect_uri !== redirectUri) {
    return jsonError(400, "invalid_grant", "redirect_uri mismatch")
  }
  if (clientId !== env.OAUTH_CLIENT_ID) {
    return jsonError(400, "invalid_client", "unknown client_id")
  }

  // Verify PKCE
  const computed = await sha256B64Url(codeVerifier)
  if (computed !== rec.code_challenge) {
    return jsonError(400, "invalid_grant", "PKCE verifier mismatch")
  }

  const token = randomToken(48)
  await saveOAuthToken(env, token, {
    user_id: rec.user_id,
    scopes: rec.scopes,
    issued_at: Date.now(),
  })

  return new Response(
    JSON.stringify({
      access_token: token,
      token_type: "bearer",
      scope: rec.scopes.join(" "),
      expires_in: 60 * 60 * 24 * 90,
    }),
    {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    },
  )
}

async function sha256B64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest("SHA-256", data)
  return base64urlEncode(new Uint8Array(hash))
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      },
    },
  )
}
