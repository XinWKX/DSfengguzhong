// 用最小 DOM 桩把网页 UI 脚本真正执行起来，验证渲染结果（浏览器跑不了，但脚本可以跑）
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const PeakValley = require('../peak-valley-core.js');
const PeakValleyFeeds = require('../peak-valley-feeds.js');

// 仓库根目录由脚本位置推导，保证从任意 CWD 调用都能跑
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 默认测交付用的网页；PV_HTML 可指向别的文件（用于变异测试/独立版校验，
// 显式给出时按调用者的 CWD 解释）
const HTML_FILE = process.env.PV_HTML || join(ROOT, 'deepseek-peak-valley.html');
const HTML = readFileSync(HTML_FILE, 'utf8');

// ---------------------------------------------------------------- 最小 DOM
function makeClassList(el, counters) {
  const set = () => new Set(String(el._class || '').split(/\s+/).filter(Boolean));
  const bump = () => { if (counters) counters.classWrites++; };
  return {
    add: (...c) => { const s = set(); c.forEach(x => s.add(x)); el._class = [...s].join(' '); bump(); },
    remove: (...c) => { const s = set(); c.forEach(x => s.delete(x)); el._class = [...s].join(' '); bump(); },
    contains: c => set().has(c),
    toggle: (c, force) => {
      const s = set();
      const on = force === undefined ? !s.has(c) : !!force;
      on ? s.add(c) : s.delete(c);
      el._class = [...s].join(' ');
      bump();
      return on;
    }
  };
}

class El {
  constructor(id = '', tag = 'div', counters = null) {
    this.id = id; this.tagName = tag.toUpperCase();
    this._children = []; this._html = ''; this._text = '';
    this._class = ''; this._attrs = {}; this._on = {};
    this.scrollTop = 0; this.scrollHeight = 0;
    this._c = counters;
    // style 用 Proxy 包一层，才能统计写入次数（性能优化的关键指标）
    this.style = counters
      ? new Proxy({}, { set(o, k, v) { counters.styleWrites++; o[k] = v; return true; } })
      : {};
    this.classList = makeClassList(this, counters);
  }
  get offsetWidth() { return 120; }
  get children() { return this._children; }
  get firstChild() { return this._children[0]; }
  get className() { return this._class; }
  set className(v) { if (this._c) this._c.classWrites++; this._class = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { if (this._c) this._c.htmlWrites++; this._html = String(v); }
  get textContent() { return this._text || this._html.replace(/<[^>]*>/g, ''); }
  set textContent(v) { if (this._c) this._c.textWrites++; this._text = String(v); this._html = ''; }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  appendChild(c) { this._children.push(c); return c; }
  removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) this._children.splice(i, 1); return c; }
  addEventListener(t, fn) { (this._on[t] = this._on[t] || []).push(fn); }
  removeEventListener() {}
  querySelector(sel) {
    if (this._c) this._c.queries++;
    if (sel === '.nowline') return this._children.find(c => c._class.includes('nowline')) || null;
    return this._children.find(c => c._class.split(' ').includes(sel.replace(/^\./, ''))) || null;
  }
  querySelectorAll() { return []; }
  getContext() {
    const c = this._c;
    const hit = n => { if (c) c.canvasOps[n] = (c.canvasOps[n] || 0) + 1; };
    // 不只数调用次数，还模拟路径语义：arc 的起点若与当前点不重合，
    // 浏览器会补一条直线（把星点连成巨大多边形）—— 这正是曾经踩过的坑。
    let cur = null;
    return {
      setTransform: () => hit('setTransform'), clearRect: () => hit('clearRect'), save: () => hit('save'), restore: () => hit('restore'),
      beginPath: () => { hit('beginPath'); cur = null; },
      moveTo: (x, y) => { hit('moveTo'); cur = { x, y }; },
      arc: (x, y, r) => {
        hit('arc');
        const start = { x: x + r, y };
        if (cur && (Math.abs(cur.x - start.x) > 0.01 || Math.abs(cur.y - start.y) > 0.01)) hit('lineJumps');
        cur = start;
      },
      lineTo: (x, y) => { hit('lineTo'); cur = { x, y }; },
      stroke: () => hit('stroke'),
      get strokeStyle() { return ''; },
      set strokeStyle(v) { hit('strokeStyle'); },
      get lineWidth() { return 0; },
      set lineWidth(v) { hit('lineWidth'); },
      fill: () => hit('fill'),
      fillRect: () => hit('fillRect'),
      get fillStyle() { return ''; },
      set fillStyle(v) { hit('fillStyle'); }
    };
  }
}

