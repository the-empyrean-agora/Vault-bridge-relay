/**
 * Minimal OAuth 2.1 authorization server for Claude connector auth.
 *
 * Claude clients (Desktop, web, mobile, Cowork, Code) require a real OAuth
 * flow for custom connectors: RFC 9728 protected-resource metadata, RFC 8414
 * authorization-server metadata, RFC 7591 dynamic client registration, then
 * authorization_code + PKCE (S256) with a form-urlencoded token exchange.
 * The previous stub endpoints satisfied an older connector-add flow but fail
 * the current one at the registration step ("Couldn't register with …'s
 * sign-in service").
 *
 * This is the smallest compliant surface: the "sign-in" is the user pasting
 * their existing vault token into a consent page. The access_token Claude
 * receives IS that vault token, so authMiddleware and every non-OAuth client
 * (Obsidian plugin, email-agent) keep working unchanged.
 *
 * Registration is stateless — client_ids are minted but not stored. Security
 * comes from the redirect-URI allowlist (Claude's callback + RFC 8252
 * loopback), single-use short-TTL authorization codes in KV, and S256 PKCE
 * binding the code to the client that started the flow.
 */

import type { TokenRecord } from "./auth.js";

/** Minimal structural slice of KVNamespace so tests can pass a mock. */
export interface OAuthKV {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

const CODE_PREFIX = "oauth-code:";
const CODE_TTL_SECONDS = 300;

// --- Discovery metadata ---

export function buildProtectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
  };
}

export function buildAuthServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

// --- Redirect URI allowlist ---

