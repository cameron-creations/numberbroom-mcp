/**
 * Remote MCP server for the NumberBroom phone verification API.
 *
 * Two ways in, one set of tools:
 *
 *  1. OAuth (since 1.1.0), for claude.ai, ChatGPT and any client that connects
 *     with a sign-in. This Worker is the OAuth authorization server, built on
 *     @cloudflare/workers-oauth-provider. NumberBroom's own sign-in is the
 *     identity step: /oauth/authorize sends the browser to
 *     numberbroom.com/connect to sign in or sign up and add credit, shows its
 *     consent page, then hands the browser back to /connect to confirm the
 *     account. NumberBroom's API then gives this Worker a connector key for
 *     that account, server to server (POST /api/internal/mcp/redeem, guarded
 *     by MCP_INTERNAL_SECRET), and the key lives only inside the encrypted
 *     grant. An MCP client holds a token issued here, never the key.
 *  2. A NumberBroom API key in the connection's Authorization header
 *     (`Bearer nb_live_...`), as before 1.1.0, for Claude Code, Cursor, VS
 *     Code and the other clients that send a header. resolveExternalToken
 *     accepts it. Forwarding a key the client presented is outside the MCP
 *     OAuth profile; it is kept on purpose so existing setups keep working.
 *
 * Either way, a tool call becomes the same REST call documented at
 * https://numberbroom.com/developers, which owns billing, limits, refunds and
 * the circuit breaker. Nothing here stores customer data; the only state is the
 * OAuth library's grants and tokens in KV (OAUTH_KV).
 */

import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import OAuthProvider, {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  OAuthError,
  type ConsentDescription,
  type OAuthHelpers,
  type TokenExchangeCallbackOptions,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

export interface Env {
  OAUTH_KV: KVNamespace;
  /** Shared with NumberBroom's API (Secret Manager there, a wrangler secret here). */
  MCP_INTERNAL_SECRET: string;
  OAUTH_PROVIDER: OAuthHelpers;
}

/** What a grant (or an accepted header key) hands the MCP handler in ctx.props. */
interface Props {
  apiKey: string;
  keyId?: string;
  via?: "oauth" | "key";
}

export const SITE = "https://numberbroom.com";
const API_BASE = `${SITE}/api/v1`;
export const RESOURCE = `${SITE}/mcp`;
export const VERSION = "1.1.0";
/**
 * Named on every call to NumberBroom's API. The CIMD compatibility flag sends
 * this Worker's own fetches to numberbroom.com through the zone's front door,
 * where Browser Integrity Check runs; an explicit agent keeps those calls from
 * looking like a headless scraper.
 */
export const USER_AGENT = `NumberBroom-MCP/${VERSION} (+${SITE}/mcp-server)`;
const KEY_RE = /^nb_live_[0-9a-f]{64}$/;

/**
 * Tells the API a call came through MCP, so a key with no limit of its own
 * gets the lower MCP daily default rather than the full per-key cap (see
 * effectiveDailyLimit in the main repo's api/v1.js). Spoofing it can only
 * lower the caller's own limit, never raise it, so it needs no signature.
 */
export const CLIENT_HEADER = "x-numberbroom-client";
export const CLIENT_NAME = "mcp";

/**
 * Upstream answered, but not with JSON: a Cloudflare or Firebase error page,
 * a 502 from Cloud Run mid-deploy. It deliberately does not claim the call was
 * free -- if the request reached the API before failing, the API refunds a
 * failed lookup itself; if it did not, nothing was taken -- so the honest
 * pointer is the free balance check.
 */
function unexpectedResult(status: number): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          `NumberBroom's API returned an unexpected response (HTTP ${status}). This is ` +
          "usually brief; try again shortly. get_credit_balance is free if you want to " +
          "confirm your balance.",
      },
    ],
  };
}

const UNREACHABLE_RESULT: CallToolResult = {
  isError: true,
  content: [
    {
      type: "text",
      text:
        "Could not reach NumberBroom's API. Try again shortly; get_credit_balance is free if " +
        "you want to confirm your balance.",
    },
  ],
};

const NO_AUTH_RESULT: CallToolResult = {
  isError: true,
  content: [
    {
      type: "text",
      text:
        "This connection has no NumberBroom account. Connect NumberBroom again from your " +
        "assistant's connector settings, or set the connection's Authorization header to " +
        "`Bearer nb_live_...` with a key from https://numberbroom.com/settings.",
    },
  ],
};

