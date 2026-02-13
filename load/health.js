/**
 * Baseline load test: GET /health only (no yt-dlp).
 * 50 VU, 30 sec. Validates latency and error rate.
 */
import http from 'k6/http';
import { BASE_URL } from './config.js';

export const options = {
  vus: 50,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/health`);
  if (res.status !== 200) {
    console.error(`Health check failed: ${res.status} ${res.body}`);
  }
}
