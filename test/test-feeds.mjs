// 数据源模块单测：全部用注入的假 fetch，不依赖网络
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Feeds = require('../peak-valley-feeds.js');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = String(got) === String(want);
  ok ? (pass++, console.log(`  [OK] ${label}`)) : (fail++, console.log(`  [X] ${label}\n       got  = ${got}\n       want = ${want}`));
};
const ok_ = (label, cond, extra) => {
  cond ? (pass++, console.log(`  [OK] ${label}`)) : (fail++, console.log(`  [X] ${label}${extra ? '  ' + extra : ''}`));
};

const jsonRes = obj => ({ ok: true, status: 200, json: () => Promise.resolve(obj) });
const badRes = code => ({ ok: false, status: code, json: () => Promise.resolve({}) });

console.log('\n[1] syncClock：失败源自动降级到下一个源，并按半程时延补偿');
{
  const calls = [];
  const fetchImpl = (url) => {
    calls.push(url);
    if (url.includes('worldtimeapi')) return Promise.resolve(badRes(503));
    if (url.includes('timeapi')) return Promise.resolve(jsonRes({ dateTime: '2026-10-03T12:34:56.789' }));
    return Promise.resolve(jsonRes({ data: { t: '1' } }));
  };
  const r = await Feeds.syncClock({ fetchImpl, timeoutMs: 500 });
  eq('已同步', r.synced, 'true');
  eq('用的是第二个源', r.source, 'timeapi.io');
  ok_('记录了两条尝试', r.attempts.length === 2, JSON.stringify(r.attempts));
  eq('第一个源标记失败', r.attempts[0].ok, 'false');
  eq('失败原因', r.attempts[0].message, 'HTTP 503');
  const expect = Date.parse('2026-10-03T12:34:56.789Z');
  ok_('偏移量 = 服务端时间 + 往返/2 − 本地时间', Math.abs((r.offsetMs) - (expect + r.rtt / 2 - (Date.now()))) < 70000, `offset=${Math.round(r.offsetMs)} rtt=${r.rtt}`);
  ok_('只请求了两个源（降级即停）', calls.length === 2, String(calls.length));
}

console.log('\n[2] syncClock：全部失败必须明确返回未同步');
{
  const r = await Feeds.syncClock({ fetchImpl: () => Promise.reject(new Error('网络不可达')), timeoutMs: 300 });
  eq('synced = false', r.synced, 'false');
  eq('offsetMs 归零', r.offsetMs, 0);
  eq('source 为空', r.source, 'null');
  eq('三个源都试过', r.attempts.length, 3);
  ok_('每条都有失败原因', r.attempts.every(a => !a.ok && a.message.includes('网络不可达')));
}

console.log('\n[3] syncClock：返回垃圾内容也要当作失败');
{
  const r = await Feeds.syncClock({ fetchImpl: () => Promise.resolve(jsonRes({ nope: 1 })), timeoutMs: 300 });
  eq('未同步', r.synced, 'false');
  ok_('原因是内容无法解析', /无法解析/.test(r.attempts[0].message), r.attempts[0].message);
}

console.log('\n[4] 超时：即使底层忽略 AbortSignal 也必须超时');
{
  const never = () => new Promise(() => {});          // 永远不 settle，且不理会 signal
  const t0 = Date.now();
  const r = await Feeds.syncClock({ fetchImpl: never, sources: [Feeds.syncClock && { label: 'x', url: 'http://x', pick: () => 1 }], timeoutMs: 120 });
  const dt = Date.now() - t0;
  ok_('在超时时间内返回（不为假 fetch 卡死）', dt < 1000, dt + 'ms');
  eq('判定为未同步', r.synced, 'false');
  ok_('原因是超时', /超时/.test(r.attempts[0].message), r.attempts[0].message);
}

console.log('\n[5] syncHolidays：解析、校验与合并');
{
  const payload = (y, extra) => ({ holiday: Object.assign({
    a: { date: `${y}-10-01`, holiday: true, name: '国庆节' },
    b: { date: `${y}-10-10`, holiday: false, name: '国庆节后补班' },
    bad: { date: '13/01/2026', holiday: true, name: '格式错' },
    wrong: { date: `${y + 1}-01-01`, holiday: true, name: '年份不符' },
    n: { holiday: true, name: '缺日期' }
  }, extra || {}) });
  const fetchImpl = url => {
    const y = Number(url.match(/year\/(\d{4})/)[1]);
    return Promise.resolve(jsonRes(payload(y)));
  };
  const r = await Feeds.syncHolidays({ years: [2026, 2027], fetchImpl, timeoutMs: 500 });
  eq('两个年份都成功', r.ok.length, 2);
  eq('失败列表为空', r.failed.length, 0);
  eq('无空数据年份', r.empty.length, 0);
  eq('2026 放假 1 天', Object.keys(r.cal['2026'].holidays).join(), '2026-10-01');
  eq('2026 调休 1 天', Object.keys(r.cal['2026'].workdays).join(), '2026-10-10');
  eq('5 条里 2 条有效、3 条异常', `${r.ok[0].count}/${r.ok[0].skipped}`, '2/3');
  eq('合并后年份齐全', Object.keys(r.cal).sort().join(), '2026,2027');
}

