const fs = require('fs');
const vm = require('vm');
const path = require('path');

// 仓库根目录由脚本位置推导，保证从任意 CWD 调用都能跑
const ROOT = path.join(__dirname, '..');
const R = f => (path.isAbsolute(f) ? f : path.join(ROOT, f));
const h = fs.readFileSync(R('deepseek-peak-valley.html'), 'utf8');

let bad = 0;

// 1) id 交叉校验
const ids = new Set([...h.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const refs = new Set([...h.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]));
const missing = [...refs].filter(r => !ids.has(r));
console.log('HTML id 定义        :', ids.size);
console.log('JS 引用 id          :', refs.size);
console.log('缺失引用            :', missing.length ? (bad++, missing) : '无 [OK]');

// 1b) 导航锚点 / 滚动观察的 id 必须真实存在且彼此一致（删区块时最容易漏）
const navAnchors = [...h.matchAll(/<a href="#([^"]+)"[^>]*>/g)].map(m => m[1]).filter(a => !a.startsWith('http'));
const missingAnchor = navAnchors.filter(a => !ids.has(a));
console.log('导航锚点有效性      :', missingAnchor.length ? (bad++, '[X] 指向不存在的 id: ' + missingAnchor.join(', ')) : `[OK] ${navAnchors.length} 个锚点均存在`);
const ioList = (h.match(/\[[^\]]*'top'[^\]]*\]/) || [''])[0];
const ioIds = [...ioList.matchAll(/'([a-z0-9-]+)'/g)].map(m => m[1]);
const missingIo = ioIds.filter(a => !ids.has(a));
console.log('滚动观察 id 有效性  :', missingIo.length ? (bad++, '[X] 观察了不存在的 id: ' + missingIo.join(', ')) : `[OK] ${ioIds.length} 个 id 均存在`);
const anchorDiff = navAnchors.filter(a => !ioIds.includes(a)).concat(ioIds.filter(a => !navAnchors.includes(a)));
console.log('导航与观察列表一致  :', anchorDiff.length ? (bad++, '[X] 不一致: ' + anchorDiff.join(', ')) : '[OK] 完全一致');


// 2) 标签配对
for (const [tag, open, close] of [
  ['script', (h.match(/<script/g) || []).length, (h.match(/<\/script>/g) || []).length],
  ['div', (h.match(/<div/g) || []).length, (h.match(/<\/div>/g) || []).length],
  ['section', (h.match(/<section/g) || []).length, (h.match(/<\/section>/g) || []).length],
]) {
  const ok = open === close;
  if (!ok) bad++;
  console.log(`<${tag}> 配对`.padEnd(20) + ':', open, '/', close, ok ? '[OK]' : '[X]');
}

