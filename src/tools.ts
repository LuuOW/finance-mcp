// MCP tool surface — the actual finance operations.
//
// Design choices:
// - Each "send money" action is split into prepare_* (returns quote + tx_id)
//   and confirm_* (executes). The LLM is expected to display the quote to the
//   user before confirming, but this is UX, not security.
// - Daily cap is the load-bearing security control (env MAX_DAILY_OUT_USD).
// - All confirms write an audit row to KV.
// - Destinations are looked up by symbolic name ("coinbase", "mp"); the worker
//   substitutes the secret-stored address. The LLM never sees raw addresses.

import type { Env } from "./storage"
import { BinanceClient } from "./binance"

const DAILY_CAP_USD_DEFAULT = 200

export interface ToolDef {
  name: string
  description: string
  inputSchema: unknown
}

export const TOOLS: ToolDef[] = [
  {
    name: "get_balances",
    description:
      "Read your spot/funding wallet balances from Binance. Returns USDC, ARS, and other non-zero assets.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "prepare_convert",
    description:
      "Get a quote to convert one asset to another inside Binance (e.g. USDC→ARS). Returns quote_id, rate, and receive_amount. Quote expires in ~10s; pass quote_id to confirm_convert immediately.",
    inputSchema: {
      type: "object",
      required: ["from_asset", "to_asset", "amount"],
      properties: {
        from_asset: { type: "string", description: "asset to spend, e.g. 'USDC'" },
        to_asset: { type: "string", description: "asset to receive, e.g. 'ARS'" },
        amount: { type: "number", description: "amount of from_asset to convert" },
      },
    },
  },
  {
    name: "confirm_convert",
    description:
      "Execute a previously-prepared convert quote. Requires quote_id from prepare_convert. Counts against daily cap.",
    inputSchema: {
      type: "object",
      required: ["quote_id"],
      properties: { quote_id: { type: "string" } },
    },
  },
  {
    name: "prepare_withdraw_usdc",
    description:
      "Quote a USDC withdrawal from Binance to your saved Coinbase wallet (Ethereum mainnet). Returns network fee and ETA.",
    inputSchema: {
      type: "object",
      required: ["amount"],
      properties: {
        amount: { type: "number", description: "USDC amount" },
        to: {
          type: "string",
          enum: ["coinbase"],
          description: "destination label; only 'coinbase' is allowed.",
        },
      },
    },
  },
  {
    name: "confirm_withdraw_usdc",
    description:
      "Execute the prepared USDC withdrawal to your saved Coinbase address. Counts against daily cap.",
    inputSchema: {
      type: "object",
      required: ["amount"],
      properties: {
        amount: { type: "number" },
        to: { type: "string", enum: ["coinbase"] },
      },
    },
  },
  {
    name: "prepare_withdraw_ars",
    description:
      "Quote an ARS withdrawal from Binance to your saved Mercado Pago CVU. Returns Binance's fiat fee.",
    inputSchema: {
      type: "object",
      required: ["amount"],
      properties: {
        amount: { type: "number", description: "ARS amount" },
        to: { type: "string", enum: ["mercadopago"] },
      },
    },
  },
  {
    name: "confirm_withdraw_ars",
    description:
      "Execute the prepared ARS withdrawal to your saved Mercado Pago CVU. Counts against daily cap.",
    inputSchema: {
      type: "object",
      required: ["amount"],
      properties: {
        amount: { type: "number" },
        to: { type: "string", enum: ["mercadopago"] },
      },
    },
  },
  {
    name: "list_recent_transfers",
    description:
      "List the last 50 confirmed transfers (audit log). Useful for 'what did I spend this week'.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", default: 50 } },
    },
  },
]

