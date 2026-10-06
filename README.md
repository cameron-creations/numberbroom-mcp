# NumberBroom MCP Server

A remote [MCP](https://modelcontextprotocol.io) server that lets AI agents verify US phone numbers
through the [NumberBroom](https://numberbroom.com) API: carrier-level line type, carrier name, an
activity score with a likely-disconnected flag, and TCPA litigator status. Agents can also hand
their user a link to add credit, or to pay for scrubbing a whole list.

Every tool call becomes a call to `https://numberbroom.com/api/v1`, which owns rate limiting,
billing, refunds and abuse protection. See [numberbroom.com/developers](https://numberbroom.com/developers)
for the REST API this wraps.

## Tools

| Tool | Description | Cost |
|---|---|---|
| `verify_phone_number` | Line type, carrier, activity score, TCPA litigator flag for one US number. | $0.20/call from your NumberBroom credit. Unparseable numbers and numbers outside the US are not charged. |
| `get_credit_balance` | Remaining pre-paid credit on your NumberBroom account. | Free. |
| `buy_credits` | A Stripe Checkout link that adds credit to the account. | Free to call; the person pays on Stripe. |
| `scrub_list` | Sends a whole list (up to 10,000 numbers) for NumberBroom's paid list scrub and returns the price and a Stripe Checkout link. | Free to call; the person pays per list by card. |
| `get_list_status` | Status and counts for a list scrub, with one-hour download links once it is done: the cleaned file, and the rows of any numbers outside the US, which are not scrubbed or charged. | Free. |

## Connect a client

The server URL is `https://numberbroom.com/mcp`. There are two ways to connect:

- **Sign in (OAuth).** Clients that connect with a sign-in discover the authorization server from
  the server's 401 challenge. You sign in or create a NumberBroom account, add credit if the account
  has none, and approve. The client gets a token; the API key behind it stays inside the
  connection, and you can disconnect it any time in NumberBroom's Settings. Client registration is
  by Client ID Metadata Document only.
- **API key header.** Clients that send a header can use a key from
  [numberbroom.com/settings](https://numberbroom.com/settings):

  ```
  Authorization: Bearer nb_live_YOUR_KEY
  ```

Step-by-step setup for each client is at [numberbroom.com/mcp-server](https://numberbroom.com/mcp-server).
Opening `https://numberbroom.com/mcp` in a browser redirects there; MCP clients are unaffected.

## Local development

```bash
npm install
npm run dev
```

This starts the server at `http://localhost:8787/mcp` via `wrangler dev`. The OAuth flow needs the
`OAUTH_KV` binding (local under `wrangler dev`) and the `MCP_INTERNAL_SECRET` secret.

## Deploy

```bash
npm run deploy
```

Deploys to Cloudflare Workers as `numberbroom-mcp`. Requires a Cloudflare account
authenticated via `wrangler login`.

## How it is built

- **OAuth** is [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).
  NumberBroom's own sign-in (numberbroom.com/connect) is the identity step. After you approve,
  NumberBroom's API gives this Worker a key for your account server to server, and the Worker keeps
  it only inside the encrypted grant in KV. Tokens and codes are stored as hashes.
- **Limits and billing are enforced once, by NumberBroom's API**: 5,000 lookups per key per day at
  most, 500 for calls through this server unless the key has its own limit, the circuit breaker,
  and refunds for failed lookups.
- An upstream error page or network failure comes back to the agent as a plain tool error, never
  a thrown exception.
- Each request builds an isolated MCP server instance; no state crosses between callers.

## License

MIT