/** fetch that turns a network failure into null instead of a throw. */
async function forward(url: string, init: RequestInit): Promise<Response | null> {
  try {
    const headers = new Headers(init.headers);
    headers.set("user-agent", USER_AGENT);
    return await fetch(url, { ...init, headers });
  } catch {
    return null;
  }
}

/** Parses a body as JSON, or returns undefined when it is not JSON. */
async function readJson(resp: Response): Promise<unknown> {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorResult(status: number, data: unknown, oauth = false): CallToolResult {
  const message =
    (typeof data === "object" && data !== null && "message" in data && String((data as any).message)) ||
    (typeof data === "object" && data !== null && "error" in data && String((data as any).error)) ||
    "Unknown error.";
  const hint =
    status === 402
      ? " Call buy_credits to get a link the person can use to add credit."
      : status === 401
        ? oauth
          ? " This connection was disconnected; connect NumberBroom again from the assistant's settings."
          : " Check the API key in this connection's Authorization header (keys are in NumberBroom's Settings)."
        : "";
  return {
    isError: true,
    content: [{ type: "text", text: `NumberBroom API error (HTTP ${status}): ${message}${hint}` }],
  };
}

function jsonResult(summary: string, data: unknown): CallToolResult {
  return {
    content: [
      { type: "text", text: summary },
      { type: "text", text: JSON.stringify(data, null, 2) },
    ],
  };
}

/** A 401 the API itself sent: the key is gone, not a hiccup on the way. */
function isRevoked(status: number, data: unknown): boolean {
  return status === 401 && typeof data === "object" && data !== null && (data as any).error === "unauthorized";
}

type Answer = { ok: true; data: Record<string, unknown> } | { ok: false; result: CallToolResult };

/** One call to NumberBroom's API, with every failure turned into a tool result. */
async function callApi(
  authHeader: string | null,
  path: string,
  init: RequestInit,
  onRevoked?: () => void
): Promise<Answer> {
  if (!authHeader) return { ok: false, result: NO_AUTH_RESULT };
  const headers = new Headers(init.headers);
  headers.set("authorization", authHeader);
  headers.set(CLIENT_HEADER, CLIENT_NAME);
  const resp = await forward(`${API_BASE}${path}`, { ...init, headers });
  if (!resp) return { ok: false, result: UNREACHABLE_RESULT };
  const data = await readJson(resp);
  if (data === undefined || data === null || typeof data !== "object") {
    return { ok: false, result: unexpectedResult(resp.status) };
  }
  if (!resp.ok) {
    if (onRevoked && isRevoked(resp.status, data)) onRevoked();
    // onRevoked is passed only for an OAuth connection, so it also says which
    // advice fits a 401: reconnect, or fix the header key.
    return { ok: false, result: errorResult(resp.status, data, Boolean(onRevoked)) };
  }
  return { ok: true, data: data as Record<string, unknown> };
}

const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Exported separately from tool registration so tests can call it directly
 * with a mocked global fetch, without simulating a full MCP JSON-RPC
 * handshake.
 */
export async function verifyPhoneNumber(
  authHeader: string | null,
  phone: string,
  onRevoked?: () => void
): Promise<CallToolResult> {
  const r = await callApi(authHeader, "/verify", postJson({ phone }), onRevoked);
  if (!r.ok) return r.result;
  const d = r.data;
  const summary = d.valid
    ? `${d.e164}: ${d.lineType}${d.carrier ? ` on ${d.carrier}` : ""}${
        // A dead mobile still reports lineType "mobile"; disconnection is its
        // own field, derived from the activity score. Without this the summary
        // an agent reads first calls a dead line a plain mobile.
        d.isLikelyDisconnected === true ? `, likely disconnected (activity score ${d.activityScore})` : ""
      }${d.isLitigator ? " -- FLAGGED as a known TCPA litigator" : ""}. Charged $${d.charged}.`
    : `"${phone}" is not a parsable US phone number. Not charged.`;
  return jsonResult(summary, d);
}

export async function getCreditBalance(authHeader: string | null, onRevoked?: () => void): Promise<CallToolResult> {
  const r = await callApi(authHeader, "/credits", {}, onRevoked);
  if (!r.ok) return r.result;
  const d = r.data;
  return jsonResult(
    `$${d.credits} remaining -- enough for about ${d.lookupsRemaining} lookups at $${d.ratePerLookup} each.`,
    d
  );
}

export async function buyCredits(authHeader: string | null, amount: number, onRevoked?: () => void): Promise<CallToolResult> {
  const r = await callApi(authHeader, "/credits/checkout", postJson({ amount }), onRevoked);
  if (!r.ok) return r.result;
  return jsonResult(
    `Give the person this link to add $${amount} of credit (paid by card on Stripe; credit lands when the ` +
      `payment clears): ${r.data.url}`,
    r.data
  );
}

export async function scrubList(
  authHeader: string | null,
  numbers: string[],
  scrubMode: "full" | "litigator_only",
  onRevoked?: () => void
): Promise<CallToolResult> {
  const r = await callApi(authHeader, "/lists", postJson({ numbers, scrubMode }), onRevoked);
  if (!r.ok) return r.result;
  const d = r.data;
  return jsonResult(
    `${d.rowCount} numbers (${d.chargedNumbers} charged, repeats once) cost $${d.amount} at list rates. ` +
      `Give the person this link to pay by card: ${d.url} -- the scrub runs once payment clears. ` +
      `Check it with get_list_status and jobId ${d.jobId}.`,
    d
  );
}

export async function getListStatus(authHeader: string | null, jobId: string, onRevoked?: () => void): Promise<CallToolResult> {
  const r = await callApi(authHeader, `/lists/${encodeURIComponent(jobId)}`, {}, onRevoked);
  if (!r.ok) return r.result;
  const d = r.data;
  const summary =
    d.status === "complete"
      ? `Done: ${d.cleanCount} kept of ${d.totalNumbers}; ${d.litigatorCount} litigators, ${d.voipLandlineCount} ` +
        `landline or VoIP, ${d.disconnectedCount} disconnected removed.` +
        (d.downloadUrl ? ` Cleaned file (link lasts an hour): ${d.downloadUrl}` : "")
      : d.paid
        ? `Status: ${d.status}. Paid; the scrub is running.`
        : "Not paid yet. The scrub starts once the person pays at the checkout link.";
  return jsonResult(summary, d);
}

/** Read-only tools say so, which lets a client skip asking the person before calling them. */
const READ_ONLY = { readOnlyHint: true, openWorldHint: true };

export function createServer(authHeader: string | null, onRevoked?: () => void): McpServer {
  const server = new McpServer({ name: "numberbroom", version: VERSION });

  server.registerTool(
    "verify_phone_number",
    {
      description:
        "Verify a single US phone number: carrier-level line type (mobile, landline, VoIP, " +
        "toll-free or other), carrier name, an activity score with a likely-disconnected flag " +
        "(a dead mobile still reports as mobile, so read isLikelyDisconnected, not lineType), " +
        "and whether the number is a known TCPA litigator. Does not check Do Not Call " +
        "registries. Costs $0.20, charged against the connected NumberBroom account's " +
        "pre-paid credit; a number that fails to parse as a phone number is not charged.",
      inputSchema: {
        phone: z
          .string()
          .min(1)
          .max(40)
          .describe("The phone number to verify, in any common US format (e.g. \"(555) 123-4567\")."),
      },
      annotations: { openWorldHint: true },
    },
    ({ phone }) => verifyPhoneNumber(authHeader, phone, onRevoked)
  );

  server.registerTool(
    "get_credit_balance",
    {
      description:
        "Check the remaining pre-paid API credit balance for the connected NumberBroom " +
        "account. Free to call -- does not spend credits.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => getCreditBalance(authHeader, onRevoked)
  );

  server.registerTool(
    "buy_credits",
    {
      description:
        "Create a Stripe Checkout link that adds credit to the connected NumberBroom account. " +
        "Free to call; nothing is charged until the person opens the link and pays by card. " +
        "Use it when a lookup fails for lack of credit, or before a large batch.",
      inputSchema: {
        amount: z.number().min(10).max(5000).describe("Dollars of credit to add, 10 to 5000."),
      },
      annotations: { openWorldHint: true },
    },
    ({ amount }) => buyCredits(authHeader, amount, onRevoked)
  );

  server.registerTool(
    "scrub_list",
    {
      description:
        "Send a whole list of US phone numbers for NumberBroom's paid list scrub, which is " +
        "cheaper per number than one lookup at a time on large lists and returns one cleaned " +
        "file. Returns the price and a Stripe Checkout link for the person to pay by card; " +
        "nothing is taken from API credit and nothing runs until they pay. mode 'full' removes " +
        "known TCPA litigators, disconnected lines and anything that is not a live mobile; " +
        "'litigator_only' removes litigators and keeps landlines and VoIP.",
      inputSchema: {
        numbers: z
          .array(z.string().min(1).max(40))
          .min(1)
          .max(10000)
          .describe("Up to 10,000 phone numbers, digits and phone punctuation only."),
        mode: z.enum(["full", "litigator_only"]).default("full"),
      },
      annotations: { openWorldHint: true },
    },
    ({ numbers, mode }) => scrubList(authHeader, numbers, mode, onRevoked)
  );

  server.registerTool(
    "get_list_status",
    {
      description:
        "Check a list scrub started with scrub_list: whether it is paid, running or done, the " +
        "counts once done, and a download link for the cleaned file that lasts an hour.",
      inputSchema: {
        jobId: z.string().min(8).max(64).describe("The jobId scrub_list returned."),
      },
      annotations: READ_ONLY,
    },
    ({ jobId }) => getListStatus(authHeader, jobId, onRevoked)
  );

  return server;
}

// ─── The MCP endpoint ────────────────────────────────────────────────────────

/**
 * Reached only with a valid token or an accepted header key: the provider
 * answers everything else with a 401 that points at the protected-resource
 * metadata. The key comes from ctx.props directly, not from async storage,
 * because agents' createMcpHandler does not see this library's context.
 */
export const mcpApi = {
  fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: Props; auth?: { token?: string } }) {
    const props = ctx.props;
    const authHeader = props?.apiKey && KEY_RE.test(props.apiKey) ? `Bearer ${props.apiKey}` : null;
    // A key revoked in Settings (Disconnect) answers 401. Revoking the grant
    // too makes the client re-authorize on its next request instead of
    // failing quietly until its access token expires.
    const onRevoked =
      props?.via === "oauth" && ctx.auth?.token
        ? () => {
            const [userId, grantId] = String(ctx.auth!.token).split(":");
            if (userId && grantId) ctx.waitUntil(env.OAUTH_PROVIDER.revokeGrant(grantId, userId).catch(() => {}));
          }
        : undefined;
    return createMcpHandler(() => createServer(authHeader, onRevoked))(request, env, ctx);
  },
};

