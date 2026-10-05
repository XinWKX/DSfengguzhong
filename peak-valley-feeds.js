/*!
 * peak-valley-feeds.js — 联网数据源（校时 + 法定节假日日历），浏览器 / Node 共用
 * Copyright (C) 2022 创想工作室 (Chuangxiang Studio)
 *
 * 本程序是自由软件：你可以依据 GNU 通用公共许可证（第 3 版或任何更新版本）
 * 的条款重新分发和/或修改它。本程序按“原样”提供，不带任何担保。
 * 完整条款见 LICENSE，或 <https://www.gnu.org/licenses/>。
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 抽出这个模块的直接原因：同一套「三源校时 + 节假日报表解析与校验」原本在网页和服务端各写一份，
 * 上一轮修日期格式校验时不得不改两处 —— 重复的代价已经出现过了。
 *
 * 浏览器：<script src="peak-valley-feeds.js"></script>  →  window.PeakValleyFeeds
 * Node：  const Feeds = require('./peak-valley-feeds.js')
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof root !== 'undefined' && root) root.PeakValleyFeeds = api;
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var VERSION = '1.1.0';
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var MAX_NAME = 40;
  var isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined';
  var globalFetch = (typeof fetch === 'function') ? fetch : null;

  // 校时源，按可靠性排序
  var TIME_SOURCES = [
    {
      label: 'worldtimeapi.org',
      url: 'https://worldtimeapi.org/api/timezone/Etc/UTC',
      pick: function (j) { return typeof j.unixtime === 'number' ? j.unixtime * 1000 : NaN; }
    },
    {
      label: 'timeapi.io',
      url: 'https://timeapi.io/api/Time/current/zone?timeZone=Etc/UTC',
      pick: function (j) {
        var s = String((j && j.dateTime) || '').replace(/Z$/i, '').replace(/\.\d+$/, '');
        return Date.parse(s + 'Z');
      }
    },
    {
      label: '淘宝授时',
      url: 'https://api.m.taobao.com/rest/api3.do?api=mtop.common.getTimestamp',
      pick: function (j) { return j && j.data && j.data.t ? Number(j.data.t) : NaN; }
    }
  ];

  var HOLIDAY_API = 'https://timor.tech/api/holiday/year/';

  function requestInit() {
    // 浏览器里不能自定义 User-Agent（禁用头），Node 里加上以示礼貌
    return isBrowser
      ? { cache: 'no-store', mode: 'cors' }
      : { cache: 'no-store', headers: { 'User-Agent': 'peak-valley-feeds/' + VERSION } };
  }

  // 统一带超时的 JSON 请求，避免任何一个源卡死整个流程。
  // 注意：不能只依赖 fetch 实现遵守 AbortSignal —— 这里用显式竞速兜底，
  // 即使底层忽略 signal，超时也一定会生效。
  function fetchJson(url, timeoutMs, fetchImpl) {
    var doFetch = fetchImpl || globalFetch;
    if (!doFetch) return Promise.reject(new Error('当前环境没有可用的 fetch'));
    var ms = timeoutMs || 5000;
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var init = requestInit();
    if (ctrl) init.signal = ctrl.signal;
    var sep = url.indexOf('?') >= 0 ? '&' : '?';

    var req = doFetch(url + sep + '_=' + Date.now(), init).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
    req.catch(function () { /* 竞速结束后原始 promise 的失败不应成为 unhandled rejection */ });

    var timer = null;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error('请求超时（' + ms + 'ms）'));
      }, ms);
    });
    return Promise.race([req, timeout]).finally(function () { clearTimeout(timer); });
  }

  // ---------------------------------------------------------------- 校时

  // 依次尝试各授时源，返回统一结果（调用方只负责记录/赋值，不重复实现逻辑）
  function syncClock(options) {
    options = options || {};
    var order = options.sources || TIME_SOURCES;
    var timeout = options.timeoutMs || 5000;
    var attempts = [];

    function tryAt(i) {
      if (i >= order.length) {
        return Promise.resolve({ synced: false, offsetMs: 0, source: null, rtt: null, attempts: attempts });
      }
      var src = order[i];
      var t0 = Date.now();
      return fetchJson(src.url, timeout, options.fetchImpl).then(function (json) {
        var t1 = Date.now();
        var server = src.pick(json);
        if (!isFinite(server) || server <= 0) throw new Error('返回内容无法解析');
        var rtt = t1 - t0;
        attempts.push({ label: src.label, ok: true, rtt: rtt });
        // 用往返时延的一半补偿，now = Date.now() + offsetMs
        return { synced: true, offsetMs: server + rtt / 2 - t1, source: src.label, rtt: rtt, attempts: attempts };
      }).catch(function (err) {
        attempts.push({ label: src.label, ok: false, message: String((err && err.message) || err) });
        return tryAt(i + 1);
      });
    }
    return tryAt(0);
  }

  // ---------------------------------------------------------------- 节假日

  // 外部数据一律校验后再入库：日期必须是该年份的 YYYY-MM-DD，异常键直接丢弃，
  // 避免第三方接口用 __proto__ / constructor 之类的键污染日历对象
  function parseHolidayPayload(json, year) {
    var cal = {};
    cal[year] = { holidays: {}, workdays: {} };
    var count = 0, skipped = 0;
    var list = (json && json.holiday) || {};
    for (var k in list) {
      if (!Object.prototype.hasOwnProperty.call(list, k)) continue;
      var v = list[k];
      var date = v && typeof v.date === 'string' ? v.date : '';
      if (date.slice(0, 4) !== String(year) || !DATE_RE.test(date)) { skipped++; continue; }
      var name = (v.name && typeof v.name === 'string' && v.name.trim()) ? v.name.trim().slice(0, MAX_NAME) : '';
      if (v.holiday) cal[year].holidays[date] = name || '节假日';
      else cal[year].workdays[date] = name || '调休上班';
      count++;
    }
    return { cal: cal, count: count, skipped: skipped };
  }

  // 危险键：赋值到 __proto__ 会走原型 setter 从而替换目标对象的原型（原型污染），
  // constructor / prototype 同理。第三方数据不可信，必须在合并前挡掉。
  var DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];
  function mergeInto(dst, srcMap) {
    var n = 0;
    if (!srcMap || typeof srcMap !== 'object') return 0;
    for (var k in srcMap) {
      if (!Object.prototype.hasOwnProperty.call(srcMap, k)) continue;
      if (DANGEROUS_KEYS.indexOf(k) !== -1) continue;
      dst[k] = srcMap[k];
      n++;
    }
    return n;
  }

  function mergeCalendar(target, src) {
    var n = 0;
    if (!src || typeof src !== 'object') return 0;
    for (var y in src) {
      if (!Object.prototype.hasOwnProperty.call(src, y)) continue;
      if (!/^\d{4}$/.test(y)) continue;              // 年份键也必须是 4 位数字
      if (DANGEROUS_KEYS.indexOf(y) !== -1) continue;
      if (!Object.prototype.hasOwnProperty.call(target, y)) target[y] = { holidays: {}, workdays: {} };
      n += mergeInto(target[y].holidays, src[y].holidays);
      n += mergeInto(target[y].workdays, src[y].workdays);
    }
    return n;
  }

  function calendarYears(cal) {
    var out = [];
    for (var y in cal) {
      if (Object.prototype.hasOwnProperty.call(cal, y) && cal[y] && cal[y].holidays && Object.keys(cal[y].holidays).length) out.push(y);
    }
    return out.sort();
  }

  // 返回 { ok: [{year,count,skipped}], empty: [year], failed: [{year,message}], cal }
  // ok 只包含真的拿到数据的年份；请求成功但接口暂无该年数据（如尚未公布）计入 empty
  function syncHolidays(options) {
    options = options || {};
    if (!options.years) return Promise.reject(new Error('syncHolidays 需要 years'));
    var timeout = options.timeoutMs || 6000;
    var results = options.years.map(function (year) {
      return fetchJson(HOLIDAY_API + year + '/', timeout, options.fetchImpl).then(function (json) {
        var parsed = parseHolidayPayload(json, year);
        return { year: year, ok: true, count: parsed.count, skipped: parsed.skipped, cal: parsed.cal };
      }).catch(function (err) {
        return { year: year, ok: false, message: String((err && err.message) || err) };
      });
    });
    return Promise.all(results).then(function (list) {
      var ok = [], empty = [], failed = [], cal = {};
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (!r.ok) failed.push({ year: r.year, message: r.message });
        else if (r.count > 0) { ok.push({ year: r.year, count: r.count, skipped: r.skipped }); mergeCalendar(cal, r.cal); }
        else empty.push(r.year);
      }
      return { ok: ok, empty: empty, failed: failed, cal: cal };
    });
  }

  // 以北京时间取「当前年 ±1」
  function yearsAround(nowMs, cstOffsetMin) {
    var d = new Date(nowMs + (cstOffsetMin || 480) * 60000);
    var y = d.getUTCFullYear();
    return [y - 1, y, y + 1];
  }

  return {
    VERSION: VERSION,
    syncClock: syncClock,
    parseHolidayPayload: parseHolidayPayload,
    mergeCalendar: mergeCalendar,
    calendarYears: calendarYears,
    syncHolidays: syncHolidays,
    yearsAround: yearsAround
  };
}));
