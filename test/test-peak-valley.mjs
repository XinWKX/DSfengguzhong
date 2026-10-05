// 直接引用网页与服务端共用的核心模块（同一份代码，不存在两边写法不一致的可能）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PV = require('../peak-valley-core.js');
const CAL = PV.CALENDAR;

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = String(got) === String(want);
  ok ? (pass++, console.log(`  [OK] ${label}`)) : (fail++, console.log(`  [X] ${label}\n       got  = ${got}\n       want = ${want}`));
};
const T = (s) => Date.parse(s);
const cst = (ms) => PV.fmtInOffset(ms, 480);
const seg = (s) => PV.getSegment(T(s), CAL);
const valley = (s) => PV.isValleyAt(T(s), CAL);

console.log('\n[1] 国庆期间全天空闲（用户所述场景）');
eq('2026-10-03 20:34 是谷', seg('2026-10-03T20:34:00+08:00').isValley, 'true');
eq('10-03 20:34 名称', seg('2026-10-03T20:34:00+08:00').name, '梁文谷');
eq('本段开始 = 09-30 18:00', cst(seg('2026-10-03T20:34:00+08:00').start), '2026-09-30 18:00:00');
eq('本段结束 = 10-08 09:00', cst(seg('2026-10-03T20:34:00+08:00').end), '2026-10-08 09:00:00');
eq('本段时长 = 7 天 15 小时', PV.fmtDurationHuman(seg('2026-10-03T20:34:00+08:00').duration), '7 天 15 小时');
eq('倒计时 = 4 天 12:26:00', PV.fmtCountdownHuman(seg('2026-10-03T20:34:00+08:00').remaining), '4 天 12:26:00');
eq('理由含「国庆节」', /国庆节/.test(seg('2026-10-03T20:34:00+08:00').reason), 'true');
eq('国庆 7 天全部是谷', [1, 2, 3, 4, 5, 6, 7].every(d => valley(`2026-10-0${d}T10:00:00+08:00`)), 'true');

console.log('\n[2] 调休上班的周末仍按空闲计费');
eq('2026-10-10（周六·补班）10:00 是谷', valley('2026-10-10T10:00:00+08:00'), 'true');
eq('该日无高峰区间', PV.peakWindowsOfDay(PV.cstDayStart(T('2026-10-10T10:00:00+08:00')), CAL).length, '0');
eq('2026-09-20（周日·补班）10:00 是谷', valley('2026-09-20T10:00:00+08:00'), 'true');
eq('2026-02-14（周六·补班）10:00 是谷', valley('2026-02-14T10:00:00+08:00'), 'true');

console.log('\n[3] 工作日高峰边界（2026-10-13 周二）');
eq('08:59:59 谷', valley('2026-10-13T08:59:59+08:00'), 'true');
eq('09:00:00 峰，剩 3h', (s => s.isValley + '|' + PV.fmtCountdown(s.remaining))(seg('2026-10-13T09:00:00+08:00')), 'false|03:00:00');
eq('11:59:59 峰，剩 1s', (s => s.isValley + '|' + s.remaining)(seg('2026-10-13T11:59:59+08:00')), 'false|1000');
eq('12:00:00 谷（午休）', valley('2026-10-13T12:00:00+08:00'), 'true');
eq('13:59:59 谷', valley('2026-10-13T13:59:59+08:00'), 'true');
eq('14:00:00 峰，剩 4h', (s => s.isValley + '|' + PV.fmtCountdown(s.remaining))(seg('2026-10-13T14:00:00+08:00')), 'false|04:00:00');
eq('17:59:59 峰，剩 1s', (s => s.isValley + '|' + s.remaining)(seg('2026-10-13T17:59:59+08:00')), 'false|1000');
eq('18:00:00 谷，直到次日 09:00', (s => PV.fmtDurationHuman(s.duration))(seg('2026-10-13T18:00:00+08:00')), '15 小时 0 分');
eq('工作日高峰是 2 段共 6h', PV.peakWindowsOfDay(PV.cstDayStart(T('2026-10-13T10:00:00+08:00')), CAL).map(w => (w[1] - w[0]) / 60).join('+'), '3+4');

