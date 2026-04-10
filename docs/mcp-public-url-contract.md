# Публичный контракт MCP: URL, пути, Bearer и `/.well-known`

Этот документ фиксирует **единый контракт** для удалённых клиентов (Claude Code, Cursor, n8n, каталоги вроде Smithery/Glama, пользовательские интеграции в духе ChatGPT Custom Actions за вашим API-шлюзом) при стеке **stdio MCP + [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy)** за **HTTPS** (обратный прокси, nginx/Caddy, cloud LB). Его можно использовать как спецификацию для edge-конфигурации и биллинга.

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
| **Заголовок** | `Authorization: Bearer <secret>` — единый формат для защищённого публичного доступа через edge (проверка API-ключа на шлюзе, nginx `auth_basic`/`map`, Caddy `forward_auth`, и т.д.). |
| **Где проверяется** | На **шлюзе или reverse proxy** перед mcp-proxy. Процессы **Node (`dist/mcp.js`)** и **mcp-proxy** в режиме server **не** должны считаться единственной линией защиты для секрета — см. [quick-start.mcp.md](quick-start.mcp.md). |
| **Claude Code** | `claude mcp add --transport http <name> https://<MCP_PUBLIC_HOST>/mcp` + способ передачи Bearer, который поддерживает ваш клиент/обёртка (при обязательном токене на edge токен должен уходить в `Authorization`). |
| **Cursor (SSE)** | URL `https://<MCP_PUBLIC_HOST>/sse`; при необходимости тот же Bearer в настройках MCP, если хост/прокси его прокидывает. |
| **Smithery** | В [smithery.yaml](../smithery.yaml) опционален `authToken`; [.well-known/mcp-config](../.well-known/mcp-config) задаёт перенос в заголовок `Authorization` (в т.ч. как Bearer на вашей стороне). |
| **ChatGPT / «Custom Actions»** | Если интеграция — HTTP API к **вашему** шлюзу с фиксированными заголовками, зафиксируйте тот же **`Authorization: Bearer <api-key>`** (или схему, которую шлюз реально принимает), чтобы не плодить вторую модель секретов. |

Итог: **один тип секрета на пользователя/тариф на edge**, один способ передачи — **Bearer** — для всех перечисленных сценариев, где требуется аутентификация.