// 3) 内联脚本语法编译（真实解析）
const scripts = [...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
scripts.forEach((code, i) => {
  try {
    new vm.Script(code, { filename: `inline-${i}.js` });
    console.log(`脚本 #${i} 语法`.padEnd(20) + ':', `${code.split('\n').length} 行`, '[OK] 编译通过');
  } catch (e) {
    bad++;
    console.log(`脚本 #${i} 语法`.padEnd(20) + ':', '[X]', e.message);
  }
});

// 4) 核心逻辑必须来自外部共享模块（网页与服务端同一份）
const coreFile = 'peak-valley-core.js';
const feedsFile = 'peak-valley-feeds.js';
const coreExists = fs.existsSync(R(coreFile));
const feedsExists = fs.existsSync(R(feedsFile));
const coreLinked = new RegExp(`<script src="${coreFile.replace('.', '\\.')}"></script>`).test(h);
const feedsLinked = new RegExp(`<script src="${feedsFile.replace('.', '\\.')}"></script>`).test(h);
const inlineCoreLeft = /=== CORE-(BEGIN|END) ===/.test(h);
console.log('外链核心模块        :', coreLinked && coreExists ? '[OK] peak-valley-core.js' : (bad++, `[X] linked=${coreLinked} exists=${coreExists}`));
console.log('外链数据源模块      :', feedsLinked && feedsExists ? '[OK] peak-valley-feeds.js' : (bad++, `[X] linked=${feedsLinked} exists=${feedsExists}`));
console.log('内联核心残留        :', inlineCoreLeft ? (bad++, '[X] HTML 里仍有 CORE 块') : '无 [OK]');
console.log('外链顺序            :', h.indexOf('peak-valley-core.js') < h.indexOf('peak-valley-feeds.js') ? '[OK] core 在前' : (bad++, '[X] 顺序错误'));
if (coreExists) {
  delete require.cache[require.resolve('../' + coreFile)];
  const PV = require('../' + coreFile);
  const need = ['getSegment', 'isValleyAt', 'statusAt', 'dayInfo', 'peakWindowsOfDay', 'countPeakMs', 'isoInOffset', 'isoUtc', 'pad2', 'calendarCovers', 'bumpCalendar', 'CALENDAR'];
  const missingApi = need.filter(k => PV[k] === undefined);
  console.log('核心模块导出        :', missingApi.length ? (bad++, '[X] 缺少 ' + missingApi.join(',')) : `[OK] ${need.length} 项齐全 · v${PV.VERSION}`);
  const years = Object.keys(PV.CALENDAR);
  console.log('核心内置日历年份    :', years.join('、'), years.length ? '[OK]' : (bad++, '[X] 空'));
}
if (feedsExists) {
  delete require.cache[require.resolve('../' + feedsFile)];
  const F = require('../' + feedsFile);
  const need = ['syncClock', 'syncHolidays', 'parseHolidayPayload', 'mergeCalendar', 'calendarYears', 'yearsAround'];
  const missingApi = need.filter(k => F[k] === undefined);
  console.log('数据源模块导出      :', missingApi.length ? (bad++, '[X] 缺少 ' + missingApi.join(',')) : `[OK] ${need.length} 项齐全 · v${F.VERSION}`);
}
// UI 脚本用到的核心符号必须有别名，否则浏览器里会 undefined
for (const alias of ['var pad2 = PeakValley.pad2;', 'var PV_CALENDAR = PeakValley.CALENDAR;', 'window.PeakValleyFeeds']) {
  if (!h.includes(alias)) { bad++; console.log('缺少核心别名        :', alias); }
}
console.log('核心符号别名        :', 'pad2 / PV_CALENDAR / Feeds [OK]');

// 5) 主题相关变量在两种主题下都有定义
for (const v of ['--bg', '--ink', '--muted', '--line', '--panel', '--particle-rgb', '--particle-alpha', '--btn-bg']) {
  const dark = new RegExp(`html\\[data-theme="dark"\\][\\s\\S]*?${v}:`).test(h);
  const light = new RegExp(`html\\[data-theme="light"\\][\\s\\S]*?${v}:`).test(h);
  if (!dark || !light) { bad++; console.log(`变量 ${v}`.padEnd(20) + ':', `dark=${dark} light=${light} [X]`); }
}
console.log('主题变量覆盖        :', bad ? '见上' : '[OK] 齐全');
for (const combo of ['dark"] body.peak', 'dark"] body.valley', 'light"] body.peak', 'light"] body.valley']) {
  if (!h.includes(combo)) { bad++; console.log('缺少强调色组合      :', combo); }
}
// 品牌色不随峰谷变化：每套主题下应有一处同时覆盖 body.peak 与 body.valley 的规则，
// 定义 --a1/--a2/--glow/--valley-fill/--peak-fill
const brandBlocks = {};
for (const theme of ['dark', 'light']) {
  const re = new RegExp(`html\\[data-theme="${theme}"\\]([^{}]*)\\{([^}]*)\\}`, 'g');
  let m, found = null;
  while ((m = re.exec(h))) { if (m[2].includes('--a1:')) { found = m[0]; break; } }
  brandBlocks[theme] = found;
  if (!found) { bad++; console.log(`[X] ${theme} 主题缺少品牌色定义`); continue; }
  for (const v of ['--a1', '--a2', '--glow', '--valley-fill', '--peak-fill']) {
    if (!found.includes(v + ':')) { bad++; console.log(`[X] ${theme} 品牌色块缺少 ${v}`); }
  }
  if (!/body\.peak/.test(found) || !/body\.valley/.test(found)) {
    bad++; console.log(`[X] ${theme} 品牌色块未同时覆盖 body.peak 与 body.valley`);
  }
}
// 钉死：暗夜的品牌色必须等于参考图 logo 取样值
const darkBrand = (brandBlocks.dark || '').match(/--a1:(#[0-9A-Fa-f]{6})/);
console.log('暗夜品牌色          :', darkBrand ? darkBrand[1] + (darkBrand[1].toUpperCase() === '#64FFDA' ? ' [OK] 等于参考图 logo 色' : ' [X] 与参考图 #64FFDA 不符') : '[X] 未取到');
if (!darkBrand || darkBrand[1].toUpperCase() !== '#64FFDA') bad++;
// 峰与谷不得使用不同品牌色
const a1Count = [...h.matchAll(/--a1:(#[0-9A-Fa-f]{6})/g)].map(m => m[1].toUpperCase());
const byTheme = { dark: [], light: [] };
for (const theme of ['dark', 'light']) {
  const blk = brandBlocks[theme] || '';
  byTheme[theme].push(...(blk.match(/--a1:(#[0-9A-Fa-f]{6})/g) || []).map(s => s.split(':')[1].toUpperCase()));
}
const brandDiffers = byTheme.dark.length !== 1 || byTheme.light.length !== 1;
console.log('品牌色定义处数      :', `暗夜 ${byTheme.dark.length} · 白昼 ${byTheme.light.length}`, brandDiffers ? '[X] 应为每主题各一处' : '[OK] 不随峰谷变化');
if (brandDiffers) bad++;
console.log('全部 --a1 取值      :', a1Count.join('  '));
// 峰谷必须使用同一个填充色变量（同一主题色）
const flat = h.replace(/\s+/g, '');
if (!/\.cal-track\.seg\{[^}]*background:var\(--peak-fill\)/.test(flat)) {
  bad++; console.log('[X] 日历高峰段未使用 --peak-fill');
} else {
  console.log('峰段填充变量        : [OK] var(--peak-fill)');
}
// 主题色必须同族：所有 --a1 都应落在参考色 #64FFDA 附近（色相 158–176°；
// 创想工作室的白底主色 #0D9488 为 174.7°，故上界取 176）
function hue(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}
const accents = [...h.matchAll(/--a1:(#[0-9A-Fa-f]{6})/g)].map(m => m[1]);
const hues = accents.map(hue);
console.log('主题色 --a1 取值    :', accents.join('  '));
console.log('对应色相(°）        :', hues.map(x => x.toFixed(1)).join('  '));
const offHue = hues.filter(x => x < 158 || x > 176);
if (offHue.length) { bad++; console.log('[X] 有强调色偏离参考主题色 #64FFDA (165.7°)'); }
const segBgs = [...h.matchAll(/--peak-fill:([^;]+);/g)].map(m => m[1].trim());
console.log('高峰填充 --peak-fill :', [...new Set(segBgs)].join('  '));
const valleyFills = [...h.matchAll(/--valley-fill:([^;]+);/g)].map(m => m[1].trim());
console.log('空闲填充 --valley-fill:', [...new Set(valleyFills)].join('  '));

// 字体：等宽链必须显式补中文无衬线，否则「天」会掉进 SimSun 等兜底字体
const mono = (h.match(/--mono:([^;]+);/) || [])[1] || '';
const sans = (h.match(/--sans:([^;]+);/) || [])[1] || '';
const cjkInMono = /YaHei|PingFang|Hiragino|Noto Sans CJK/.test(mono);
const monoLast = /monospace\s*$/.test(mono.trim());
const genericAt = mono.lastIndexOf('monospace');   // 末尾的通用族（注意 ui-monospace 也含该子串）
const cjkAt = ['YaHei', 'PingFang', 'Hiragino', 'Noto Sans CJK']
  .map(n => mono.indexOf(n)).filter(i => i > 0).sort((a, b) => a - b)[0] ?? -1;
const cjkBeforeGeneric = cjkAt > 0 && cjkAt < genericAt;
console.log('等宽链含中文字体    :', cjkInMono && cjkBeforeGeneric ? '[OK] 且排在 monospace 之前' : '[X]');
console.log('等宽链以 monospace 收尾:', monoLast ? '[OK]' : '[X]');
if (!(cjkInMono && cjkBeforeGeneric)) { bad++; console.log('[X] --mono 缺少中文无衬线回退，「天」会渲染成宋体类兜底字体'); }
if (!monoLast) { bad++; console.log('[X] --mono 未以 monospace 收尾'); }
if (!sans) { bad++; console.log('[X] 缺少 --sans 变量'); }
if (!/\.u\{[^}]*font-family:var\(--sans\)/.test(flat)) { bad++; console.log('[X] 缺少 .u 规则（等宽区中文字族切换）'); }
else console.log('中文单位 .u 规则    : [OK] font-family:var(--sans)');
// 倒计时拆成三个节点（性能优化：每秒只改时间文本，不重建 HTML），且「天」必须带 .u 切中文字体
const cdParts = ['cdDays', 'cdUnit', 'cdTime'].every(id => new RegExp(`id="${id}"`).test(h));
const cdUnitStyled = /class="u"\s+id="cdUnit"|id="cdUnit"[^>]*class="u"/.test(h);
const cdUnitWritten = /setText\(\$\('cdUnit'\),[^)]*'天'/.test(h);
console.log('倒计时节点拆分      :', cdParts ? '[OK] cdDays / cdUnit / cdTime' : (bad++, '[X] 缺少节点'));
console.log('「天」用 .u 切字体  :', cdUnitStyled && cdUnitWritten ? '[OK] 静态 .u 节点 + textContent 赋值' : (bad++, `[X] styled=${cdUnitStyled} written=${cdUnitWritten}`));

// 图标：页面内不允许出现表情符号，一律使用 sprite 里的自绘 SVG
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/u;
const emojiHits = [];
h.split('\n').forEach((l, i) => { if (EMOJI.test(l)) emojiHits.push(`${i + 1}: ${l.trim().slice(0, 70)}`); });
console.log('页面表情符号        :', emojiHits.length ? `[X] ${emojiHits.length} 处` : '无 [OK] 全部为自绘 SVG');
if (emojiHits.length) { bad++; emojiHits.slice(0, 5).forEach(x => console.log('   ' + x)); }
// 交付文件统一扫描（网页 + 核心 + 服务端）
for (const f of ['peak-valley-core.js', 'peak-valley-feeds.js', 'server.js']) {
  if (!fs.existsSync(R(f))) { bad++; console.log(`文件缺失            : ${f}`); continue; }
  const src = fs.readFileSync(R(f), 'utf8');
  const n = src.split('\n').filter(l => EMOJI.test(l)).length;
  console.log(`${f.padEnd(20)}:`, n ? (bad++, `[X] ${n} 行含表情`) : `${src.split('\n').length} 行，无表情 [OK]`);
}
const symbols = [...h.matchAll(/<symbol id="([^"]+)"/g)].map(m => m[1]);
const usedIcons = [...new Set([...h.matchAll(/#i-([a-z]+)"/g)].map(m => 'i-' + m[1]))];
const unknownIcons = usedIcons.filter(u => !symbols.includes(u));
console.log('自绘图标 symbol     :', `${symbols.length} 个 ·`, symbols.join(' '));
console.log('引用未定义图标      :', unknownIcons.length ? '[X] ' + unknownIcons.join(',') : '无 [OK]');
if (unknownIcons.length) bad++;

console.log('\n' + (bad ? `[X] 共 ${bad} 项异常` : '[OK] 全部结构检查通过'));
process.exit(bad ? 1 : 0);