console.log('\n[5b] 接口成功但无数据 ≠ 已同步（2027 尚未公布的情形）');
{
  const fetchImpl = url => {
    const y = Number(url.match(/year\/(\d{4})/)[1]);
    return Promise.resolve(jsonRes(y === 2027 ? { holiday: {} } : { holiday: { a: { date: `${y}-10-01`, holiday: true, name: '国庆节' } } }));
  };
  const r = await Feeds.syncHolidays({ years: [2026, 2027], fetchImpl, timeoutMs: 500 });
  eq('只有 2026 算同步成功', r.ok.map(x => x.year).join(), '2026');
  eq('2027 归入 empty', r.empty.join(), '2027');
  eq('2027 未写入日历', r.cal['2027'], 'undefined');
  eq('failed 为空（不是错误）', r.failed.length, 0);
}

console.log('\n[6] syncHolidays：整年失败不抛异常，只进 failed');
{
  const r = await Feeds.syncHolidays({ years: [2026], fetchImpl: () => Promise.reject(new Error('DNS 失败')), timeoutMs: 300 });
  eq('ok 为空', r.ok.length, 0);
  eq('failed 一条', r.failed.length, 1);
  eq('失败信息透传', r.failed[0].message, 'DNS 失败');
  eq('cal 为空对象', Object.keys(r.cal).length, 0);
}

console.log('\n[7] mergeCalendar：幂等、不覆盖已有、不污染原型');
{
  const target = { '2026': { holidays: { '2026-01-01': '元旦' }, workdays: {} } };
  const n1 = Feeds.mergeCalendar(target, { '2026': { holidays: { '2026-10-01': '国庆节' }, workdays: { '2026-10-10': '补班' } } });
  eq('合并条数', n1, 2);
  eq('保留原有', target['2026'].holidays['2026-01-01'], '元旦');
  eq('新增生效', target['2026'].holidays['2026-10-01'], '国庆节');
  Feeds.mergeCalendar(target, { '2026': { holidays: { '2026-10-01': '国庆节' }, workdays: {} } });
  eq('同内容重复合并幂等', Object.keys(target['2026'].holidays).length, 2);
  const evil = JSON.parse('{"2026":{"holidays":{"__proto__":"x","constructor":"y"},"workdays":{}}}');
  Feeds.mergeCalendar(target, evil);
  ok_('原型未被污染', ({}).polluted === undefined && Object.getPrototypeOf(target['2026'].holidays) === Object.prototype);
  // 字符串值赋给 __proto__ 会被静默忽略，必须用**对象值**才能真触发原型 setter
  const evilObj = JSON.parse('{"2026":{"holidays":{"__proto__":{"polluted":"yes"}},"workdays":{"constructor":{"x":1}}}}');
  const merged = Feeds.mergeCalendar(target, evilObj);
  eq('危险键未合并', merged, 0);
  ok_('对象值也未能污染原型',
    Object.getPrototypeOf(target['2026'].holidays) === Object.prototype && ({}).polluted === undefined);
  // 年份键同样要挡（target['__proto__'] 会命中 Object.prototype）
  const evilYear = JSON.parse('{"__proto__":{"holidays":{"2026-01-01":"x"},"workdays":{}}}');
  eq('危险年份键未合并', Feeds.mergeCalendar(target, evilYear), 0);
  ok_('Object.prototype 未被污染', Object.prototype['2026-01-01'] === undefined);
}

console.log('\n[8] yearsAround：按北京时间取年份，不受 UTC 跨年影响');
{
  // 北京时间 2026-01-01 07:00，此刻 UTC 还是 2025-12-31
  eq('北京 2026-01-01 07:00 → [2025,2026,2027]', Feeds.yearsAround(Date.parse('2026-01-01T07:00:00+08:00'), 480).join(), '2025,2026,2027');
  eq('北京 2025-12-31 07:00 → [2024,2025,2026]', Feeds.yearsAround(Date.parse('2025-12-31T07:00:00+08:00'), 480).join(), '2024,2025,2026');
  eq('北京 2026-12-31 23:00 → [2025,2026,2027]', Feeds.yearsAround(Date.parse('2026-12-31T23:00:00+08:00'), 480).join(), '2025,2026,2027');
}

console.log('\n[9] calendarYears：只列出真正有数据的年份');
{
  const cal = { '2025': { holidays: { '2025-01-01': '元旦' }, workdays: {} }, '2027': { holidays: {}, workdays: { '2027-01-01': 'x' } } };
  eq('只含有放假日的年份', Feeds.calendarYears(cal).join(), '2025');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
