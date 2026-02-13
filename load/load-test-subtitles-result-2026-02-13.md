# Load test: subtitles

**Сценарий:** `load-test:subtitles` (POST /subtitles)  
**Дата:** 2026-02-13  
**BASE_URL:** http://127.0.0.1:3000  
**Инструмент:** k6 (Grafana), Docker  

## Параметры сценария

- **Скрипт:** `load/subtitles.js`
- **Эндпоинт:** POST /subtitles
- **VUs:** до 10 (ramp-up за 3 этапа, 60 s + graceful stop 30 s)
- **Длительность:** 1m 30s (включая остановку)

## Результаты (сводка)

| Метрика | Значение |
|--------|----------|
| **http_reqs** | 216 (3.22 req/s) |
| **http_req_duration (avg)** | 2.32 s |
| **http_req_duration (min/max)** | 9.24 ms / 20.97 s |
| **http_req_duration p(95)** | 13.38 s |
| **http_req_failed** | 0.00% (0 из 216) |
| **iterations** | 216 |
| **data_received** | 943 kB |
| **data_sent** | 41 kB |

## Пороги (thresholds)

| Порог | Ожидание | Факт | Статус |
|-------|----------|------|--------|
| `http_req_duration` p(95) < 120 s | ✓ | p(95)=13.38 s | **PASS** |
| `http_req_failed` rate < 5% | ✓ | 0.00% | **PASS** |

Все пороги пройдены.

## Детальные метрики

```
HTTP
  http_req_duration..............: avg=2.32s   min=9.24ms med=17.1ms  max=20.97s p(90)=12.27s p(95)=13.38s
    { expected_response:true }...: avg=2.32s   min=9.24ms med=17.1ms  max=20.97s p(90)=12.27s p(95)=13.38s
  http_req_failed................: 0.00%  0 out of 216
  http_reqs......................: 216    3.218818/s

EXECUTION
  iteration_duration.............: avg=2.33s   min=9.59ms med=18.58ms max=20.97s p(90)=12.27s p(95)=13.38s
  iterations.....................: 216    3.218818/s
  vus............................: 1      min=1         max=10
  vus_max........................: 10     min=10        max=10

NETWORK
  data_received..................: 943 kB 14 kB/s
  data_sent......................: 41 kB  608 B/s
```

## Итог k6

```
     execution: local
        script: /scripts/subtitles.js
        output: -

     scenarios: (100.00%) 1 scenario, 10 max VUs, 1m30s max duration (incl. graceful stop):
              * default: Up to 10 looping VUs for 1m0s over 3 stages (gracefulRampDown: 30s, gracefulStop: 30s)

  █ THRESHOLDS
    http_req_duration  ✓ 'p(95)<120000' p(95)=13.38s
    http_req_failed    ✓ 'rate<0.05' rate=0.00%

  █ TOTAL RESULTS
    [см. блок «Детальные метрики» выше]

running (1m07.1s), 00/10 VUs, 216 complete and 0 interrupted iterations
default ✓ [ 100% ] 00/10 VUs  1m0s
```

**Exit code:** 0 (все пороги пройдены).
