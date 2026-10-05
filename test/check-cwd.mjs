// 回归检查：所有套件必须能在任意工作目录下运行
//
// 背景：早先 4 个套件（test-ui / check-html / check-icons / check-quality）用
// CWD 相对路径读取文件，从仓库上层目录调用就会报
//   ENOENT: no such file or directory, open '...\deepseek-peak-valley.html'
// 现在它们都改为基于脚本自身位置推导仓库根，这个套件把该行为钉死：
// 故意切到仓库外的目录再跑一遍，任何一个 ENOENT 都会让本检查失败。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTSIDE = join(ROOT, '..');

// 只挑不需要服务端的套件（API / 压测类必须先起服务）
const SUITES = [
  'test-peak-valley.mjs',
  'test-oracle.mjs',
  'test-feeds.mjs',
  'test-ui.mjs',
  'check-html.cjs',
  'check-icons.mjs',
  'check-quality.cjs'
];

let failed = 0;
const run = (file, cwd, env) => spawnSync(process.execPath, [join(ROOT, 'test', file)], {
  cwd,
  stdio: 'ignore',
  env: env ? { ...process.env, ...env } : process.env
});

console.log('从仓库外目录执行（' + OUTSIDE + '）：');
for (const f of SUITES) {
  const r = run(f, OUTSIDE);
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? '[OK]' : '[X] '} ${f.padEnd(24)} exit=${r.status}`);
}

// 从仓库根执行一次（常规用法，必须依然正常）
console.log('\n从仓库根执行：');
for (const f of ['test-ui.mjs', 'check-quality.cjs']) {
  const r = run(f, ROOT);
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? '[OK]' : '[X] '} ${f.padEnd(24)} exit=${r.status}`);
}

// PV_HTML 显式给相对路径时，仍按调用者 CWD 解释（保持既有用法不变）
{
  const r = run('test-ui.mjs', ROOT, { PV_HTML: 'deepseek-peak-valley.html' });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? '[OK]' : '[X] '} ${'test-ui.mjs (PV_HTML 相对路径)'.padEnd(24)} exit=${r.status}`);
}

if (failed) {
  console.log('\n[X] ' + failed + ' 项在非仓库目录下失败 —— 说明仍有 CWD 相对路径，');
  console.log('    请把读取路径改为基于脚本位置（见 test/check-quality.cjs 的 ROOT/R 写法）。');
  console.log('    下面是失败套件的原始输出：\n');
  for (const f of SUITES) {
    const r = spawnSync(process.execPath, [join(ROOT, 'test', f)], { cwd: OUTSIDE, stdio: 'inherit' });
    if (r.status !== 0) console.log(`--- ${f} ---`);
  }
} else {
  console.log('\n[OK] 全部套件在任意工作目录下均可运行（无 CWD 依赖）');
}

process.exit(failed ? 1 : 0);