/**
 * Hosted Claude surfaces use the fixed claude.ai callback (claude.com is its
 * announced successor). Claude Code is a native client using an RFC 8252
 * loopback redirect on an ephemeral port, so loopback hosts match on any port.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (
    (u.origin === "https://claude.ai" || u.origin === "https://claude.com") &&
    u.pathname === "/api/mcp/auth_callback"
  ) {
    return true;
  }
  if (
    u.protocol === "http:" &&
    (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
    u.pathname === "/callback"
  ) {
    return true;
  }
  return false;
}

// --- Dynamic client registration (RFC 7591) ---

export interface RegistrationResult {
  status: 201 | 400;
  body: Record<string, unknown>;
}

export function handleRegistration(body: unknown): RegistrationResult {
  const req = (body ?? {}) as Record<string, unknown>;
  const redirectUris = req.redirect_uris;

  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    !redirectUris.every((u) => typeof u === "string" && isAllowedRedirectUri(u))
  ) {
    return {
      status: 400,
      body: {
        error: "invalid_redirect_uri",
        error_description:
          "redirect_uris must be Claude's OAuth callback or an RFC 8252 loopback /callback URI",
      },
    };
  }

  return {
    status: 201,
    body: {
      client_id: crypto.randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      ...(typeof req.client_name === "string"
        ? { client_name: req.client_name }
        : {}),
    },
  };
}

// --- Authorization endpoint ---

export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
}

/** Returns an error string if the authorize request is malformed, else null. */
export function validateAuthorizeParams(p: AuthorizeParams): string | null {
  if (!p.redirect_uri || !isAllowedRedirectUri(p.redirect_uri)) {
    return "redirect_uri is missing or not an allowed Claude callback";
  }
  if (p.response_type !== "code") {
    return "response_type must be 'code'";
  }
  if (!p.client_id) {
    return "client_id is required";
  }
  if (!p.code_challenge) {
    return "code_challenge is required (PKCE)";
  }
  if (p.code_challenge_method !== "S256") {
    return "code_challenge_method must be S256";
  }
  return null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Consent page: the user pastes their vault token to approve the connection. */
export function renderConsentPage(
  p: AuthorizeParams,
  errorMessage?: string
): string {
  const hidden = (name: string, value: string | undefined) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value ?? "")}">`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Connect Vault Bridge</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; display: grid; place-items: center;
         min-height: 100vh; margin: 0; background: Canvas; color: CanvasText; }
  main { max-width: 22rem; padding: 2rem; border: 1px solid color-mix(in srgb, CanvasText 20%, Canvas);
         border-radius: 12px; }
  h1 { font-size: 1.2rem; margin-top: 0; }
  p { font-size: 0.9rem; line-height: 1.4; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 0.5rem;
         margin: 0.75rem 0; font-size: 1rem; border-radius: 6px;
         border: 1px solid color-mix(in srgb, CanvasText 30%, Canvas); }
  button { width: 100%; padding: 0.6rem; font-size: 1rem; border-radius: 6px;
         border: none; background: #6c5ce7; color: white; cursor: pointer; }
  .error { color: #d63031; font-size: 0.85rem; }
</style>
</head>
<body>
<main>
<h1>Connect to Vault Bridge</h1>
<p>Claude is asking to access your Obsidian vault. Paste your vault access
token to approve. The token stays between you and this server.</p>
${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ""}
<form method="post" action="/authorize">
${hidden("client_id", p.client_id)}
${hidden("redirect_uri", p.redirect_uri)}
${hidden("state", p.state)}
${hidden("code_challenge", p.code_challenge)}
${hidden("code_challenge_method", p.code_challenge_method)}
${hidden("response_type", p.response_type)}
<input type="password" name="vault_token" placeholder="Vault access token" required autofocus>
<button type="submit">Connect</button>
</form>
</main>
</body>
</html>`;
}

interface StoredCode {
  token: string;
  code_challenge: string;
  redirect_uri: string;
  client_id: string;
}

export interface ConsentResult {
  /** 302 target on success; absent when the page should re-render with error. */
  redirectTo?: string;
  errorMessage?: string;
}

/**
 * Handle the consent form POST: validate the pasted vault token against KV,
 * mint a single-use authorization code, and build the callback redirect.
 * `validateVaultToken` is injected so tests don't need the full auth stack.
 */
export async function handleConsent(
  kv: OAuthKV,
  p: AuthorizeParams,
  vaultToken: string,
  validateVaultToken: (token: string) => Promise<TokenRecord | null>
): Promise<ConsentResult> {
  const paramError = validateAuthorizeParams(p);
  if (paramError) {
    return { errorMessage: paramError };
  }
  const record = await validateVaultToken(vaultToken);
  if (!record) {
    return { errorMessage: "That token wasn't recognised. Check for missing characters and try again." };
  }

  const code = crypto.randomUUID();
  const stored: StoredCode = {
    token: vaultToken,
    code_challenge: p.code_challenge!,
    redirect_uri: p.redirect_uri!,
    client_id: p.client_id!,
  };
  await kv.put(CODE_PREFIX + code, JSON.stringify(stored), {
    expirationTtl: CODE_TTL_SECONDS,
  });

  const target = new URL(p.redirect_uri!);
  target.searchParams.set("code", code);
  if (p.state) target.searchParams.set("state", p.state);
  return { redirectTo: target.href };
}

// --- Token endpoint ---

export interface TokenResult {
  status: 200 | 400;
  body: Record<string, unknown>;
}

export async function handleTokenExchange(
  kv: OAuthKV,
  form: Record<string, string | undefined>
): Promise<TokenResult> {
  if (form.grant_type !== "authorization_code") {
    return {
      status: 400,
      body: { error: "unsupported_grant_type" },
    };
  }
  const code = form.code;
  if (!code) {
    return { status: 400, body: { error: "invalid_request" } };
  }

  const raw = await kv.get(CODE_PREFIX + code);
  if (!raw) {
    return { status: 400, body: { error: "invalid_grant" } };
  }
  // Single use: consume before verifying so a failed PKCE attempt burns it.
  await kv.delete(CODE_PREFIX + code);

  let stored: StoredCode;
  try {
    stored = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: "invalid_grant" } };
  }

  if (form.redirect_uri && form.redirect_uri !== stored.redirect_uri) {
    return { status: 400, body: { error: "invalid_grant" } };
  }
  if (!form.code_verifier) {
    return { status: 400, body: { error: "invalid_grant" } };
  }
  const challenge = await s256(form.code_verifier);
  if (challenge !== stored.code_challenge) {
    return { status: 400, body: { error: "invalid_grant" } };
  }

  // The vault token is the access token. Vault tokens don't expire, so no
  // expires_in / refresh_token — Claude treats the token as non-expiring and
  // a revoked token simply 401s, prompting a fresh connect.
  return {
    status: 200,
    body: { access_token: stored.token, token_type: "Bearer" },
  };
}

/** S256 PKCE: base64url(sha256(verifier)). */
export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  const bytes = new Uint8Array(digest);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
