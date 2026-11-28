# Deno, the JS runtime for yt-dlp, at a fixed version (#135). Dependabot updates this tag.
FROM denoland/deno:bin-2.9.8 AS deno

# ============================================
# Stage 1: Build
# ============================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

# ============================================
# Stage 2: Base (shared runtime: yt-dlp, ffmpeg, Deno)
# ============================================
FROM node:22-bookworm-slim AS base

# System dependencies for yt-dlp and the JS runtime. ffmpeg handles audio post-processing.
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    curl \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Ensure Node/npm are on PATH (avoid 127 when building api/mcp stages)
ENV PATH="/usr/local/bin:${PATH}"

# Deno from the fixed stage at the top. The version line goes into the build log.
COPY --from=deno /deno /usr/local/bin/deno
RUN deno --version

# Install the latest stable yt-dlp from pip. curl-cffi adds browser impersonation.
# Without curl-cffi, TikTok and some Dailymotion videos fail to open.
RUN pip3 install --no-cache-dir --break-system-packages -U "yt-dlp[default,curl-cffi]"

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
# GET /changelogs reads it from the working directory.
COPY CHANGELOG.md ./

# yt-dlp and ffmpeg parse pages and media from the internet, so the server does not run as root
# (#131). `node` (uid 1000) comes with the base image. It writes only to /tmp and its home
# (~/.cache for yt-dlp and Deno). /app stays owned by root, and the server only reads it.
USER node

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

# npm writes a script banner to stdout before it starts a script: four lines in a local run of
# 1.5.21 on 2026-10-07. In stdio mode (`npm run start:mcp`, the command in server.json), stdout
# must carry only MCP messages (#81). The silent log level also removes all npm lines from stderr,
# for every npm command in the image. The log of the default HTTP command loses them. A failure
# before the server starts, such as a missing script, exits 1 with an empty stderr. To get the npm
# lines back, run the image with -e NPM_CONFIG_LOGLEVEL=notice.
# This line comes after `npm ci`, so that the build log keeps the npm output.
ENV NPM_CONFIG_LOGLEVEL=silent

# Same reason as in the api stage (#131).
USER node

EXPOSE 4200

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||4200)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Default: MCP over Streamable HTTP on MCP_PORT (4200), served by this process — no sidecar.
# For stdio (e.g. `docker run --rm -i`), override the command with: npm run start:mcp
CMD ["npm", "run", "start:mcp:http"]
