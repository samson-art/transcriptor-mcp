/**
 * Mixed scenario: 70% /health, 20% /subtitles/available, 10% /subtitles.
 * Simulates realistic traffic.
 */
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, getVideoRequest } from './config.js';

export const options = {
  vus: 10,
  duration: '60s',
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<90000'],
  },
};

export default function () {
  const r = Math.random();
  const iter = typeof __ITER === 'number' ? __ITER : Math.floor(Date.now() / 1000);

  if (r < 0.7) {
    const res = http.get(`${BASE_URL}/health`);
    check(res, { 'health status 200': (r) => r.status === 200 });
  } else if (r < 0.9) {
    const { url } = getVideoRequest(iter, __VU);
    const res = http.post(
      `${BASE_URL}/subtitles/available`,
      JSON.stringify({ url }),
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: '60s',
      }
    );
    check(res, { 'available status 200': (r) => r.status === 200 });
  } else {
    const { url, type, lang } = getVideoRequest(iter, __VU);
    const res = http.post(
      `${BASE_URL}/subtitles`,
      JSON.stringify({ url, type, lang }),
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: '120s',
      }
    );
    check(res, { 'subtitles status 200': (r) => r.status === 200 });
  }
}