Для **OAuth 2.0 / OIDC** (каталоги вроде [Glama](https://glama.ai/mcp), спецификация [MCP Authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization)) токен в `Authorization: Bearer` выдаёт **отдельный authorization server**; для этого деплоя выбран **Authentik** — см. [раздел 6](#6-authorization-server-idp-authentik-vps).

---

## 4. Решение по `/.well-known`

После удаления встроенного Fastify MCP HTTP **ответы `/.well-known/...` не отдаёт** процесс `dist/mcp.js` и не обязан отдавать mcp-proxy. Для каталогов и сканеров исторически важны **анонимные GET** на discovery (см. [mcp-http-proxy-integration-audit.md](mcp-http-proxy-integration-audit.md)).

**Принятое решение для продуктовой политики:**

| Вариант | Когда использовать |
|--------|---------------------|
| **A. Публичные GET без ключа (рекомендуется для discovery)** | Отдельный маршрут на edge: `GET /.well-known/mcp/*` (и при необходимости статические `server-card.json`, `config-schema.json`) **без** проверки API-ключа, с нормальными CORS для GET. Контент — статика из репозитория/артефакта деплоя или отдельный микросервис. **MCP-сессии** (`/mcp`, `/sse`) остаются за API-ключом. |
| **B. Только закрытый доступ** | Если discovery не нужен вовсе (чистый private SaaS), маршруты `/.well-known/*` можно не публиковать или защитить тем же Bearer — с пониманием, что **Smithery/Glama-сканеры** не смогут прочитать карточку без ключа. |

**Рекомендация для монетизации (edge + биллинг):** использовать **вариант A** для `/.well-known` (или вынести discovery на отдельный поддомен/статический хост), а **квоты и ключи** применять к **`/mcp` и `/sse`** (и при желании к `/status`).

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

## 6. Authorization Server (IdP): Authentik (VPS)

### Resource server (шлюз) и authorization server (IdP)

По [MCP Authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization) роли разделены так:

| Роль | Где в этом деплое | Ответственность |
|------|-------------------|-----------------|
| **Resource server (RS)** | Публичный HTTPS edge (**reverse proxy** → **mcp-proxy**) | Отдаёт MCP over HTTP; для OAuth — [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) Protected Resource Metadata (`GET /.well-known/oauth-protected-resource`), приём `Authorization: Bearer <access_token>`, дальнейшая валидация токена на шлюзе (например JWT + JWKS). |
| **Authorization server (AS)** | **Authentik** на VPS (отдельный хост/приложение) | [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414) / OIDC discovery, выдача access token, регистрация/настройка OAuth-клиента в админке IdP. |

Клиент каталога (например [Glama](https://glama.ai/mcp)) ходит к **AS** за логином и токеном, а к **RS** — с Bearer на MCP URL. **Issuer URL** и **audience** (`aud` в JWT) настраиваются в Authentik и должны совпадать с тем, что ожидает шлюз при включении проверки JWT.

### Типичные параметры OAuth на edge

Ниже — **логические** значения, которые оператор задаёт в своей конфигурации шлюза (env, шаблоны ingress, секреты CI/CD и т.д.). В этом репозитории отдельного compose-файла для edge нет: маршруты и подстановки настраиваются у вас.

| Переменная / параметр | Назначение |
|------------------------|------------|
| **`OAUTH_ISSUER`** | Строка **issuer** authorization server (базовый URL OAuth2/OIDC provider в Authentik). Попадает в PRM как `authorization_servers[]` и задаёт, какой IdP использовать для discovery. |
| **`OAUTH_RESOURCE`** | Канонический URL защищаемого ресурса в PRM (часто `https://<MCP_PUBLIC_HOST>/mcp`). Должен совпадать с тем URL, который клиент считает «ресурсом» MCP. |
| **`OAUTH_AUDIENCE`** | Ожидаемое значение claim **`aud`** в JWT access token при проверке JWT на маршруте; на практике часто совпадает с **client_id** OAuth-приложения в Authentik, если провайдер так заполняет `aud`. Пока JWT-ветка на шлюзе не включена, значение может быть пустым. |
| **`OAUTH_RESOURCE_METADATA_URL`** | Полный URL документа PRM, если клиентам или прокси нужен явный канонический адрес (часто `https://<MCP_PUBLIC_HOST>/.well-known/oauth-protected-resource`). |

Для сценариев **OAuth 2.0** с MCP (protected resource на HTTPS edge, discovery клиента по [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) и метаданным AS) **зафиксирован** [Authentik](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/) на VPS как **OIDC / OAuth2 provider**.

| Тема | Контракт |
|------|----------|
| **Issuer** | Базовый URL провайдера в Authentik — тот же URL, который указан как issuer для OAuth2/OIDC Provider (в UI провайдера / приложения). Его используют клиенты и edge как идентификатор authorization server. |
| **OIDC discovery** | Обычно доступен по виду **`https://<authentik-host>/application/o/<provider-slug>/.well-known/openid-configuration`**. Точный путь зависит от slug провайдера; **канонический URL** брать из UI Authentik (страница провайдера / ссылка «OpenID Configuration»). |
| **Приложение в Authentik** | Создать **Application** и связанный **OAuth2 / OpenID Provider**: разрешить нужные grant types (для пользовательских клиентов вроде Glama обычно **authorization code + PKCE**). Задать **redirect URI**, которые ожидает клиент каталога. |
| **Glama** | В интерфейсе Glama указать **client_id** и **client_secret**, а также **redirect URI(s)** из **того же** приложения Authentik. Glama допускает предрегистрацию клиента вместо DCR. |
| **DCR** | Полноценный **RFC 7591 Dynamic Client Registration** в Authentik **не** считается стандартной возможностью; ориентир — **статическая пара client_id / client_secret** и redirect URIs в UI клиента. См. обсуждение: [goauthentik/authentik#8751](https://github.com/goauthentik/authentik/issues/8751). |
| **Токены на edge** | Для проверки access token на шлюзе (например через **JWT + JWKS** по OIDC discovery Authentik) нужны **JWT access tokens**. **Opaque** токены потребуют **introspection** на стороне AS, а не только проверки подписи на edge. |

Документация Authentik по OAuth2 provider: [OAuth2 Provider](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/).

---

## См. также

- [MCP Authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization) — OAuth 2.0 для MCP (RS, PRM, Bearer)
- [Glama MCP](https://glama.ai/mcp) — каталог серверов; OAuth-клиент настраивается в UI каталога
- [quick-start.mcp.md](quick-start.mcp.md) — пути, клиенты, mcp-proxy 0.11.0
- [mcp-http-proxy-integration-audit.md](mcp-http-proxy-integration-audit.md) — Smithery, метрики, перенос ответственности на proxy
- [docs/monitoring.md](monitoring.md) — метрики API vs порт 4200
