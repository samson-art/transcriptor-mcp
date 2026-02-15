# Use case: Search and get transcript

Find videos on YouTube and then fetch the transcript of one or more of them.

## With MCP (recommended)

1. Connect to Transcriptor MCP (e.g. via [Smithery](https://server.smithery.ai/samson-art/transcriptor-mcp) or your own server).
2. Use **search_videos** to find videos, then **get_transcript** (or **get_raw_subtitles**) to get the text.

### Example prompts to the model

- *"Search for 'react hooks tutorial' and get the transcript of the first result."*
- *"Find the top 5 videos about TypeScript and summarize the first one."*

### Step-by-step (tool calls)

1. **search_videos**
   - **query** (required): e.g. `"react hooks tutorial"`
   - **limit** (optional): number of results (1–50, default 10)
   - **offset** (optional): skip first N results for pagination
   - **uploadDateFilter** (optional): `hour` | `today` | `week` | `month` | `year` to filter by upload date
   - **response_format** (optional): `json` or `markdown` for the human-readable content

   Returns a list of videos with `videoId`, `title`, `url`, `uploader`, `viewCount`, etc.

2. **get_transcript**
   - **url** (required): use the `url` or build `https://www.youtube.com/watch?v=<videoId>` from a search result.

   Returns cleaned plain text of the transcript (first chunk by default).

### For multiple transcripts

Call **get_transcript** once per video URL. For very long transcripts, use **get_raw_subtitles** with `response_limit` and `next_cursor` to page through the content.

## REST API alternative

Use the REST API to search (if exposed) or pass known video URLs to `POST /subtitles`. See [quick-start.rest.md](quick-start.rest.md). The MCP server exposes search and transcript tools together for use inside an AI workflow.
