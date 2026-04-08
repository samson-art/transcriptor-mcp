# Публичный контракт MCP: URL, пути, Bearer и `/.well-known`

Этот документ фиксирует **единый контракт** для удалённых клиентов (Claude Code, Cursor, n8n, каталоги вроде Smithery/Glama, пользовательские интеграции в духе ChatGPT Custom Actions за вашим API-шлюзом) при стеке **stdio MCP + [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy)** за **HTTPS** (обратный прокси, APISIX, cloud LB). Его можно использовать как спецификацию для edge-конфигурации и биллинга.

---

## 1. Базовый публичный URL

| Элемент | Контракт |
|--------|----------|
| **Схема** | `https` (в проде TLS обязателен). |
| **Хост** | Один канонический хост для MCP, например `mcp.example.com` — задаётся деплоем (`MCP_PUBLIC_HOST` / DNS / ingress). |
| **Порт** | Стандартный **443** снаружи; внутри контейнера mcp-proxy по умолчанию слушает **4200** (см. `docker-compose.example.yml`). |
| **Путь приложения** | Без обязательного префикса: корень сервиса на хосте — это уже «вход» в mcp-proxy. Если на шлюзе используется префикс (например `/api/mcp`), он должен быть **согласован** с тем, что клиенты указывают в URL целиком. |

**Каноническая база для клиентов:** `https://<MCP_PUBLIC_HOST>` (без завершающего `/`).

Smithery для публичного листинга использует свой URL вида `https://server.smithery.ai/<org>/<server>` — это **прокси каталога**, не замена описанного ниже контракта для **самостоятельного** хостинга.

---

## 2. Пути HTTP (mcp-proxy)

Все пути ниже — относительно базы `https://<MCP_PUBLIC_HOST>`.

| Путь | Назначение | Типичный клиент |
|------|------------|-----------------|
| **`/mcp`** | Streamable HTTP (JSON-RPC MCP) | Claude Code (`--transport http`), n8n MCP Client, любые клиенты streamable HTTP |
| **`/sse`** | SSE-транспорт MCP | Cursor (SSE), другие SSE-хосты |
| **`/status`** | Статус/служебный JSON mcp-proxy | Операции, мониторинг (не часть MCP JSON-RPC) |

Совместимость: некоторые клиенты отправляют streamable-запросы на **`/sse`** (POST) — mcp-proxy может обслуживать это в зависимости от версии и режима; канонический streamable endpoint в документации репозитория — **`POST /mcp`**.

---

## 3. Модель авторизации: `Authorization: Bearer`

| Правило | Описание |
|---------|----------|
| **Заголовок** | `Authorization: Bearer <secret>` — единый формат для защищённого публичного доступа через edge (APISIX `key-auth`, nginx `auth_basic`/`map`, Caddy `forward_auth`, и т.д.). |
| **Где проверяется** | На **шлюзе или reverse proxy** перед mcp-proxy. Процессы **Node (`dist/mcp.js`)** и **mcp-proxy** в режиме server **не** должны считаться единственной линией защиты для секрета — см. [quick-start.mcp.md](quick-start.mcp.md). |
| **Claude Code** | `claude mcp add --transport http <name> https://<MCP_PUBLIC_HOST>/mcp` + способ передачи Bearer, который поддерживает ваш клиент/обёртка (при обязательном токене на edge токен должен уходить в `Authorization`). |
| **Cursor (SSE)** | URL `https://<MCP_PUBLIC_HOST>/sse`; при необходимости тот же Bearer в настройках MCP, если хост/прокси его прокидывает. |
| **Smithery** | В [smithery.yaml](../smithery.yaml) опционален `authToken`; [.well-known/mcp-config](../.well-known/mcp-config) задаёт перенос в заголовок `Authorization` (в т.ч. как Bearer на вашей стороне). |
| **ChatGPT / «Custom Actions»** | Если интеграция — HTTP API к **вашему** шлюзу с фиксированными заголовками, зафиксируйте тот же **`Authorization: Bearer <api-key>`** (или схему, которую шлюз реально принимает), чтобы не плодить вторую модель секретов. |

Итог: **один тип секрета на пользователя/тариф на edge**, один способ передачи — **Bearer** — для всех перечисленных сценариев, где требуется аутентификация.

---

## 4. Решение по `/.well-known`

После удаления встроенного Fastify MCP HTTP **ответы `/.well-known/...` не отдаёт** процесс `dist/mcp.js` и не обязан отдавать mcp-proxy. Для каталогов и сканеров исторически важны **анонимные GET** на discovery (см. [mcp-http-proxy-integration-audit.md](mcp-http-proxy-integration-audit.md)).

**Принятое решение для продуктовой политики:**

| Вариант | Когда использовать |
|--------|---------------------|
| **A. Публичные GET без ключа (рекомендуется для discovery)** | Отдельный маршрут на edge: `GET /.well-known/mcp/*` (и при необходимости статические `server-card.json`, `config-schema.json`) **без** `key-auth`, с нормальными CORS для GET. Контент — статика из репозитория/артефакта деплоя или отдельный микросервис. **MCP-сессии** (`/mcp`, `/sse`) остаются за API-ключом. |
| **B. Только закрытый доступ** | Если discovery не нужен вовсе (чистый private SaaS), маршруты `/.well-known/*` можно не публиковать или защитить тем же Bearer — с пониманием, что **Smithery/Glama-сканеры** не смогут прочитать карточку без ключа. |

**Рекомендация для монетизации (APISIX + биллинг):** использовать **вариант A** для `/.well-known` (или вынести discovery на отдельный поддомен/статический хост), а **квоты и ключи** применять к **`/mcp` и `/sse`** (и при желании к `/status`).

---

## 5. Сводка для конфигурации шлюза

```
https://<MCP_PUBLIC_HOST>/mcp   → streamable MCP + Bearer (если включена защита)
https://<MCP_PUBLIC_HOST>/sse   → SSE MCP + Bearer (если включена защита)
https://<MCP_PUBLIC_HOST>/status → по желанию: публичный health или только внутри сети / с тем же Bearer
GET https://<MCP_PUBLIC_HOST>/.well-known/mcp/... → по политике раздела 4 (часто без ключа)
```

Upstream после TLS-терминации: **`mcp-proxy:4200`** (или эквивалент), без повторного требования Bearer внутри доверенной сети, если проверка уже на edge.

---

## См. также

- [quick-start.mcp.md](quick-start.mcp.md) — пути, клиенты, mcp-proxy 0.11.0
- [mcp-http-proxy-integration-audit.md](mcp-http-proxy-integration-audit.md) — Smithery, метрики, перенос ответственности на proxy
- [docs/monitoring.md](monitoring.md) — метрики API vs порт 4200