function newCounters() {
  return { textWrites: 0, htmlWrites: 0, styleWrites: 0, classWrites: 0, queries: 0, canvasOps: {} };
}

// 桌面通知桩：可模拟 granted / denied / 永不返回 / promise reject / 同步抛错
function makeNotification(conf = {}) {
  function N(title, o) { N.created.push({ title: title, body: o && o.body }); }
  N.permission = conf.permission || 'default';
  N.created = [];
  N.requestPermission = function (cb) {
    const mode = conf.request || 'granted';
    if (mode === 'throw') throw new Error('The Notification API may no longer be used from insecure origins');
    if (mode === 'reject') return Promise.reject(new Error('The Notification API may no longer be used from insecure origins'));
    if (mode === 'never') return new Promise(function () {});
    N.permission = mode;
    if (typeof cb === 'function') cb(mode);
    return Promise.resolve(mode);
  };
  return N;
}

function makeDom(search, opts = {}) {
  const counters = opts.counters || null;
  const clock = opts.clock || null;
  const ids = [...new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]))];
  // 把 HTML 里写好的 class 也搬进桩里，否则 classList.contains() 查不到真实类名
  const classById = new Map();
  for (const m of HTML.matchAll(/<[a-z]+[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const cls = /\bclass="([^"]*)"/.exec(m[0]);
    if (cls) classById.set(m[1], cls[1]);
  }
  const byId = new Map(ids.map(id => {
    const el = new El(id, 'div', counters);
    if (classById.has(id)) el._class = classById.get(id);
    return [id, el];
  }));
  const get = id => byId.get(id) || null;
  const theme = (/[?&]theme=(dark|light)\b/.exec(search) || [])[1] || 'dark';

  const body = new El('', 'body', counters); body._class = 'valley';
  const documentElement = new El('', 'html', counters);
  documentElement.setAttribute('data-theme', theme);

  const navEl = get('navLinks');
  const navHrefs = [...(HTML.match(/<nav class="nav-links"[\s\S]*?<\/nav>/) || [''])[0].matchAll(/href="#([^"]+)"/g)].map(m => m[1]);
  const navLinks = navHrefs.map(h => { const a = new El('', 'a', counters); a.setAttribute('href', '#' + h); return a; });
  if (navEl) navEl.querySelectorAll = () => navLinks;

  const trackCache = new Map();
  const document = {
    body, documentElement, title: '', hidden: false, visibilityState: 'visible',
    getElementById: get,
    createElement: tag => new El('', tag, counters),
    addEventListener() {},
    querySelector(sel) {
      if (counters) counters.queries++;
      const m = /\.cal-track\[data-day="([^"]+)"\]/.exec(sel);
      if (m) {
        const rows = get('calRows');
        if (!rows || !rows.innerHTML.includes('data-day="' + m[1] + '"')) return null;
        if (!trackCache.has(m[1])) { const t = new El('', 'div', counters); t._class = 'cal-track'; rows.appendChild(t); trackCache.set(m[1], t); }
        return trackCache.get(m[1]);
      }
      return null;
    },
    querySelectorAll: sel => (sel === '#navLinks a' ? navLinks : [])
  };

  // 可控时钟：让 render 循环可以在测试里被逐秒推进
  let DateImpl = Date;
  if (clock) {
    DateImpl = class extends Date {
      constructor(...a) { a.length === 0 ? super(clock.ms) : super(...a); }
      static now() { return clock.ms; }
    };
  }

  const store = opts.store || {};
  const notif = opts.notification === undefined ? undefined : makeNotification(opts.notification);
  // 页面用的是 window.Notification / window.isSecureContext，桩必须挂在 window 上；
  // 且「浏览器不支持」要表现为**键不存在**，否则 'Notification' in window 会误判为 true
  const win = {
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1, scrollY: 0,
    addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    PeakValley, PeakValleyFeeds,
    isSecureContext: opts.secure !== false
  };
  if (notif) win.Notification = notif;
  const ctx = {
    document,
    window: win,
    location: { search, href: 'http://localhost/' },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    getComputedStyle: () => ({ getPropertyValue: n => ({ '--particle-rgb': '232,235,242', '--glow': '100,255,218', '--particle-alpha': '1', '--particle-alpha ': '1' }[n] || '') }),
    IntersectionObserver: class { constructor() {} observe() {} },
    Notification: notif,
    fetch: opts.fetchImpl || (() => Promise.reject(new Error('测试环境不联网'))),
    Date: DateImpl,
    PeakValley,
    PeakValleyFeeds,
    URLSearchParams, URL, AbortController,
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: (fn, ms) => { intervals.push({ fn: fn, ms: ms }); return intervals.length; },
    clearInterval: () => {},
    console
  };
  let rafQueue = [];
  const intervals = [];
  ctx.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
  ctx.cancelAnimationFrame = () => {};
  // 驱动定时器：桩记录了 setInterval 的回调，便于验证「定时校时」的重试频率
  ctx.__fireInterval = (ms, times) => {
    const hit = intervals.filter(i => i.ms === ms);
    for (let n = 0; n < (times || 1); n++) hit.forEach(i => i.fn());
    return hit.length;
  };
  // 驱动按钮：桩记录了 addEventListener 的回调，这里手动触发
  ctx.__click = id => {
    const el = get(id);
    if (!el) throw new Error('没有 id=' + id + ' 的元素');
    (el._on.click || []).forEach(fn => fn());
  };
  ctx.__pump = n => {
    for (let i = 0; i < n; i++) {
      if (clock) clock.ms += 1000;        // 每次泵一帧 = 推进一秒
      const q = rafQueue; rafQueue = [];
      q.forEach(cb => cb(performance.now()));
    }
  };
  return { ctx, get, body, document, documentElement, counters, store };
}

