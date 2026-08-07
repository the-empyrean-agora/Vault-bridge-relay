import { describe, it, expect } from "vitest";
import {
  buildAuthServerMetadata,
  buildProtectedResourceMetadata,
  handleConsent,
  handleRegistration,
  handleTokenExchange,
  isAllowedRedirectUri,
  renderConsentPage,
  s256,
  validateAuthorizeParams,
  type OAuthKV,
} from "../src/oauth.js";
import type { TokenRecord } from "../src/auth.js";

const ORIGIN = "https://vault-bridge.the-empyrean.com";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

function mockKv(): OAuthKV & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(k) {
      return store.get(k) ?? null;
    },
    async put(k, v) {
      store.set(k, v);
    },
    async delete(k) {
      store.delete(k);
    },
  };
}

const validRecord: TokenRecord = {
  label: "test",
  created: "2026-01-01",
  active: true,
  mode: "r2",
  prefix: "leigh-r2",
};

const acceptToken = async (t: string) =>
  t === "good-token" ? validRecord : null;

describe("discovery metadata", () => {
  it("protected resource metadata points at /mcp and this origin's auth server", () => {
    const meta = buildProtectedResourceMetadata(ORIGIN);
    expect(meta.resource).toBe(`${ORIGIN}/mcp`);
    expect(meta.authorization_servers).toEqual([ORIGIN]);
  });

  it("auth server metadata has the fields Claude requires", () => {
    const meta = buildAuthServerMetadata(ORIGIN);
    expect(meta.issuer).toBe(ORIGIN);
    expect(meta.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    expect(meta.token_endpoint).toBe(`${ORIGIN}/token`);
    expect(meta.registration_endpoint).toBe(`${ORIGIN}/register`);
    expect(meta.response_types_supported).toEqual(["code"]);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });
});

describe("redirect URI allowlist", () => {
  it("accepts Claude hosted callbacks and RFC 8252 loopback", () => {
    expect(isAllowedRedirectUri(CALLBACK)).toBe(true);
    expect(isAllowedRedirectUri("https://claude.com/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:3118/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:49152/callback")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isAllowedRedirectUri("https://evil.example/api/mcp/auth_callback")).toBe(false);
    expect(isAllowedRedirectUri("https://claude.ai.evil.example/api/mcp/auth_callback")).toBe(false);
    expect(isAllowedRedirectUri("https://claude.ai/other_path")).toBe(false);
    expect(isAllowedRedirectUri("http://localhost:3118/other")).toBe(false);
    expect(isAllowedRedirectUri("not a url")).toBe(false);
  });
});

describe("dynamic client registration", () => {
  it("registers a client with Claude's callback", () => {
    const result = handleRegistration({
      redirect_uris: [CALLBACK],
      client_name: "Claude",
      token_endpoint_auth_method: "none",
    });
    expect(result.status).toBe(201);
    expect(typeof result.body.client_id).toBe("string");
    expect(result.body.redirect_uris).toEqual([CALLBACK]);
    expect(result.body.token_endpoint_auth_method).toBe("none");
    expect(result.body.client_name).toBe("Claude");
  });

  it("rejects registration with a non-allowlisted redirect", () => {
    const result = handleRegistration({
      redirect_uris: ["https://evil.example/callback"],
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_redirect_uri");
  });

  it("rejects registration without redirect_uris", () => {
    expect(handleRegistration({}).status).toBe(400);
    expect(handleRegistration(null).status).toBe(400);
  });
});

describe("authorize params", () => {
  const good = {
    response_type: "code",
    client_id: "abc",
    redirect_uri: CALLBACK,
    state: "xyz",
    code_challenge: "challenge",
    code_challenge_method: "S256",
  };

  it("accepts a well-formed request", () => {
    expect(validateAuthorizeParams(good)).toBeNull();
  });

  it("rejects missing PKCE, wrong method, bad redirect, wrong response_type", () => {
    expect(validateAuthorizeParams({ ...good, code_challenge: undefined })).toBeTruthy();
    expect(validateAuthorizeParams({ ...good, code_challenge_method: "plain" })).toBeTruthy();
    expect(validateAuthorizeParams({ ...good, redirect_uri: "https://evil.example/cb" })).toBeTruthy();
    expect(validateAuthorizeParams({ ...good, response_type: "token" })).toBeTruthy();
  });

  it("escapes HTML in rendered consent page", () => {
    const html = renderConsentPage({ ...good, state: `"><script>alert(1)</script>` });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});

describe("consent → code → token exchange (full PKCE round trip)", () => {
  const verifier = "test-verifier-string-with-enough-entropy-0123456789";

  async function authorize(kv: OAuthKV) {
    const challenge = await s256(verifier);
    return handleConsent(
      kv,
      {
        response_type: "code",
        client_id: "client-1",
        redirect_uri: CALLBACK,
        state: "state-1",
        code_challenge: challenge,
        code_challenge_method: "S256",
      },
      "good-token",
      acceptToken
    );
  }

  it("issues a code bound to the callback and exchanges it for the vault token", async () => {
    const kv = mockKv();
    const consent = await authorize(kv);
    expect(consent.errorMessage).toBeUndefined();
    const target = new URL(consent.redirectTo!);
    expect(target.origin + target.pathname).toBe(CALLBACK);
    expect(target.searchParams.get("state")).toBe("state-1");
    const code = target.searchParams.get("code")!;
    expect(code).toBeTruthy();

    const token = await handleTokenExchange(kv, {
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: "client-1",
      code_verifier: verifier,
    });
    expect(token.status).toBe(200);
    expect(token.body.access_token).toBe("good-token");
    expect(token.body.token_type).toBe("Bearer");
  });

  it("rejects a wrong vault token at consent", async () => {
    const kv = mockKv();
    const consent = await handleConsent(
      kv,
      {
        response_type: "code",
        client_id: "c",
        redirect_uri: CALLBACK,
        code_challenge: await s256(verifier),
        code_challenge_method: "S256",
      },
      "wrong-token",
      acceptToken
    );
    expect(consent.redirectTo).toBeUndefined();
    expect(consent.errorMessage).toBeTruthy();
    expect(kv.store.size).toBe(0);
  });

  it("rejects a wrong code_verifier and burns the code", async () => {
    const kv = mockKv();
    const consent = await authorize(kv);
    const code = new URL(consent.redirectTo!).searchParams.get("code")!;

    const bad = await handleTokenExchange(kv, {
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: "client-1",
      code_verifier: "some-other-verifier",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_grant");

    // Code is single-use: even the correct verifier fails now.
    const retry = await handleTokenExchange(kv, {
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: "client-1",
      code_verifier: verifier,
    });
    expect(retry.status).toBe(400);
    expect(retry.body.error).toBe("invalid_grant");
  });

  it("rejects unknown grant types and unknown codes", async () => {
    const kv = mockKv();
    expect(
      (await handleTokenExchange(kv, { grant_type: "client_credentials" })).body.error
    ).toBe("unsupported_grant_type");
    expect(
      (
        await handleTokenExchange(kv, {
          grant_type: "authorization_code",
          code: "no-such-code",
          code_verifier: verifier,
        })
      ).body.error
    ).toBe("invalid_grant");
  });

  it("rejects a mismatched redirect_uri at exchange", async () => {
    const kv = mockKv();
    const consent = await authorize(kv);
    const code = new URL(consent.redirectTo!).searchParams.get("code")!;
    const result = await handleTokenExchange(kv, {
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:3118/callback",
      client_id: "client-1",
      code_verifier: verifier,
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_grant");
  });
});
