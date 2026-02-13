/**
 * Verifies VIDEO_POOL: for each video calls POST /subtitles/available and checks
 * that at least one subtitle language (official or auto) exists.
 * Run: BASE_URL=http://127.0.0.1:3000 node load/verify-pool.js
 * Or: make verify-pool
 */

import { VIDEO_POOL } from './config.js';

const BASE_URL = process.env.LOAD_BASE_URL || process.env.BASE_URL || 'http://127.0.0.1:3000';

async function checkVideo(entry) {
  const url = `https://www.youtube.com/watch?v=${entry.id}`;
  const res = await fetch(`${BASE_URL}/subtitles/available`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}`, body: await res.text().then((t) => t.slice(0, 200)) };
  }
  const data = await res.json();
  const official = data.official || [];
  const auto = data.auto || [];
  const hasAny = official.length > 0 || auto.length > 0;
  return {
    ok: hasAny,
    official,
    auto,
    suggestion: hasAny ? { official, auto } : null,
  };
}

async function main() {
  console.log(`Verifying ${VIDEO_POOL.length} videos at ${BASE_URL}\n`);
  let failed = 0;
  for (const entry of VIDEO_POOL) {
    const result = await checkVideo(entry);
    const status = result.ok ? 'OK' : 'FAIL';
    if (!result.ok) failed++;
    console.log(`${status} ${entry.id} (${entry.duration}s)`);
    if (!result.ok && result.error) console.log(`   ${result.error} ${result.body || ''}`);
    if (result.ok && result.suggestion) {
      const poolOfficial = (entry.official || []).join(',') || '[]';
      const poolAuto = (entry.auto || []).join(',') || '[]';
      const actualOfficial = (result.official || []).join(',');
      const actualAuto = (result.auto || []).join(',');
      if (poolOfficial !== actualOfficial || poolAuto !== actualAuto) {
        console.log(`   pool has official: [${poolOfficial}] auto: [${poolAuto}]`);
        console.log(`   actual official: [${actualOfficial}] auto: [${actualAuto}]`);
      }
    }
  }
  console.log(`\nDone. ${failed} of ${VIDEO_POOL.length} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
