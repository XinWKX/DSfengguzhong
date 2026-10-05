#!/usr/bin/env node
/*!
 * DS峰谷钟 (DS Fenggu Zhong) — HTTP 服务
 * Copyright (C) 2022 创想工作室 (Chuangxiang Studio)
 *
 * 本程序是自由软件：你可以依据 GNU 通用公共许可证（第 3 版或任何更新版本）
 * 的条款重新分发和/或修改它。本程序按“原样”提供，不带任何担保。
 * 完整条款见 LICENSE，或 <https://www.gnu.org/licenses/>。
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * DS峰谷钟 API 服务
 *
 *   GET /                    DS峰谷钟网页
 *   GET /peak-valley-core.js 判定核心（网页与服务端共用）
 *   GET /v1/fenggu           当前峰谷状态（JSON）
 *   GET /v1/fenggu.txt       当前峰谷状态（纯文本）
 *   GET /healthz             存活检查
 *
 * 查询参数：
 *   ?at=2026-10-09T10:00:00+08:00   查询指定时刻（也接受 unix 秒 / 毫秒）
 *   ?format=text                    返回纯文本
 *
 * 启动：node server.js [端口]     环境变量：PORT / HOST
 *
 * 文件结构（按依赖顺序，见下方同名分隔注释）：
 *   常量与运行时状态 → 日历与时钟 → 校时/日历同步 → 状态构建（API 载荷）
 *   → HTTP 响应helper → 路由分发 → 服务与进程生命周期
 *
 * 分层原则：本文件只做「HTTP 与编排」，峰谷判定与日历数据全部来自
 * peak-valley-core.js / peak-valley-feeds.js（与网页共用同一份实现）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const PV = require('./peak-valley-core.js');
const Feeds = require('./peak-valley-feeds.js');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || process.argv[2] || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const CST = PV.CONFIG.cstOffsetMin;
const STARTED_AT = Date.now();
const stats = { requests: 0, errors: 0 };

// 用标准 Server-Timing 头暴露服务端真实处理耗时，便于把「服务端慢」和「客户端慢」分开
function serverTiming(res) {
  const t0 = res.__t0;
  if (!t0) return null;
  const dur = Number(process.hrtime.bigint() - t0) / 1e6;
  return 'app;dur=' + dur.toFixed(3);
}

// ---------------------------------------------------------------- 日历

// 内置表克隆一份，联网同步的数据合并进来（web 端做同样的事，逻辑都在 Feeds 里）
const CAL = (() => {
  const out = {};
  for (const y of Object.keys(PV.CALENDAR)) {
    out[y] = {
      holidays: Object.assign({}, PV.CALENDAR[y].holidays),
      workdays: Object.assign({}, PV.CALENDAR[y].workdays)
    };
  }
  return out;
})();
let calendarSource = '内置';

function calendarYears() { return Feeds.calendarYears(CAL); }

// ---------------------------------------------------------------- 时钟

let clockOffsetMs = 0;
let timeSource = 'system';
let clockSyncedAt = 0;

function nowMs() { return Date.now() + clockOffsetMs; }

async function syncClock(reason) {
  const r = await Feeds.syncClock({ timeoutMs: 5000 });
  for (const a of r.attempts) {
    if (!a.ok) console.warn(`[clock] ${a.label} 失败：${a.message}`);
  }
  if (!r.synced) {
    console.warn(`[clock] 所有授时源均失败，继续使用本机时间（${reason}）`);
    return false;
  }
  clockOffsetMs = r.offsetMs;
  timeSource = r.source;
  clockSyncedAt = Date.now();
  console.log(`[clock] 已同步 ${r.source} · 往返 ${r.rtt}ms · 本机偏差 ${(-r.offsetMs / 1000).toFixed(2)}s（${reason}）`);
  return true;
}

async function syncHolidays(reason) {
  const r = await Feeds.syncHolidays({ years: Feeds.yearsAround(nowMs(), CST), timeoutMs: 6000 });
  if (!r.ok.length) {
    console.warn(`[calendar] 接口不可用，继续使用内置表（${calendarYears().join('、')}）（${reason}）`);
    return false;
  }
  Feeds.mergeCalendar(CAL, r.cal);
  PV.bumpCalendar();   // 日历变了，让区间缓存失效
  calendarSource = `内置 + timor.tech（${r.ok.map(x => x.year).join('、')}）`;
  for (const x of r.ok) if (x.skipped) console.warn(`[calendar] ${x.year} 丢弃 ${x.skipped} 条格式异常的日期`);
  if (r.empty.length) console.log(`[calendar] ${r.empty.join('、')} 接口暂无数据（国务院通常在前一年年底公布），已跳过`);
  console.log(`[calendar] 已同步 ${r.ok.map(x => `${x.year}:${x.count} 条`).join(' ')}（${reason}）`);
  return true;
}

// ---------------------------------------------------------------- 状态

// 指定年份的日历条数（不传则取服务器当前年）
function calendarStats(year) {
  const y = year || PV.fmtInOffset(nowMs(), CST).slice(0, 4);
  const e = CAL[y] || { holidays: {}, workdays: {} };
  return {
    year: y,
    holidays: Object.keys(e.holidays || {}).length,
    workdays: Object.keys(e.workdays || {}).length
  };
}

function buildStatus(atMs) {
  const t = Number.isFinite(atMs) ? atMs : nowMs();
  const s = PV.statusAt(t, CAL);
  const sec = ms => Math.round(ms / 1000);
  const year = s.dateKey.slice(0, 4);
  const covered = PV.calendarCovers(s.dateKey, CAL);
  // 注意：这里不要叫 stats，否则会遮蔽模块级的请求计数器
  const yearStats = calendarStats(year);
  const out = {
    ok: true,
    fenggu: s.kind,
    name: s.name,
    is_valley: s.isValley,
    price: { tier: s.tier, label: s.price, ratio: s.ratio },
    reason: s.reason,
    now: {
      iso: PV.isoInOffset(t, CST),
      utc: PV.isoUtc(t),
      unix: Math.floor(t / 1000),
      date: s.dateKey,
      weekday: s.day.week,
      is_weekend: s.day.isWeekend,
      holiday: s.day.holiday,
      makeup_workday: s.day.makeup,
      minute_of_day: s.minuteOfDay
    },
    current: {
      start: PV.isoInOffset(s.start, CST),
      end: PV.isoInOffset(s.end, CST),
      duration_seconds: sec(s.duration),
      elapsed_seconds: sec(s.elapsed),
      remaining_seconds: sec(s.remaining),
      progress: Number(s.progress.toFixed(4))
    },
    next: {
      fenggu: s.nextKind,
      name: s.nextName,
      tier: s.nextTier,
      at: PV.isoInOffset(s.nextAt, CST),
      in_seconds: sec(s.remaining),
      in_human: PV.fmtCountdownHuman(s.remaining),
      in_duration: PV.fmtDurationHuman(s.remaining)
    },
    day: {
      date: s.dateKey,
      weekday: s.day.week,
      is_weekend: s.day.isWeekend,
      holiday: s.day.holiday,
      makeup_workday: s.day.makeup,
      all_day_valley: s.day.isValleyAllDay
    },
    rules: PV.RULES,
    calendar: {
      year: year,
      covered: covered,
      counts: { holidays: yearStats.holidays, workdays: yearStats.workdays },
      source: calendarSource,
      years: calendarYears()
    },
    server: {
      version: PV.VERSION,
      time_source: timeSource,
      clock_offset_ms: Math.round(clockOffsetMs),
      clock_synced_at: clockSyncedAt ? PV.isoInOffset(clockSyncedAt, CST) : null,
      calendar_current: calendarStats(),
      uptime_seconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      generated_at: PV.isoInOffset(nowMs(), CST)
    },
    source: PV.SOURCE,
    // 项目归属：任何消费本接口的地方都能看到署名
    project: { name: 'DS峰谷钟', author: '创想工作室', license: 'GPL-3.0-or-later' }
  };
  if (!covered) {
    out.calendar_warning = `${year} 年法定节假日表尚未录入（国务院通知通常在前一年年底发布），` +
      `${year} 年的法定节假日会被按工作日判定，结果可能偏「峰」，请以官方通知为准`;
  }
  return out;
}

function buildText(st) {
  const nextWord = st.is_valley ? '上峰' : '下谷';
  return [
    `${st.fenggu} · ${st.name}（${st.price.label}）`,
    `距离${nextWord}（${st.next.name}）还有 ${st.next.in_human}`,
    `本段：${st.current.start.replace('T', ' ')} → ${st.current.end.replace('T', ' ')}（北京时间，共 ${PV.fmtDurationHuman(st.current.duration_seconds * 1000)}）`,
    `原因：${st.reason}`,
    `查询时间：${st.now.iso}（UTC ${st.now.utc}）`,
    '规则：高峰 = 北京时间周一至周五（不含法定节假日）09:00–12:00、14:00–18:00；其余为空闲（半价）',
    ...(st.calendar_warning ? [`注意：${st.calendar_warning}`] : []),
    `来源：${st.source}`
  ].join('\n') + '\n';
}

// ---------------------------------------------------------------- HTTP

const STATIC = {
  '/': { file: 'deepseek-peak-valley.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'deepseek-peak-valley.html', type: 'text/html; charset=utf-8' },
  '/deepseek-peak-valley.html': { file: 'deepseek-peak-valley.html', type: 'text/html; charset=utf-8' },
  '/peak-valley-core.js': { file: 'peak-valley-core.js', type: 'application/javascript; charset=utf-8' },
  '/peak-valley-feeds.js': { file: 'peak-valley-feeds.js', type: 'application/javascript; charset=utf-8' }
};

// 三类响应共用的基础头：CORS、禁嗅探、Server-Timing，必须完全一致，集中在这里
function applyCommonHeaders(res) {
  cors(res);
  const timing = serverTiming(res);
  if (timing) res.setHeader('Server-Timing', timing);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');
  // 不加这条，跨域 JS 拿不到自定义响应头（fetch 只能读 CORS 白名单里的头）
  res.setHeader('Access-Control-Expose-Headers', 'X-Fenggu, X-Fenggu-CN, X-Next-At');
  // 禁止浏览器对响应做 MIME 嗅探
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

// 默认紧凑 JSON（省带宽），?pretty 或浏览器直接访问时缩进便于阅读；
// 客户端支持 gzip 时压缩，实测 2KB → 约 0.5KB
// handleRequest 已经解析过 URL，挂在 res.__url 上复用，响应层不再重复解析
function requestUrl(res) {
  if (res.__url) return res.__url;
  try { return new URL((res.req && res.req.url) || '/', 'http://x'); } catch (e) { return null; }
}

function sendJson(res, code, body, extraHeaders) {
  const req = res.req || {};
  const u = requestUrl(res);
  // ?pretty 或浏览器直接访问时缩进，便于人看
  const pretty = !!(u && u.searchParams.has('pretty'))
    || String(req.headers.accept || '').includes('text/html');
  const text = JSON.stringify(body, null, pretty ? 2 : 0) + '\n';
  const buf = Buffer.from(text, 'utf8');

  applyCommonHeaders(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extraHeaders || {})) {
    // HTTP 头只能放 ASCII（范围 0x20-0x7E），中文必须百分号编码，否则 Node 会抛 ERR_INVALID_CHAR
    const safe = String(v).replace(/[^\x20-\x7E]/g, c => encodeURIComponent(c));
    res.setHeader(k, safe);
  }

  if (req.method === 'HEAD') {
    res.setHeader('Content-Length', buf.length);
    res.writeHead(code);
    res.end();
    return;
  }
  const accept = String(req.headers && req.headers['accept-encoding'] || '');
  if (accept.includes('gzip') && buf.length >= 512) {
    const gz = zlib.gzipSync(buf);
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Content-Length', gz.length);
    res.writeHead(code);
    res.end(gz);
    return;
  }
  res.setHeader('Content-Length', buf.length);
  res.writeHead(code);
  res.end(buf);
}

function sendText(res, code, text) {
  applyCommonHeaders(res);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(code);
  res.end(text);
}

// 纯数字一律按 unix 时间戳解释（≤10 位算秒，>10 位算毫秒）。
// 不能用 Date.parse("0")——它会被当成公元 2000 年，语义完全错乱。
// 同时必须做范围校验，否则超大数字会让 Date 变成 Invalid Date，格式化时抛错变 500。
const MAX_MS = 8.64e15;   // Date 能表示的最大毫秒数
function parseAt(raw) {
  if (raw === null || raw === '') return null;
  const s = String(raw).trim();
  let ms;
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    ms = s.replace('-', '').length <= 10 ? n * 1000 : n;
  } else {
    // 没有时区偏移的时间串按**北京时间**解释：Date.parse 对无偏移串使用服务器本地时区，
    // 会让同一个请求在 UTC 与 Asia/Shanghai 的机器上得到相差 8 小时的结果。
    let t = s;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += 'T00:00:00+08:00';
    else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(t)) t = t.replace(' ', 'T') + '+08:00';
    ms = Date.parse(t);
  }
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_MS ? ms : NaN;
}

function serveStatic(res, req, entry) {
  const file = path.join(ROOT, entry.file);
  if (!file.startsWith(ROOT)) { sendText(res, 403, 'forbidden\n'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { sendText(res, 500, 'read error: ' + err.message + '\n'); return; }
    applyCommonHeaders(res);
    res.setHeader('Content-Type', entry.type);
    res.setHeader('Cache-Control', 'no-cache');
    res.writeHead(200);
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (e) {
    sendText(res, 400, 'bad request\n');
    return;
  }
  res.__url = url;            // 供响应层复用，避免二次解析
  let p = url.pathname;
  if (p.length > 1) p = p.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    cors(res);
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: 'method_not_allowed', message: '仅支持 GET / HEAD' });
    return;
  }

  const isApi = p === '/v1/fenggu' || p === '/v1/fenggu.txt' || p === '/fenggu';
  if (isApi) {
    const at = parseAt(url.searchParams.get('at'));
    if (at !== null && Number.isNaN(at)) {
      sendJson(res, 400, {
        ok: false,
        error: 'invalid_at',
        message: 'at 参数无法解析，请用 ISO 8601（2026-10-09T10:00:00+08:00）或 unix 秒/毫秒',
        received: url.searchParams.get('at')
      });
      return;
    }
    let st;
    try {
      st = buildStatus(at);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: 'internal', message: String(err && err.message || err) });
      return;
    }
    const wantText = p.endsWith('.txt') ||
      url.searchParams.get('format') === 'text' ||
      String(req.headers.accept || '').includes('text/plain');
    if (wantText) {
      sendText(res, 200, buildText(st));
    } else {
      sendJson(res, 200, st, {
        'X-Fenggu': st.is_valley ? 'valley' : 'peak',
        'X-Fenggu-CN': st.fenggu,
        'X-Next-At': st.next.at
      });
    }
    return;
  }

  if (p === '/healthz') {
    const mem = process.memoryUsage();
    sendJson(res, 200, {
      ok: true,
      uptime_seconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      requests: stats.requests,
      errors: stats.errors,
      rss_mb: +(mem.rss / 1048576).toFixed(1),
      heap_used_mb: +(mem.heapUsed / 1048576).toFixed(1),
      clock_offset_ms: Math.round(clockOffsetMs),
      time_source: timeSource,
      calendar_years: calendarYears()
    });
    return;
  }

  const entry = STATIC[p];
  if (entry) { serveStatic(res, req, entry); return; }

  sendJson(res, 404, {
    ok: false,
    error: 'not_found',
    routes: ['/', '/v1/fenggu', '/v1/fenggu.txt', '/healthz']
  });
}

// 单个请求出错不能拖垮整个服务（曾因响应头里塞中文抛 ERR_INVALID_CHAR 而整体退出）
const server = http.createServer((req, res) => {
  stats.requests++;
  res.__t0 = process.hrtime.bigint();
  // errors 只统计 5xx（服务端失败）；4xx 是客户端问题，不计入
  res.on('finish', () => { if (res.statusCode >= 500) stats.errors++; });
  try {
    handleRequest(req, res);
  } catch (err) {
    // 这里不自增 errors：紧随其后发出的 500 由 res 的 finish 事件统一计数，
    // 否则同一次失败会被记两次（errors 的语义是「5xx 响应数」）
    console.error('[http] 请求处理失败：', (err && err.stack) || err);
    try {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal', message: String((err && err.message) || err) });
      else res.end();
    } catch (e2) {
      try { res.destroy(); } catch (e3) { /* ignore */ }
    }
  }
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) { /* ignore */ }
});