console.log('\n[4] 跨周末的长空闲段');
eq('10-09(周五) 18:00 → 10-12(周一) 09:00', cst(seg('2026-10-09T18:00:00+08:00').end), '2026-10-12 09:00:00');
eq('时长 2 天 15 小时', PV.fmtDurationHuman(seg('2026-10-09T18:00:00+08:00').duration), '2 天 15 小时');

console.log('\n[5] 法定节假日全天（多节日抽样）');
for (const [d, name] of [['2026-01-01', '元旦'], ['2026-02-15', '春节'], ['2026-02-23', '初七'], ['2026-04-05', '清明节'], ['2026-05-02', '劳动节'], ['2026-06-20', '端午节'], ['2026-09-25', '中秋节'], ['2026-10-05', '国庆节']]) {
  eq(`${d} 10:00 是谷（${name}）`, valley(`${d}T10:00:00+08:00`), 'true');
}
eq('节假日的节假日名可查', PV.holidayName('2026-10-01', CAL), '国庆节');

console.log('\n[6] 普通工作日与夜间');
eq('2026-10-14 03:00 是谷（夜间）', valley('2026-10-14T03:00:00+08:00'), 'true');
eq('2026-10-14 10:00 是峰', valley('2026-10-14T10:00:00+08:00'), 'false');
eq('2026-10-14 23:00 是谷', valley('2026-10-14T23:00:00+08:00'), 'true');

console.log('\n[7] 节假日表数据完整');
const cnt = (y) => [Object.keys(CAL[y].holidays).length, Object.keys(CAL[y].workdays).length].join('/');
eq('2025 放假/调休 = 28/5', cnt('2025'), '28/5');
eq('2026 放假/调休 = 33/6', cnt('2026'), '33/6');
eq('国庆 7 天在表中', [1, 2, 3, 4, 5, 6, 7].every(d => !!CAL['2026'].holidays[`2026-10-0${d}`]), 'true');
eq('补班日在表中', ['2026-09-20', '2026-10-10'].every(d => !!CAL['2026'].workdays[d]), 'true');

console.log('\n[8] 未来 14 天高峰统计');
const from = T('2026-10-03T20:34:00+08:00');
// 每个工作日高峰 = 3h(09-12) + 4h(14-18) = 7h；窗口内有 10-08/09/12/13/14/15/16 共 7 个工作日
eq('国庆起点起算 14 天高峰 = 49 小时（7 天 × 7h）', PV.fmtDurationHuman(PV.countPeakMs(from, 14, CAL)), '2 天 1 小时');
eq('高峰只落在 10-08/09/12/13/14/15/16', PV.nextNDays(from, 14).filter(d => PV.peakWindowsOfDay(d, CAL).length).map(d => PV.cstParts(d).key.slice(5)).join(','),
   '10-08,10-09,10-12,10-13,10-14,10-15,10-16');

// countPeakMs 的 span 必须随天数扩展：原先固定 16 天，days > 16 会静默漏算
{
  const sumByDay = (startMs, days) => PV.nextNDays(startMs, days)
    .reduce((acc, d) => acc + PV.peakWindowsOfDay(d, CAL).reduce((s, w) => s + (w[1] - w[0]) * 60000, 0), 0);
  const base = PV.cstDayStart(T('2026-11-02T10:00:00+08:00'));   // 一段没有节假日的工作周起点
  for (const days of [14, 17, 30, 60]) {
    eq(`countPeakMs(${days} 天) 与逐日相加一致`, PV.countPeakMs(base, days, CAL), sumByDay(base, days));
  }
  eq('30 天结果大于 16 天（未被截断）', PV.countPeakMs(base, 30, CAL) > PV.countPeakMs(base, 16, CAL), true);
}

// 区间缓存必须能感知「年月数相同但内容不同」的日历对象
{
  const t = T('2026-11-03T10:00:00+08:00');
  const calA = { 2026: { holidays: {}, workdays: {} } };
  const calB = { 2026: { holidays: { '2026-11-03': '测试假日' }, workdays: {} } };
  eq('两个日历的年份数量相同', Object.keys(calA).length, Object.keys(calB).length);
  const segA = PV.getSegment(t, calA);
  const segB = PV.getSegment(t, calB);
  eq('日历 A 下 11-03 10:00 是高峰', segA.isValley, false);
  eq('换成日历 B 后重新计算（缓存未命中旧结果）', segB.isValley, true);
  eq('缓存键已包含日历指纹', PV.getSegment(t, calB).isValley, true);
}

