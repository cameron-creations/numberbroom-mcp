/**
 * The MCP endpoint itself, through the real OAuthProvider and createMcpHandler,
 * with NumberBroom's API mocked at fetch. A patched SDK refuses a shared server
 * or transport and leaves its size limits off, so what this pins is:
 *   - real SDK clients of both generations connect, list and call with a header
 *     key, on the legacy protocol lane and on the 2026-07-28 one
 *   - two callers answered at the same moment under the same JSON-RPC id each
 *     get their own answer (GHSA-jm63-cq47-j5jp)
 *   - the largest legal list still goes through, and anything past the limits
 *     is refused before it reaches the API (GHSA-46jr-4wx8-v453)
 * The same limits on an OAuth token are in oauth.test.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Client as Client2, StreamableHTTPClientTransport as Transport2 } from "@modelcontextprotocol/client";
import { Client as Client1 } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as Transport1 } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import worker, { MAX_REQUEST_BYTES, MAX_TOOL_INPUT_ELEMENTS } from "../src/index";

const SITE = "https://numberbroom.com";
const MCP_URL = new URL(`${SITE}/mcp`);
const KEY_A = "nb_live_" + "aa".repeat(32);
const KEY_B = "nb_live_" + "bb".repeat(32);

afterEach(() => vi.unstubAllGlobals());

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env as any, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** NumberBroom's API, answering each key with its own carrier so a crossed answer shows. */
function stubApi() {
  const seen: { url: string; authorization: string | null; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const authorization = new Headers(init.headers).get("authorization");
      seen.push({ url, authorization, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === `${SITE}/api/v1/verify`) {
        // Long enough that a second request is in flight before this one answers.
        await new Promise((resolve) => setTimeout(resolve, 20));
        const carrier = authorization === `Bearer ${KEY_A}` ? "Carrier-A" : "Carrier-B";
        return Response.json({ valid: true, e164: "+14155553000", lineType: "mobile", carrier, isLitigator: false, charged: 0.2 });
      }
      if (url === `${SITE}/api/v1/lists`) {
        return Response.json({ rowCount: 1, chargedNumbers: 1, amount: 5, url: "https://checkout.example/x", jobId: "job_12345678" });
      }
      return new Response("unexpected fetch " + url, { status: 599 });
    })
  );
  return seen;
}

function rawCall(key: string, body: BodyInit, headers: Record<string, string> = {}) {
  return new Request(MCP_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      ...headers,
    },
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

const toolCall = (name: string, args: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

/** A Streamable HTTP body may be plain JSON or one SSE message: the parsed JSON-RPC reply either way. */
function reply(text: string): any {
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice(6) : text);
}

const numbers = (n: number, width = 40) => Array.from({ length: n }, () => "1".repeat(width));

function streamOf(bytes: Uint8Array) {
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 64 * 1024) controller.enqueue(bytes.slice(i, i + 64 * 1024));
      controller.close();
    },
  });
}

/** The client's way into the Worker, noting each request's protocol version. */
const transportOptions = (key: string, protocols: string[]) => ({
  requestInit: { headers: { authorization: `Bearer ${key}` } },
  fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as any, init);
    const version = req.headers.get("mcp-protocol-version");
    if (version) protocols.push(version);
    return call(req);
  }) as any,
});

const INFO = { name: "test", version: "1.0.0" };
const LANES = [
  {
    lane: "the 1.x SDK client, on the legacy lane",
    protocol: "2025-11-25",
    connect: async (key: string, protocols: string[] = []) => {
      const client = new Client1(INFO);
      await client.connect(new Transport1(MCP_URL, transportOptions(key, protocols)));
      return client;
    },
  },
  {
    lane: "the 2.x SDK client, on the legacy lane",
    protocol: "2025-11-25",
    connect: async (key: string, protocols: string[] = []) => {
      const client = new Client2(INFO);
      await client.connect(new Transport2(MCP_URL, transportOptions(key, protocols)));
      return client;
    },
  },
  {
    lane: "the 2.x SDK client, on the 2026-07-28 lane",
    protocol: "2026-07-28",
    connect: async (key: string, protocols: string[] = []) => {
      const client = new Client2(INFO, { versionNegotiation: { mode: "auto" } });
      await client.connect(new Transport2(MCP_URL, transportOptions(key, protocols)));
      return client;
    },
  },
];