// 进程级兜底：只在作为服务运行时安装（被 require 时不污染宿主进程，例如测试进程）
function installProcessHandlers() {
  // 未捕获的 Promise 拒绝通常只影响那一次异步操作，记录后继续服务
  process.on('unhandledRejection', err => console.error('[unhandled]', (err && err.stack) || err));
  // 未捕获异常之后进程状态未知。本项目无状态，重启比带病运行更安全：
  // 记录后优雅退出，交给 systemd（Restart=always）重新拉起。
  process.on('uncaughtException', err => {
    console.error('[uncaught]', (err && err.stack) || err);
    try {
      server.close(() => process.exit(1));
    } catch (e) { process.exit(1); }
    setTimeout(() => process.exit(1), 1500).unref();
    if (!server.listening) process.exit(1);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log('\n收到 ' + sig + '，正在关闭…');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    });
  }
}

function start() {
  server.listen(PORT, HOST, () => {
    console.log(`DS峰谷钟 API 已启动`);
    console.log(`  网页      http://127.0.0.1:${PORT}/`);
    console.log(`  峰谷状态  http://127.0.0.1:${PORT}/v1/fenggu`);
    console.log(`  纯文本    http://127.0.0.1:${PORT}/v1/fenggu.txt`);
    console.log(`  监听      ${HOST}:${PORT}`);
    syncClock('启动').then(() => syncHolidays('启动'));
  });
  return server;
}

// 作为命令行程序运行时才监听 + 装处理器 + 起定时同步；
// 被 require 时只导出函数（单测不会顺带装上信号处理器或开定时器）
if (require.main === module) {
  installProcessHandlers();
  start();
  setInterval(() => syncClock('定时'), 30 * 60 * 1000).unref();
  setInterval(() => syncHolidays('定时'), 6 * 60 * 60 * 1000).unref();
}

module.exports = {
  server, start, buildStatus, buildText, parseAt, calendarStats, CAL, calendarYears,
  syncClock, syncHolidays, nowMs, stats
};

