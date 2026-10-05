// 代码质量检查：死代码、重复实现、库模块纯净度、可读性
// 把这次代码审查的结论固化下来，防止回归
const fs = require('fs');
const path = require('path');

// 仓库根目录由脚本自身位置推导，而不是当前工作目录：
// 这样从任何目录调用都不会出现 ENOENT（以前必须 cd 到仓库根才能跑）
const ROOT = path.join(__dirname, '..');
const R = f => (path.isAbsolute(f) ? f : path.join(ROOT, f));

let bad = 0;
const ok = (label, pass, detail) => {
  if (pass) console.log(`${label.padEnd(24)} [OK]${detail ? ' ' + detail : ''}`);
  else { bad++; console.log(`${label.padEnd(24)} [X]${detail ? ' ' + detail : ''}`); }
};
const read = f => fs.readFileSync(R(f), 'utf8');

// 递归列出仓库内的脚本（测试/工具可能在子目录里，扫描范围必须跟着走）
function listScripts(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listScripts(p));
    else if (/\.(mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

// 按扩展名递归列出（shell 检查用；listScripts 只收 .mjs/.cjs）
function listFiles(dir, re) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, re));
    else if (re.test(e.name)) out.push(p);
  }
  return out;
}

const html = read('deepseek-peak-valley.html');
const core = read('peak-valley-core.js');
const feeds = read('peak-valley-feeds.js');
const server = read('server.js');
const shipped = { 'deepseek-peak-valley.html': html, 'peak-valley-core.js': core, 'peak-valley-feeds.js': feeds, 'server.js': server };
const allCode = Object.values(shipped).join('\n');

console.log('===== 1. 交付文件齐备 =====');
for (const f of ['deepseek-peak-valley.html', 'peak-valley-core.js', 'peak-valley-feeds.js', 'server.js']) {
  ok(f, fs.existsSync(R(f)));
}

console.log('\n===== 2. 库模块必须安静（不能往控制台打字）=====');
for (const [f, src] of [['peak-valley-core.js', core], ['peak-valley-feeds.js', feeds]]) {
  const hits = (src.match(/console\.\w+/g) || []).length;
  ok(f, hits === 0, hits ? `发现 ${hits} 处 console` : '无 console');
}

console.log('\n===== 3. 导出必须真的被用到（不留死 API）=====');
// 只取导出的对象字面量，避免把 CONFIG 之类的嵌套字段误判成顶层导出
const exportBlock = src => {
  const i = src.indexOf('var PeakValley = {') >= 0 ? src.indexOf('var PeakValley = {') : src.indexOf('return {');
  const j = src.indexOf('\n  };', i);
  return src.slice(i, j < 0 ? src.length : j);
};
for (const [f, src] of [['peak-valley-core.js', core], ['peak-valley-feeds.js', feeds]]) {
  const names = [...exportBlock(src).matchAll(/^\s{4}([a-zA-Z_][\w]*):/gm)].map(m => m[1]);
  const others = Object.entries(shipped).filter(([n]) => n !== f).map(([, s]) => s).join('\n')
    + listScripts(ROOT).map(read).join('\n');
  const dead = names.filter(n => !new RegExp(`\\.${n}\\b`).test(others));
  ok(f, dead.length === 0, dead.length ? '外部零引用: ' + dead.join(', ') : `${names.length} 项全部有引用`);
}