describe.each(LANES)("$lane", ({ protocol, connect }) => {
  it("connects with a header key, lists the five tools and calls one, twice", async () => {
    const seen = stubApi();
    const protocols: string[] = [];
    const client = await connect(KEY_A, protocols);

    const { tools } = await client.listTools();
    expect(tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "buy_credits",
      "get_credit_balance",
      "get_list_status",
      "scrub_list",
      "verify_phone_number",
    ]);

    // Twice, because a server or transport shared between requests fails on the second.
    for (let i = 0; i < 2; i++) {
      const result: any = await client.callTool({ name: "verify_phone_number", arguments: { phone: "4155553000" } });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("Carrier-A");
    }
    expect(seen.filter((s) => s.url.endsWith("/verify")).map((s) => s.authorization)).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_A}`]);
    expect(protocols.at(-1)).toBe(protocol);
    await client.close();
  });

  it("gives two callers at the same moment their own answers", async () => {
    stubApi();
    const [a, b] = await Promise.all([connect(KEY_A), connect(KEY_B)]);
    // Each client numbers its requests from 0, so these ids collide, as the advisory describes.
    const answers: any[] = await Promise.all(
      [a, b, a, b].map((client) => client.callTool({ name: "verify_phone_number", arguments: { phone: "4155553000" } }))
    );
    expect(answers.map((r) => r.content[0].text.match(/Carrier-[AB]/)![0])).toEqual(["Carrier-A", "Carrier-B", "Carrier-A", "Carrier-B"]);
    await Promise.all([a.close(), b.close()]);
  });

  it("takes the largest legal list, and refuses a longer one without calling the API", async () => {
    const seen = stubApi();
    const client = await connect(KEY_A);

    const full: any = await client.callTool({ name: "scrub_list", arguments: { numbers: numbers(10_000), mode: "full" } });
    expect(full.isError).toBeFalsy();
    expect(seen.filter((s) => s.url.endsWith("/lists")).map((s) => s.body.numbers.length)).toEqual([10_000]);
    seen.length = 0;

    // One over the tool's own limit: the schema refuses it.
    const oneOver: any = await client.callTool({ name: "scrub_list", arguments: { numbers: numbers(10_001, 1) } });
    expect(oneOver.isError).toBe(true);
    expect(oneOver.content[0].text).toContain("10000");

    // Past the element limit: refused before the schema looks at any of it.
    const tooMany: any = await client.callTool({ name: "scrub_list", arguments: { numbers: numbers(MAX_TOOL_INPUT_ELEMENTS + 1, 1) } });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.content[0].text).toContain(`maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`);

    expect(seen).toEqual([]);
    await client.close();
  });
});

describe("a body past the limit", () => {
  const tooBig = new TextEncoder().encode(toolCall("scrub_list", { numbers: numbers(Math.ceil(MAX_REQUEST_BYTES / 40)) }));

  it("is a 413 on its Content-Length alone, with the body left unread", async () => {
    const seen = stubApi();
    const res = await call(rawCall(KEY_A, toolCall("get_credit_balance", {}), { "content-length": String(MAX_REQUEST_BYTES + 1) }));
    expect(res.status).toBe(413);
    expect((await res.json<any>()).error.message).toContain(String(MAX_REQUEST_BYTES));
    expect(seen).toEqual([]);
  });

  it("is a 413 with no Content-Length to read, on the bytes that arrive", async () => {
    const seen = stubApi();
    expect(tooBig.byteLength).toBeGreaterThan(MAX_REQUEST_BYTES);
    const req = rawCall(KEY_A, streamOf(tooBig));
    expect(req.headers.get("content-length")).toBeNull();
    const res = await call(req);
    expect(res.status).toBe(413);
    expect(seen).toEqual([]);
  });

  it("leaves a streamed request inside the limit alone", async () => {
    stubApi();
    const bytes = new TextEncoder().encode(toolCall("verify_phone_number", { phone: "4155553000" }));
    const res = await call(rawCall(KEY_A, streamOf(bytes)));
    expect(res.status).toBe(200);
    expect(reply(await res.text()).result.content[0].text).toContain("Carrier-A");
  });
});

describe("a key checked only for its format", () => {
  // resolveExternalToken cannot tell a real key from a made-up one, so these limits are what an
  // anonymous caller meets first. Nothing here reaches the API.
  const madeUp = "nb_live_" + "0".repeat(64);

  it("meets the element limit", async () => {
    const seen = stubApi();
    const res = await call(rawCall(madeUp, toolCall("scrub_list", { numbers: numbers(MAX_TOOL_INPUT_ELEMENTS + 1, 1) })));
    expect(reply(await res.text()).result.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("meets the body limit", async () => {
    const seen = stubApi();
    const res = await call(rawCall(madeUp, toolCall("scrub_list", { numbers: numbers(Math.ceil(MAX_REQUEST_BYTES / 40)) })));
    expect(res.status).toBe(413);
    expect(seen).toEqual([]);
  });
});
