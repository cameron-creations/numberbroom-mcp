/**
 * The OAuth flow end to end, through the real OAuthProvider and the real
 * createMcpHandler, with NumberBroom's API and the client's CIMD document
 * mocked at fetch. What it proves:
 *   - discovery: the 401 challenge, the protected-resource document, and
 *     authorization-server metadata with CIMD on and no registration endpoint
 *   - a browser that is not ready goes to numberbroom.com/connect first, named
 *     by the client's verified domain, not its self-chosen name
 *   - consent, then the handoff to /connect, then the callback that redeems
 *     the code server to server and finishes the grant
 *   - a tool call made with the issued token reaches the API with the minted
 *     key, never the token, and a header key still works on its own
 *   - a key revoked in Settings ends the grant at the next refresh
 *   - Deny, a foreign browser and a failed redeem each end the flow safely
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker, { consentHtml, RESOURCE, USER_AGENT } from "../src/index";

const SITE = "https://numberbroom.com";
const CLIENT_ID = "https://client.example/oauth/client-metadata.json";
const REDIRECT = "https://client.example/callback";
const KEY = "nb_live_" + "ab".repeat(32);
const CODE = "C".repeat(43);

afterEach(() => vi.unstubAllGlobals());

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env as any, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** The name=value pairs a response sets, ready to send back as a Cookie header. */
function cookies(res: Response): string {
  const all = (res.headers as any).getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  return all
    .map((c: string) => c.split(";")[0])
    .filter((c: string) => c && !c.endsWith("="))
    .join("; ");
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

type Upstream = {
  redeem?: (body: any, headers: Headers) => Response;
  credits?: () => Response;
  seen: { url: string; init: RequestInit }[];
};

/** NumberBroom's API and the client's metadata document, at fetch. */
function stubFetch(upstream: Upstream) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      upstream.seen.push({ url, init });
      if (url === CLIENT_ID) {
        return Response.json({
          client_id: CLIENT_ID,
          client_name: "Example Assistant",
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        });
      }
      if (url === `${SITE}/api/internal/mcp/redeem`) {
        const body = JSON.parse(String(init.body));
        return upstream.redeem
          ? upstream.redeem(body, new Headers(init.headers))
          : Response.json({ key: KEY, keyId: "key_0123456789abcdef", subject: "nb_subjectABC" });
      }
      if (url === `${SITE}/api/v1/verify`) {
        return Response.json({ valid: true, e164: "+14155553000", lineType: "mobile", isLitigator: false, charged: 0.2 });
      }
      if (url === `${SITE}/api/v1/credits`) {
        return upstream.credits ? upstream.credits() : Response.json({ credits: 10, ratePerLookup: 0.2, lookupsRemaining: 50 });
      }
      return new Response("unexpected fetch " + url, { status: 599 });
    })
  );
}

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

function authorizeUrl(challenge: string) {
  const u = new URL(`${SITE}/oauth/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", "client-state-xyz");
  u.searchParams.set("resource", RESOURCE);
  return u.toString();
}

/** Consent page, approve, and the hop to /connect. Returns the upstream state and its cookie. */
async function throughConsent(challenge: string) {
  const page = await call(new Request(authorizeUrl(challenge), { headers: { cookie: "nb_oauth_ready=1" } }));
  expect(page.status).toBe(200);
  const html = await page.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)![1];
  const approve = await call(
    new Request(authorizeUrl(challenge), {
      method: "POST",
      headers: { cookie: cookies(page), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle, decision: "approve" }),
    })
  );
  expect(approve.status).toBe(302);
  const to = new URL(approve.headers.get("location")!, SITE);
  return { html, page, to, state: to.searchParams.get("state")!, cookie: cookies(approve) };
}

async function mcpCall(token: string, name: string, args: Record<string, unknown>) {
  const res = await call(
    new Request(`${SITE}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    })
  );
  return { status: res.status, text: await res.text() };
}