// ─── The authorization pages ─────────────────────────────────────────────────

const READY_COOKIE = "nb_oauth_ready";

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Every page this Worker renders. All text from a client is escaped, and the
 * page runs no script and loads nothing: it shares an origin with the
 * signed-in app, so one escaping slip here must not be able to reach it.
 * There is no form-action, which would also block the Deny redirect.
 */
function page(title: string, body: string, status = 200, headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<meta name="robots" content="noindex"><title>${escape(title)}</title><style>` +
      `body{margin:0;background:#0a0a0b;color:#ececec;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}` +
      `main{max-width:520px;margin:48px auto;padding:0 20px}h1{font-size:22px;line-height:1.3;margin:0 0 12px}` +
      `.brand{font-weight:700;letter-spacing:.02em;margin-bottom:28px;color:#9ad1ff}` +
      `.card{border:1px solid #2a2a2e;border-radius:10px;padding:20px;background:#141416}` +
      `.muted{color:#a3a3a8}.warn{border-color:#a15c00;background:#241a0b}ul{padding-left:20px}` +
      `button{font:inherit;border-radius:8px;padding:10px 18px;border:1px solid #3a3a40;background:#1d1d21;color:#ececec;cursor:pointer}` +
      `button.primary{background:#9ad1ff;border-color:#9ad1ff;color:#0a0a0b;font-weight:600}.row{display:flex;gap:10px;margin-top:18px}` +
      `@media (prefers-color-scheme: light){body{background:#fafafa;color:#151517}.card{background:#fff;border-color:#e2e2e6}` +
      `.muted{color:#5c5c63}.brand{color:#1c5d99}button{background:#f1f1f3;border-color:#d4d4da;color:#151517}` +
      `button.primary{background:#1c5d99;border-color:#1c5d99;color:#fff}.warn{background:#fff6e5;border-color:#e0a040}}` +
      `</style></head><body><main><div class="brand">NumberBroom</div>${body}</main></body></html>`,
    { status, headers }
  );
}

