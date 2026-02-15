# Use case: Summarize video

Get a short summary of a video by fetching its transcript and asking the model to summarize it.

## With MCP (recommended)

1. Connect to Transcriptor MCP (e.g. via [Smithery](https://server.smithery.ai/samson-art/transcriptor-mcp) or your own server).
2. In your AI chat (Cursor, Claude, etc.), use the **summarize_video** prompt or ask in natural language.

### Example prompts to the model

- *"Summarize this video: https://www.youtube.com/watch?v=VIDEO_ID"*
- *"Use get_transcript to fetch the transcript for this video, then summarize the video content in a few sentences. Video URL: https://www.youtube.com/watch?v=VIDEO_ID"*

### Using the MCP prompt (if your client supports prompts)

- **Prompt:** `summarize_video`
- **Argument:** `url` — video URL or YouTube video ID

The prompt builds a user message that tells the model to call `get_transcript` and then summarize the result.

## Two-step flow

1. **get_transcript** — returns cleaned plain text (no timestamps). Pass only the video `url`.
2. The model uses that text to produce a summary (a few sentences or bullet points).

For long videos, the tool returns the first chunk by default. For full transcript with pagination, use **get_raw_subtitles** with `response_limit` and `next_cursor`.

## REST API alternative

If you call the REST API directly, use `POST /subtitles` (or the appropriate endpoint) to get subtitle text, then send that text to an LLM for summarization. See [quick-start.rest.md](quick-start.rest.md).
