// 对运行中的服务做端到端 HTTP 验证（不 spawn 子进程，直接请求）
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';
const require = createRequire(import.meta.url);
const PV = require('../peak-valley-core.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = String(got) === String(want);
  ok ? (pass++, console.log(`  [OK] ${label}`)) : (fail++, console.log(`  [X] ${label}\n       got  = ${got}\n       want = ${want}`));
};
const ok_ = (label, cond, extra) => {
  cond ? (pass++, console.log(`  [OK] ${label}`)) : (fail++, console.log(`  [X] ${label}${extra ? '  ' + extra : ''}`));
};

async function get(path, opts) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { res, text, json };
}

console.log('\n[1] GET /v1/fenggu 基本响应');
const r1 = await get('/v1/fenggu');
eq('HTTP 200', r1.res.status, 200);
ok_('Content-Type 是 JSON', /application\/json/.test(r1.res.headers.get('content-type') || ''));
eq('CORS 允许任意来源', r1.res.headers.get('access-control-allow-origin'), '*');
ok_('响应头带 X-Fenggu', !!r1.res.headers.get('x-fenggu'), r1.res.headers.get('x-fenggu'));
eq('X-Fenggu 是 ASCII 的 valley/peak', ['valley', 'peak'].includes(r1.res.headers.get('x-fenggu')), 'true');
ok_('X-Next-At 是 ISO', /^\d{4}-\d{2}-\d{2}T/.test(r1.res.headers.get('x-next-at') || ''), r1.res.headers.get('x-next-at'));
eq('Cache-Control 不缓存', r1.res.headers.get('cache-control'), 'no-store');
const st = r1.json;
eq('X-Fenggu-CN 百分号编码可还原为 fenggu', decodeURIComponent(r1.res.headers.get('x-fenggu-cn') || ''), st.fenggu);
ok_('fenggu 是 谷 或 峰', st && (st.fenggu === '谷' || st.fenggu === '峰'), JSON.stringify(st && st.fenggu));
eq('name 与 fenggu 对应', st.name, st.fenggu === '谷' ? '梁文谷' : '梁文峰');
eq('is_valley 与 fenggu 一致', st.is_valley, st.fenggu === '谷');
ok_('price.ratio 谷=0.5 峰=1', st.price.ratio === (st.is_valley ? 0.5 : 1), String(st.price.ratio));
for (const k of ['ok', 'fenggu', 'name', 'is_valley', 'price', 'reason', 'now', 'current', 'next', 'day', 'rules', 'server', 'source', 'project']) {
  if (!(k in st)) { fail++; console.log(`  [X] 缺少字段 ${k}`); }
}
console.log(`  [OK] 14 个顶层字段齐全`);
eq('project 归属署名', st.project.author, '创想工作室');
eq('project 协议', st.project.license, 'GPL-3.0-or-later');
eq('project 名称', st.project.name, 'DS峰谷钟');
eq('now.iso 带 +08:00', /\+08:00$/.test(st.now.iso), 'true');
eq('now.utc 以 Z 结尾', /Z$/.test(st.now.utc), 'true');

console.log('\n[2] 服务端结果必须与核心模块一致（不造假数据）');
let mismatch = 0;
for (const iso of ['2026-10-03T20:34:00+08:00', '2026-10-09T10:00:00+08:00', '2026-10-10T10:00:00+08:00', '2026-01-01T12:00:00+08:00', '2026-10-13T03:00:00+08:00']) {
  const t = Date.parse(iso);
  const expect = PV.statusAt(t, PV.CALENDAR);
  const got = (await get('/v1/fenggu?at=' + encodeURIComponent(iso))).json;
  const same = got.fenggu === expect.kind && got.name === expect.name &&
               got.current.start === PV.isoInOffset(expect.start, 480) &&
               got.current.end === PV.isoInOffset(expect.end, 480) &&
               got.next.in_seconds === Math.round(expect.remaining / 1000);
  if (!same) { mismatch++; console.log(`      ${iso}: API=${got.fenggu} core=${expect.kind}`); }
}
eq('5 个时刻与核心模块完全一致', mismatch, 0);