function startAgain(message: string, status = 400): Response {
  return page(
    "Connect NumberBroom",
    `<h1>Start again from your assistant</h1><div class="card"><p>${escape(message)}</p>` +
      `<p class="muted">Go back to the assistant and connect NumberBroom again. Nothing was connected and nothing was charged.</p></div>`,
    status
  );
}

/** Who is asking, by the name we can stand behind: the CIMD domain when there is one. */
function clientWho(d: ConsentDescription): string {
  return d.clientDomain || d.redirectHost;
}

export function consentHtml(d: ConsentDescription, handle: string): string {
  const name = escape(d.clientName);
  const origin = d.clientDomain
    ? `Published by <strong>${escape(d.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  return (
    `<h1>Allow ${name} to use your NumberBroom account?</h1>` +
    `<div class="card"><p>${origin} Access will be sent to <strong>${escape(d.redirectHost)}</strong>.</p>` +
    (d.redirectIsLoopback
      ? `<p class="card warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>`
      : "") +
    `<p>It will be able to:</p><ul>` +
    `<li>verify phone numbers, at $0.20 each from your prepaid credit</li>` +
    `<li>check your credit balance</li>` +
    `<li>give you links to add credit or to pay for scrubbing a whole list</li></ul>` +
    `<p class="muted">It never sees your card or an API key. Disconnect it any time in Settings.</p>` +
    `<form method="post"><input type="hidden" name="handle" value="${escape(handle)}">` +
    `<div class="row"><button class="primary" name="decision" value="approve">Continue</button>` +
    `<button name="decision" value="deny">Cancel</button></div></form></div>`
  );
}

