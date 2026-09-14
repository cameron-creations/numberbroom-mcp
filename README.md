# NumberBroom MCP Server

A remote [MCP](https://modelcontextprotocol.io) server that lets AI agents (Claude Code, Cursor,
Claude Desktop and other MCP clients that can send an Authorization header) verify US phone numbers through the
[NumberBroom](https://numberbroom.com) API: carrier-level line type, carrier name, an activity
score, and TCPA litigator status.

This server is a thin, stateless proxy. It has no database and runs no OAuth flow — it forwards
your NumberBroom API key straight through to `https://numberbroom.com/api/v1`, which already
owns authentication, rate limiting, billing, and abuse protection. See
[numberbroom.com/developers](https://numberbroom.com/developers) for the underlying REST API
this wraps.

## Tools

| Tool | Description | Cost |
|---|---|---|
| `verify_phone_number` | Line type, carrier, activity score, TCPA litigator flag for one US number. | $0.20/call, charged to your NumberBroom credit balance. Unparseable numbers are not charged. |
| `get_credit_balance` | Remaining pre-paid credit balance on your NumberBroom account. | Free. |

## Get an API key

1. Sign up at [numberbroom.com](https://numberbroom.com) and add credit to your account.
2. Generate an API key at [numberbroom.com/settings](https://numberbroom.com/settings).

## Connect a client

Add this server as a remote MCP connection using its deployed URL,
`https://numberbroom.com/mcp`, with your NumberBroom API key as a Bearer token in the
`Authorization` header:

```
Authorization: Bearer nb_live_YOUR_KEY
```

Step-by-step setup for Claude Code, Cursor, Claude Desktop, ChatGPT and other clients, with
copy-paste config for each, is at [numberbroom.com/mcp-server](https://numberbroom.com/mcp-server).
Opening `https://numberbroom.com/mcp` in a browser redirects there; MCP clients are unaffected.

## Local development

```bash
npm install
npm run dev
```

This starts the server at `http://localhost:8787/mcp` via `wrangler dev`.

## Deploy

```bash
npm run deploy
```

Deploys to Cloudflare Workers as `numberbroom-mcp`. Requires a Cloudflare account
authenticated via `wrangler login`.

## Why a proxy, not a rewrite

Every tool call here is a direct, unmodified pass-through to NumberBroom's own `/api/v1`
endpoints. That means:

- Auth, rate limiting (5,000 lookups per key per day at most, and 500 for calls through this server
  unless the key has its own limit set in Settings), the circuit breaker, and billing are all
  enforced exactly once, by NumberBroom's own API — this server does not duplicate or
  second-guess any of it.
- A number that fails to parse costs nothing, same as calling the REST API directly.
- An upstream error page or network failure comes back to the agent as a plain tool error, never
  a thrown exception.
- This server never sees or stores your API key beyond the lifetime of a single request; each
  MCP tool call constructs an isolated server instance with no shared state between callers.

## License

MIT