console.log('\n[3] 指定时刻的关键用例');
const peak = (await get('/v1/fenggu?at=' + encodeURIComponent('2026-10-09T10:00:00+08:00'))).json;
eq('工作日 10:00 → 峰', peak.fenggu, '峰');
eq('  下一段是谷', peak.next.fenggu, '谷');
eq('  本段结束 12:00', peak.current.end.slice(11, 16), '12:00');
eq('  原因含「高峰」', /高峰/.test(peak.reason), 'true');
const hol = (await get('/v1/fenggu?at=' + encodeURIComponent('2026-10-03T20:34:00+08:00'))).json;
eq('国庆期间 → 谷', hol.fenggu, '谷');
eq('  本段结束 = 10-08 09:00', hol.current.end, '2026-10-08T09:00:00+08:00');
eq('  剩余 4 天 12 小时 26 分（精确倒计时）', hol.next.in_human, '4 天 12:26:00');
eq('  粗粒度用于文案', hol.next.in_duration, '4 天 12 小时');
eq('  节假日名', hol.day.holiday, '国庆节');
const mk = (await get('/v1/fenggu?at=' + encodeURIComponent('2026-10-10T10:00:00+08:00'))).json;
eq('调休上班的周六 → 谷', mk.fenggu, '谷');
eq('  标记为补班', mk.day.makeup_workday, '国庆节后补班');
eq('  该日全天谷', mk.day.all_day_valley, 'true');
eq('unix 秒参数可用', (await get('/v1/fenggu?at=' + Math.floor(Date.parse('2026-10-09T10:00:00+08:00') / 1000))).json.fenggu, '峰');

console.log('\n[3b] 日历数据缺失必须显式告警（不能静默算错）');
{
  const covered = (await get('/v1/fenggu?at=' + encodeURIComponent('2026-10-09T10:00:00+08:00'))).json;
  eq('2026 已录入', covered.calendar.covered, 'true');
  eq('  无告警字段', covered.calendar_warning, undefined);
  const missing = (await get('/v1/fenggu?at=' + encodeURIComponent('2027-10-01T10:00:00+08:00'))).json;
  eq('2027 未录入 → covered=false', missing.calendar.covered, 'false');
  ok_('  给出 calendar_warning', typeof missing.calendar_warning === 'string' && missing.calendar_warning.includes('2027'), String(missing.calendar_warning));
  const txt = await get('/v1/fenggu.txt?at=' + encodeURIComponent('2027-10-01T10:00:00+08:00'));
  ok_('  纯文本也带注意行', /注意：2027/.test(txt.text), JSON.stringify(txt.text.split('\n').slice(-3)));
}

console.log('\n[4] 纯文本与错误处理');
const txt = await get('/v1/fenggu.txt');
ok_('Content-Type 是 text/plain', /text\/plain/.test(txt.res.headers.get('content-type') || ''));
ok_('首行是「谷 · 梁文谷」形式', /^(谷|峰) · 梁文(谷|峰)（/.test(txt.text), JSON.stringify(txt.text.split('\n')[0]));
ok_('含「距离上峰/下谷」', /距离(上峰|下谷)/.test(txt.text));
eq('?format=text 也返回文本', /^(谷|峰) · /.test((await get('/v1/fenggu?format=text')).text), 'true');
eq('Accept: text/plain 也返回文本', /^(谷|峰) · /.test((await get('/v1/fenggu', { headers: { Accept: 'text/plain' } })).text), 'true');
const badAt = await get('/v1/fenggu?at=不是时间');
eq('非法 at → 400', badAt.res.status, 400);
eq('  错误码', badAt.json.error, 'invalid_at');
eq('未知路径 → 404', (await get('/nope')).res.status, 404);
eq('POST → 405', (await get('/v1/fenggu', { method: 'POST' })).res.status, 405);
const pre = await fetch(BASE + '/v1/fenggu', { method: 'OPTIONS' });
eq('OPTIONS 预检 → 204', pre.status, 204);
eq('  预检带 CORS', pre.headers.get('access-control-allow-origin'), '*');