function hasReadyCookie(request: Request): boolean {
  return (request.headers.get("cookie") || "").split(/;\s*/).includes(`${READY_COOKIE}=1`);
}

async function authorizeGet(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const url = new URL(request.url);

  // Not ready yet: sign in or sign up, and add credit, on numberbroom.com,
  // where nothing is timed. The library's sign-in step after consent lasts
  // ten minutes, too short for a new account plus a Stripe payment.
  if (!hasReadyCookie(request)) {
    const next = `${url.pathname}${url.search}`;
    const to = `/connect?next=${encodeURIComponent(next)}&app=${encodeURIComponent(clientWho(details))}`;
    return new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store" } });
  }

  const consent = await oauth.beginConsent(authRequest);
  consent.headers.append("Set-Cookie", `${READY_COOKIE}=; Max-Age=0; Path=/oauth; Secure; SameSite=Lax`);
  return page(`Allow ${details.clientName}?`, consentHtml(details, consent.handle), 200, consent.headers);
}

/** The posted form, or an empty one when the body is missing or not a form. */
async function formOf(request: Request): Promise<FormData> {
  return request.formData().catch(() => new FormData());
}

async function authorizePost(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await formOf(request);
  const handle = String(form.get("handle") || "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  // No scope argument: the request's own scopes stand, and a refresh can never
  // ask for one that was not granted.
  const approved = await oauth.approveConsent(request, handle);
  const details = await oauth.describeConsent(approved.request);
  const { state, headers } = await oauth.beginUpstream(approved.request, {
    data: { clientId: details.clientId, who: clientWho(details), name: details.clientName },
    headers: approved.headers,
  });
  headers.set("Location", `/connect?state=${encodeURIComponent(state)}&app=${encodeURIComponent(clientWho(details))}`);
  return new Response(null, { status: 302, headers });
}

interface UpstreamData {
  clientId: string;
  who: string;
  name: string;
}

async function callback(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await formOf(request);
  const code = String(form.get("code") || "");
  const state = new URL(request.url).searchParams.get("state") || "";
  const { request: original, data, headers } = await oauth.finishUpstream<UpstreamData>(request);

  const fail = (description: string) => {
    headers.set("Location", authorizationErrorRedirect(original, "server_error", description));
    return new Response(null, { status: 302, headers });
  };

  const resp = await forward(`${SITE}/api/internal/mcp/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mcp-secret": env.MCP_INTERNAL_SECRET },
    body: JSON.stringify({
      code,
      state,
      clientId: data.clientId,
      clientLabel: `${data.name} via ${data.who}`.slice(0, 60),
    }),
  });
  const body = resp ? ((await readJson(resp)) as Record<string, unknown> | undefined) : undefined;
  if (!resp || !resp.ok || !body || typeof body.key !== "string" || !KEY_RE.test(body.key) || typeof body.subject !== "string") {
    return fail("NumberBroom could not finish connecting this account. Try again.");
  }

  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: body.subject,
    metadata: { client: data.who },
    scope: original.scope,
    props: { apiKey: body.key, keyId: typeof body.keyId === "string" ? body.keyId : undefined, via: "oauth" } satisfies Props,
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

export const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/oauth/authorize" && request.method === "GET") return await authorizeGet(request, env);
      if (pathname === "/oauth/authorize" && request.method === "POST") return await authorizePost(request, env);
      if (pathname === "/oauth/callback" && request.method === "POST") return await callback(request, env);
      if (pathname === "/oauth/callback") return startAgain("This page only finishes a connection that is in progress.");
      return new Response("Not found", { status: 404 });
    } catch (error) {
      // Redirect to the client only once the library has validated it and its
      // redirect URI; everything else is shown here.
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError) return startAgain(error.description || "This connection request is not valid.");
      if (error instanceof CimdFetchError) return startAgain("This app could not be verified.");
      throw error;
    }
  },
};

// ─── Token callbacks ─────────────────────────────────────────────────────────

/**
 * On a refresh, ask the API whether the grant's key still works (the balance
 * check is free). A key revoked in Settings ends the grant, so the client
 * re-authorizes rather than retrying a connection that can never work. Only
 * the API's own JSON 401 means revoked; anything else is a hiccup.
 */
export async function tokenExchangeCallback(options: TokenExchangeCallbackOptions<Env>) {
  if (options.grantType !== "refresh_token") return;
  const key = (options.props as Props | undefined)?.apiKey;
  if (!key || !KEY_RE.test(key)) throw new OAuthError("invalid_grant", { description: "This connection has no key" });
  const resp = await forward(`${API_BASE}/credits`, {
    headers: { authorization: `Bearer ${key}`, [CLIENT_HEADER]: CLIENT_NAME },
  });
  if (resp?.ok) return;
  const data = resp ? await readJson(resp) : undefined;
  if (resp && isRevoked(resp.status, data)) {
    throw new OAuthError("invalid_grant", { description: "This connection was disconnected in NumberBroom's Settings" });
  }
  throw new OAuthError("temporarily_unavailable", { description: "NumberBroom is unavailable; try again shortly", statusCode: 503 });
}

/** A NumberBroom API key in the header, as before OAuth existed. Format only; the API checks it on every call. */
export async function resolveExternalToken({ token }: { token: string }) {
  if (!KEY_RE.test(token)) return null;
  return { props: { apiKey: token, via: "key" } satisfies Props, audience: RESOURCE };
}

const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpApi as any,
  defaultHandler: authHandler as any,
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  // CIMD only: Claude and ChatGPT both use it when it is offered, client IDs
  // stay stable, and nobody can write to KV by registering. No DCR endpoint.
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: {
    resource: RESOURCE,
    authorization_servers: [SITE],
    bearer_methods_supported: ["header"],
    resource_name: "NumberBroom",
  },
  accessTokenTTL: 3600,
  refreshTokenTTL: 30 * 86400,
  refreshTokenIdleTTL: 30 * 86400,
  tokenExchangeCallback,
  resolveExternalToken,
});

/**
 * Where a person lands. `/mcp` is the machine endpoint, so a request that asks
 * for HTML and not for an event stream is a browser, sent to the setup page.
 * Only on /mcp: the OAuth pages are browser pages too.
 */
export const DOCS_URL = `${SITE}/mcp-server`;

export function wantsHtml(request: Request): boolean {
  if (request.method !== "GET") return false;
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html") && !accept.includes("text/event-stream");
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/mcp" && wantsHtml(request)) return Response.redirect(DOCS_URL, 302);
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
