# ============================================
# Stage 1: Build
# ============================================
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

# ============================================
# Stage 2: Base (shared runtime: yt-dlp, ffmpeg, Deno)
# ============================================
FROM node:20-slim AS base

# Системные зависимости для yt-dlp и JS runtime (ffmpeg для постобработки аудио)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    curl \
    unzip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Ensure Node/npm are on PATH (avoid 127 when building api/mcp stages)
ENV PATH="/usr/local/bin:${PATH}"

# Deno (js runtime для yt-dlp)
ENV DENO_INSTALL=/usr/local
RUN curl -fsSL https://deno.land/x/install/install.sh | sh

# yt-dlp через pip (последняя стабильная версия)
RUN pip3 install --no-cache-dir --break-system-packages -U yt-dlp

ENV YT_DLP_JS_RUNTIMES="deno,node"

# ============================================
# Stage 3a: Production (REST API)
# ============================================
FROM base AS api

WORKDIR /app

COPY package*.json ./

# Skip prepare (husky) — devDependencies not installed in production image
RUN /usr/local/bin/npm ci --omit=dev --ignore-scripts && /usr/local/bin/npm cache clean --force

COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["npm", "start"]

# ============================================
# Stage 3b: Production (MCP)
# ============================================
FROM base AS mcp

# Ownership proof for the MCP Registry (must match `name` in server.json).
LABEL io.modelcontextprotocol.server.name="io.github.samson-art/transcriptor-mcp"

WORKDIR /app

COPY package*.json ./

# Skip prepare (husky) — devDependencies not installed in production image
RUN /usr/local/bin/npm ci --omit=dev --ignore-scripts && /usr/local/bin/npm cache clean --force

COPY --from=builder /app/dist ./dist

EXPOSE 4200

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||4200)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Default: MCP over Streamable HTTP on MCP_PORT (4200), served by this process — no sidecar.
# For stdio (e.g. `docker run --rm -i`), override the command with: npm run start:mcp
CMD ["npm", "run", "start:mcp:http"]