console.log('\n[5] 静态资源与健康检查');
const page = await get('/');
eq('GET / → 200', page.res.status, 200);
ok_('  是 HTML', /text\/html/.test(page.res.headers.get('content-type') || ''));
ok_('  引用了核心模块', /<script src="peak-valley-core\.js"><\/script>/.test(page.text));
const core = await get('/peak-valley-core.js');
eq('核心 JS → 200', core.res.status, 200);
ok_('  是 JS', /javascript/.test(core.res.headers.get('content-type') || ''));
ok_('  导出 PeakValley', /root\.PeakValley = api/.test(core.text));
const health = await get('/healthz');
eq('healthz → 200', health.res.status, 200);
eq('  ok=true', health.json.ok, 'true');
const head = await fetch(BASE + '/v1/fenggu', { method: 'HEAD' });
eq('HEAD → 200', head.status, 200);
eq('  HEAD 无正文', (await head.text()).length, 0);

console.log('\n[6] 健壮性：单个坏请求不能打死服务进程');
function raw(text, waitMs = 1200) {
  return new Promise(resolve => {
    const url = new URL(BASE);
    const s = net.connect(Number(url.port || 80), url.hostname);
    let buf = '', done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch (e) {}
      resolve(buf);
    };
    s.setTimeout(waitMs, finish);
    s.on('connect', () => s.write(text));
    s.on('data', d => { buf += d.toString(); });
    s.on('end', finish);
    s.on('close', finish);
    s.on('error', finish);
  });
}
await raw('GET /v1/fenggu HTTP/1.1\r\nHost: x\r\nX-Bad: \u00fc\u00e8\r\nConnection: close\r\n\r\n');   // 非 ASCII 头，触发 clientError
await raw('NOT-A-REQUEST\r\n\r\n');
await raw('GET /' + 'a'.repeat(9000) + ' HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
await new Promise(r => setTimeout(r, 80));   // 等 socket 关闭完成，避免退出时撞 libuv 断言
const alive = await get('/v1/fenggu');
eq('畸形请求之后服务仍存活', alive.res.status, 200);
ok_('仍能返回正确状态', alive.json && (alive.json.fenggu === '谷' || alive.json.fenggu === '峰'));

// [9] README 里的响应示例必须与真实响应字段一致（防止文档与接口走偏）
console.log('\n[9] README 的响应示例与真实接口对齐');
{
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const block = (readme.match(/```json\n([\s\S]*?)```/) || [])[1];
  ok_('README 含 json 示例', !!block);
  let example = null;
  try { example = JSON.parse(block); ok_('示例语法合法', true); }
  catch (e) { ok_('示例语法合法', false, e.message); }
  if (example) {
    const live = alive.json;
    const cmp = (label, a, b) => {
      const ka = Object.keys(a).sort();
      const kb = Object.keys(b === undefined ? {} : b).sort();
      const miss = kb.filter(k => !ka.includes(k));
      const extra = ka.filter(k => !kb.includes(k));
      ok_(`${label} 字段一致`, !miss.length && !extra.length,
        miss.length ? '示例缺: ' + miss.join(',') : (extra.length ? '示例多: ' + extra.join(',') : `${ka.length} 个`));
    };
    cmp('顶层', example, live);
    for (const k of ['now', 'current', 'next', 'day', 'price', 'rules', 'calendar', 'server', 'project']) {
      if (example[k] && live[k]) cmp(k, example[k], live[k]);
      else ok_(`${k} 存在于示例与实际`, false, `示例=${!!example[k]} 实际=${!!live[k]}`);
    }
    cmp('server.calendar_current', example.server.calendar_current, live.server.calendar_current);
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
