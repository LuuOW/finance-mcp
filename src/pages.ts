// HTML pages served by the worker. Vanilla — no build step.
// Loads @simplewebauthn/browser from CDN so the browser glue is one ESM import.

const SIMPLE_WEBAUTHN_BROWSER_CDN =
  "https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@11.0.0/dist/bundle/index.js"

const STYLE = `
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 480px;
         margin: 64px auto; padding: 0 24px; color: #111; }
  h1 { font-size: 1.5rem; margin: 0 0 16px; }
  p  { line-height: 1.6; color: #444; }
  button { font: inherit; padding: 12px 20px; border: 0; border-radius: 8px;
           background: #111; color: #fff; cursor: pointer; font-weight: 600; }
  button:disabled { opacity: 0.4; cursor: progress; }
  .ok    { color: #0a7c2c; font-weight: 600; }
  .err   { color: #b00020; font-weight: 600; }
  .muted { color: #888; font-size: 0.9rem; }
  code   { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
`

export function registrationPage(token: string): string {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8">
<title>Register passkey · Finance Vault</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLE}</style>
<h1>Register passkey</h1>
<p>This is a one-time link to bind your passkey (Face ID / Touch ID / fingerprint / hardware key)
to your finance vault. After registration this URL is destroyed.</p>
<p class="muted">If this link doesn't work or you didn't create it, ignore and close this tab.</p>
<button id="go">Register passkey</button>
<p id="status" class="muted"></p>
<script type="module">
  import { startRegistration } from "${SIMPLE_WEBAUTHN_BROWSER_CDN}"
  const status = document.getElementById("status")
  const btn = document.getElementById("go")
  btn.addEventListener("click", async () => {
    btn.disabled = true
    status.textContent = "Requesting options..."
    status.className = "muted"
    try {
      const optsRes = await fetch("/register/${token}/options", { method: "POST" })
      if (!optsRes.ok) throw new Error("options: " + optsRes.status)
      const opts = await optsRes.json()
      status.textContent = "Awaiting passkey..."
      const cred = await startRegistration({ optionsJSON: opts })
      status.textContent = "Verifying..."
      const verifyRes = await fetch("/register/${token}/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cred),
      })
      const result = await verifyRes.json()
      if (verifyRes.ok && result.ok) {
        status.textContent = "✓ Passkey registered. This link is now disabled. You can close this tab."
        status.className = "ok"
        btn.style.display = "none"
      } else {
        status.textContent = "✗ " + (result.reason || "registration failed")
        status.className = "err"
        btn.disabled = false
      }
    } catch (e) {
      status.textContent = "✗ " + e.message
      status.className = "err"
      btn.disabled = false
    }
  })
</script>
</html>`
}

export function loginPage(authorizeUrl: string, challengeKey: string): string {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8">
<title>Sign in with passkey · Finance Vault</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLE}</style>
<h1>Authorize Finance Vault</h1>
<p>A client wants to connect to your vault. Confirm with your passkey to proceed.</p>
<button id="go">Authorize with passkey</button>
<p id="status" class="muted"></p>
<script type="module">
  import { startAuthentication } from "${SIMPLE_WEBAUTHN_BROWSER_CDN}"
  const status = document.getElementById("status")
  const btn = document.getElementById("go")
  btn.addEventListener("click", async () => {
    btn.disabled = true
    status.textContent = "Requesting challenge..."
    status.className = "muted"
    try {
      const optsRes = await fetch("/login/options?key=${challengeKey}", { method: "POST" })
      if (!optsRes.ok) throw new Error("options: " + optsRes.status)
      const opts = await optsRes.json()
      status.textContent = "Awaiting passkey..."
      const cred = await startAuthentication({ optionsJSON: opts })
      status.textContent = "Verifying..."
      const verifyRes = await fetch("/login/verify?key=${challengeKey}", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cred),
      })
      const result = await verifyRes.json()
      if (verifyRes.ok && result.ok) {
        status.textContent = "✓ Authorized. Redirecting..."
        status.className = "ok"
        location.href = ${JSON.stringify(authorizeUrl)}
      } else {
        status.textContent = "✗ " + (result.reason || "auth failed")
        status.className = "err"
        btn.disabled = false
      }
    } catch (e) {
      status.textContent = "✗ " + e.message
      status.className = "err"
      btn.disabled = false
    }
  })
</script>
</html>`
}

export function statusPage(state: { passkeysRegistered: number }): string {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8">
<title>Finance Vault</title>
<style>${STYLE}</style>
<h1>Finance Vault</h1>
<p>Passkeys registered: <strong>${state.passkeysRegistered}</strong></p>
<p class="muted">Endpoints: <code>/authorize</code>, <code>/token</code>, <code>/mcp</code>.
Admin: <code>/admin/create-registration-link</code> (requires <code>X-Admin-Secret</code>).</p>
</html>`
}
