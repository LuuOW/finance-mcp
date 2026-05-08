// KV-backed storage primitives.
//
// Key layout:
//   passkey:{user_id}:{credential_id}      → CredentialRecord (JSON)
//   passkey-list:{user_id}                 → comma-separated credential_ids
//   reg-link:{token}                       → RegLinkRecord  (single-use)
//   webauthn-challenge:{purpose}:{key}     → string (60s TTL)
//   oauth-code:{code}                      → CodeRecord     (60s TTL)
//   oauth-token:{token}                    → TokenRecord    (long TTL)

export interface Env {
  VAULT_KV: KVNamespace
  RP_NAME: string
  RP_ID: string
  ORIGIN: string
  ADMIN_SECRET: string
  USER_ID: string
  OAUTH_CLIENT_ID: string
  // Finance tool secrets
  BINANCE_API_KEY: string
  BINANCE_API_SECRET: string
  DEST_COINBASE_USDC: string
  DEST_MERCADOPAGO_CVU: string
  MAX_DAILY_OUT_USD?: string
  // Fly proxy that forwards through Bright Data → Binance
  BINANCE_PROXY_URL?: string
  BINANCE_PROXY_SECRET?: string
}

export interface CredentialRecord {
  credentialID: string          // base64url
  publicKey: string             // base64url
  counter: number
  transports?: string[]
  createdAt: number
}

export interface RegLinkRecord {
  user_id: string
  expires_at: number
  used: boolean
  created_at: number
}

export interface CodeRecord {
  user_id: string
  code_challenge: string
  code_challenge_method: string
  redirect_uri: string
  scopes: string[]
  expires_at: number
}

export interface TokenRecord {
  user_id: string
  scopes: string[]
  issued_at: number
}

const TTL_REG_LINK = 60 * 60               // 1 hour to use the link
const TTL_CHALLENGE = 60                   // 60s WebAuthn challenge
const TTL_OAUTH_CODE = 60                  // 60s code → token exchange window
const TTL_OAUTH_TOKEN = 60 * 60 * 24 * 90  // 90-day bearer

// ─── Passkeys ───────────────────────────────────────────────────────
export async function savePasskey(
  env: Env,
  userId: string,
  cred: CredentialRecord,
): Promise<void> {
  const key = `passkey:${userId}:${cred.credentialID}`
  await env.VAULT_KV.put(key, JSON.stringify(cred))
  // Maintain a list of credential IDs for this user
  const list = (await env.VAULT_KV.get(`passkey-list:${userId}`)) ?? ""
  const ids = new Set(list.split(",").filter(Boolean))
  ids.add(cred.credentialID)
  await env.VAULT_KV.put(`passkey-list:${userId}`, [...ids].join(","))
}

export async function getPasskey(
  env: Env,
  userId: string,
  credentialId: string,
): Promise<CredentialRecord | null> {
  const raw = await env.VAULT_KV.get(`passkey:${userId}:${credentialId}`)
  return raw ? (JSON.parse(raw) as CredentialRecord) : null
}

export async function listPasskeys(
  env: Env,
  userId: string,
): Promise<CredentialRecord[]> {
  const list = (await env.VAULT_KV.get(`passkey-list:${userId}`)) ?? ""
  const ids = list.split(",").filter(Boolean)
  const records = await Promise.all(ids.map((id) => getPasskey(env, userId, id)))
  return records.filter((r): r is CredentialRecord => r !== null)
}

export async function updatePasskeyCounter(
  env: Env,
  userId: string,
  credentialId: string,
  counter: number,
): Promise<void> {
  const cred = await getPasskey(env, userId, credentialId)
  if (!cred) return
  cred.counter = counter
  await env.VAULT_KV.put(`passkey:${userId}:${credentialId}`, JSON.stringify(cred))
}

// ─── Registration links (one-time) ──────────────────────────────────
export async function createRegLink(env: Env, userId: string): Promise<string> {
  const token = randomToken(32)
  const record: RegLinkRecord = {
    user_id: userId,
    expires_at: Date.now() + TTL_REG_LINK * 1000,
    used: false,
    created_at: Date.now(),
  }
  await env.VAULT_KV.put(`reg-link:${token}`, JSON.stringify(record), {
    expirationTtl: TTL_REG_LINK,
  })
  return token
}

export async function getRegLink(env: Env, token: string): Promise<RegLinkRecord | null> {
  const raw = await env.VAULT_KV.get(`reg-link:${token}`)
  return raw ? (JSON.parse(raw) as RegLinkRecord) : null
}

export async function consumeRegLink(env: Env, token: string): Promise<void> {
  // Self-destruct: remove from KV entirely so the URL becomes 404.
  await env.VAULT_KV.delete(`reg-link:${token}`)
}

// ─── WebAuthn challenges ────────────────────────────────────────────
export async function saveChallenge(
  env: Env,
  purpose: "register" | "auth",
  key: string,
  challenge: string,
): Promise<void> {
  await env.VAULT_KV.put(`webauthn-challenge:${purpose}:${key}`, challenge, {
    expirationTtl: TTL_CHALLENGE,
  })
}

export async function consumeChallenge(
  env: Env,
  purpose: "register" | "auth",
  key: string,
): Promise<string | null> {
  const challenge = await env.VAULT_KV.get(`webauthn-challenge:${purpose}:${key}`)
  if (challenge) await env.VAULT_KV.delete(`webauthn-challenge:${purpose}:${key}`)
  return challenge
}

// ─── OAuth codes + tokens ───────────────────────────────────────────
export async function saveOAuthCode(env: Env, code: string, rec: CodeRecord): Promise<void> {
  await env.VAULT_KV.put(`oauth-code:${code}`, JSON.stringify(rec), {
    expirationTtl: TTL_OAUTH_CODE,
  })
}

export async function consumeOAuthCode(env: Env, code: string): Promise<CodeRecord | null> {
  const raw = await env.VAULT_KV.get(`oauth-code:${code}`)
  if (!raw) return null
  await env.VAULT_KV.delete(`oauth-code:${code}`)
  return JSON.parse(raw) as CodeRecord
}

export async function saveOAuthToken(env: Env, token: string, rec: TokenRecord): Promise<void> {
  await env.VAULT_KV.put(`oauth-token:${token}`, JSON.stringify(rec), {
    expirationTtl: TTL_OAUTH_TOKEN,
  })
}

export async function getOAuthToken(env: Env, token: string): Promise<TokenRecord | null> {
  const raw = await env.VAULT_KV.get(`oauth-token:${token}`)
  return raw ? (JSON.parse(raw) as TokenRecord) : null
}

// ─── helpers ────────────────────────────────────────────────────────
export function randomToken(byteLen: number): string {
  const buf = new Uint8Array(byteLen)
  crypto.getRandomValues(buf)
  return base64urlEncode(buf)
}

export function base64urlEncode(buf: Uint8Array): string {
  let s = ""
  for (const b of buf) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function base64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