console.log('\n[9] 全天候采样：getSegment 与 isValleyAt 必须一致，且边界合法');
let bad = 0, boundaries = 0;
const legal = new Set([0, 540, 720, 840, 1080]);
for (let t = T('2026-01-01T00:00:00+08:00'); t < T('2026-12-31T00:00:00+08:00'); t += 3600000) {
  const s = PV.getSegment(t, CAL);
  if (s.isValley !== PV.isValleyAt(t, CAL)) { bad++; continue; }
  if (!(s.start <= t && t < s.end)) { bad++; continue; }
  if (PV.isValleyAt(s.end, CAL) === s.isValley) { bad++; continue; }  // 下一个区间状态必须相反
  const p = PV.cstParts(s.start);
  if (!legal.has(p.minute) || (s.start % 60000) !== 0) boundaries++;
}
eq('全年 8760 个采样点判定自洽', bad, '0');
eq('所有切换点都落在 00:00/09:00/12:00/14:00/18:00', boundaries, '0');

console.log('\n[10] 时区无关性');
const inst = T('2026-10-03T12:34:00Z');
eq('同一绝对时刻判定稳定', PV.getSegment(inst, CAL).isValley, 'true');
eq('相邻采样不跳变', [0, 1, 2, 3, 4].every(i => PV.getSegment(inst + i * 1000, CAL).isValley === true), 'true');

console.log('\n[11] 区间缓存失效（性能优化的副作用防护）');
{
  const t = T('2026-10-13T10:00:00+08:00');   // 普通工作日高峰
  const cal = { '2026': { holidays: {}, workdays: {} } };                  // 指纹 2026:0/0
  eq('自定义日历：工作日 10:00 是峰', PV.getSegment(t, cal).isValley, 'false');

  // 年份数量相同、内容不同：靠日历指纹识别，不再命中旧缓存
  eq('同为 1 个年份、内容不同的日历不会命中旧缓存',
    PV.getSegment(t, { '2026': { holidays: { '2026-10-13': '甲', '2026-01-01': '乙' }, workdays: {} } }).isValley, 'true');

  // 就地改动：条数一变指纹就变，调用方无需做任何事
  cal['2026'].holidays['2026-10-13'] = '甲';                                // 0/0 → 1/0
  eq('就地新增假日（条数变化）自动察觉', PV.getSegment(t, cal).isValley, 'true');

  // 残留契约：条数不变、只把键换掉，指纹看不出来，这种情况仍必须显式失效
  cal['2026'].holidays = { '2026-10-15': '甲' };                            // 仍是 1/0
  eq('同条数换键：缓存仍旧（契约：这种情况必须显式 bumpCalendar）', PV.getSegment(t, cal).isValley, 'true');
  PV.bumpCalendar();
  eq('bumpCalendar 后立刻反映新日历', PV.getSegment(t, cal).isValley, 'false');

  eq('内置日历不受影响', PV.getSegment(t, CAL).isValley, 'false');
}

console.log('\n[12] 日历覆盖检测（未录入年份必须能被识别，而不是静默算错）');
{
  eq('2026 已录入', PV.calendarCovers('2026-10-01', CAL), 'true');
  eq('2025 已录入', PV.calendarCovers('2025-10-01', CAL), 'true');
  eq('2027 未录入', PV.calendarCovers('2027-10-01', CAL), 'false');
  eq('1970 未录入', PV.calendarCovers('1970-01-01', CAL), 'false');
  // 未录入时确实会误判为峰——所以必须靠 calendarCovers 提示，而不是当作正常结果
  eq('2027 国庆被当成工作日高峰（已知局限）', valley('2027-10-01T10:00:00+08:00'), 'false');
  eq('但能被识别为未覆盖', PV.calendarCovers('2027-10-01', CAL) === false && valley('2027-10-01T10:00:00+08:00') === false, 'true');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
