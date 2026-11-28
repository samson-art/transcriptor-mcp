# 010. Tool schemas are zod v4 objects, and tools/list shows the JSON Schema that the SDK makes from them

- Status: Accepted
- Date: 2026-11-28 (#83)
- Sources: this PR, issue #83, CHANGELOG (Unreleased), `src/mcp-tools-contract.json` (#80)

## Context

From February 2026, `src/mcp-core.ts` imported `z` from `'zod/v3'`. This is the copy of the zod 3 API inside zod 4. The comment gave the reason: some MCP clients, for example n8n, can fail on the JSON Schema that zod 4 makes. No record of a real failure exists.

SDK 1.x converted zod 3 schemas with `zod-to-json-schema`. SDK 2.x refuses zod 3 schemas. A raw shape of zod 3 fields throws in `registerTool`, and a `z.object` from `'zod/v3'` throws at the first `tools/list` (read in the SDK 2.4.0 code). SDK 1.x will never get MCP 2026-07-28, so the server moved to SDK 2.x (#83).

On 2026-10-07, the MCP Client Tool node on n8n master read only `inputSchema`, and its converter accepted the zod 4 shapes. Nobody ran n8n end to end.

A measurement on 2026-11-28 used SDK 2.4.0 and zod 4.6.7. The output schemas were equal to the stored `tools/list` answer of #80. The input schemas differed in 12 places:

- 8 tools lost `additionalProperties: false`.
- `maximum: 9007199254740991` (the largest safe integer in JavaScript) appeared on `response_limit` of `get_transcript` and `get_raw_subtitles`, on `maxItems` of `get_playlist_transcripts` and on `offset` of `search_videos`.

## Decision

- `src/mcp-core.ts` imports `z` from `'zod'` (v4). The tool schemas are `z.object` objects, not strict ones. When a call has an argument key that the schema does not know, zod drops the key, and the tool runs as without it.
- `tools/list` shows the JSON Schema that the SDK makes from these schemas, with the 2020-12 label. The server does not change it. The relabel of #80 (`relabelToolSchemas`) is gone, because the SDK writes the 2020-12 label itself.
- `src/mcp-tools-contract.json` stores the `tools/list` answer. A test in `src/mcp-http.test.ts` compares it over HTTP, and a test in `src/mcp-stdio.test.ts` compares it over stdio. A schema change shows as a diff of this file.

## Alternatives

- Keep the input schemas of #80: a small wrapper adds `additionalProperties: false` and removes the safe-integer `maximum`. Not chosen by the maintainer on 2026-11-28. The schemas accept the same calls either way, and the wrapper is more code to keep.
- Strict objects (`z.strictObject`). They keep `additionalProperties: false`, but they refuse a call with an unknown key. Rejected: since 1.5.21 at least, such a call runs the tool.
- Stay on SDK 1.x and `'zod/v3'`. Rejected: SDK 1.x will never get MCP 2026-07-28 (#85, #86).

## Consequences

- A client that reads `additionalProperties` sees no ban on extra keys. An extra key does not reach the tool, because zod drops it.
- A published ChatGPT app holds the 8 changed input schemas for review until the publisher approves them in the OpenAI portal.
- A new field or tool changes the stored answer. Rewrite it with `UPDATE_TOOLS_CONTRACT=1 npx jest src/mcp-http.test.ts -t 'tool contract'` and read the diff before you commit it.

## Do not

- Do not import `'zod/v3'` again. SDK 2.x refuses its schemas.
- Do not make the input objects strict (`z.strictObject`, `.strict()`). Guarded by "drops an unknown argument key and answers as without it" in `src/mcp-http.test.ts`.
- Do not edit `src/mcp-tools-contract.json` by hand. Rewrite it with the command above.