// ---------------------------------------------------------------- 断言
let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = String(got) === String(want);
  ok ? (pass++, console.log(`  [OK] ${label}`)) : (fail++, console.log(`  [X] ${label}\n       got  = ${got}\n       want = ${want}`));
};
const ok_ = (label, cond, extra) => {
  cond ? (pass++, console.log(`  [OK] ${label}`)) : (fail++, console.log(`  [X] ${label}${extra ? '  ' + extra : ''}`));
};

function runUi(search, opts) {
  const dom = makeDom(search, opts);
  const env = vm.createContext(dom.ctx);
  const ui = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).pop();
  vm.runInContext(ui, env, { filename: 'ui.js' });
  dom.ctx.__pump(3);
  return dom;
}

// ---------------------------------------------------------------- 场景 1：国庆期间（谷）
console.log('\n[1] 场景：2026-10-03 20:34 国庆假期 → 谷');
{
  const d = runUi('?t=2026-10-03T20:34:00%2B08:00&theme=dark');
  const g = d.get;
  ok_('body 带 valley 类', d.body.classList.contains('valley') && !d.body.classList.contains('peak'));
  eq('状态名', g('stateName').textContent, '梁文谷');
  eq('状态标签', g('stateKind').textContent, '谷 · 空闲时段 · 半价');
  eq('倒计时拆成 天/单位/时间 三个节点', [g('cdDays').textContent, g('cdUnit').textContent, g('cdTime').textContent].join('|'), '4|天|12:26:00');
  eq('「天」单位用 .u 切中文字体', g('cdUnit').classList.contains('u'), 'true');
  eq('本段开始', g('factStart').textContent, '2026-09-30 18:00:00');
  eq('本段结束', g('factEnd').textContent, '2026-10-08 09:00:00');
  eq('本段时长', g('factLen').innerHTML, '7 <span class="u">天</span> 15 <span class="u">小时</span>');
  eq('北京时间时钟', g('clockCst').textContent, '2026-10-03 20:34:00');
  eq('UTC 时钟', g('clockUtc').textContent, '12:34:00');
  ok_('标题含状态与倒计时', /^梁文谷 · 距梁文峰 4 天 12:26:00/.test(d.document.title), d.document.title);
  const w = parseFloat(g('progressBar').style.width);
  const expect = PeakValley.statusAt(Date.parse('2026-10-03T20:34:00+08:00'), PeakValley.CALENDAR).progress * 100;
  ok_(`进度宽度合法且与核心一致（${w}%）`, Math.abs(w - Number(expect.toFixed(2))) < 0.01, `expect ${expect.toFixed(2)}`);
  const rows = g('calRows').innerHTML;
  eq('日历 14 行', (rows.match(/class="cal-row/g) || []).length, 14);
  eq('今天只有一行高亮', (rows.match(/cal-row today/g) || []).length, 1);
  eq('高峰段数量 = 7 个工作日 × 2', (rows.match(/class="seg"/g) || []).length, 14);
  eq('刻度 0/3/…/24 共 9 个', (g('calTicks').innerHTML.match(/<i /g) || []).length, 9);
  ok_('日历标注国庆节', rows.includes('国庆节'));
  ok_('日历标注补班日', rows.includes('国庆节后补班'));
  ok_('统计行含高峰总时长', /未来 14 天高峰共/.test(g('calStat').textContent), g('calStat').textContent);
  ok_('今日有 nowline 游标', !!d.ctx.document.querySelector('.cal-track[data-day="2026-10-03"]').querySelector('.nowline'));
  ok_('日志有内容', g('syncLog').children.length >= 1);
  ok_('演示模式已提示', g('syncLog').children.some(c => c.innerHTML.includes('演示模式')));
  eq('同步状态显示演示模式', g('syncChip').textContent, '演示模式');
  ok_('节假日信息已渲染', /2026 · 33 天假 \/ 6 天补班/.test(g('calInfo').textContent), g('calInfo').textContent);
  eq('主题为 dark', d.documentElement.getAttribute('data-theme'), 'dark');
}

// ---------------------------------------------------------------- 场景 2：工作日高峰（峰）
console.log('\n[2] 场景：2026-10-09 10:00 工作日高峰 → 峰');
{
  const d = runUi('?t=2026-10-09T10:00:00%2B08:00');
  const g = d.get;
  ok_('body 带 peak 类', d.body.classList.contains('peak'));
  eq('状态名', g('stateName').textContent, '梁文峰');
  eq('状态标签', g('stateKind').textContent, '峰 · 高峰时段 · 全价');
  eq('倒计时（不足一天时天数为空）', [g('cdDays').textContent, g('cdTime').textContent].join('|'), '|02:00:00');
  eq('本段结束', g('factEnd').textContent, '2026-10-09 12:00:00');
  ok_('说明含高峰原因', /工作日高峰时段/.test(g('stateDesc').innerHTML));
  eq('日历今天行高亮在 10-09', (g('calRows').innerHTML.match(/cal-row today/g) || []).length, 1);
}

// ---------------------------------------------------------------- 场景 3：补班周六
console.log('\n[3] 场景：2026-10-10（周六·补班）→ 仍为谷');
{
  const d = runUi('?t=2026-10-10T10:00:00%2B08:00');
  const g = d.get;
  eq('状态名', g('stateName').textContent, '梁文谷');
  ok_('周日历标注补班', g('calRows').innerHTML.includes('国庆节后补班'));
}

// ---------------------------------------------------------------- 场景 4：白天主题 + 预览参数
console.log('\n[4] 场景：theme=light 与 preview 参数');
{
  const d = runUi('?t=2026-10-13T10:00:00%2B08:00&theme=light');
  eq('主题为 light', d.documentElement.getAttribute('data-theme'), 'light');
  eq('工作日 10:00 判峰', d.get('stateName').textContent, '梁文峰');
  const pv = runUi('?preview=valley&theme=dark');
  eq('preview=valley 生效', pv.get('stateName').textContent, '梁文谷');
  const pp = runUi('?preview=peak&theme=dark');
  eq('preview=peak 生效', pp.get('stateName').textContent, '梁文峰');
}

// ---------------------------------------------------------------- 场景 5：UI 与核心必须完全一致
console.log('\n[5] 网页渲染与核心模块逐时刻对齐');
{
  let mismatch = 0;
  for (const iso of ['2026-10-03T20:34:00+08:00', '2026-10-09T10:00:00+08:00', '2026-10-10T10:00:00+08:00', '2026-01-01T12:00:00+08:00', '2026-10-13T12:30:00+08:00', '2026-10-13T17:59:00+08:00']) {
    const t = Date.parse(iso);
    const core = PeakValley.statusAt(t, PeakValley.CALENDAR);
    const d = runUi('?t=' + encodeURIComponent(iso));
    if (d.get('stateName').textContent !== core.name) mismatch++;
    if (d.get('cdTime').textContent !== PeakValley.fmtCountdownHuman(core.remaining).split(' ').pop()) mismatch++;
    if (d.body.classList.contains('valley') !== core.isValley) mismatch++;
  }
  eq('6 个时刻网页与核心一致', mismatch, 0);
}

console.log('\n[6] 同步成功路径（此前只用冻结时钟测过，成功路径从未覆盖）');
{
  const calls = [];
  const fetchImpl = url => {
    calls.push(url);
    if (url.includes('worldtimeapi')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ unixtime: Math.floor(Date.parse('2026-10-03T12:34:56Z') / 1000) }) });
    if (url.includes('timor')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ holiday: { x: { date: '2026-10-14', holiday: true, name: '测试假日' } } }) });
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  };
  const d = runUi('?theme=dark', { fetchImpl, clock: { ms: Date.parse('2026-10-03T20:34:00+08:00') } });
  await new Promise(r => setTimeout(r, 80));
  d.ctx.__pump(1);                       // 同步完成后需要再渲染一帧才会重建日历
  const g = d.get;
  ok_('请求了授时与日历接口', calls.some(u => u.includes('worldtimeapi')) && calls.some(u => u.includes('timor')), calls.length + ' 次请求');
  eq('校时成功状态', g('syncChip').textContent, '已同步');
  ok_('显示本机偏差', /s$/.test(g('driftChip').textContent), g('driftChip').textContent);
  ok_('日志记录了校时成功', g('syncLog').children.some(c => c.innerHTML.includes('校时')));
  ok_('日志记录了日历同步', g('syncLog').children.some(c => c.innerHTML.includes('节假日日历已同步')));
  ok_('同步来的节假日已进入日历（10-14 在 14 天窗口内）', g('calRows').innerHTML.includes('测试假日'));
  ok_('降级即停：第一个源成功就不请求后面的源', calls.some(u => u.includes('worldtimeapi')) && !calls.some(u => u.includes('timeapi.io')), calls.length + ' 次请求');
}

