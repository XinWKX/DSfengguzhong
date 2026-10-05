// 一键跑完全部验证套件，并把「实际断言数」与 README 表格交叉比对。
//
// 子进程输出用**临时文件**重定向而不是管道：DSH 沙箱下管道捕获会被拒（EPERM），
// 文件描述符重定向在沙箱与 CI 里都能用。这样既能保留完整输出，
// 又能解析每个套件的「结果：N 通过」用于校验文档里的数字（这类数字漂移过多次）。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { openSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const suites = [
  ['判定逻辑', 'test-peak-valley.mjs'],
  ['独立对照 + 性能基线', 'test-oracle.mjs'],
  ['数据源模块单测', 'test-feeds.mjs'],
  ['网页 UI（DOM 桩执行）', 'test-ui.mjs'],
  ['API 端到端', 'test-api.mjs'],
  ['加固审计', 'test-hardening.mjs'],
  ['压测', 'test-load.mjs'],
  ['结构检查', 'check-html.cjs'],
  ['图标路径检查', 'check-icons.mjs'],
  ['代码质量检查', 'check-quality.cjs'],
  ['工作目录无关性', 'check-cwd.mjs']
];

const results = [];
for (const [name, file] of suites) {
  console.log('\n' + '='.repeat(72));
  console.log('>>> ' + name + '  (' + file + ')');
  console.log('='.repeat(72));
  const t0 = Date.now();
  const logFile = join(tmpdir(), 'ds-fenggu-' + basename(file) + '.log');
  const fd = openSync(logFile, 'w');
  const r = spawnSync(process.execPath, [join(HERE, file)], { stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const out = readFileSync(logFile, 'utf8');
  unlinkSync(logFile);
  process.stdout.write(out);
  const m = /结果：(\d+) 通过 \/ (\d+) 失败/.exec(out);
  results.push({
    name, file, ok: r.status === 0, ms: Date.now() - t0, code: r.status,
    pass: m ? Number(m[1]) : null
  });
}

console.log('\n' + '='.repeat(72));
console.log('汇总');
console.log('='.repeat(72));
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  const cnt = r.pass === null ? '    - 项' : String(r.pass).padStart(5) + ' 项';
  console.log(`${r.ok ? '[OK]' : '[X] '} ${r.file.padEnd(24)} ${r.name.padEnd(20)} ${cnt} ${String(r.ms).padStart(7)}ms  exit=${r.code}`);
}

// ---- README 数字一致性：防止「改了测试没改文档」 ----
console.log('\n' + '='.repeat(72));
console.log('README 数字一致性');
console.log('='.repeat(72));
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const declared = {};
for (const m of readme.matchAll(/\| `test\/([\w.-]+)` \| (\d+) \|/g)) declared[m[1]] = Number(m[2]);
const declaredTotal = Number((readme.match(/\/ (\d+) 项断言/) || [])[1]);
const declaredSuites = Number((readme.match(/(\d+) 个测试套件/) || [])[1]);
let docBad = 0;

for (const r of results) {
  const want = declared[r.file];
  if (want === undefined || r.pass === null) continue;
  // test-oracle 末节的线上交叉核对在源不可达/空数据时会跳过 2 项
  const tolerant = r.file === 'test-oracle.mjs';
  const okCount = r.pass === want || (tolerant && r.pass === want - 2);
  if (!okCount) docBad++;
  console.log(`  ${okCount ? '[OK]' : '[X] '} ${r.file.padEnd(24)} README 写 ${want} · 实际 ${r.pass}`);
}
const actualTotal = results.reduce((s, r) => s + (r.pass || 0), 0);
const totalOk = actualTotal === declaredTotal;
if (!totalOk) docBad++;
console.log(`  ${totalOk ? '[OK]' : '[X] '} 断言总数                README 写 ${declaredTotal} · 实际 ${actualTotal}`);
const suitesOk = declaredSuites === results.length;
if (!suitesOk) docBad++;
console.log(`  ${suitesOk ? '[OK]' : '[X] '} 套件数                  README 写 ${declaredSuites} · 实际 ${results.length}`);

console.log(`\n${results.length - failed}/${results.length} 套件通过${docBad ? '，但 README 有 ' + docBad + ' 处数字不一致' : '，README 数字一致'}`);
process.exit(failed || docBad ? 1 : 0);