describe("discovery", () => {
  it("publishes the protected resource and the authorization server, CIMD on, no registration", async () => {
    const prm = await call(new Request(`${SITE}/.well-known/oauth-protected-resource/mcp`));
    expect(prm.status).toBe(200);
    const prmText = await prm.text();
    expect(JSON.parse(prmText).resource).toBe(RESOURCE);
    // The exact strings deploy.yml's post-deploy checks grep for.
    expect(prmText).toContain('"resource":"https://numberbroom.com/mcp"');

    const asText = await (await call(new Request(`${SITE}/.well-known/oauth-authorization-server`))).text();
    expect(asText).toContain('"authorization_endpoint":"https://numberbroom.com/oauth/authorize"');
    const as = JSON.parse(asText);
    expect(as.issuer).toBe(SITE);
    expect(as.authorization_endpoint).toBe(`${SITE}/oauth/authorize`);
    expect(as.token_endpoint).toBe(`${SITE}/oauth/token`);
    expect(as.registration_endpoint).toBeUndefined();
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.code_challenge_methods_supported).toContain("S256");
  });
});

describe("connecting", () => {
  it("sends a browser that is not ready to /connect, named by the client's verified domain", async () => {
    stubFetch({ seen: [] });
    const { challenge } = await pkce();
    const res = await call(new Request(authorizeUrl(challenge)));
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!, SITE);
    expect(to.pathname).toBe("/connect");
    expect(to.searchParams.get("app")).toBe("client.example");
    expect(to.searchParams.get("next")).toBe(new URL(authorizeUrl(challenge)).pathname + new URL(authorizeUrl(challenge)).search);
  });

  it("runs consent, the /connect handoff and the callback, then the token reaches the API as the minted key", async () => {
    const upstream: Upstream = { seen: [] };
    stubFetch(upstream);
    const { verifier, challenge } = await pkce();
    const { html, page, to, state, cookie } = await throughConsent(challenge);

    expect(html).toContain("Example Assistant");
    expect(html).toContain("client.example");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(to.pathname).toBe("/connect");
    expect(to.searchParams.get("app")).toBe("client.example");

    const done = await call(
      new Request(`${SITE}/oauth/callback?state=${encodeURIComponent(state)}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: CODE }),
      })
    );
    expect(done.status).toBe(302);
    const back = new URL(done.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("client-state-xyz");
    const authCode = back.searchParams.get("code")!;

    const redeem = upstream.seen.find((s) => s.url.endsWith("/api/internal/mcp/redeem"))!;
    expect(new Headers(redeem.init.headers).get("x-mcp-secret")).toBe("test-internal-secret");
    expect(new Headers(redeem.init.headers).get("user-agent")).toBe(USER_AGENT);
    expect(JSON.parse(String(redeem.init.body))).toEqual({
      code: CODE,
      state,
      clientId: CLIENT_ID,
      clientLabel: "Example Assistant via client.example",
    });

    const tokenRes = await call(
      new Request(`${SITE}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authCode,
          redirect_uri: REDIRECT,
          client_id: CLIENT_ID,
          code_verifier: verifier,
          resource: RESOURCE,
        }),
      })
    );
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json<any>();
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.access_token).not.toContain(KEY);
    expect(tokens.access_token.startsWith("nb_subjectABC:")).toBe(true);

    upstream.seen.length = 0;
    const r = await mcpCall(tokens.access_token, "verify_phone_number", { phone: "4155553000" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("+14155553000");
    const verify = upstream.seen.find((s) => s.url === `${SITE}/api/v1/verify`)!;
    expect(new Headers(verify.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(new Headers(verify.init.headers).get("x-numberbroom-client")).toBe("mcp");

    // Disconnected in Settings: the key answers 401, so the next refresh ends the grant.
    upstream.credits = () => Response.json({ error: "unauthorized", message: "Invalid or revoked API key." }, { status: 401 });
    const refresh = await call(
      new Request(`${SITE}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: CLIENT_ID, resource: RESOURCE }),
      })
    );
    expect(refresh.status).toBe(400);
    expect((await refresh.json<any>()).error).toBe("invalid_grant");
  });

  it("a hiccup at refresh keeps the grant", async () => {
    const upstream: Upstream = { seen: [], credits: () => new Response("<html>502</html>", { status: 502 }) };
    stubFetch(upstream);
    const { verifier, challenge } = await pkce();
    const { state, cookie } = await throughConsent(challenge);
    const done = await call(
      new Request(`${SITE}/oauth/callback?state=${encodeURIComponent(state)}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: CODE }),
      })
    );
    const authCode = new URL(done.headers.get("location")!).searchParams.get("code")!;
    const tokens = await (
      await call(
        new Request(`${SITE}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "authorization_code", code: authCode, redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: verifier, resource: RESOURCE }),
        })
      )
    ).json<any>();
    const refresh = await call(
      new Request(`${SITE}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: CLIENT_ID, resource: RESOURCE }),
      })
    );
    expect((await refresh.json<any>()).error).toBe("temporarily_unavailable");
  });

  it("Deny sends access_denied back to the client", async () => {
    stubFetch({ seen: [] });
    const { challenge } = await pkce();
    const page = await call(new Request(authorizeUrl(challenge), { headers: { cookie: "nb_oauth_ready=1" } }));
    const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)![1];
    const deny = await call(
      new Request(authorizeUrl(challenge), {
        method: "POST",
        headers: { cookie: cookies(page), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ handle, decision: "deny" }),
      })
    );
    expect(deny.status).toBe(302);
    const back = new URL(deny.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("error")).toBe("access_denied");
  });

  it("a callback from another browser is refused, and redeems nothing", async () => {
    const upstream: Upstream = { seen: [] };
    stubFetch(upstream);
    const { challenge } = await pkce();
    const { state } = await throughConsent(challenge);
    const res = await call(
      new Request(`${SITE}/oauth/callback?state=${encodeURIComponent(state)}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: CODE }),
      })
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Start again");
    expect(upstream.seen.some((s) => s.url.endsWith("/redeem"))).toBe(false);
  });

  it("a failed redeem sends server_error back to the client and issues no grant", async () => {
    stubFetch({ seen: [], redeem: () => Response.json({ error: "code_used" }, { status: 409 }) });
    const { challenge } = await pkce();
    const { state, cookie } = await throughConsent(challenge);
    const res = await call(
      new Request(`${SITE}/oauth/callback?state=${encodeURIComponent(state)}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: CODE }),
      })
    );
    const back = new URL(res.headers.get("location")!);
    expect(back.searchParams.get("error")).toBe("server_error");
    expect(back.searchParams.get("code")).toBeNull();
  });
});