console.log('\n[7] 渲染性能（逐秒推进 600 次，统计 JS 侧开销与 DOM 写入）');
{
  const clock = { ms: Date.parse('2026-10-03T20:34:00+08:00') };
  const counters = newCounters();
  const d = runUi('?theme=dark', { clock, counters });
  const tick = () => d.ctx.__pump(1);

  for (let i = 0; i < 30; i++) tick();                      // 预热
  const c0 = JSON.parse(JSON.stringify(counters));
  const frames = 600;
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) tick();
  const dt = performance.now() - t0;

  const delta = {};
  for (const k of ['textWrites', 'htmlWrites', 'styleWrites', 'classWrites', 'queries']) delta[k] = counters[k] - c0[k];
  const canvas = {};
  for (const k of Object.keys(counters.canvasOps)) canvas[k] = counters.canvasOps[k] - (c0.canvasOps[k] || 0);

  const per = k => (delta[k] / frames).toFixed(2);
  console.log(`  每帧 JS 耗时 ${(dt / frames).toFixed(3)}ms（含粒子绘制，本机同进程测量）`);
  console.log(`  每帧 DOM 写入: textContent ${per('textWrites')} · innerHTML ${per('htmlWrites')} · style ${per('styleWrites')} · class ${per('classWrites')} · querySelector ${per('queries')}`);
  console.log(`  每帧 canvas: fill ${(canvas.fill / frames).toFixed(1)} · arc ${(canvas.arc / frames).toFixed(1)} · fillStyle ${(canvas.fillStyle / frames).toFixed(1)} · clearRect ${(canvas.clearRect / frames).toFixed(1)}`);
  console.log(`  路径连线跳变（>0 说明星点被直线连成多边形）: ${canvas.lineJumps || 0}`);

  // 阈值按实测收紧（优化前是 innerHTML 6 / class 2 / 查询 2 / fill 96，回归会立刻失败）
  ok_('每帧 innerHTML ≤ 0.2（静态文案不再重建）', delta.htmlWrites / frames <= 0.2, per('htmlWrites'));
  ok_('每帧 textContent ≤ 8（仅时钟与倒计时）', delta.textWrites / frames <= 8, per('textWrites'));
  ok_('每帧 class 写入 ≤ 0.05（仅状态切换时）', delta.classWrites / frames <= 0.05, per('classWrites'));
  ok_('每帧 querySelector ≤ 0.05（引用已缓存）', delta.queries / frames <= 0.05, per('queries'));
  ok_('每帧 canvas fill ≤ 24（粒子已合批）', (canvas.fill || 0) / frames <= 24, ((canvas.fill || 0) / frames).toFixed(1));
  ok_('canvas 路径无连线跳变（星点不会被连成多边形）', (canvas.lineJumps || 0) === 0, (canvas.lineJumps || 0) + ' 次');
  ok_('每个 arc 前都有 moveTo', (canvas.moveTo || 0) >= (canvas.arc || 0), `moveTo ${((canvas.moveTo || 0) / frames).toFixed(1)} vs arc ${((canvas.arc || 0) / frames).toFixed(1)}`);
  ok_('每帧 JS 耗时 < 4ms', dt / frames < 4, (dt / frames).toFixed(3) + 'ms');
  ok_('渲染内容仍正确（国庆期间为谷）', d.get('stateName').textContent === '梁文谷');
  const cdEl = d.get('cdTime') || d.get('countdown');
  ok_('倒计时仍在走', /^[\d:]+$/.test(cdEl.textContent), cdEl.textContent);
}

