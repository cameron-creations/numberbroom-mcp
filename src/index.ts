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

  const resp = await fetch(`${API_BASE}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: authHeader },
    body: JSON.stringify({ phone }),
  });
  const data = await resp.json();
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

  const resp = await fetch(`${API_BASE}/credits`, {
    headers: { authorization: authHeader },
  });
  const data = await resp.json();
  if (!resp.ok) return errorResult(resp.status, data);

  const d = data as Record<string, unknown>;
  return jsonResult(
    `$${d.credits} remaining — enough for about ${d.lookupsRemaining} lookups at $${d.ratePerLookup} each.`,
    data
  );
}

function createServer(ctx: McpRequestContext): McpServer {
  const server = new McpServer({ name: "numberbroom", version: "1.0.0" });
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

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    return createMcpHandler(createServer)(request, env, ctx);
  },
} satisfies ExportedHandler;
