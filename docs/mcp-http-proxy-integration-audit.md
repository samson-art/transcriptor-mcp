# Audit: MCP HTTP removal → stdio + mcp-proxy (integrations, metrics, auth)

This document records the removal of the in-repo Fastify MCP HTTP layer (`src/mcp-http.ts`) in favor of **stdio** (`node dist/mcp.js`) plus **[mcp-proxy](https://github.com/sparfenyuk/mcp-proxy)** for remote HTTP/SSE. It answers: **Smithery / Glama / E2E**, and **where metrics, rate limiting, and auth live now**.

---

## Smithery (`server.smithery.ai`)

| Area | Current behavior (in repo) | After removal of `mcp-http` |
|------|---------------------------|-----------------------------|
| **Public URL** | Users connect to `https://server.smithery.ai/samson-art/transcriptor-mcp` (see `smithery.yaml`, README). | Smithery still needs a **stable HTTP/SSE endpoint** that speaks MCP to their gateway. That endpoint must be whatever you deploy: **mcp-proxy in front of stdio**, or a **separate legacy HTTP stack**, not the stdio process alone. |
| **Config / `authToken`** | `smithery.yaml` declares optional `authToken`; `.well-known/mcp-config` documents `x-from` / `x-to` mapping to `Authorization`. | Token validation must live at the **edge** Smithery hits: **reverse proxy** (e.g. Caddy `forward_auth`, nginx `auth_request`), or **mcp-proxy**-compatible headers when **mcp-proxy** is the client. |
| **SSE `endpoint` / cross-origin** | `resolvePublicBaseUrlForRequest`, `MCP_PUBLIC_URL` / `MCP_PUBLIC_URLS`, `MCP_SMITHERY_PUBLIC_URL`, `cf-worker` detection — ensure clients POST to the real host (see `src/sse-transport.ts`, tests in `mcp-http.test.ts`). | **mcp-proxy** must advertise the correct public base URL for the transport Smithery uses. If the proxy does not replicate this logic, configure **one canonical public URL** in proxy/env and verify SSE/streamable clients still resolve message URLs correctly. |
| **Discovery** | `GET /.well-known/mcp/server-card.json`, `config-schema`, CORS for discovery, `POST /sse` compatibility — implemented in `mcp-http.ts`. | Either **serve static discovery** from a tiny static host or **reverse-proxy** those paths to a **static file** or **minimal sidecar**. Smithery scanners expect these URLs to be reachable without MCP session auth (today unauthenticated GETs). |
| **Operational coupling** | Smithery’s hosted URL is **not** defined only by this repo; their platform proxies to **your** server behavior. | Any change to **paths** (`/mcp`, `/sse`), **auth**, or **transport** requires **re-validation** on Smithery’s side and possibly an update to their server configuration / your published URL. |

**Summary:** Smithery integration is **HTTP-edge dependent**. Moving to stdio + mcp-proxy means **replicating or replacing** every Smithery-facing concern at the **proxy + static discovery** layer; the pure stdio binary alone does not satisfy their “connect by URL” model.

---

## Glama (`glama.json`)

| Area | Current behavior | After change |
|------|------------------|--------------|
| **Metadata** | `glama.json` at repo root references schema `https://glama.ai/mcp/schemas/server.json` and maintainers. | **Unchanged** — still valid as directory metadata. |
| **User-facing URL** | README links to [glama.ai/mcp/servers/samson-art/transcriptor-mcp](https://glama.ai/mcp/servers/samson-art/transcriptor-mcp) alongside Smithery. | If the **public MCP URL** or connection method changes (e.g. only self-hosted docs), update **README / quick-start** and coordinate with Glama if the listing points at a **specific URL** that must stay live. |
| **Scanning / scorecard** | Glama may run checks against the **published** server (see their docs). | **Smoke-test** the same URL after the proxy stack replaces Fastify so **tool discovery and security scorecards** do not regress. |

**Summary:** Glama is **low coupling** to repo internals but **high coupling** to a **working public MCP endpoint** and accurate docs. Plan a **post-migration verification** pass on the directory page.

---

## E2E (`src/e2e/api-smoke.ts`)

| Area | Current behavior | Required change |
|------|------------------|-----------------|
| **MCP container** | Started with `npm run start:mcp:http`, maps `MCP_PORT` (default 4200), optional `MCP_AUTH_TOKEN`. | **Done:** E2E and the example compose stack run **`mcp-proxy` + `node dist/mcp.js`**, port **4200**. |
| **Checks** | `checkMcpStreamable` (`POST /mcp`), `checkMcpSse` (`GET /sse` or equivalent), `checkMcpStdio`. | Keep **stdio** check against `node dist/mcp.js`. Point HTTP/SSE checks at the **proxy** URL and paths **configured for mcp-proxy** (must match production). |
| **Auth** | `SMOKE_MCP_AUTH_TOKEN` → container `MCP_AUTH_TOKEN`. | If auth moves to **proxy only**, set proxy/env (or test-only reverse proxy) so the **HTTP client** in smoke tests still sends **Bearer** the way production clients will. |

**Summary:** E2E uses **mcp-proxy + stdio**; auth at the HTTP edge is **reverse-proxy** (or test-only Bearer) rather than `MCP_AUTH_TOKEN` on the Node app.

---

## Metrics (Prometheus)

| Where today | Metrics | Migration target |
|-------------|---------|------------------|
| Old Fastify MCP + `src/metrics.ts` | Exposed `GET /metrics` with `mcp_*` and `service=mcp`. | **Removed:** MCP image no longer serves `/metrics`. **Option A:** **Reverse proxy** metrics. **Option B:** **Sidecar** / logs. **Option C:** **`mcp_*` in-process** without HTTP export unless you add an exporter. |

See also `docs/monitoring.md` for scrape config; those queries assume **`/metrics` on the MCP HTTP server** — they will need **relabeling** or **new scrape targets** after migration.

---

## Rate limiting

| Where today | Behavior | Migration target |
|-------------|----------|------------------|
| `src/mcp-http.ts` — `@fastify/rate-limit` | `MCP_RATE_LIMIT_MAX`, `MCP_RATE_LIMIT_TIME_WINDOW` (see `docs/configuration.md`). | **Reverse proxy** rate limits (e.g. nginx `limit_req`, Caddy `rate_limit`), **cloud WAF**, or **mcp-proxy** if it exposes equivalent knobs — **verify in mcp-proxy docs** for Streamable HTTP/SSE. |

Application-level limits tied to **session IDs** are harder to replicate at the proxy without **consistent headers**; prefer **IP + path** limits at the edge for abuse protection.

---

## Auth (Bearer / OAuth)

| Where today | Behavior | Migration target |
|-------------|----------|------------------|
| `MCP_AUTH_TOKEN` (removed) | Was a timing-safe Bearer check on in-process MCP HTTP routes. | Use **reverse proxy** or **mcp-proxy** client options (`-H`, `API_ACCESS_TOKEN`, OAuth) per deployment; **stdio** has no per-request HTTP auth. |
| **Smithery `authToken`** | Documented mapping to `Authorization` via gateway. | **Smithery → your edge** must still accept the same **Authorization** model; configure **mcp-proxy** or upstream **reverse proxy** accordingly. |

---

## Consolidated recommendations

1. **Smithery / Glama:** Treat **public URL + discovery + SSE base URL** as a **deployed bundle** (proxy + stdio + optional static files for `/.well-known`), not as features of `dist/mcp.js` alone.
2. **E2E:** Switch Docker smoke to **multi-process or compose**: **stdio binary + mcp-proxy**, then assert **HTTP** against the proxy port and **stdio** against the raw entrypoint as today.
3. **Metrics:** Move **HTTP-level** observability to **proxy / infra**; optionally **reintroduce tool-level counters** in shared code used by **stdio** if you need `mcp_tool_*` parity.
4. **Rate limit:** Default to **reverse proxy** or **platform** limits; align env vars (`MCP_RATE_LIMIT_*`) with whatever component replaces Fastify.
5. **Auth:** Implement **Bearer (or OAuth)** at the **proxy**; update **docs** (`docs/configuration.md`, `README`) so `MCP_AUTH_TOKEN` refers to the **component that terminates HTTP**, not necessarily the Node stdio process.

This audit is informational for the **stdio + mcp-proxy** plan; it does not change runtime behavior by itself.

For a fixed **public URL, paths, Bearer model, and `/.well-known` policy** (Claude, ChatGPT-style integrations, edge gateways), see [mcp-public-url-contract.md](mcp-public-url-contract.md).