console.log('\n[8] 切换提醒：任何结局都必须有反馈（服务器上静默失败的回归测试）');
{
  const clickAndWait = async (d, ms) => { d.ctx.__click('btnNotify'); await new Promise(r => setTimeout(r, ms || 30)); };
  const logsOf = d => d.get('syncLog').children.map(c => c.innerHTML).join('\n');

  // (1) HTTP 非安全上下文：Chromium 会直接拒绝，必须给出 HTTPS 提示而不是静默
  {
    const d = runUi('?theme=dark', { fetchImpl: () => Promise.reject(new Error('offline')), secure: false, notification: { request: 'reject' }, clock: { ms: Date.parse('2026-10-03T20:34:00+08:00') } });
    await clickAndWait(d);
    ok_('非安全上下文：按钮有反馈', /不可用/.test(d.get('btnNotify').textContent), d.get('btnNotify').textContent);
    ok_('非安全上下文：日志提示需要 HTTPS', /HTTPS/.test(logsOf(d)));
    ok_('非安全上下文：未误报为已开启', d.get('btnNotify').getAttribute('aria-pressed'), 'false');
  }
  // (2) requestPermission 抛错（同步）
  {
    const d = runUi('?theme=dark', { secure: true, notification: { request: 'throw' }, clock: { ms: Date.now() } });
    await clickAndWait(d);
    ok_('同步抛错也有反馈', /不可用/.test(d.get('btnNotify').textContent), d.get('btnNotify').textContent);
    ok_('同步抛错写进日志', /开启提醒失败/.test(logsOf(d)));
  }
  // (3) 浏览器不支持
  {
    const d = runUi('?theme=dark', { clock: { ms: Date.now() } });   // notification 未提供 → undefined
    await clickAndWait(d);
    ok_('不支持时给出提示', /不支持桌面通知/.test(logsOf(d)));
    ok_('不支持时按钮有反馈', /不可用/.test(d.get('btnNotify').textContent));
  }
  // (4) denied
  {
    const d = runUi('?theme=dark', { secure: true, notification: { request: 'denied' }, clock: { ms: Date.now() } });
    await clickAndWait(d);
    ok_('denied 有反馈', /提醒被拒绝/.test(d.get('btnNotify').textContent), d.get('btnNotify').textContent);
    ok_('denied 指引去站点设置', /站点设置/.test(logsOf(d)));
  }
  // (5) granted：按钮变开、写偏好、发一条测试通知
  {
    const notif = { request: 'granted' };
    const d = runUi('?theme=dark', { secure: true, notification: notif, clock: { ms: Date.now() } });
    await clickAndWait(d);
    eq('granted：按钮变「开」', d.get('btnNotify').textContent, '切换提醒：开');
    eq('granted：aria-pressed', d.get('btnNotify').getAttribute('aria-pressed'), 'true');
    ok_('granted：写入了偏好', d.store['pv-notify'] === '1', JSON.stringify(d.store));
  }
  // (6) 刷新后恢复：偏好仍在且浏览器已授权 → 启动即为「开」
  {
    const store = { 'pv-notify': '1' };
    const d = runUi('?theme=dark', { secure: true, store, notification: { permission: 'granted' }, clock: { ms: Date.now() } });
    eq('刷新后保持「开」', d.get('btnNotify').textContent, '切换提醒：开');
    const d2 = runUi('?theme=dark', { secure: true, store: {}, notification: { permission: 'granted' }, clock: { ms: Date.now() } });
    eq('没开过则默认「关」', d2.get('btnNotify').textContent, '切换提醒：关');
    const d3 = runUi('?theme=dark', { secure: true, store: { 'pv-notify': '1' }, notification: { permission: 'denied' }, clock: { ms: Date.now() } });
    eq('偏好为开但权限已被收回 → 回到「关」', d3.get('btnNotify').textContent, '切换提醒：关');
  }
  // (7) 先开后关
  {
    const d = runUi('?theme=dark', { secure: true, notification: { request: 'granted' }, clock: { ms: Date.now() } });
    await clickAndWait(d);
    eq('第一次点击 → 开', d.get('btnNotify').textContent, '切换提醒：开');
    await clickAndWait(d);
    eq('第二次点击 → 关', d.get('btnNotify').textContent, '切换提醒：关');
    eq('关闭后偏好写 0', d.store['pv-notify'], '0');
    ok_('关闭有日志', /已关闭切换提醒/.test(logsOf(d)));
  }
}

