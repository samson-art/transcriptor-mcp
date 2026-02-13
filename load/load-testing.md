# Load testing REST API

Load tests use [k6](https://k6.io) and target the REST API (port 3000). The scripts use a video pool of varying lengths (short, medium, long) with round-robin selection.

## Prerequisites

- REST API running (Docker or local)
- Docker (for `make load-test-*` and `npm run load-test*`), or k6 installed locally for direct `k6 run` usage

## Starting the API for tests

**Docker:**

```bash
docker run -p 3000:3000 -e RATE_LIMIT_MAX=1000 artsamsonov/transcriptor-mcp-api
```

**Local:**

```bash
npm run build && RATE_LIMIT_MAX=1000 npm start
```

For load tests, raise `RATE_LIMIT_MAX` so the default 100 req/min limit does not cap throughput.

## Running load tests

### Via Make (Docker)

```bash
# All scenarios
make load-test

# Individual scenarios
make load-test-health    # GET /health only (50 VU, 30s)
make load-test-subtitles # POST /subtitles (5–10 VU, 60s)
make load-test-mixed     # health + available + subtitles (10 VU, 60s)
```

Override base URL:

```bash
make load-test-health LOAD_BASE_URL=http://localhost:3000
```

### Via npm (uses Docker k6 image)

```bash
npm run load-test           # health
npm run load-test:subtitles
npm run load-test:mixed
```

With custom base URL:

```bash
BASE_URL=http://192.168.1.10:3000 npm run load-test
```

### Direct k6

```bash
k6 run load/health.js
k6 run -e BASE_URL=http://localhost:3000 load/subtitles.js
```

## Scenarios

| Script | Endpoint(s) | VUs | Duration | Description |
|--------|-------------|-----|----------|-------------|
| `health.js` | GET /health | 50 | 30s | Baseline, no yt-dlp |
| `subtitles.js` | POST /subtitles | 5→10 | 60s | Heavy load, video pool |
| `mixed.js` | /health, /subtitles/available, /subtitles | 10 | 60s | 70% / 20% / 10% mix |

## Video pool

Videos in `load/config.js` are real YouTube IDs with different durations. Each pool entry has:

- **`id`**, **`duration`** (seconds) — required
- **`official`**, **`auto`** — optional arrays of language codes (e.g. `['en','ru']`) for which subtitles are known to exist

Scenarios use **`getVideoRequest(iter, vu)`**, which returns `{ url, type, lang }` so that POST /subtitles is sent with a type and language that match the video (reducing 404s). Selection is round-robin; when metadata is present, `type`/`lang` are chosen from it (prefer `en` in auto, then official, then first available); otherwise fallback is `type: 'auto'`, `lang: 'en'`.

- **Short (≤2 min):** e.g. Me at the zoo, Potter Puppet Pals
- **Medium (3–6 min):** e.g. Rick Astley, Gangnam Style, Despacito, Tom Scott, various music/talk
- **Long (7–20 min):** TED talks and similar

**Verifying the pool:** run `make verify-pool` or `npm run verify-pool` (with the API at `LOAD_BASE_URL` / `BASE_URL`). This calls POST /subtitles/available for each video and reports which have at least one subtitle; it also prints actual `official`/`auto` when they differ from the pool so you can update `config.js`.

## Recommended thresholds for regression

Use these thresholds when running load tests to catch performance regressions (e.g. in CI or before release):

| Script | Threshold | Value | Meaning |
|--------|-----------|--------|---------|
| `subtitles.js` | `http_req_failed` | `rate<0.05` | Error rate must stay below 5%. |
| `subtitles.js` | `http_req_duration` | `p(95)<120000` | 95th percentile latency must be under 120 s. |

Example: `k6 run --throw load/subtitles.js` fails the run if thresholds are not met. The scripts in this directory already define these thresholds; `--throw` is useful in CI.

## Metrics

k6 reports:

- `http_reqs` — requests per second
- `http_req_duration` — latency (avg, p95, p99)
- `http_req_failed` — error rate
- `iterations` — completed script runs

For throughput (videos/min): `http_reqs` for POST /subtitles × 60.

## Recommended env for load tests

```bash
RATE_LIMIT_MAX=1000
YT_DLP_TIMEOUT=90000
```

See [configuration.md](configuration.md) for all options.

## Visualizing results in Grafana (VPS)

k6 can send metrics to **InfluxDB v1.x** (built-in); Grafana on your VPS can use InfluxDB as a data source.

### 1. InfluxDB 1.x on the VPS

If you don’t have InfluxDB yet, run it (e.g. with Docker):

```bash
docker run -d --name influxdb -p 8086:8086 influxdb:1.8
```

Create a database for k6 (optional; k6 can create it):

```bash
curl -X POST 'http://YOUR_VPS:8086/query' --data-urlencode "q=CREATE DATABASE k6"
```

Ensure the host where you run k6 (laptop or same VPS) can reach `http://YOUR_VPS:8086`.

### 2. Grafana: add InfluxDB data source

- **Configuration** → **Data sources** → **Add data source** → **InfluxDB**
- **Query Language:** InfluxQL
- **URL:** `http://localhost:8086` (if Grafana and InfluxDB on same host) or `http://influxdb:8086` (Docker network)
- **Database:** `k6`
- Save & test

### 3. Import k6 dashboard

- **Dashboards** → **Import** → enter ID **24708** (k6 Load Test Dashboard for InfluxDB v1.x) → Load → choose the InfluxDB data source → Import

### 4. Run load tests with metrics sent to InfluxDB

**Make (Docker):**

```bash
LOAD_INFLUXDB_URL=http://YOUR_VPS:8086/k6 make load-test-health
# or all scenarios
LOAD_INFLUXDB_URL=http://YOUR_VPS:8086/k6 make load-test
```

**Direct k6 (if installed):**

```bash
k6 run --out influxdb=http://YOUR_VPS:8086/k6 -e BASE_URL=http://127.0.0.1:3000 load/health.js
```

Replace `YOUR_VPS` with the hostname or IP that the machine running k6 can reach (e.g. public IP of the VPS, or `host.docker.internal` if k6 runs in Docker on the same host as InfluxDB on macOS/Windows). After the test, open the imported dashboard in Grafana and select the time range of the run.