describe("stray requests to the OAuth pages", () => {
  it("a bare POST to /oauth/callback, or an authorize URL missing its parameters, gets the start-again page", async () => {
    stubFetch({ seen: [] });
    for (const req of [
      new Request(`${SITE}/oauth/callback?state=smoke`, { method: "POST" }),
      new Request(`${SITE}/oauth/authorize?smoke=1`),
      new Request(`${SITE}/oauth/authorize`, { method: "POST" }),
    ]) {
      const res = await call(req);
      expect(res.status, req.url).toBe(400);
      expect(await res.text()).toContain("<title>Connect NumberBroom</title>");
    }
  });
});

describe("a NumberBroom API key in the header", () => {
  it("still works, and is what the API receives", async () => {
    const upstream: Upstream = { seen: [] };
    stubFetch(upstream);
    const r = await mcpCall(KEY, "verify_phone_number", { phone: "4155553000" });
    expect(r.status).toBe(200);
    const verify = upstream.seen.find((s) => s.url === `${SITE}/api/v1/verify`)!;
    expect(new Headers(verify.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("anything that is neither a token nor a key gets the 401 challenge", async () => {
    stubFetch({ seen: [] });
    const r = await mcpCall("nb_live_short", "verify_phone_number", { phone: "4155553000" });
    expect(r.status).toBe(401);
  });
});

describe("the consent page", () => {
  it("escapes everything a client chose and warns about a local app", () => {
    const html = consentHtml(
      {
        clientId: "https://evil.example/x",
        clientName: '<img src=x onerror="alert(1)">',
        redirectUri: "http://localhost:3333/cb",
        redirectHost: "localhost",
        redirectIsLoopback: true,
        scope: [],
      },
      'h"><script>'
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#60;img");
    expect(html).toContain("app on your computer");
    expect(html).toContain("not verified");
  });
});