console.log('\n[9] 安全与重试（第三方数据注入 / 校时失败后的重试频率）');
{
  // (1) 第三方假日名含 HTML 时必须转义后再进 innerHTML（否则可执行脚本）
  const EVIL = '<img src=x onerror=alert(1)>';
  const CAL = PeakValley.CALENDAR;
  const Y = 2026;
  CAL[Y] = CAL[Y] || { holidays: {}, workdays: {} };
  const hadKey = Object.prototype.hasOwnProperty.call(CAL[Y].holidays, '2026-10-05');
  const oldVal = CAL[Y].holidays['2026-10-05'];
  CAL[Y].holidays['2026-10-05'] = EVIL;
  PeakValley.bumpCalendar();
  try {
    const d = runUi('?theme=dark', { clock: { ms: Date.parse('2026-10-03T20:34:00+08:00') } });
    const rows = d.get('calRows').innerHTML;
    ok_('日历行渲染出该假日', /class="hol"/.test(rows));
    ok_('恶意 HTML 已被转义', rows.includes('&lt;img'), (rows.match(/<em class="hol">[^<]{0,30}/) || [''])[0]);
    ok_('页面里没有可执行的 img 标签', !/<img\s+src=x/i.test(rows));
  } finally {
    if (hadKey) CAL[Y].holidays['2026-10-05'] = oldVal;
    else delete CAL[Y].holidays['2026-10-05'];
    PeakValley.bumpCalendar();
  }

  // (2) 校时全部失败后，60 秒定时器不能每分钟重发（失败也必须记录尝试时间）
  let fetchCalls = 0;
  const failing = () => { fetchCalls++; return Promise.reject(new Error('offline')); };
  const d2 = runUi('?theme=dark', {
    fetchImpl: failing,
    clock: { ms: Date.parse('2026-10-03T20:34:00+08:00') }
  });
  await new Promise(r => setTimeout(r, 80));
  const afterStartup = fetchCalls;
  ok_('启动时确实尝试了授时源', afterStartup >= 1, 'calls=' + afterStartup);
  const fired = d2.ctx.__fireInterval(60000, 3);      // 连按 3 次「定时校时」
  await new Promise(r => setTimeout(r, 40));
  ok_('存在 60 秒定时器', fired >= 1, 'fired=' + fired);
  eq('校时失败后 60 秒定时器不重复请求', fetchCalls, afterStartup);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
