## MCP quick start

This project ships an MCP server that exposes tools for fetching video subtitles, metadata, and chapters.
Supported platforms: YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion (or YouTube video ID).
You can run it either via Docker or directly with Node.js.

### Docker (recommended)

- **Image**: `artsamsonov/transcriptor-mcp:latest`

Run the MCP server locally over stdio:

```bash
docker run --rm -i artsamsonov/transcriptor-mcp:latest
```

Then configure your MCP host (e.g. Cursor) to use this Docker command as the MCP server.

### Local MCP server (Node.js)

Install dependencies and build:

```bash
npm install
npm run build
```

Run the MCP server over stdio:

```bash
npm run start:mcp
```

This starts the MCP server on stdio. Point your MCP-capable client to the `node dist/mcp.js` command.

### MCP over HTTP/SSE

You can also expose the MCP server over HTTP/SSE for remote usage (e.g. VPS + Tailscale).

Run via Node:

```bash
npm run build
MCP_PORT=4200 MCP_HOST=0.0.0.0 npm run start:mcp:http
```

Run via Docker:

```bash
docker build -f Dockerfile.mcp -t transcriptor-mcp .
docker run -p 4200:4200 -e MCP_PORT=4200 -e MCP_HOST=0.0.0.0 transcriptor-mcp npm run start:mcp:http
```

For ready-made docker-compose setup, see `docker-compose.example.yml` in the repository root.

### MCP configuration examples

#### Cursor (Docker-based stdio)

```json
{
  "mcpServers": {
    "transcriptor": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "artsamsonov/transcriptor-mcp:latest"]
    }
  }
}
```

#### Cursor (local Node.js)

```json
{
  "mcpServers": {
    "transcriptor": {
      "command": "node",
      "args": ["dist/mcp.js"]
    }
  }
}
```

#### Remote HTTP/SSE

- **Claude Code (HTTP / streamable HTTP)**:

  ```bash
  claude mcp add --transport http transcriptor http://<host>:4200/mcp
  ```

- **Cursor (SSE)**:

  - Add a new MCP server of type **SSE** with URL:

    ```text
    http://<host>:4200/sse
    ```

If you set `MCP_AUTH_TOKEN` on the server, add `Authorization: Bearer <token>` in the client headers.