console.log('\n===== 4. 重复实现守卫（这次审查的核心结论）=====');
// 联网地址只允许出现在数据源模块里，绝不允许在网页/服务端再写一份
for (const needle of ['https://worldtimeapi.org', 'https://timeapi.io', 'https://api.m.taobao.com', 'https://timor.tech']) {
  const where = Object.entries(shipped).filter(([, s]) => s.includes(needle)).map(([n]) => n);
  const onlyFeeds = where.length === 1 && where[0] === 'peak-valley-feeds.js';
  ok(needle.replace('https://', ''), onlyFeeds, '出现在: ' + (where.join(', ') || '无'));
}
// 校时源解析器与日历解析不得在网页或服务端被重新实现（薄包装可以，函数体不行）
for (const [f, src] of [['deepseek-peak-valley.html', html], ['server.js', server]]) {
  const reimpl = /function\s+(parseHolidayPayload|mergeCalendar|fetchWithTimeout)\s*\(/.test(src) || /\bpick:\s*function|\bpick:\s*j\s*=>/.test(src);
  ok(`${f} 无重复实现`, !reimpl, reimpl ? '重新实现了公共数据源逻辑' : '仅调用公共模块');
}

console.log('\n===== 5. CSS 死类 =====');
const styleEnd = html.indexOf('</style>');
const style = html.slice(html.indexOf('<style>'), styleEnd);
const bodyJs = html.slice(styleEnd);
const dynamicPrefix = [...bodyJs.matchAll(/['"]([a-z][a-z0-9]*-)['"]\s*\+/g)].map(m => m[1]);
const cssClasses = [...new Set([...style.matchAll(/\.([a-z][a-z0-9-]*)/g)].map(m => m[1]))];
const orphan = cssClasses.filter(c => {
  if (dynamicPrefix.some(p => c.startsWith(p))) return false;   // 形如 'lv-' + level 动态拼接
  return !new RegExp(`class="[^"]*\\b${c}\\b|['"]${c}['"]`).test(bodyJs);
});
ok('孤儿 CSS 类', orphan.length === 0, orphan.length ? orphan.join(', ') : `${cssClasses.length} 个类全部被使用`);

console.log('\n===== 6. 可达性：状态类必须有调用点 =====');
const dotStates = [...new Set([...style.matchAll(/\.dot\.(\w+)\s*\{/g)].map(m => m[1]))];
const usedStates = [...new Set([...bodyJs.matchAll(/setSyncChip\('(\w+)'/g)].map(m => m[1]))];
const unreachable = dotStates.filter(s => !usedStates.includes(s));
ok('.dot 状态类', unreachable.length === 0, unreachable.length ? '不可达: ' + unreachable.join(', ') : dotStates.join('/') + ' 均可达');

console.log('\n===== 7. 可读性 =====');
for (const [f, src] of Object.entries(shipped)) {
  const lines = src.split('\n');
  const trail = lines.filter(l => /[ \t]+$/.test(l)).length;
  const tabs = lines.filter(l => /^\t/.test(l)).length;
  const eof = src.endsWith('\n');
  const todo = (src.match(/\b(TODO|FIXME|XXX|HACK)\b/g) || []).length;
  ok(f, trail === 0 && tabs === 0 && eof && todo === 0,
    `行尾空格 ${trail} · Tab ${tabs} · 结尾换行 ${eof ? 'ok' : '缺'} · TODO ${todo}`);
}

console.log('\n===== 8. 关键不变量 =====');
ok('缓存失效接口已导出', /bumpCalendar:\s*bumpCalendar/.test(core));
ok('日期格式校验在数据源层', /DATE_RE\s*=\s*\/\^\\d\{4\}/.test(feeds));
ok('服务端与网页共用核心', /require\('\.\/peak-valley-core\.js'\)/.test(server) && /src="peak-valley-core\.js"/.test(html));
ok('服务端与网页共用数据源', /require\('\.\/peak-valley-feeds\.js'\)/.test(server) && /src="peak-valley-feeds\.js"/.test(html));
ok('服务端加载顺序正确', html.indexOf('peak-valley-core.js') < html.indexOf('peak-valley-feeds.js'));

console.log('\n===== 9. 署名与协议一致性（项目归属创想工作室）=====');
const AUTHOR = '创想工作室';
const RUNTIME = ['server.js', 'peak-valley-core.js', 'peak-valley-feeds.js', 'deepseek-peak-valley.html'];
for (const [f, needle] of [
  ['NOTICE', 'DS峰谷钟 (DS Fenggu Zhong)'],
  ['NOTICE', 'Copyright (C) 2022 创想工作室 (Chuangxiang Studio)'],
  ['LICENSE', 'GNU GENERAL PUBLIC LICENSE'],
  ['LICENSE', 'Version 3, 29 June 2007'],
  ['LICENSE', 'END OF TERMS AND CONDITIONS'],
  ['package.json', '"author": "创想工作室"'],
  ['package.json', '"license": "GPL-3.0-or-later"'],
  ['README.md', '由 **创想工作室** 开发与维护'],
  ['README.md', '## 项目归属'],
  ['README.md', 'GPL-3.0-or-later'],
  ['deepseek-peak-valley.html', '© 2022 创想工作室'],
  ['deepseek-peak-valley.html', '<meta name="author" content="创想工作室" />'],
  ['server.js', "author: '创想工作室'"],
  ['server.js', "license: 'GPL-3.0-or-later'"],
  [path.join('assets', 'logo.svg'), AUTHOR]
]) {
  ok(`${f} 署名`, read(f).includes(needle), read(f).includes(needle) ? '' : `缺少 ${JSON.stringify(needle)}`);
}
// GPL-3.0：四个运行文件都要带版权与许可声明（§5 要求保留声明并标明修改）
for (const f of RUNTIME) {
  const has = read(f).includes('Copyright (C) 2022 创想工作室 (Chuangxiang Studio)')
    && read(f).includes('GPL-3.0-or-later');
  ok(`${f} 版权头`, has, has ? '' : '缺少 GPL 版权/许可声明头');
}
// NOTICE 是归属声明的载体，必须存在且被 README 指向
ok('NOTICE 存在且非空', read('NOTICE').trim().length > 40);
ok('README 指向 NOTICE', /\[`NOTICE`\]\(NOTICE\)/.test(read('README.md')));
ok('LICENSE 不含 MIT 残留', !/MIT License/.test(read('LICENSE')));
ok('LICENSE 不含 Apache 残留', !/Apache License/.test(read('LICENSE')));

console.log('\n===== 10. 版本一致性 =====');
{
  const pkgVersion = JSON.parse(read('package.json')).version;
  const coreVersion = (core.match(/VERSION\s*=\s*'([^']+)'/) || [])[1];
  const feedsVersion = (feeds.match(/VERSION\s*=\s*'([^']+)'/) || [])[1];
  ok('package.json 与核心 VERSION 一致', pkgVersion === coreVersion,
    `${pkgVersion} vs ${coreVersion}`);
  ok('package.json 与数据源 VERSION 一致', pkgVersion === feedsVersion,
    `${pkgVersion} vs ${feedsVersion}`);
  ok('版本号出现在接口示例里', read('README.md').includes(`"version": "${coreVersion}"`),
    `README 示例中的 server.version 应为 ${coreVersion}`);
}

console.log('\n===== 11. shell 脚本结构（本机无法执行 bash -n，做静态结构校验）=====');
{
  const shFiles = listFiles(ROOT, /\.sh$/);
  ok('找到 shell 脚本', shFiles.length > 0, shFiles.map(f => path.relative(ROOT, f)).join(', '));
  for (const f of shFiles) {
    const rel2 = path.relative(ROOT, f).split(path.sep).join('/');
    const src = fs.readFileSync(f, 'utf8');
    const lines = src.split('\n');
    ok(`${rel2} shebang`, lines[0] === '#!/usr/bin/env bash');
    ok(`${rel2} 严格模式`, /set -euo pipefail/.test(src));
    ok(`${rel2} 无 CR`, !/\r/.test(src));
    // heredoc 必须成对：每个 <<EOF 都要有独占一行的 EOF
    const opens = (src.match(/<<-?['"]?EOF['"]?/g) || []).length;
    const closes = lines.filter(l => l.trim() === 'EOF').length;
    ok(`${rel2} heredoc 配对`, opens === closes, `${opens} 开 / ${closes} 闭`);
    // 关键字配对（先剔除以 # 开头的整行注释，再按词边界计数）
    const code = lines.filter(l => !/^\s*#/.test(l)).join('\n');
    const cnt = re => (code.match(re) || []).length;
    for (const [a, b] of [['if', 'fi'], ['for', 'done'], ['case', 'esac']]) {
      const na = cnt(new RegExp(`\\b${a}\\b`, 'g'));
      const nb = cnt(new RegExp(`\\b${b}\\b`, 'g'));
      ok(`${rel2} ${a}/${b} 配对`, na === nb, `${na}/${nb}`);
    }
  }
}

console.log('\n===== 12. 4 文件部署契约一致性 =====');
{
  // 契约：运行时就是 4 个文件。四个地方各自声明了一份，必须完全一致 ——
  // 将来谁加了第 5 个运行时文件却漏改某处，这里就会失败。
  const CONTRACT = ['deepseek-peak-valley.html', 'peak-valley-core.js', 'peak-valley-feeds.js', 'server.js'];
  const sortJoin = a => [...a].sort().join(',');
  const want = sortJoin(CONTRACT);

  const fromBuild = [...read('build-dist.mjs').matchAll(/file:\s*'([^']+)'/g)].map(m => m[1]);
  ok('build-dist.mjs 运行时清单', sortJoin(fromBuild) === want, fromBuild.sort().join(','));

  const sh = read(path.join('deploy', 'install.sh'));
  const req = (sh.match(/REQUIRED=\(([^)]*)\)/) || [])[1] || '';
  const fromSh = req.trim().split(/\s+/).filter(Boolean);
  ok('install.sh 的 REQUIRED', sortJoin(fromSh) === want, fromSh.sort().join(','));

  for (const f of CONTRACT) {
    ok(`README 声明了 ${f}`, read('README.md').includes(f));
    ok(`ARCHITECTURE 声明了 ${f}`, read('ARCHITECTURE.md').includes(f));
  }
}

console.log('\n===== 13. 单点计数（防止错误被重复统计）=====');
{
  const server = read('server.js');
  const bumps = (server.match(/stats\.errors\+\+/g) || []).length;
  ok('stats.errors 只有一个自增点', bumps === 1, `出现 ${bumps} 次`);
  ok('由 finish 事件统计 5xx', /res\.on\('finish', \(\) => \{ if \(res\.statusCode >= 500\) stats\.errors\+\+; \}\)/.test(server));
  const calls = (server.match(/applyCommonHeaders\(res\);/g) || []).length;
  ok('三条响应路径共用基础头', calls === 3, `调用 ${calls} 次（应为 JSON/文本/静态 各一次）`);
}

console.log('\n' + (bad ? `[X] 共 ${bad} 项不合格` : '[OK] 代码质量检查全部通过'));
process.exit(bad ? 1 : 0);
