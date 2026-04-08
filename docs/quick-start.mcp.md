## MCP quick start

For the **canonical public URL contract** (HTTPS base, `/mcp` / `/sse`, `Authorization: Bearer`, and `/.well-known` policy), see [mcp-public-url-contract.md](mcp-public-url-contract.md).

This project ships an MCP server that exposes tools for fetching video subtitles, metadata, and chapters.
Supported platforms: YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion, Reddit (or YouTube video ID).

**Connection options** (no install): [Smithery](https://smithery.ai/servers/samson-art/transcriptor-mcp) · [Glama](https://glama.ai/mcp/servers/samson-art/transcriptor-mcp) | **Self-hosted**: Docker · Node.js · remote HTTP/SSE via [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy)

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

### MCP over HTTP/SSE (stdio + mcp-proxy)

For remote usage (e.g. VPS + Tailscale), run the **stdio** MCP server behind **[mcp-proxy](https://github.com/sparfenyuk/mcp-proxy)**, which exposes **streamable HTTP** at `/mcp` and **SSE** at `/sse` (same paths clients already use).

Install **mcp-proxy** (version **0.11.0** matches the `mcp` stage in the [Dockerfile](../Dockerfile)):

```bash
pip install 'mcp-proxy==0.11.0'
# or: uv tool install 'mcp-proxy==0.11.0'
# or: pipx install 'mcp-proxy==0.11.0'
```

See [mcp-proxy upstream](https://github.com/sparfenyuk/mcp-proxy) for the full CLI (`mcp-proxy --help`).

After `npm run build`, from the repo root:

```bash
mcp-proxy --pass-environment --host=0.0.0.0 --port=4200 -- node --import ./dist/instrument.js dist/mcp.js
```

**Docker** (image includes `mcp-proxy` on `PATH`):

```bash
docker build -f Dockerfile --target mcp -t transcriptor-mcp .
docker run -p 4200:4200 transcriptor-mcp \
  mcp-proxy --pass-environment --host=0.0.0.0 --port=4200 -- \
  node --import ./dist/instrument.js dist/mcp.js
```

For a ready-made compose stack (API + Whisper + MCP over mcp-proxy), see `docker-compose.example.yml` in the repository root.

#### mcp-proxy flags (stdio → HTTP/SSE)

The Node app only speaks **stdio** (`dist/mcp.js`). Remote clients use **[mcp-proxy](https://github.com/sparfenyuk/mcp-proxy)** in **server** mode (SSE → stdio in upstream docs): it listens on `--host` / `--port` and spawns the stdio server after `--`. Defaults in examples use port **4200**. Exposed paths: **`/mcp`** (streamable HTTP), **`/sse`** (SSE), **`/status`** (proxy status JSON).

| Concern | How to configure |
|--------|------------------|
| Listen address | `--host=0.0.0.0` `--port=4200` — where remote clients connect for `/mcp` and `/sse` |
| Env for the Node child | `--pass-environment` and/or repeated `-e KEY VALUE` ([upstream](https://github.com/sparfenyuk/mcp-proxy)) |
| CORS | `--allow-origin` (repeatable), e.g. `--allow-origin='*'` for wide-open dev |
| Streamable HTTP stateless mode | `--stateless` / `--no-stateless` (see upstream; default is stateful) |

**`MCP_AUTH_TOKEN` vs mcp-proxy**

This repository’s MCP server is **stdio-only** in Node (`dist/mcp.js`); there is **no** `MCP_PORT` / `MCP_AUTH_TOKEN` handling inside the app (see [.env.example](../.env.example) and [configuration.md](configuration.md)). Catalogs and docs sometimes still use the name **`MCP_AUTH_TOKEN`** for a shared secret clients send as **`Authorization: Bearer …`** — that secret must be enforced at your **edge** (reverse proxy, API gateway, or private network), not in the Node process.

| Layer | Incoming `Authorization: Bearer …` |
|--------|--------------------------------------|
| **stdio + mcp-proxy 0.11.0** | Neither Node nor mcp-proxy validates Bearer on `/mcp` or `/sse`. Use **Tailscale**, **VPN**, or a **reverse proxy** (Caddy, nginx, Traefik, cloud LB) that checks the header before traffic reaches mcp-proxy. |
| **mcp-proxy as HTTP client** (argument is a URL) | `-H Authorization 'Bearer <token>'` and env **`API_ACCESS_TOKEN`** apply to **outbound** requests to a remote MCP server — not to protecting your own stdio server. |

Clients (Cursor, Claude Code, n8n, Smithery) should send **`Authorization: Bearer <token>`** only when **your** deployment requires it at the edge.

When **mcp-proxy** runs in **client** mode (first argument is a URL to a remote MCP server), `-H Authorization 'Bearer <token>'` and env **`API_ACCESS_TOKEN`** apply to **outbound** requests — the opposite direction from publishing your stdio server.

OAuth2 **client** credentials toward a remote authorization server (mcp-proxy as HTTP **client** only): `--client-id`, `--client-secret`, `--token-url` per [upstream](https://github.com/sparfenyuk/mcp-proxy).

#### Remote clients (paths)

| Client | Transport | URL |
|--------|-----------|-----|
| **Cursor** | SSE | `http://<host>:4200/sse` |
| **Claude Code** | Streamable HTTP | `http://<host>:4200/mcp` |
| **n8n** (MCP Client Tool) | Streamable HTTP | `http://<host>:4200/mcp` |

See also [use-case-n8n-automation.md](use-case-n8n-automation.md).

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

If your deployment enforces Bearer auth at a reverse proxy, configure the client to send `Authorization: Bearer <token>` (or the catalog’s `authToken` field) as your edge expects.

