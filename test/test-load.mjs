// 压测：分离「服务端处理能力」与「客户端/传输开销」，并验证 gzip 优化
import http from 'node:http';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const HOST = new URL(BASE).hostname, PORT = Number(new URL(BASE).port || 80);

let pass = 0, fail = 0;
const ok_ = (label, cond, extra) => {
  cond ? (pass++, console.log(`  [OK] ${label}`)) : (fail++, console.log(`  [X] ${label}${extra ? '  ' + extra : ''}`));
};
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];

// 原生 keep-alive 客户端：测服务端真实能力，避免 undici fetch 每请求约 12ms 的客户端开销
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
function httpGet(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const s = performance.now();
    const r = http.request({ host: HOST, port: PORT, path, agent, headers }, res => {
      let n = 0;
      res.on('data', d => { n += d.length; });
      res.on('end', () => resolve({ ms: performance.now() - s, bytes: n, headers: res.headers, status: res.statusCode }));
    });
    r.on('error', reject);
    r.end();
  });
}

async function bench(path, n, concurrency) {
  await httpGet(path);
  const lat = [], app = [];
  let bytes = 0, errors = 0, issued = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (issued < n) {
      issued++;
      try {
        const r = await httpGet(path);
        lat.push(r.ms); bytes += r.bytes;
        if (r.status !== 200) errors++;
        const m = /app;dur=([\d.]+)/.exec(r.headers['server-timing'] || '');
        if (m) app.push(Number(m[1]));
      } catch (e) { errors++; }
    }
  }));
  const dt = performance.now() - t0;
  lat.sort((a, b) => a - b); app.sort((a, b) => a - b);
  return { dt, lat, app, bytes, errors, rps: n / dt * 1000 };
}

const health = async () => JSON.parse(await new Promise((res, rej) => {
  http.get({ host: HOST, port: PORT, path: '/healthz', agent }, r => {
    let s = ''; r.on('data', d => s += d); r.on('end', () => res(s));
  }).on('error', rej);
}));

const before = await health();
console.log(`\n压测目标 ${BASE}（原生 keep-alive 客户端）`);
console.log(`起始：请求 ${before.requests} · RSS ${before.rss_mb}MB\n`);

console.log('[1] 串行 500 次 /v1/fenggu（服务端真实延迟）');
{
  const r = await bench('/v1/fenggu', 500, 1);
  console.log(`  端到端 ${r.rps.toFixed(0)} req/s · p50 ${pct(r.lat, .5).toFixed(2)}ms · p95 ${pct(r.lat, .95).toFixed(2)}ms · p99 ${pct(r.lat, .99).toFixed(2)}ms`);
  console.log(`  服务端处理（Server-Timing）p50 ${pct(r.app, .5).toFixed(3)}ms · p95 ${pct(r.app, .95).toFixed(3)}ms · p99 ${pct(r.app, .99).toFixed(3)}ms`);
  ok_('零错误', r.errors === 0, 'errors=' + r.errors);
  ok_('拿到 Server-Timing 指标', r.app.length === r.lat.length, `${r.app.length}/${r.lat.length}`);
  ok_('服务端处理 p50 < 1.5ms', pct(r.app, .5) < 1.5, pct(r.app, .5).toFixed(3) + 'ms');
  ok_('服务端处理 p95 < 4ms', pct(r.app, .95) < 4, pct(r.app, .95).toFixed(3) + 'ms');
  ok_('端到端 p50 < 10ms', pct(r.lat, .5) < 10, pct(r.lat, .5).toFixed(2) + 'ms');
  console.log(`  （p99 仅供参考，同机共享 CPU 时受 GC/调度抖动影响，不作硬断言）`);
}

