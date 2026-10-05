/*!
 * peak-valley-core.js — DS峰谷钟 判定核心（浏览器 / Node 共用）
 * Copyright (C) 2022 创想工作室 (Chuangxiang Studio)
 *
 * 本程序是自由软件：你可以依据 GNU 通用公共许可证（第 3 版或任何更新版本）
 * 的条款重新分发和/或修改它。本程序按“原样”提供，不带任何担保。
 * 完整条款见 LICENSE，或 <https://www.gnu.org/licenses/>。
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 浏览器：<script src="peak-valley-core.js"></script>  →  window.PeakValley
 * Node：  const PeakValley = require('./peak-valley-core.js')
 *
 * 规则（依据官方定价页，2026-09 调整后）：
 *   高峰 = 北京时间 周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00
 *   空闲 = 其余全部（工作日夜间与午休、周末全天、法定节假日全天、调休上班的周末）
 *   空闲时段单价 = 高峰时段单价的一半
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof root !== 'undefined' && root) root.PeakValley = api;
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var VERSION = '1.1.0';
  var SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';

  var PV_CONFIG = {
    cstOffsetMin: 480,
    peakWindows: [[540, 720], [840, 1080]],
    label: {
      peak:   { kind: '峰', name: '梁文峰', tier: 'peak',     price: '高峰时段 · 全价', ratio: 1 },
      valley: { kind: '谷', name: '梁文谷', tier: 'off_peak', price: '空闲时段 · 半价', ratio: 0.5 }
    }
  };

  // 内置日历（来源：公开节假日接口 / 各省放假通知），离线也能判定
  var PV_CALENDAR = {
    "2025": {
      holidays: { "2025-01-01":"元旦", "2025-01-28":"除夕", "2025-01-29":"初一", "2025-01-30":"初二", "2025-01-31":"初三", "2025-02-01":"初四", "2025-02-02":"初五", "2025-02-03":"初六", "2025-02-04":"初七", "2025-04-04":"清明节", "2025-04-05":"清明节", "2025-04-06":"清明节", "2025-05-01":"劳动节", "2025-05-02":"劳动节", "2025-05-03":"劳动节", "2025-05-04":"劳动节", "2025-05-05":"劳动节", "2025-05-31":"端午节", "2025-06-01":"端午节", "2025-06-02":"端午节", "2025-10-01":"国庆节", "2025-10-02":"国庆节", "2025-10-03":"国庆节", "2025-10-04":"国庆节", "2025-10-05":"国庆节", "2025-10-06":"中秋节", "2025-10-07":"国庆节", "2025-10-08":"国庆节" },
      workdays: { "2025-01-26":"春节前补班", "2025-02-08":"春节后补班", "2025-04-27":"劳动节前补班", "2025-09-28":"国庆节前补班", "2025-10-11":"国庆节后补班" }
    },
    "2026": {
      holidays: { "2026-01-01":"元旦", "2026-01-02":"元旦", "2026-01-03":"元旦", "2026-02-15":"春节", "2026-02-16":"除夕", "2026-02-17":"初一", "2026-02-18":"初二", "2026-02-19":"初三", "2026-02-20":"初四", "2026-02-21":"初五", "2026-02-22":"初六", "2026-02-23":"初七", "2026-04-04":"清明节", "2026-04-05":"清明节", "2026-04-06":"清明节", "2026-05-01":"劳动节", "2026-05-02":"劳动节", "2026-05-03":"劳动节", "2026-05-04":"劳动节", "2026-05-05":"劳动节", "2026-06-19":"端午节", "2026-06-20":"端午节", "2026-06-21":"端午节", "2026-09-25":"中秋节", "2026-09-26":"中秋节", "2026-09-27":"中秋节", "2026-10-01":"国庆节", "2026-10-02":"国庆节", "2026-10-03":"国庆节", "2026-10-04":"国庆节", "2026-10-05":"国庆节", "2026-10-06":"国庆节", "2026-10-07":"国庆节" },
      workdays: { "2026-01-04":"元旦后补班", "2026-02-14":"春节前补班", "2026-02-28":"春节后补班", "2026-05-09":"劳动节后补班", "2026-09-20":"中秋节前补班", "2026-10-10":"国庆节后补班" }
    }
  };

  var MS_MIN = 60000;
  var MS_DAY = 86400000;
  var WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function pad2(n){ return String(n).padStart(2, '0'); }
  function weekName(dow){ return WEEK_CN[dow]; }
  function isWeekend(dow){ return dow === 0 || dow === 6; }

  // 北京时间（UTC+8，无夏令时），返回该时刻所在北京日 00:00 的绝对毫秒
  function cstDayStart(ms){
    var off = PV_CONFIG.cstOffsetMin * MS_MIN;
    return Math.floor((ms + off) / MS_DAY) * MS_DAY - off;
  }
  function cstParts(ms){
    var d = new Date(ms + PV_CONFIG.cstOffsetMin * MS_MIN);
    return {
      key: d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()),
      dow: d.getUTCDay(),
      minute: d.getUTCHours() * 60 + d.getUTCMinutes()
    };
  }
  function calEntry(dateKey, cal){
    var y = String(dateKey).slice(0, 4);
    return (cal || PV_CALENDAR)[y] || null;
  }
  function holidayName(dateKey, cal){
    var e = calEntry(dateKey, cal);
    return (e && e.holidays && e.holidays[dateKey]) || null;
  }
  function workdayName(dateKey, cal){
    var e = calEntry(dateKey, cal);
    return (e && e.workdays && e.workdays[dateKey]) || null;
  }
  // 该年份的法定节假日表是否已录入。未录入时只能把节假日当工作日处理，
  // 调用方应据此给出提示，而不是静默输出可能错误的结果。
  function calendarCovers(dateKey, cal){
    var e = calEntry(dateKey, cal);
    return !!(e && e.holidays && Object.keys(e.holidays).length > 0);
  }

  function dayInfo(dayStartMs, cal){
    var p = cstParts(dayStartMs);
    var hol = holidayName(p.key, cal);
    return {
      key: p.key,
      dow: p.dow,
      week: weekName(p.dow),
      isWeekend: isWeekend(p.dow),
      holiday: hol,
      makeup: workdayName(p.key, cal),
      isValleyAllDay: !!hol || isWeekend(p.dow)
    };
  }

  // 某一时刻是否空闲（谷）
  function isValleyAt(ms, cal){
    var p = cstParts(ms);
    if (isWeekend(p.dow)) return true;
    if (holidayName(p.key, cal)) return true;
    for (var i = 0; i < PV_CONFIG.peakWindows.length; i++){
      var w = PV_CONFIG.peakWindows[i];
      if (p.minute >= w[0] && p.minute < w[1]) return false;
    }
    return true;
  }

  // 一天内的候选切换分钟：00:00 / 09:00 / 12:00 / 14:00 / 18:00 / 24:00
  function boundaryMinutes(){
    var out = [0], w = PV_CONFIG.peakWindows;
    for (var i = 0; i < w.length; i++){ out.push(w[i][0], w[i][1]); }
    out.push(1440);
    return out.sort(function(a, b){ return a - b; });
  }

  // 区间集合只在北京日切换或日历变更时才会变，缓存一份即可（246µs → 1µs 量级）
  // 注意：修改传入的日历对象后必须调用 bumpCalendar() 使其失效
  var _runsCache = { key: null, runs: null };
  var _calVersion = 0;
  function bumpCalendar(){ _calVersion++; _runsCache.key = null; }

  // 日历指纹：缓存 key 必须能感知「传入的日历对象变了」。
  // 只记年份数量是不够的 —— 换一份年份数相同、内容不同的日历会命中旧缓存算出错误结果。
  // 代价是每次 buildRuns 遍历年份并数一遍键，量级为微秒，可以接受。
  function calFingerprint(cal){
    if (!cal) return '-';
    var parts = [];
    for (var y in cal){
      if (!Object.prototype.hasOwnProperty.call(cal, y)) continue;
      var e = cal[y] || {};
      parts.push(y + ':' + Object.keys(e.holidays || {}).length + '/' + Object.keys(e.workdays || {}).length);
    }
    parts.sort();
    return parts.join(',');
  }

  // 把 ±span 天内的候选点切成连续区间，再合并同状态的相邻区间
  function buildRuns(nowMs, cal, span){
    span = span || 16;
    var key = cstDayStart(nowMs) + '#' + span + '#' + _calVersion + '#' + calFingerprint(cal);
    if (_runsCache.key === key) return _runsCache.runs;

    var bounds = boundaryMinutes();
    var base = cstDayStart(nowMs);
    var times = [];
    for (var d = -span; d <= span; d++){
      var ds = base + d * MS_DAY;
      for (var i = 0; i < bounds.length; i++) times.push(ds + bounds[i] * MS_MIN);
    }
    times.sort(function(a, b){ return a - b; });
    var runs = [];
    for (var k = 0; k < times.length - 1; k++){
      var v = isValleyAt(times[k] + 1, cal);
      var last = runs[runs.length - 1];
      if (last && last.isValley === v) last.end = times[k + 1];
      else runs.push({ isValley: v, start: times[k], end: times[k + 1] });
    }
    _runsCache.key = key;
    _runsCache.runs = runs;
    return runs;
  }

  function describeRun(run, nowMs, cal){
    var L = PV_CONFIG.label[run.isValley ? 'valley' : 'peak'];
    var duration = run.end - run.start;
    var elapsed = Math.min(Math.max(nowMs - run.start, 0), duration);
    var p = cstParts(nowMs);
    var hol = holidayName(p.key, cal);
    var reason;
    if (run.isValley){
      if (hol) reason = '法定节假日「' + hol + '」全天按空闲时段计费';
      else if (isWeekend(p.dow)) reason = '周末（' + weekName(p.dow) + '）全天按空闲时段计费，调休上班的周末同样适用';
      else reason = '工作日非高峰时段（高峰仅 09:00–12:00、14:00–18:00）';
    } else {
      reason = weekName(p.dow) + '工作日高峰时段（09:00–12:00 / 14:00–18:00）';
    }
    return {
      isValley: run.isValley,
      name: L.name, kind: L.kind, price: L.price, tier: L.tier, ratio: L.ratio,
      reason: reason,
      start: run.start, end: run.end, duration: duration, elapsed: elapsed,
      remaining: Math.max(run.end - nowMs, 0),
      progress: Math.min(Math.max((nowMs - run.start) / duration, 0), 1),
      nextName: run.isValley ? PV_CONFIG.label.peak.name : PV_CONFIG.label.valley.name,
      nextKind: run.isValley ? PV_CONFIG.label.peak.kind : PV_CONFIG.label.valley.kind,
      nextTier: run.isValley ? PV_CONFIG.label.peak.tier : PV_CONFIG.label.valley.tier,
      nextIsValley: !run.isValley
    };
  }

  // 当前所处时段：[start, end) 左闭右开
  function getSegment(nowMs, cal){
    var runs = buildRuns(nowMs, cal);
    for (var i = 0; i < runs.length; i++){
      if (nowMs >= runs[i].start && nowMs < runs[i].end) return describeRun(runs[i], nowMs, cal);
    }
    var fallback = { isValley: isValleyAt(nowMs, cal), start: nowMs, end: nowMs + MS_MIN };
    return describeRun(fallback, nowMs, cal);
  }

  // 某一天内的高峰区间（分钟），节假日 / 周末返回空
  function peakWindowsOfDay(dayStartMs, cal){
    var info = dayInfo(dayStartMs, cal);
    if (info.isValleyAllDay) return [];
    var out = [];
    for (var i = 0; i < PV_CONFIG.peakWindows.length; i++) out.push([PV_CONFIG.peakWindows[i][0], PV_CONFIG.peakWindows[i][1]]);
    return out;
  }

  // 从某天起连续 n 天的北京日 00:00
  function nextNDays(startMs, n){
    var base = cstDayStart(startMs);
    var out = [];
    for (var i = 0; i < n; i++) out.push(base + i * MS_DAY);
    return out;
  }

  // 统计 [fromMs, fromMs + days 天) 内的高峰毫秒数
  function countPeakMs(fromMs, days, cal){
    // span 必须覆盖统计区间：原先固定用默认的 16 天，days > 16 时超出部分会被静默漏算
    var runs = buildRuns(fromMs, cal, Math.max(16, Math.ceil(days) + 1));
    var until = fromMs + days * MS_DAY;
    var total = 0;
    for (var i = 0; i < runs.length; i++){
      if (runs[i].isValley) continue;
      var s = Math.max(runs[i].start, fromMs), e = Math.min(runs[i].end, until);
      if (e > s) total += e - s;
    }
    return total;
  }

  function splitDuration(ms){
    ms = Math.max(Math.floor(ms), 0);
    return {
      d: Math.floor(ms / MS_DAY),
      h: Math.floor(ms / 3600000) % 24,
      m: Math.floor(ms / MS_MIN) % 60,
      s: Math.floor(ms / 1000) % 60,
      totalH: Math.floor(ms / 3600000)
    };
  }
  function fmtCountdown(ms){
    var p = splitDuration(ms);
    return (p.totalH < 10 ? '0' + p.totalH : String(p.totalH)) + ':' + pad2(p.m) + ':' + pad2(p.s);
  }
  // 超过一天时带上「天」，避免出现 183:00:00 这种读不动的倒计时
  function fmtCountdownHuman(ms){
    var p = splitDuration(ms);
    if (p.d > 0) return p.d + ' 天 ' + pad2(p.h) + ':' + pad2(p.m) + ':' + pad2(p.s);
    return (p.h < 10 ? '0' + p.h : String(p.h)) + ':' + pad2(p.m) + ':' + pad2(p.s);
  }
  function fmtDurationHuman(ms){
    var p = splitDuration(ms);
    if (p.d > 0) return p.d + ' 天 ' + p.h + ' 小时';
    if (p.totalH > 0) return p.totalH + ' 小时 ' + p.m + ' 分';
    return p.m + ' 分';
  }
  // 在固定 UTC 偏移下格式化（不依赖运行环境时区）
  function fmtInOffset(ms, offsetMinutes, withDate){
    var d = new Date(ms + offsetMinutes * MS_MIN);
    var date = d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
    var time = pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
    return withDate === false ? time : date + ' ' + time;
  }
  // ISO 8601 带固定偏移，例如 2026-10-03T20:44:17+08:00
  function isoInOffset(ms, offsetMinutes){
    var d = new Date(ms + offsetMinutes * MS_MIN);
    var abs = Math.abs(offsetMinutes);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + 'T' +
           pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()) +
           (offsetMinutes >= 0 ? '+' : '-') + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
  }
  function isoUtc(ms){
    return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  // 完整状态快照：网页与服务端 API 共用同一份结果
  function statusAt(ms, cal){
    var seg = getSegment(ms, cal);
    var day = dayInfo(cstDayStart(ms), cal);
    var p = cstParts(ms);
    return {
      at: ms,
      isValley: seg.isValley,
      kind: seg.kind, name: seg.name, price: seg.price, tier: seg.tier, ratio: seg.ratio,
      reason: seg.reason,
      start: seg.start, end: seg.end,
      duration: seg.duration, elapsed: seg.elapsed, remaining: seg.remaining, progress: seg.progress,
      nextName: seg.nextName, nextKind: seg.nextKind, nextTier: seg.nextTier, nextAt: seg.end,
      dateKey: p.key, minuteOfDay: p.minute, day: day
    };
  }

  var PeakValley = {
    VERSION: VERSION,
    SOURCE: SOURCE,
    CONFIG: PV_CONFIG,
    CALENDAR: PV_CALENDAR,
    RULES: {
      peak_windows_cst: [['09:00', '12:00'], ['14:00', '18:00']],
      peak_days: '周一至周五（不含中国法定节假日）',
      valley: '其余全部：工作日夜间与午休、周末全天、法定节假日全天、调休上班的周末',
      ratio: '空闲时段单价 = 高峰时段单价的一半'
    },
    statusAt: statusAt,
    getSegment: getSegment,
    bumpCalendar: bumpCalendar,
    isValleyAt: isValleyAt,
    cstParts: cstParts,
    cstDayStart: cstDayStart,
    dayInfo: dayInfo,
    holidayName: holidayName,
    calendarCovers: calendarCovers,
    isWeekend: isWeekend,
    peakWindowsOfDay: peakWindowsOfDay,
    nextNDays: nextNDays,
    countPeakMs: countPeakMs,
    splitDuration: splitDuration,
    fmtCountdown: fmtCountdown,
    fmtCountdownHuman: fmtCountdownHuman,
    fmtDurationHuman: fmtDurationHuman,
    fmtInOffset: fmtInOffset,
    isoInOffset: isoInOffset,
    isoUtc: isoUtc,
    pad2: pad2
  };

  return PeakValley;
}));
