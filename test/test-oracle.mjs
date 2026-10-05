// 独立对照测试：另写一份判定实现（只共用节假日“数据”，不共用任何“逻辑”）逐分钟对照
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PV = require('../peak-valley-core.js');
const CAL = PV.CALENDAR;

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = String(got) === String(want);
  ok ? (pass++, console.log(`  [OK] ${label}`)) : (fail++, console.log(`  [X] ${label}\n       got  = ${got}\n       want = ${want}`));
};

// ---------------------------------------------------------------- 独立对照实现
// 直接照官方定价页的规则文字重写，不复用核心的任何函数
const TZ = 8 * 3600 * 1000;
const pad = n => String(n).padStart(2, '0');
function oracle(ms) {
  const d = new Date(ms + TZ);
  const key = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  const dow = d.getUTCDay();                       // 0=周日
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (dow === 0 || dow === 6) return true;         // 周末全天空闲
  const year = key.slice(0, 4);
  if (CAL[year] && CAL[year].holidays[key]) return true;   // 法定节假日全天空闲
  const peak = (min >= 9 * 60 && min < 12 * 60) || (min >= 14 * 60 && min < 18 * 60);
  return !peak;
}

console.log('\n[1] 逐分钟对照（2025-01-01 ~ 2027-12-31，共 3 年）');
{
  const from = Date.parse('2025-01-01T00:00:00+08:00');
  const to = Date.parse('2028-01-01T00:00:00+08:00');
  let n = 0, bad = 0, firstBad = null;
  for (let t = from; t < to; t += 60000) {
    const a = PV.isValleyAt(t, CAL), b = oracle(t);
    n++;
    if (a !== b) { bad++; if (!firstBad) firstBad = new Date(t + TZ).toISOString(); }
  }
  eq(`样本 ${n.toLocaleString()} 分钟，与独立实现零分歧`, bad, 0);
  if (firstBad) console.log('       首个分歧:', firstBad);
}

console.log('\n[2] 时段区间与独立实现对照（2026 全年，每 7 分钟一个样本）');
{
  const from = Date.parse('2026-01-01T00:00:00+08:00');
  const to = Date.parse('2027-01-01T00:00:00+08:00');
  let n = 0, badState = 0, badRange = 0, badEdgeStart = 0, badEdgeEnd = 0, badBoundary = 0, badMath = 0;
  const LEGAL = new Set([0, 540, 720, 840, 1080]);
  for (let t = from; t < to; t += 7 * 60000) {
    const s = PV.getSegment(t, CAL);
    n++;
    if (s.isValley !== oracle(t)) badState++;
    if (!(s.start <= t && t < s.end)) badRange++;
    if (oracle(s.start - 1) === s.isValley) badEdgeStart++;      // 起点必须真的是状态变化点
    if (oracle(s.end) === s.isValley) badEdgeEnd++;              // 终点必须真的是状态变化点
    if (!LEGAL.has(PV.cstParts(s.start).minute)) badBoundary++;  // 只允许在 5 个时刻切换
    if (s.duration !== s.end - s.start || Math.abs(s.elapsed + s.remaining - s.duration) > 0 ||
        Math.abs(s.progress - s.elapsed / s.duration) > 1e-12) badMath++;
  }
  eq(`样本 ${n.toLocaleString()} 个，状态一致`, badState, 0);
  eq('区间包含当前时刻', badRange, 0);
  eq('起点即状态突变点', badEdgeStart, 0);
  eq('终点即状态突变点', badEdgeEnd, 0);
  eq('切换点只落在 00:00/09:00/12:00/14:00/18:00', badBoundary, 0);
  eq('时长/已过/剩余/进度自洽', badMath, 0);
}

console.log('\n[3] 极端与边界时刻');
{
  const zero = PV.getSegment(0, CAL);
  eq('unix 0（1970-01-01 08:00 北京）不崩且判谷', zero.isValley, true);
  const far = PV.getSegment(Date.parse('2099-06-15T10:00:00+08:00'), CAL);
  eq('2099 年工作日 10:00 判峰（无日历数据也不崩）', far.isValley, false);
  const back = PV.getSegment(Date.parse('1980-03-04T10:00:00+08:00'), CAL);
  eq('1980 年工作日 10:00 判峰', back.isValley, false);
  const leap = PV.getSegment(Date.parse('2028-02-29T10:00:00+08:00'), CAL);
  eq('闰日 2028-02-29 可判定', typeof leap.isValley, 'boolean');
  eq('负数时间戳（1969）不崩', typeof PV.getSegment(-86400000, CAL).isValley, 'boolean');
}

console.log('\n[4] 节假日数据与线上源交叉核对');
{
  try {
    const res = await fetch('https://timor.tech/api/holiday/year/2026/', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const j = await res.json();
    const live = new Set(), liveWork = new Set();
    for (const v of Object.values(j.holiday || {})) (v.holiday ? live : liveWork).add(v.date);
    // 只防抛错是不够的：线上源可能限流或改版而返回 HTTP 200 + 空数据，
    // 那种情况下把「零条」当成事实会让断言全部失败（CI 会因第三方抖动而挂）
    if (!res.ok || (live.size === 0 && liveWork.size === 0)) {
      console.log(`  [--] 线上日历返回空数据（HTTP ${res.status}），跳过交叉核对（不因第三方限流而失败）`);
    } else {
      const mine = new Set(Object.keys(CAL['2026'].holidays));
      const mineWork = new Set(Object.keys(CAL['2026'].workdays));
      const missH = [...live].filter(d => !mine.has(d));
      const extraH = [...mine].filter(d => !live.has(d));
      const missW = [...liveWork].filter(d => !mineWork.has(d));
      eq(`2026 放假日与线上一致（线上 ${live.size} 天）`, missH.length + extraH.length, 0);
      eq(`2026 调休上班日与线上一致（线上 ${liveWork.size} 天）`, missW.length, 0);
    }
  } catch (e) {
    console.log('  [--] 线上日历不可达，跳过交叉核对：', e.message);
  }
}

console.log('\n[5] 性能基线');
{
  const base = Date.parse('2026-10-13T09:30:00+08:00');
  for (const [name, fn, n] of [
    ['isValleyAt', t => PV.isValleyAt(t, CAL), 200000],
    ['getSegment', t => PV.getSegment(t, CAL), 50000],
    ['statusAt', t => PV.statusAt(t, CAL), 50000]
  ]) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn(base + (i % 1000) * 60000);
    const dt = performance.now() - t0;
    console.log(`  ${name.padEnd(12)} ${n.toLocaleString()} 次 / ${dt.toFixed(1)}ms → ${Math.round(n / dt * 1000).toLocaleString()} 次/秒 · 单次 ${(dt / n * 1000).toFixed(1)}µs`);
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
