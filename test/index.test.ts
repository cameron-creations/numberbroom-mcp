import { describe, it, expect, vi, afterEach } from "vitest";
import worker, { verifyPhoneNumber, getCreditBalance, wantsHtml, DOCS_URL, CLIENT_HEADER } from "../src/index";
import type { CallToolResult } from "@modelcontextprotocol/server";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Content blocks are a union (text/image/audio/...); every result here uses text blocks only. */
function textAt(result: CallToolResult, i = 0): string {
  const block = result.content[i];
  if (block.type !== "text") throw new Error(`content[${i}] is not a text block: ${block.type}`);
  return block.text;
}

describe("verifyPhoneNumber", () => {
  it("short-circuits with NO_AUTH_RESULT when no Authorization header is present", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyPhoneNumber(null, "5551234567");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(textAt(result)).toContain("No NumberBroom API key");
  });

  it("forwards the Authorization header and phone number to /v1/verify", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          phone: "5551234567",
          e164: "+15551234567",
          valid: true,
          lineType: "mobile",
          carrier: "Verizon Wireless",
          isLitigator: false,
          activityScore: 82,
          isLikelyDisconnected: false,
          outcome: "clean",
          keep: true,
          dncEvaluated: false,
          charged: 0.2,
          creditsRemaining: 24.8,
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyPhoneNumber("Bearer nb_live_test", "5551234567");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://numberbroom.com/api/v1/verify",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer nb_live_test" }),
        body: JSON.stringify({ phone: "5551234567" }),
      })
    );
    expect(result.isError).toBeUndefined();
    expect(textAt(result)).toContain("mobile on Verizon Wireless");
    expect(textAt(result)).toContain("Charged $0.2.");
  });

  it("flags a known TCPA litigator in the summary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            e164: "+15551234567",
            valid: true,
            lineType: "mobile",
            carrier: null,
            isLitigator: true,
            outcome: "flagged",
            keep: false,
            charged: 0.2,
          }),
          { status: 200 }
        )
      )
    );

    const result = await verifyPhoneNumber("Bearer nb_live_test", "5551234567");

    expect(textAt(result)).toContain("FLAGGED as a known TCPA litigator");
  });

  it("reports an unparseable number as a normal (non-error) result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            phone: "abc",
            e164: null,
            valid: false,
            outcome: "invalid",
            keep: false,
            charged: 0,
            message: "Not a parsable US phone number. Not charged.",
          }),
          { status: 200 }
        )
      )
    );

    const result = await verifyPhoneNumber("Bearer nb_live_test", "abc");

    expect(result.isError).toBeUndefined();
    expect(textAt(result)).toBe('"abc" is not a parsable US phone number. Not charged.');
  });

  it("surfaces an upstream error response as an MCP tool error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: "insufficient_credits",
            message: "Not enough API credits. Top up to continue.",
          }),
          { status: 402 }
        )
      )
    );

    const result = await verifyPhoneNumber("Bearer nb_live_test", "5551234567");

    expect(result.isError).toBe(true);
    expect(textAt(result)).toContain("HTTP 402");
    expect(textAt(result)).toContain("Not enough API credits");
  });
});

describe("getCreditBalance", () => {
  it("short-circuits with NO_AUTH_RESULT when no Authorization header is present", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCreditBalance(null);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it("forwards the Authorization header to /v1/credits and summarizes the balance", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ credits: 24.8, ratePerLookup: 0.2, lookupsRemaining: 124 }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCreditBalance("Bearer nb_live_test");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://numberbroom.com/api/v1/credits",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer nb_live_test" }) })
    );
    expect(textAt(result)).toBe("$24.8 remaining — enough for about 124 lookups at $0.2 each.");
  });

  it("surfaces an upstream error response as an MCP tool error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "unauthorized", message: "Invalid or revoked API key." }), {
          status: 401,
        })
      )
    );

    const result = await getCreditBalance("Bearer nb_live_bad");

    expect(result.isError).toBe(true);
    expect(textAt(result)).toContain("HTTP 401");
    expect(textAt(result)).toContain("Invalid or revoked API key");
  });
});

describe("browser GET on /mcp", () => {
  const url = "https://numberbroom.com/mcp";
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

  it("sends a browser (Accept: text/html) to the setup page", async () => {
    const res = await worker.fetch(
      new Request(url, { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } }),
      {},
      ctx
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(DOCS_URL);
    expect(DOCS_URL).toBe("https://numberbroom.com/mcp-server");
  });

  it("does not redirect an MCP client opening the event stream", () => {
    expect(wantsHtml(new Request(url, { headers: { accept: "text/event-stream" } }))).toBe(false);
    // A client that lists both is asking for the stream; the page is the fallback, not the answer.
    expect(wantsHtml(new Request(url, { headers: { accept: "text/html, text/event-stream" } }))).toBe(false);
  });

  it("does not redirect a POST, whatever it accepts", () => {
    expect(
      wantsHtml(new Request(url, { method: "POST", headers: { accept: "text/html" }, body: "{}" }))
    ).toBe(false);
  });

  it("keeps the bare GET (curl's Accept: */*) on the MCP handler, which deploy.yml checks for 405", async () => {
    const res = await worker.fetch(new Request(url, { headers: { accept: "*/*" } }), {}, ctx);
    expect(res.status).not.toBe(302);
    expect(res.status).toBe(405);
  });
});

describe("upstream that does not answer in JSON", () => {
  const html502 = () =>
    new Response("<html><body>502 Bad Gateway</body></html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });

  it("verify: an HTML error page becomes a clean tool error, not a thrown parse error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => html502()));
    const result = await verifyPhoneNumber("Bearer nb_live_test", "5551234567");
    expect(result.isError).toBe(true);
    expect(textAt(result)).toContain("HTTP 502");
    expect(textAt(result)).not.toMatch(/not charged/i);
  });

  it("verify: a 200 that is not JSON is still an error, never a success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!doctype html>", { status: 200 })));
    const result = await verifyPhoneNumber("Bearer nb_live_test", "5551234567");
    expect(result.isError).toBe(true);
    expect(textAt(result)).toContain("HTTP 200");
  });

  it("credits: an HTML error page becomes a clean tool error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => html502()));
    const result = await getCreditBalance("Bearer nb_live_test");
    expect(result.isError).toBe(true);
    expect(textAt(result)).toContain("HTTP 502");
  });

  it("a network failure becomes a clean tool error on both tools", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    for (const result of [
      await verifyPhoneNumber("Bearer nb_live_test", "5551234567"),
      await getCreditBalance("Bearer nb_live_test"),
    ]) {
      expect(result.isError).toBe(true);
      expect(textAt(result)).toContain("Could not reach");
    }
  });
});

describe("calls identify themselves as MCP", () => {
  it("both tools send the client header the API uses for the MCP daily default", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ credits: 1, ratePerLookup: 0.2, lookupsRemaining: 5 }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    await getCreditBalance("Bearer nb_live_test");
    await verifyPhoneNumber("Bearer nb_live_test", "5551234567");
    for (const call of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect((call[1].headers as Record<string, string>)[CLIENT_HEADER]).toBe("mcp");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
