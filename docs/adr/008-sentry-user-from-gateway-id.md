# 008. Sentry counts users from one log per tool call, with an HMAC of the gateway user id

- Status: Accepted
- Date: 2026-11-12
- Sources: #118, #124, CHANGELOG [Unreleased]

## Context

The metrics and the log lines of the server count calls, not people. One person who repeats a failing call looks like many failures. To count users, someone had to export the per-call records of the gateway and join them with the container logs by request id. That worked only while the logs of the current container existed.

The gateway in front of the hosted server sends the id of its signed-in user on each `tools/call`, in `x-mcpal-user-id`. Sentry Explore counts the distinct values of a log attribute with `count_unique`, and it filters on the other attributes.

## Decision

- `src/mcp-core.ts`, `sentryUserId`: the id is the first 16 hex characters of HMAC-SHA256 of the header value, with the secret in `SENTRY_USER_HASH_SECRET`. The header comes from the request headers that the MCP SDK gives each tool call. Without the secret or the header, there is no id.
- `src/mcp-core.ts`, `withToolErrorHandling`: a call with an id sends one Sentry log, "MCP tool call". Its attributes are `user.id`, `tool`, `outcome` and `source`, and also `reason`, `answer` and `platform` when they exist. It holds no address, address hash or video id.
- A call whose transport closed before the answer gets `outcome: error` and `reason: cancelled`. A proxy cut the call, or the client left.
- `src/instrument.ts`: `enableLogs: true`. Nothing else calls `Sentry.logger`.
- `src/lifecycle.ts`: shutdown waits up to 2 s for Sentry, because `process.exit` skips the flush of the SDK.
- The server trusts the header for the same reason as `x-request-id` in ADR 001: only the gateway reaches the listener.

Queries in Sentry Explore, Logs, with `message:"MCP tool call"`:

- All users: `count_unique(user.id)`.
- Users with any failure: the same query with `outcome:error`.
- Users with a failure that the server can fix: `reason:[busy,timeout,rate_limited,bot_check,extractor,unknown]`, plus `reason:not_found` without `answer`. The second part covers the failures where the server cannot tell the cause.

## Alternatives

- `Sentry.setUser` on the request scope. Issues then show "Users affected". The review of #124 rejected it for three reasons:
  - Error events carry breadcrumbs from the log lines of the request, with the requested addresses and search queries. A user id on the event links a person to what they asked for.
  - The request scope shares the Release Health session of the process, so the first user becomes the user of that session.
  - Without an enabled Sentry client, the scope is the same for the whole process, so the user stays on later requests.
- Count distinct users in the server, with a Redis HyperLogLog, and send only the counts as Sentry metrics. Application Metrics cannot count unique values. This keeps the id in the server, but it is custom code, and Sentry cannot slice the counts by tool or reason.
- A hashed id on every tool-call span. Exact counts need every tool call traced, at the cost of many spans per call. A log per call costs less, and Sentry does not sample logs.
- The raw id as the user id. It is a stable identifier of a person in another company's system. A keyed hash keeps the counts and does not show the id.

## Consequences

- With the secret set, Sentry holds a pseudonymous id per user in its logs. The privacy policy of the hosted Service must say so before the operator sets the secret there.
- Each tool call of a known user costs one Sentry log.
- Some failures send no log:
  - The gateway rejects some calls before they reach the server, for example with 502 or 530 during an outage.
  - The MCP SDK rejects unknown tools and bad arguments before the tool runs.
  - The SDK checks the output after the tool returns, so a call that fails that check gets an `ok` log.

  The stdout line and the Prometheus metrics have the same gaps.

- A new secret gives every user a new id. A count across the change sees each user twice.
- A short secret is easy to guess for anyone who knows one id and its hash. Use a long random secret, the same on every instance.

## Do not

- Do not send the raw header value. `src/instrument.test.ts` checks every log, event and transaction.
- Do not add the address, `addr`, `vid` or `host` to the Sentry log. `src/instrument.test.ts` checks this.
- Do not put the user on a Sentry scope. The error-event test in `src/instrument.test.ts` then fails.
- Do not turn on the request headers or the request body of `requestDataIntegration`, and keep `beforeSendTransaction` in `src/instrument.ts`. `src/instrument.test.ts` guards both.
