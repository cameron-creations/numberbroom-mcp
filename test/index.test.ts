import { describe, it, expect, vi, afterEach } from "vitest";
import worker, {
  verifyPhoneNumber,
  getCreditBalance,
  buyCredits,
  scrubList,
  getListStatus,
  wantsHtml,
  DOCS_URL,
  CLIENT_HEADER,
} from "../src/index";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { env } from "cloudflare:test";

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
    expect(textAt(result)).toContain("no NumberBroom account");
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

    const [url, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe("https://numberbroom.com/api/v1/verify");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer nb_live_test");
    expect(init.body).toBe(JSON.stringify({ phone: "5551234567" }));
    expect(result.isError).toBeUndefined();
    expect(textAt(result)).toContain("mobile on Verizon Wireless");
    expect(textAt(result)).not.toContain("disconnected");
    expect(textAt(result)).toContain("Charged $0.2.");
  });

  it("says a likely-disconnected mobile is likely disconnected", async () => {
    // The provider has no "disconnected" line type: a dead mobile still
    // reports "mobile", and only isLikelyDisconnected says otherwise.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            e164: "+15551234567",
            valid: true,
            lineType: "mobile",
            carrier: "Verizon Wireless",
            isLitigator: false,
            activityScore: 12,
            isLikelyDisconnected: true,
            outcome: "disconnected",
            keep: false,
            charged: 0.2,
          }),
          { status: 200 }
        )
      )
    );

    const result = await verifyPhoneNumber("Bearer nb_live_test", "5551234567");

    expect(textAt(result)).toContain("mobile on Verizon Wireless, likely disconnected (activity score 12)");
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

    const [url, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe("https://numberbroom.com/api/v1/credits");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer nb_live_test");
    expect(textAt(result)).toBe("$24.8 remaining -- enough for about 124 lookups at $0.2 each.");
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
      env,
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

  it("answers a bare GET (curl's Accept: */*) with the OAuth challenge deploy.yml checks for", async () => {
    const res = await worker.fetch(new Request(url, { headers: { accept: "*/*" } }), env, ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://numberbroom.com/.well-known/oauth-protected-resource/mcp"'
    );
  });

  it("does not send the OAuth pages to the setup page, though a browser asks for them", async () => {
    const res = await worker.fetch(
      new Request("https://numberbroom.com/oauth/callback", { headers: { accept: "text/html" } }),
      env,
      ctx
    );
    expect(res.headers.get("location")).not.toBe(DOCS_URL);
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
      expect(new Headers(call[1].headers).get(CLIENT_HEADER)).toBe("mcp");
      expect(new Headers(call[1].headers).get("user-agent")).toMatch(/^NumberBroom-MCP\//);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("buying tools", () => {
  const ok = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  const sent = (m: ReturnType<typeof vi.fn>) => (m.mock.calls as unknown as [string, RequestInit][])[0];

  it("buy_credits asks /v1/credits/checkout for that amount and hands back the link", async () => {
    const m = ok({ url: "https://checkout.stripe.com/c/pay/x", sessionId: "cs_1" });
    vi.stubGlobal("fetch", m);
    const result = await buyCredits("Bearer nb_live_test", 25);
    const [url, init] = sent(m);
    expect(url).toBe("https://numberbroom.com/api/v1/credits/checkout");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ amount: 25 });
    expect(textAt(result)).toContain("https://checkout.stripe.com/c/pay/x");
  });

  it("scrub_list sends the numbers and mode to /v1/lists and reports price, link and job", async () => {
    const m = ok({ jobId: "job-1234", url: "https://checkout.stripe.com/c/pay/y", rowCount: 31, chargedNumbers: 30, amount: 6, scrubMode: "litigator_only" });
    vi.stubGlobal("fetch", m);
    const result = await scrubList("Bearer nb_live_test", ["4155553000"], "litigator_only");
    const [url, init] = sent(m);
    expect(url).toBe("https://numberbroom.com/api/v1/lists");
    expect(JSON.parse(String(init.body))).toEqual({ numbers: ["4155553000"], scrubMode: "litigator_only" });
    expect(textAt(result)).toContain("$6");
    expect(textAt(result)).toContain("job-1234");
    expect(textAt(result)).toContain("https://checkout.stripe.com/c/pay/y");
  });

  it("get_list_status reads /v1/lists/:jobId and passes on the hour-long download link", async () => {
    const m = ok({ jobId: "job-1234", status: "complete", paid: true, totalNumbers: 31, cleanCount: 20, litigatorCount: 2, voipLandlineCount: 5, disconnectedCount: 3, downloadUrl: "https://numberbroom.com/api/download/job-1234?token=t" });
    vi.stubGlobal("fetch", m);
    const result = await getListStatus("Bearer nb_live_test", "job-1234");
    expect(sent(m)[0]).toBe("https://numberbroom.com/api/v1/lists/job-1234");
    expect(textAt(result)).toContain("20 kept of 31");
    expect(textAt(result)).toContain("/api/download/job-1234?token=t");
  });

  it("an unpaid list says it is waiting for payment", async () => {
    vi.stubGlobal("fetch", ok({ jobId: "job-1234", status: "awaiting_payment", paid: false }));
    expect(textAt(await getListStatus("Bearer nb_live_test", "job-1234"))).toContain("Not paid yet");
  });

  it("out of credit points the agent at buy_credits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "insufficient_credits", message: "Not enough API credits. Top up to continue." }), { status: 402 })));
    const result = await verifyPhoneNumber("Bearer nb_live_test", "4155553000");
    expect(result.isError).toBe(true);
    expect(textAt(result)).toContain("buy_credits");
  });

  it("the API's own 401 tells the caller the key is gone; a 401 page from anywhere else does not", async () => {
    let revoked = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized", message: "Invalid or revoked API key." }), { status: 401 })));
    await getCreditBalance("Bearer nb_live_test", () => revoked++);
    expect(revoked).toBe(1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>401</html>", { status: 401 })));
    await getCreditBalance("Bearer nb_live_test", () => revoked++);
    expect(revoked).toBe(1);
  });
});
