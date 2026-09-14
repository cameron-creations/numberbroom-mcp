/**
 * Remote MCP server for the NumberBroom phone verification API.
 *
 * This is a thin, stateless proxy — it has no user database and does not run
 * an OAuth flow. Whoever configures this MCP connection supplies their own
 * NumberBroom API key as a Bearer token in the connection's Authorization
 * header (get one at https://numberbroom.com/settings); every tool call here
 * forwards that header verbatim to https://numberbroom.com/api/v1/*, which
 * already owns auth, rate limiting, billing and the circuit breaker. This
 * server adds nothing to that trust boundary — it only translates MCP tool
 * calls into the same REST calls documented at https://numberbroom.com/developers.
 *
 * Built on the MCP SDK v2 stateless handler (`createMcpHandler`), not the
 * older Durable-Object-backed `McpAgent` — there is no session state to
 * persist here, so the SDK constructs a fresh, isolated server per request
 * and no state ever crosses between callers.
 */

import { McpServer, type CallToolResult, type McpRequestContext } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const API_BASE = "https://numberbroom.com/api/v1";

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
 * a 502 from Cloud Run mid-deploy. Before this, `resp.json()` threw and the
 * agent saw a parser exception. It deliberately does not claim the call was
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

/** fetch that turns a network failure into null instead of a throw. */
async function forward(url: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, init);
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

const NO_AUTH_RESULT: CallToolResult = {
  isError: true,
  content: [
    {
      type: "text",
      text:
        "No NumberBroom API key was supplied on this connection. Configure this MCP " +
        "connection's Authorization header as `Bearer nb_live_...`. Get a key at " +
        "https://numberbroom.com/settings (free to generate; usage is billed against " +
        "your NumberBroom account's pre-paid credit balance).",
    },
  ],
};

function errorResult(status: number, data: unknown): CallToolResult {
  const message =
    (typeof data === "object" && data !== null && "message" in data && String((data as any).message)) ||
    (typeof data === "object" && data !== null && "error" in data && String((data as any).error)) ||
    "Unknown error.";
  return {
    isError: true,
    content: [{ type: "text", text: `NumberBroom API error (HTTP ${status}): ${message}` }],
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

/**
 * Exported separately from tool registration so tests can call it directly
 * with a mocked global fetch, without simulating a full MCP JSON-RPC
 * handshake. Behavior is unchanged from before this was extracted.
 */
export async function verifyPhoneNumber(
  authHeader: string | null,
  phone: string
): Promise<CallToolResult> {
  if (!authHeader) return NO_AUTH_RESULT;

  const resp = await forward(`${API_BASE}/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: authHeader,
      [CLIENT_HEADER]: CLIENT_NAME,
    },
    body: JSON.stringify({ phone }),
  });
  if (!resp) return UNREACHABLE_RESULT;
  const data = await readJson(resp);
  if (data === undefined || data === null || typeof data !== "object") return unexpectedResult(resp.status);
  if (!resp.ok) return errorResult(resp.status, data);

  const d = data as Record<string, unknown>;
  const summary = d.valid
    ? `${d.e164}: ${d.lineType}${d.carrier ? ` on ${d.carrier}` : ""}${
        d.isLitigator ? " — FLAGGED as a known TCPA litigator" : ""
      }. Charged $${d.charged}.`
    : `"${phone}" is not a parsable US phone number. Not charged.`;
  return jsonResult(summary, data);
}

/** See verifyPhoneNumber's comment — same reason this is a standalone export. */
export async function getCreditBalance(authHeader: string | null): Promise<CallToolResult> {
  if (!authHeader) return NO_AUTH_RESULT;

  const resp = await forward(`${API_BASE}/credits`, {
    headers: { authorization: authHeader, [CLIENT_HEADER]: CLIENT_NAME },
  });
  if (!resp) return UNREACHABLE_RESULT;
  const data = await readJson(resp);
  if (data === undefined || data === null || typeof data !== "object") return unexpectedResult(resp.status);
  if (!resp.ok) return errorResult(resp.status, data);

  const d = data as Record<string, unknown>;
  return jsonResult(
    `$${d.credits} remaining — enough for about ${d.lookupsRemaining} lookups at $${d.ratePerLookup} each.`,
    data
  );
}

function createServer(ctx: McpRequestContext): McpServer {
  const server = new McpServer({ name: "numberbroom", version: "1.0.1" });
  const authHeader = ctx.requestInfo?.headers.get("authorization") ?? null;

  server.registerTool(
    "verify_phone_number",
    {
      description:
        "Verify a single US phone number: carrier-level line type (mobile, landline, VoIP, " +
        "disconnected), carrier name, an activity score, and whether the number is a known " +
        "TCPA litigator. Does not check Do Not Call registries. Costs $0.20, charged against " +
        "the caller's NumberBroom API credit balance — a number that fails to parse as a " +
        "phone number is not charged. Get an API key at https://numberbroom.com/settings.",
      inputSchema: {
        phone: z
          .string()
          .min(1)
          .max(40)
          .describe("The phone number to verify, in any common US format (e.g. \"(555) 123-4567\")."),
      },
    },
    ({ phone }) => verifyPhoneNumber(authHeader, phone)
  );

  server.registerTool(
    "get_credit_balance",
    {
      description:
        "Check the remaining pre-paid API credit balance for the connected NumberBroom " +
        "account. Free to call — does not spend credits.",
      inputSchema: {},
    },
    () => getCreditBalance(authHeader)
  );

  return server;
}

/**
 * Where a person lands. `/mcp` is the machine endpoint, and Streamable HTTP
 * answers a plain browser GET with 405 -- which is what anyone clicking the
 * URL out of llms.txt, the MCP registry or a chat answer used to see. A
 * request that asks for HTML and not for an event stream is a browser, not
 * an MCP client, so it is sent to the setup page instead. MCP clients open
 * the SSE stream with `Accept: text/event-stream` and POST everything else,
 * so neither path is touched; curl's default `Accept: *\/*` still gets the
 * 405 that deploy.yml's route check relies on.
 */
export const DOCS_URL = "https://numberbroom.com/mcp-server";

export function wantsHtml(request: Request): boolean {
  if (request.method !== "GET") return false;
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html") && !accept.includes("text/event-stream");
}

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    if (wantsHtml(request)) return Response.redirect(DOCS_URL, 302);
    return createMcpHandler(createServer)(request, env, ctx);
  },
} satisfies ExportedHandler;
