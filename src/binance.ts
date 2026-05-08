// Minimal Binance USD-M / Spot client (HMAC-SHA256 signed).
// Routes via the binance-proxy Worker on Fly that forwards through
// Bright Data's static-residential-grade IP (89.32.132.226), which is
// whitelistable on the Binance API key.

export class BinanceClient {
  private apiKey: string
  private apiSecret: string
  private base: string
  private fapiBase: string
  private proxySecret?: string

  constructor(
    apiKey: string,
    apiSecret: string,
    opts: { proxyUrl?: string; proxySecret?: string } = {},
  ) {
    this.apiKey = apiKey
    this.apiSecret = apiSecret
    if (opts.proxyUrl) {
      const u = opts.proxyUrl.replace(/\/+$/, "")
      this.base = u
      this.fapiBase = u
      this.proxySecret = opts.proxySecret
    } else {
      this.base = "https://api.binance.com"
      this.fapiBase = "https://fapi.binance.com"
    }
  }

  async signedGet(path: string, params: Record<string, string | number> = {}): Promise<unknown> {
    return this.signedRequest("GET", path, params)
  }

  async signedPost(path: string, params: Record<string, string | number> = {}): Promise<unknown> {
    return this.signedRequest("POST", path, params)
  }

  private async signedRequest(
    method: string,
    path: string,
    params: Record<string, string | number>,
  ): Promise<unknown> {
    const all: Record<string, string | number> = { ...params, timestamp: Date.now(), recvWindow: 5000 }
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(all)) qs.set(k, String(v))
    const sig = await hmacSha256Hex(this.apiSecret, qs.toString())
    qs.set("signature", sig)

    const fapi = path.startsWith("/fapi/")
    const url = `${fapi ? this.fapiBase : this.base}${path}${method === "GET" ? `?${qs}` : ""}`
    const headers: Record<string, string> = { "X-MBX-APIKEY": this.apiKey }
    if (this.proxySecret) headers["X-Proxy-Secret"] = this.proxySecret
    const init: RequestInit = { method, headers }
    if (method !== "GET") {
      init.body = qs.toString()
      headers["content-type"] = "application/x-www-form-urlencoded"
    }
    const r = await fetch(url, init)
    const text = await r.text()
    if (!r.ok) {
      throw new Error(`Binance ${method} ${path} → HTTP ${r.status}: ${text}`)
    }
    return text ? JSON.parse(text) : {}
  }
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")
}
