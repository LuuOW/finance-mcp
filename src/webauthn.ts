// Passkey (WebAuthn / FIDO2) registration + authentication.
// Server side uses @simplewebauthn/server. Browser side uses @simplewebauthn/browser
// loaded from CDN in pages.ts.

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server"
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/types"

import {
  type Env,
  saveChallenge,
  consumeChallenge,
  savePasskey,
  listPasskeys,
  getPasskey,
  updatePasskeyCounter,
  base64urlEncode,
  base64urlDecode,
} from "./storage"

// ─── Registration flow ──────────────────────────────────────────────
// 1. POST /register/{token}/options → returns options (challenge cached server-side)
// 2. Browser prompts for passkey, returns attestation
// 3. POST /register/{token}/verify → verifies, stores credential, marks token used

export async function registrationOptions(
  env: Env,
  userId: string,
  challengeKey: string,
): Promise<unknown> {
  const existing = await listPasskeys(env, userId)
  const opts = await generateRegistrationOptions({
    rpName: env.RP_NAME,
    rpID: env.RP_ID,
    userName: userId,
    userID: new TextEncoder().encode(userId),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.credentialID,
      transports: c.transports as AuthenticatorTransportFuture[] | undefined,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
  })
  await saveChallenge(env, "register", challengeKey, opts.challenge)
  return opts
}

export async function verifyRegistration(
  env: Env,
  userId: string,
  challengeKey: string,
  response: RegistrationResponseJSON,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const expectedChallenge = await consumeChallenge(env, "register", challengeKey)
  if (!expectedChallenge) return { ok: false, reason: "challenge expired" }
  let verification
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: env.ORIGIN,
      expectedRPID: env.RP_ID,
      requireUserVerification: true,
    })
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, reason: "verification failed" }
  }
  const info = verification.registrationInfo
  const cred = info.credential
  await savePasskey(env, userId, {
    credentialID: cred.id,
    publicKey: base64urlEncode(cred.publicKey),
    counter: cred.counter,
    transports: response.response.transports,
    createdAt: Date.now(),
  })
  return { ok: true }
}

// ─── Authentication flow ────────────────────────────────────────────
// Used during OAuth /authorize to confirm "this is the user."

export async function authenticationOptions(
  env: Env,
  userId: string,
  challengeKey: string,
): Promise<unknown> {
  const passkeys = await listPasskeys(env, userId)
  if (passkeys.length === 0) {
    throw new Error("no passkeys registered — open a fresh registration link first")
  }
  const opts = await generateAuthenticationOptions({
    rpID: env.RP_ID,
    allowCredentials: passkeys.map((c) => ({
      id: c.credentialID,
      transports: c.transports as AuthenticatorTransportFuture[] | undefined,
    })),
    userVerification: "required",
  })
  await saveChallenge(env, "auth", challengeKey, opts.challenge)
  return opts
}

export async function verifyAuthentication(
  env: Env,
  userId: string,
  challengeKey: string,
  response: AuthenticationResponseJSON,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const expectedChallenge = await consumeChallenge(env, "auth", challengeKey)
  if (!expectedChallenge) return { ok: false, reason: "challenge expired" }
  const cred = await getPasskey(env, userId, response.id)
  if (!cred) return { ok: false, reason: "unknown credential" }
  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: env.ORIGIN,
      expectedRPID: env.RP_ID,
      credential: {
        id: cred.credentialID,
        publicKey: base64urlDecode(cred.publicKey),
        counter: cred.counter,
        transports: cred.transports as AuthenticatorTransportFuture[] | undefined,
      },
      requireUserVerification: true,
    })
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
  if (!verification.verified) return { ok: false, reason: "signature invalid" }
  await updatePasskeyCounter(env, userId, cred.credentialID, verification.authenticationInfo.newCounter)
  return { ok: true }
}

// `AuthenticatorTransportFuture` import from @simplewebauthn/server is internal;
// declare a permissive alias here to avoid the deep import path.
type AuthenticatorTransportFuture =
  | "ble"
  | "cable"
  | "hybrid"
  | "internal"
  | "nfc"
  | "smart-card"
  | "usb"
