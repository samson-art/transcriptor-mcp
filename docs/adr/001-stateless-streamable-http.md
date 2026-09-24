# 001. MCP is served over native, stateless Streamable HTTP; auth and edge limits stay outside the process

- **Status:** Accepted
- **Date:** 2026-08-13 (1.2.1)
- **Sources:** d9cce87 / PR #3 (restore as transport only), 824c38b (the earlier removal, 1.0.0), 757a871 (x-request-id, canary), CHANGELOG 1.0.0, 1.1.0, 1.2.1

## Context

From 1.0.0 to 1.2.0 the server spoke stdio only, and remote clients reached it through the Python `mcp-proxy` sidecar. The earlier in-process HTTP layer (Bearer auth, rate limits, sessions, legacy SSE, Smithery URL rewriting, `.well-known` documents) had been deleted.

The sidecar became a dead end. Python `mcp` 2.x renamed `streamablehttp_client`, and `mcp-proxy` 0.11.0 still imported the old name (PR #3 says 0.12.0 is not compatible either). The sidecar also owned the HTTP surface that the current MCP spec gives to the server (header validation, JSON-RPC error bodies), served the legacy HTTP+SSE transport, and hid the `mcp_*` metrics because nothing exposed `/metrics`.

## Decision

`src/mcp-http.ts` is a small Fastify app:

- `POST /mcp` in the SDK's stateless mode. No `Mcp-Session-Id` is issued. Each request gets a new `McpServer` and transport, because the SDK throws when a stateless transport is reused.
- `GET` and `DELETE /mcp` answer 405. Otherwise the stateless transport opens an SSE stream that never delivers a message.
- Every error is a JSON-RPC envelope. `/health` and `/metrics` share the port.
- No authentication and no rate limits in the process. A gateway or reverse proxy in front terminates auth; edge limits stay at the edge.
- The image's default command is HTTP (`start:mcp:http`). stdio stays available through `npm run start:mcp`, which `server.json` passes as package arguments.

The old auth, Smithery and `.well-known` layer was deliberately not restored.

## Alternatives

- **stdio plus the `mcp-proxy` sidecar** (1.0.0–1.2.0). Rejected: dependency dead end, no control of the HTTP surface, legacy SSE.
- **Restore the old in-process layer** with auth, rate limits and discovery documents. Rejected: the gateway owns auth, the edge owns limits, and only the transport needs to be here.
- **Stateful sessions.** Both earlier designs had them (a session map with a TTL, then `mcp-proxy`'s session ids). Not chosen: stateless lets any instance answer any request.
- **Keep stdio as the image default.** Rejected: deployments already mapped the HTTP port. This was a breaking change for stdio users, noted in CHANGELOG 1.2.1.

## Consequences

- The server scales horizontally with no session affinity. Shared state lives at module level (holds, in-flight maps, canary), never on the server instance.
- The listener has no auth and adopts an inbound `x-request-id`. Operators must publish port 4200 only on loopback or a private network that the proxy reaches. The default bind is `0.0.0.0`.
- Old `/sse` clients must move to `POST /mcp`.

## Don't

- Don't bring back `mcp-proxy`, `MCP_AUTH_TOKEN`, in-process rate limits on `/mcp`, `/sse` or `/status`. Documents that describe those as current are describing the superseded design.
- Don't hoist the transport or server to module scope "for efficiency". The SDK throws on the second request (`src/mcp-http.test.ts`).
- Don't remove the `GET`/`DELETE` 405 route as redundant, or switch the image `CMD` back to stdio.
- `src/e2e/mcp-smoke.ts` asserts no session header, a working `tools/list`, and 405 on `GET`.
