# 001. The server serves MCP over native, stateless Streamable HTTP, and auth and edge limits stay outside the process

- Status: Accepted
- Date: 2026-08-13 (1.2.1), Origin rule 2026-10-30 (#82)
- Sources: d9cce87 / PR #3 (restore as transport only), 824c38b (the earlier removal, 1.0.0), 757a871 (x-request-id, canary), CHANGELOG 1.0.0, 1.1.0, 1.2.1, issue #82 (Origin rule)

## Context

From 1.0.0 to 1.2.0 the server spoke stdio only, and remote clients reached it through the Python `mcp-proxy` sidecar. The earlier in-process HTTP layer (Bearer auth, rate limits, sessions, legacy SSE, Smithery URL rewriting, `.well-known` documents) was already deleted in 824c38b.

The sidecar became a dead end. Python `mcp` 2.x renamed `streamablehttp_client`, and `mcp-proxy` 0.11.0 still imported the old name (PR #3 says 0.12.0 is not compatible either). The sidecar also owned the HTTP surface that the current MCP spec gives to the server (header validation, JSON-RPC error bodies). It served the legacy HTTP+SSE transport. It also hid the `mcp_*` metrics, because nothing exposed `/metrics`.

The spec says that the server must test the `Origin` header of every incoming connection, against DNS rebinding. In this attack, a hostile web page points its own domain name at a local address, and the browser sends the requests of the page to the server. Since 2025-11-25, a present `Origin` that is not valid must get 403. On 2026-10-07, a local 1.5.21 build answered `tools/list` with `Origin: https://example.com` with 200. The SDK option `allowedOrigins` is deprecated in SDK 1.30 and off by default, and its 403 text repeats the raw header. SDK 2.x leaves the test to the app.

## Decision

`src/mcp-http.ts` is a small Fastify app:

- `POST /mcp` in the SDK's stateless mode. The server issues no `Mcp-Session-Id`. Each request gets a new `McpServer` and transport. The SDK throws an error on reuse of a stateless transport.
- `GET` and `DELETE /mcp` answer 405. Otherwise the stateless transport opens an SSE stream that never delivers a message.
- Every error is a JSON-RPC envelope. `/health` and `/metrics` share the port.
- No authentication and no rate limits in the process. A gateway or reverse proxy in front terminates auth. Edge limits stay at the edge.
- The image's default command is HTTP (`start:mcp:http`). stdio stays available through `npm run start:mcp`, which `server.json` passes as package arguments.
- A `POST`, `GET` or `DELETE` request to `/mcp` with an `Origin` header that is not allowed gets 403 and a JSON-RPC error with code -32000. `HEAD` follows `GET`. The `onRequest` hook `refuseForeignOrigin` on both `/mcp` routes does this before a server or a transport exists, so no tool runs. The text is `ORIGIN_NOT_ALLOWED_MESSAGE` in `src/errors.ts`. The hook writes one warn line with the hostname of the origin and sends nothing to Sentry. `/health` and `/metrics` have no hook.
- The server reads `MCP_ALLOWED_ORIGINS` on each request. It lists full origins, comma separated, matched exactly, the way the REST API reads `CORS_ALLOWED_ORIGINS`. A value replaces the default, and `*` turns the rule off. A value with no origin in it counts as not set. If it is not set, only loopback origins pass: `localhost`, `127.0.0.1` and `[::1]`, on any port, over http or https. A request without `Origin`, or with an empty one, passes.
- The reason for the loopback default: a rebinding page never has a loopback origin, and clients outside a browser send no `Origin`. On 2026-10-29, nobody knew which `Origin` values reach the hosted deployment, because no service on the hosted path logged request headers. A public file must not name a production host. So a deployment that gets another value sets the variable in its own configuration.

PR #3 deliberately did not restore the old auth, Smithery and `.well-known` layer.

## Alternatives

- stdio plus the `mcp-proxy` sidecar (1.0.0–1.2.0). Rejected: dependency dead end, no control of the HTTP surface, legacy SSE.
- Restore the old in-process layer with auth, rate limits and discovery documents. Rejected: the gateway owns auth, the edge owns limits, and only the transport needs to be here.
- Stateful sessions. Both earlier designs had them (a session map with a TTL, then `mcp-proxy`'s session ids). Not chosen: stateless lets any instance answer any request.
- Keep stdio as the image default. Rejected: deployments already mapped the HTTP port. This was a breaking change for stdio users, noted in CHANGELOG 1.2.1.
- Refuse every `Origin`. Rejected: a loopback page carries no rebinding risk, and local setups that forward a page of the same origin stop working.
- No Origin rule until the operator sets the variable. Rejected: the spec says must, and the listener binds to `0.0.0.0` with no auth.
- The SDK option `allowedOrigins`. Rejected: it is deprecated, SDK 2.x does not have it (#83), and its 403 text repeats the header.
- A `Host` rule as well. Not chosen: browsers send `Origin` with every POST, so the `Origin` rule alone stops rebinding on `/mcp`.

## Consequences

- The server scales horizontally with no session affinity. Shared state lives at module level (holds, in-flight maps, canary), never on the server instance.
- The listener has no auth and adopts an inbound `x-request-id`. Operators must publish port 4200 only on loopback or a private network that the proxy reaches. The default bind is `0.0.0.0`.
- Old `/sse` clients must move to `POST /mcp`.
- A deployment whose proxy forwards a browser `Origin` must list that origin, or those requests get 403.
- `*` turns the Origin rule off on every path to the listener. Use it only if the gateway tests `Origin` itself and only the gateway can reach the port.
- The Origin rule is not auth. Auth stays at the gateway.
- `PUT`, `PATCH` and `OPTIONS` on `/mcp` have no route. They keep their 404 for every `Origin`, and no tool runs there.

## Do not

- Do not bring back `mcp-proxy`, `MCP_AUTH_TOKEN`, in-process rate limits on `/mcp`, `/sse` or `/status`. Documents that describe those as current describe the superseded design.
- Do not hoist the transport or server to module scope "for efficiency". The SDK throws on the second request (`src/mcp-http.test.ts`).
- Do not remove the `GET`/`DELETE` 405 route as redundant, or switch the image `CMD` back to stdio.
- `src/e2e/mcp-smoke.ts` asserts no session header, a working `tools/list`, and 405 on `GET`.
- Do not move the Origin rule into an SDK option, and do not make the hook app-wide. `/health` must answer any `Origin` (`src/mcp-http.test.ts`, "Origin rule (#82)"). A new `/mcp` route, such as the one of #85, gets the same hook.
- Do not put the `Origin` value or a variable name into the 403 text (`src/errors.test.ts`).
- Do not list `null` in `MCP_ALLOWED_ORIGINS`. A hostile page can send `null` too.