console.log('\n[2] 并发 64 × 共 2000 次');
{
  const r = await bench('/v1/fenggu', 2000, 64);
  console.log(`  端到端 ${r.rps.toFixed(0)} req/s · p50 ${pct(r.lat, .5).toFixed(2)}ms · p95 ${pct(r.lat, .95).toFixed(2)}ms · p99 ${pct(r.lat, .99).toFixed(2)}ms`);
  console.log(`  服务端处理（Server-Timing）p50 ${pct(r.app, .5).toFixed(3)}ms · p95 ${pct(r.app, .95).toFixed(3)}ms · p99 ${pct(r.app, .99).toFixed(3)}ms`);
  console.log('  注：压测客户端与服务端同机共享 CPU，端到端吞吐不代表服务端上限');
  ok_('零错误', r.errors === 0, 'errors=' + r.errors);
  ok_('服务端处理 p95 < 6ms（不受客户端排队影响）', pct(r.app, .95) < 6, pct(r.app, .95).toFixed(3) + 'ms');
  // 端到端吞吐受同机 CPU 争用影响极大（实测 237~2800 req/s 波动），只作「没坏」的下限检查
  ok_('端到端吞吐 > 100 req/s（仅作崩溃下限，非性能断言）', r.rps > 100, Math.round(r.rps) + ' req/s');
  console.log(`  （端到端吞吐 ${Math.round(r.rps)} req/s 仅参考：压测客户端与服务端争用同一台机器的 CPU）`);
}

console.log('\n[3] 浏览器同类路径（undici fetch，含客户端固定开销）500 次');
{
  await fetch(BASE + '/v1/fenggu');
  const lat = []; let errors = 0; let issued = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: 32 }, async () => {
    while (issued < 500) {
      issued++;
      const s = performance.now();
      try { const r = await fetch(BASE + '/v1/fenggu'); if (!r.ok) errors++; await r.json(); } catch (e) { errors++; }
      lat.push(performance.now() - s);
    }
  }));
  const dt = performance.now() - t0;
  lat.sort((a, b) => a - b);
  console.log(`  ${(500 / dt * 1000).toFixed(0)} req/s · p50 ${lat[250].toFixed(2)}ms（含 undici 客户端开销约 12ms）`);
  ok_('零错误', errors === 0, 'errors=' + errors);
}

console.log('\n[4] gzip 优化');
{
  const plain = await httpGet('/v1/fenggu');
  const gz = await httpGet('/v1/fenggu', { 'Accept-Encoding': 'gzip' });
  const ratio = 1 - gz.bytes / plain.bytes;
  console.log(`  未压缩 ${plain.bytes} B → gzip ${gz.bytes} B（省 ${(ratio * 100).toFixed(0)}%）`);
  ok_('返回了 Content-Encoding: gzip', gz.headers['content-encoding'] === 'gzip', String(gz.headers['content-encoding']));
  ok_('设置 Vary: Accept-Encoding', /accept-encoding/i.test(gz.headers['vary'] || ''), String(gz.headers['vary']));
  ok_('压缩率 > 35%（1.6KB 小包体，gzip 头占比高）', ratio > 0.35, (ratio * 100).toFixed(0) + '%');
  const prettyBody = await new Promise((res, rej) => {
    http.get({ host: HOST, port: PORT, path: '/v1/fenggu?pretty', agent }, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => res(s)); }).on('error', rej);
  });
  ok_('?pretty 返回缩进 JSON', /\n  "fenggu"/.test(prettyBody), JSON.stringify(prettyBody.slice(0, 24)));
  ok_('默认返回紧凑 JSON（字节数小于 pretty）', plain.bytes < Buffer.byteLength(prettyBody),
    `默认 ${plain.bytes}B vs pretty ${Buffer.byteLength(prettyBody)}B`);
  ok_('未请求压缩时返回明文', !plain.headers['content-encoding']);
  ok_('Content-Length 正确', Number(gz.headers['content-length']) === gz.bytes, `${gz.headers['content-length']} vs ${gz.bytes}`);
}

console.log('\n[5] 内存与计数');
{
  const after = await health();
  const grew = after.rss_mb - before.rss_mb;
  console.log(`  请求 ${before.requests} → ${after.requests}（+${after.requests - before.requests}）`);
  console.log(`  RSS ${before.rss_mb}MB → ${after.rss_mb}MB（+${grew.toFixed(1)}MB）· 堆 ${after.heap_used_mb}MB`);
  ok_('请求计数已统计', after.requests > before.requests);
  ok_('无 5xx 累计', after.errors === before.errors, 'errors=' + after.errors);
  ok_('内存无异常增长（< 60MB）', grew < 60, grew.toFixed(1) + 'MB');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
