/**
 * Heavy load test: POST /subtitles with video pool (round-robin).
 * 5-10 VU, 60 sec ramp-up. Uses yt-dlp.
 */
import http from 'k6/http';
import { BASE_URL, getVideoRequest } from './config.js';

export const options = {
  stages: [
    { duration: '10s', target: 5 },
    { duration: '20s', target: 10 },
    { duration: '30s', target: 10 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<120000'],
  },
};

export default function () {
  const iter = typeof __ITER === 'number' ? __ITER : Math.floor(Date.now() / 1000);
  const { url } = getVideoRequest(iter, __VU);
  const res = http.post(
    `${BASE_URL}/subtitles`,
    JSON.stringify({ url }),
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: '120s',
    }
  );
  if (res.status !== 200) {
    console.error(`Subtitles failed: ${res.status} ${res.body?.slice(0, 200)}`);
  }
}