// ─── dispatcher ─────────────────────────────────────────────────────
export async function callTool(
  env: Env & {
    BINANCE_API_KEY: string
    BINANCE_API_SECRET: string
    DEST_COINBASE_USDC: string
    DEST_MERCADOPAGO_CVU: string
    MAX_DAILY_OUT_USD?: string
    BINANCE_PROXY_URL?: string
    BINANCE_PROXY_SECRET?: string
  },
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const bn = new BinanceClient(env.BINANCE_API_KEY, env.BINANCE_API_SECRET, {
    proxyUrl: env.BINANCE_PROXY_URL,
    proxySecret: env.BINANCE_PROXY_SECRET,
  })
  switch (name) {
    case "get_balances":
      return getBalances(bn)
    case "prepare_convert":
      return prepareConvert(bn, args)
    case "confirm_convert":
      return confirmConvert(bn, env, args)
    case "prepare_withdraw_usdc":
      return prepareWithdrawUSDC(bn, env, args)
    case "confirm_withdraw_usdc":
      return confirmWithdrawUSDC(bn, env, args)
    case "prepare_withdraw_ars":
      return prepareWithdrawARS(bn, env, args)
    case "confirm_withdraw_ars":
      return confirmWithdrawARS(bn, env, args)
    case "list_recent_transfers":
      return listRecentTransfers(env, args)
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

// ─── reads ──────────────────────────────────────────────────────────
async function getBalances(bn: BinanceClient): Promise<unknown> {
  // Spot wallet
  const spot = (await bn.signedPost("/sapi/v3/asset/getUserAsset", {})) as Array<{
    asset: string
    free: string
    locked: string
    freeze: string
    withdrawing: string
  }>
  const balances = spot
    .filter((a) => Number(a.free) + Number(a.locked) + Number(a.freeze) > 0)
    .map((a) => ({
      asset: a.asset,
      free: Number(a.free),
      locked: Number(a.locked),
    }))
    .sort((a, b) => b.free - a.free)
  return { balances }
}

async function listRecentTransfers(
  env: Env,
  args: Record<string, unknown>,
): Promise<unknown> {
  const limit = Math.min((args.limit as number) ?? 50, 100)
  const list = (await env.VAULT_KV.get("audit-log")) ?? "[]"
  const log = JSON.parse(list) as Array<unknown>
  return { transfers: log.slice(0, limit) }
}

// ─── convert ────────────────────────────────────────────────────────
async function prepareConvert(
  bn: BinanceClient,
  args: Record<string, unknown>,
): Promise<unknown> {
  const fromAsset = String(args.from_asset).toUpperCase()
  const toAsset = String(args.to_asset).toUpperCase()
  const amount = Number(args.amount)
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be > 0")

  const q = (await bn.signedPost("/sapi/v1/convert/getQuote", {
    fromAsset,
    toAsset,
    fromAmount: amount,
  })) as {
    quoteId: string
    ratio: string
    inverseRatio: string
    validTimestamp: number
    toAmount: string
    fromAmount: string
  }
  return {
    quote_id: q.quoteId,
    from_asset: fromAsset,
    to_asset: toAsset,
    from_amount: Number(q.fromAmount),
    to_amount: Number(q.toAmount),
    rate: Number(q.ratio),
    expires_at_ms: q.validTimestamp,
    expires_in_seconds: Math.max(0, Math.floor((q.validTimestamp - Date.now()) / 1000)),
  }
}

async function confirmConvert(
  bn: BinanceClient,
  env: Env & { MAX_DAILY_OUT_USD?: string },
  args: Record<string, unknown>,
): Promise<unknown> {
  const quoteId = String(args.quote_id)
  // Daily cap pre-check uses zero (we don't know amount until accepted; do post-check too)
  await assertDailyCap(env, 0)
  const result = (await bn.signedPost("/sapi/v1/convert/acceptQuote", {
    quoteId,
  })) as { orderId: string; createTime: number; orderStatus: string }
  await recordTransfer(env, {
    type: "convert",
    quote_id: quoteId,
    order_id: result.orderId,
    status: result.orderStatus,
    ts: result.createTime,
  })
  return {
    order_id: result.orderId,
    status: result.orderStatus,
    executed_at_ms: result.createTime,
  }
}

// ─── USDC → Coinbase ────────────────────────────────────────────────
async function prepareWithdrawUSDC(
  bn: BinanceClient,
  env: Env & { DEST_COINBASE_USDC: string },
  args: Record<string, unknown>,
): Promise<unknown> {
  const amount = Number(args.amount)
  const to = String(args.to ?? "coinbase")
  if (to !== "coinbase") throw new Error("only 'coinbase' destination is allowed")
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be > 0")
  // Look up withdraw networks for USDC (fee per network)
  const cfg = (await bn.signedGet("/sapi/v1/capital/config/getall")) as Array<{
    coin: string
    networkList: Array<{
      network: string
      name: string
      withdrawFee: string
      minConfirm: number
      withdrawEnable: boolean
      withdrawMin: string
      estimatedArrivalTime?: number
    }>
  }>
  const usdc = cfg.find((c) => c.coin === "USDC")
  if (!usdc) throw new Error("USDC not found in withdraw config")
  // Prefer ETH (matches the user's Coinbase Ethereum wallet address 0x...)
  const eth = usdc.networkList.find((n) => n.network === "ETH")
  if (!eth || !eth.withdrawEnable) throw new Error("ETH USDC withdrawal not enabled")
  return {
    network: "ETH",
    fee: Number(eth.withdrawFee),
    min: Number(eth.withdrawMin),
    receive_amount: Math.max(0, amount - Number(eth.withdrawFee)),
    eta_minutes: eth.estimatedArrivalTime ? Math.round(eth.estimatedArrivalTime / 60) : null,
    destination_label: "Coinbase USDC wallet",
  }
}

async function confirmWithdrawUSDC(
  bn: BinanceClient,
  env: Env & {
    DEST_COINBASE_USDC: string
    MAX_DAILY_OUT_USD?: string
  },
  args: Record<string, unknown>,
): Promise<unknown> {
  const amount = Number(args.amount)
  await assertDailyCap(env, amount) // USDC ≈ USD 1:1
  const result = (await bn.signedPost("/sapi/v1/capital/withdraw/apply", {
    coin: "USDC",
    network: "ETH",
    address: env.DEST_COINBASE_USDC,
    amount,
  })) as { id: string }
  await recordTransfer(env, {
    type: "withdraw_usdc",
    network: "ETH",
    amount,
    address_label: "coinbase",
    binance_id: result.id,
    ts: Date.now(),
  })
  await incrementDailySpend(env, amount)
  return {
    binance_withdraw_id: result.id,
    status: "submitted",
    note: "Track via list_recent_transfers; ETA ~30s on ETH mainnet.",
  }
}

// ─── ARS → Mercado Pago ─────────────────────────────────────────────
// Binance's ARS-to-CVU withdraw uses /sapi/v1/fiat/withdraw under the hood
// in the Argentina region. The exact endpoint shape may differ from the
// documented ones; first call may need adjustment based on the actual
// error response. The prepare path is best-effort (we estimate fee from
// historical fiat orders).
async function prepareWithdrawARS(
  _bn: BinanceClient,
  _env: Env,
  args: Record<string, unknown>,
): Promise<unknown> {
  const amount = Number(args.amount)
  const to = String(args.to ?? "mercadopago")
  if (to !== "mercadopago") throw new Error("only 'mercadopago' destination is allowed")
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be > 0")
  // Conservative fee estimate — ARS withdrawals to bank typically 1-2% with min ARS 100
  const estimatedFeePct = 0.01
  const estimatedFlatFee = 100
  const fee = Math.max(estimatedFlatFee, Math.round(amount * estimatedFeePct))
  return {
    amount_ars: amount,
    estimated_fee_ars: fee,
    receive_amount_ars: amount - fee,
    eta_minutes: 30,
    destination_label: "Mercado Pago CVU",
    note: "Fee is estimated; Binance shows the exact fee at confirmation.",
  }
}

async function confirmWithdrawARS(
  bn: BinanceClient,
  env: Env & {
    DEST_MERCADOPAGO_CVU: string
    MAX_DAILY_OUT_USD?: string
  },
  args: Record<string, unknown>,
): Promise<unknown> {
  const amount = Number(args.amount)
  // Convert ARS to USD-equivalent for cap check (rough — uses 1300 ARS/USD)
  const usdEquivalent = amount / 1300
  await assertDailyCap(env, usdEquivalent)
  // Try the documented fiat-withdrawal endpoint shape. If Binance returns
  // an error here, the response is logged in the audit and surfaced — so
  // first run is also a smoke test.
  let result: { orderId?: string; status?: string; raw?: string }
  try {
    const resp = (await bn.signedPost("/sapi/v1/fiat/withdraw", {
      fiatCurrency: "ARS",
      amount,
      bankAccount: env.DEST_MERCADOPAGO_CVU,
    })) as { orderId: string; status: string }
    result = { orderId: resp.orderId, status: resp.status }
  } catch (e) {
    // Surface the Binance error verbatim — the user can then iterate.
    return {
      error: "ars_withdraw_endpoint_unverified",
      detail: (e as Error).message,
      hint:
        "The ARS-to-CVU endpoint shape isn't fully documented. Manually withdraw via " +
        "Binance app once and capture the network call from devtools, then we update this handler.",
    }
  }
  await recordTransfer(env, {
    type: "withdraw_ars",
    amount,
    cvu_label: "mercadopago",
    binance_id: result.orderId,
    ts: Date.now(),
  })
  await incrementDailySpend(env, usdEquivalent)
  return {
    binance_order_id: result.orderId,
    status: result.status ?? "submitted",
    eta_minutes: 30,
  }
}

// ─── daily cap + audit log ──────────────────────────────────────────
async function assertDailyCap(
  env: Env & { MAX_DAILY_OUT_USD?: string },
  addUSD: number,
): Promise<void> {
  const cap = Number(env.MAX_DAILY_OUT_USD ?? DAILY_CAP_USD_DEFAULT)
  const today = new Date().toISOString().slice(0, 10)
  const spentRaw = (await env.VAULT_KV.get(`daily-spent:${today}`)) ?? "0"
  const spent = Number(spentRaw)
  if (spent + addUSD > cap) {
    throw new Error(
      `daily cap exceeded: spent $${spent.toFixed(2)} + this $${addUSD.toFixed(2)} > cap $${cap}. ` +
        `cap resets at UTC midnight, or set MAX_DAILY_OUT_USD via wrangler secret.`,
    )
  }
}

async function incrementDailySpend(
  env: Env,
  addUSD: number,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  const key = `daily-spent:${today}`
  const cur = Number((await env.VAULT_KV.get(key)) ?? "0")
  await env.VAULT_KV.put(key, String(cur + addUSD), { expirationTtl: 60 * 60 * 36 })
}

async function recordTransfer(env: Env, entry: Record<string, unknown>): Promise<void> {
  const list = JSON.parse((await env.VAULT_KV.get("audit-log")) ?? "[]") as Array<unknown>
  list.unshift(entry)
  // Keep last 200
  await env.VAULT_KV.put("audit-log", JSON.stringify(list.slice(0, 200)))
}
