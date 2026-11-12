# 008. Sentry counts users from an HMAC of the gateway user id and one Sentry log per tool call

- Status: Accepted
- Date: 2026-11-12
- Sources: #118, PR for #118, CHANGELOG [Unreleased]

## Context

The metrics and the log lines of the server count calls, not people. One person who repeats a failing call looks like many failures. To learn how many users met errors, someone had to export the per-call records of the gateway and join them with the container logs by request id. That worked only while the logs of the current container existed.

The gateway in front of the hosted server sends the id of its signed-in user on each `tools/call`, in `x-mcpal-user-id`. Sentry ties events, spans, logs and metrics to a user natively: `setUser` on a scope, and Sentry adds `user.id` to each item. Explore counts `count_unique(user.id)` on logs and spans, with filters.

## Decision

- `src/mcp-http.ts`, `sentryUserId`: when `SENTRY_USER_HASH_SECRET` is set and the request has `x-mcpal-user-id`, the POST `/mcp` handler sets the user of its Sentry isolation scope. The id is the first 16 hex characters of HMAC-SHA256 of the header value with the secret. The raw value never leaves the process.
- `src/mcp-core.ts`, `withToolErrorHandling`: a tool call whose isolation scope has a user sends one Sentry log, "MCP tool call", with `tool`, `outcome`, `source`, and `reason`, `answer` and `platform` when they exist. No address, address hash or video id.
- `src/instrument.ts`: `enableLogs: true`. Nothing else calls `Sentry.logger`.
- The header is trusted for the same reason as `x-request-id` in ADR 001: only the gateway reaches the listener.

## Alternatives

- Count distinct users in the server (Redis HyperLogLog) and send only the counts as Sentry metrics. No id would leave the server, but it is custom code, and Sentry could not slice by tool or reason or link a user to an error. Application Metrics cannot count unique values, so this was the only way with metrics.
- A hashed id on every tool-call span. Exact counts need all tool calls traced, which costs many spans per call. One log per call is cheaper and is never sampled.
- The raw id as the Sentry user. It is a stable identifier of a person in another company's system; a keyed hash keeps the counts and does not expose it.

## Consequences

- With the secret set, Sentry holds a pseudonymous id per user (in events up to 90 days, in logs for the Sentry log retention). The privacy policy of the hosted Service must say so before the secret is set there.
- Sentry log volume: one log per tool call of a known user.
- Calls that the gateway rejects before they reach the server (for example 502 or 530 during an outage) are not counted. Only the gateway sees those users.
- Changing the secret changes every id: counts across the change see each user twice.

## Do not

- Do not send the raw header value, and do not add the address, `addr`, `vid` or `host` to the Sentry log. `src/instrument.test.ts` checks both.
- Do not set the user on a shared scope (global or current scope outside the request): concurrent requests would swap users. The overlap test in `src/instrument.test.ts` guards this.
- Do not turn on the request headers or the request body of `requestDataIntegration` in `src/instrument.ts`: the header would reach Sentry raw. `src/instrument.test.ts` guards this.
