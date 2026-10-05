// 加固审计：外部数据污染、参数语义、HTTP 边界
import { createRequire } from 'node:module';
import net from 'node:net';
const require = createRequire(import.meta.url);
const srv = require('../server.js');
const Feeds = require('../peak-valley-feeds.js');


const BASE = process.env.BASE || 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = String(got) === String(want);
  ok ? (pass++, console.log(`  [OK] ${label}`)) : (fail++, console.log(`  [X] ${label}\n       got  = ${got}\n       want = ${want}`));
};
const ok_ = (label, cond, extra) => {
  cond ? (pass++, console.log(`  [OK] ${label}`)) : (fail++, console.log(`  [X] ${label}${extra ? '  ' + extra : ''}`));
};

// require server.js 只应导出函数：不得把进程级处理器或定时器带进宿主进程
{
  const before = {
    uncaught: process.listenerCount('uncaughtException'),
    unhandled: process.listenerCount('unhandledRejection'),
    term: process.listenerCount('SIGTERM'),
    int: process.listenerCount('SIGINT')
  };
  ok_('require server.js 未安装 uncaughtException 处理器', before.uncaught === 0, 'count=' + before.uncaught);
  ok_('require server.js 未安装 unhandledRejection 处理器', before.unhandled === 0, 'count=' + before.unhandled);
  ok_('require server.js 未安装信号处理器', before.term === 0 && before.int === 0,
    `SIGTERM=${before.term} SIGINT=${before.int}`);
  ok_('require server.js 未开始监听', srv.server.listening === false);
}

console.log('\n[1] 外部日历数据必须校验后才能入库');
{
  const payload = {
    holiday: {
      good: { date: '2026-10-01', holiday: true, name: '国庆节' },
      bad_fmt: { date: '10/01/2026', holiday: true, name: '格式错' },
      bad_year: { date: '2027-01-01', holiday: true, name: '年份不符' },
      no_date: { holiday: true, name: '缺日期' },
      nullish: null,
      weird_name: { date: '2026-10-02', holiday: true, name: { toString: () => 'x' } },
      long_name: { date: '2026-10-03', holiday: true, name: 'x'.repeat(200) },
      work: { date: '2026-10-10', holiday: false, name: '国庆节后补班' }
    }
  };
  const r = Feeds.parseHolidayPayload(payload, 2026);
  eq('只收下合法日期', r.count, 4);
  eq('丢弃条数', r.skipped, 4);
  eq('放假入库', Object.keys(r.cal[2026].holidays).sort().join(','), '2026-10-01,2026-10-02,2026-10-03');
  eq('调休入库', Object.keys(r.cal[2026].workdays).join(','), '2026-10-10');
  ok_('超长名称被截断', r.cal[2026].holidays['2026-10-03'].length <= 40, String(r.cal[2026].holidays['2026-10-03'].length));
  eq('非字符串名称回退为默认', r.cal[2026].holidays['2026-10-02'], '节假日');
}

console.log('\n[2] 拒绝原型污染键');
{
  const evil = JSON.parse('{"holiday":{"a":{"date":"2026-12-25","holiday":true,"name":"x"},"__proto__":{"date":"__proto__","holiday":true,"name":"pwn"},"constructor":{"date":"constructor","holiday":true,"name":"pwn"}}}');
  const r = Feeds.parseHolidayPayload(evil, 2026);
  eq('只收下合法那条', r.count, 1);
  ok_('Object.prototype 未被污染', ({}).polluted === undefined && ({}).name === undefined);
  ok_('日历原型未被改写', Object.getPrototypeOf(r.cal[2026].holidays) === Object.prototype);
  eq('危险键未进入日历', Object.keys(r.cal[2026].holidays).join(','), '2026-12-25');
}

console.log('\n[3] at 参数语义必须明确（Date.parse("0") 会被当成 2000 年）');
{
  eq('空字符串 → null（表示当前时间）', srv.parseAt(''), null);
  eq('null → null', srv.parseAt(null), null);
  eq('"0" 按 unix 秒 → 0（纪元）', srv.parseAt('0'), 0);
  eq('"1759499057" 按 unix 秒', srv.parseAt('1759499057'), 1759499057000);
  eq('"1759499057000" 按 unix 毫秒', srv.parseAt('1759499057000'), 1759499057000);
  eq('"2026" 按 unix 秒（不是公元 2026 年）', srv.parseAt('2026'), 2026000);
  eq('ISO 字符串正常解析', srv.parseAt('2026-10-09T10:00:00+08:00'), Date.parse('2026-10-09T10:00:00+08:00'));
  ok_('乱码 → NaN', Number.isNaN(srv.parseAt('不是时间')));
  ok_('超范围时间戳 → NaN', Number.isNaN(srv.parseAt('9999999999999999')));
}

console.log('\n[4] HTTP 边界');
async function get(path, opts) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { res, text, json };
}
{
  const epoch = await get('/v1/fenggu?at=0');
  eq('at=0 → 200', epoch.res.status, 200);
  eq('at=0 → 1970-01-01T08:00:00+08:00（不是 2000 年）', epoch.json.now.iso, '1970-01-01T08:00:00+08:00');
  eq('at=0 → 谷（周四早上）', epoch.json.fenggu, '谷');
  eq('暴露自定义响应头给浏览器', epoch.res.headers.get('access-control-expose-headers'), 'X-Fenggu, X-Fenggu-CN, X-Next-At');
  ok_('跨域可读 X-Fenggu', epoch.res.headers.get('x-fenggu') !== null, String(epoch.res.headers.get('x-fenggu')));
  eq('空 at 走当前时间', (await get('/v1/fenggu?at=')).res.status, 200);
  const dup = await get('/v1/fenggu?at=0&at=' + Date.parse('2026-10-09T10:00:00+08:00'));
  eq('重复 at 取第一个', dup.json.now.iso, '1970-01-01T08:00:00+08:00');
  eq('超长 query → 不崩', (await get('/v1/fenggu?x=' + 'a'.repeat(6000))).res.status, 200);
  eq('超范围时间戳 → 400', (await get('/v1/fenggu?at=9999999999999999')).res.status, 400);
  eq('负数时间戳可用', (await get('/v1/fenggu?at=-86400')).res.status, 200);
  eq('远未来年份可判定', (await get('/v1/fenggu?at=2099-06-15T10:00:00%2B08:00')).json.fenggu, '峰');
  // 裸 socket：必须显式 destroy 且等关闭完成，否则 process.exit 会撞上 libuv 断言
  const oneZero = await new Promise(resolve => {
    const s = net.connect(Number(new URL(BASE).port || 80), new URL(BASE).hostname, () => {
      s.write('GET /v1/fenggu HTTP/1.0\r\nConnection: close\r\n\r\n');
    });
    let buf = '', done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch (e) {}
      resolve(buf);
    };
    s.on('data', d => { buf += d.toString(); });
    s.on('end', finish);
    s.on('close', finish);
    s.on('error', finish);
    s.setTimeout(3000, finish);
  });
  ok_('HTTP/1.0 无 Host 头也能响应', /^HTTP\/1\.[01] 200/.test(oneZero), oneZero.split('\r\n')[0]);
  await new Promise(r => setTimeout(r, 80));   // 等 socket 彻底关闭再退出
}

console.log('\n[5] 静态资源不能越权读取');
{
  for (const p of ['/../server.js', '/..%2fserver.js', '/%2e%2e%2fpeak-valley-core.js', '/server.js', '/package.json']) {
    const r = await get(p);
    ok_(`${p} → 不返回源码`, r.res.status === 404 || r.res.status === 400, 'status=' + r.res.status);
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
