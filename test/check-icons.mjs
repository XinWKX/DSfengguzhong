// 校验页面里手绘 SVG 图标的路径语法：命令合法性、参数个数、弧线标志位、绝对坐标范围
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 路径基于脚本位置，便于从任意 CWD 调用
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'deepseek-peak-valley.html'), 'utf8');

const ARGS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const PAD = 2;                 // 允许微量越界（描边、手绘误差）
let bad = 0, checked = 0, values = 0;

function checkPath(d, where, vb) {
  const [vx, vy, vw, vh] = vb;
  const box = [[vx - PAD, vx + vw + PAD], [vy - PAD, vy + vh + PAD]];
  const deltaMax = Math.max(vw, vh) * 1.2;
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  if (tokens.join('') !== d.replace(/[\s,]+/g, '')) {
    console.log(`  [X] ${where}: 含非法字符  ${d}`); bad++; return false;
  }
  let i = 0, cur = null;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const pts = [];
  const push = (x, y) => { cx = x; cy = y; pts.push([x, y]); };

  while (i < tokens.length) {
    const t = tokens[i];
    if (/[A-Za-z]/.test(t)) { cur = t; i++; }
    else if (!cur) { console.log(`  [X] ${where}: 以数字开头  ${d}`); bad++; return false; }

    const up = cur.toUpperCase(), rel = cur !== up, n = ARGS[up];
    if (n === undefined) { console.log(`  [X] ${where}: 未知命令 ${cur}`); bad++; return false; }
    if (n === 0) { push(sx, sy); cur = null; continue; }

    const p = tokens.slice(i, i + n);
    if (p.length < n || p.some(x => /[A-Za-z]/.test(x))) {
      console.log(`  [X] ${where}: ${cur} 需要 ${n} 个参数，只有 ${p.length} 个  ${d}`); bad++; return false;
    }
    const v = p.map(Number);
    if (v.some(x => !isFinite(x))) { console.log(`  [X] ${where}: ${cur} 含非数字参数  ${d}`); bad++; return false; }
    values += n;
    i += n;

    const ax = (k) => (rel ? cx + v[k] : v[k]);
    const ay = (k) => (rel ? cy + v[k] : v[k]);

    if (up === 'A') {
      if (!(v[0] > 0) || !(v[1] > 0)) { console.log(`  [X] ${where}: 弧线半径必须为正  ${d}`); bad++; return false; }
      if (![0, 1].includes(v[3]) || ![0, 1].includes(v[4])) {
        console.log(`  [X] ${where}: 弧线标志位必须是 0/1，得到 ${v[3]},${v[4]}  ${d}`); bad++; return false;
      }
      const ex = ax(5), ey = ay(6);
      const chord = Math.hypot(ex - cx, ey - cy);
      if (Math.max(v[0], v[1]) < chord / 2 - 0.01) {
        console.log(`  [X] ${where}: 半径 ${Math.max(v[0], v[1])} 小于半弦长 ${(chord / 2).toFixed(2)}，浏览器会强行放大半径改变形状  ${d}`);
        bad++; return false;
      }
      push(ex, ey);
    } else if (up === 'H') { push(rel ? cx + v[0] : v[0], cy); }
    else if (up === 'V') { push(cx, rel ? cy + v[0] : v[0]); }
    else if (up === 'C') { push(ax(4), ay(5)); }
    else if (up === 'S' || up === 'Q') { push(ax(2), ay(3)); }
    else { const k = n - 2; push(ax(k), ay(k + 1)); if (up === 'M') { sx = cx; sy = cy; } }
  }

  for (const [x, y] of pts) {
    if (x < box[0][0] || x > box[0][1] || y < box[1][0] || y > box[1][1]) {
      console.log(`  [X] ${where}: 绝对坐标越界 (${x}, ${y})，viewBox ${vb.join(' ')}  ${d}`); bad++; return false;
    }
  }
  for (const n2 of d.match(/-?\d*\.?\d+/g) || []) {
    if (Math.abs(Number(n2)) > deltaMax) { console.log(`  [X] ${where}: 数值过大 ${n2}（上限 ${deltaMax.toFixed(1)}）  ${d}`); bad++; return false; }
  }
  checked++;
  return true;
}

const sprite = html.match(/<svg class="sprite"[\s\S]*?<\/svg>/);
if (!sprite) { console.log('[X] 未找到 sprite'); process.exit(1); }
const symbols = [...sprite[0].matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g)];
console.log(`sprite symbol: ${symbols.length} 个\n`);
for (const [, id, vb, body] of symbols) {
  const box = vb.split(/\s+/).map(Number);
  const square = box.length === 4 && box[0] === 0 && box[1] === 0 && box[2] === box[3] && box[2] >= 12 && box[2] <= 32;
  let ok = square;
  if (!square) { console.log(`  [X] ${id}: viewBox 异常 ${vb}（应为 "0 0 N N"，N 在 12–32）`); bad++; }
  const paths = [...body.matchAll(/<path d="([^"]+)"/g)];
  if (!paths.length) { console.log(`  [X] ${id}: 没有 path`); bad++; ok = false; }
  for (const [, d] of paths) ok = checkPath(d, id, box) && ok;
  if (!/fill="none"/.test(body) || !/stroke="currentColor"/.test(body)) {
    console.log(`  [X] ${id}: 缺少 fill="none" / stroke="currentColor"`); bad++; ok = false;
  }
  if (ok) console.log(`  [OK] ${id.padEnd(9)} viewBox ${vb} · ${paths.length} 条路径`);
}

const mark = html.match(/<svg class="mark" viewBox="([^"]+)"[\s\S]*?<\/svg>/);
if (!mark) { console.log('[X] 未找到 logo mark'); bad++; }
else {
  const box = mark[1].split(/\s+/).map(Number);
  let ok = true;
  for (const [, d] of mark[0].matchAll(/<path d="([^"]+)"/g)) ok = checkPath(d, 'logo-mark', box) && ok;
  if (ok) console.log(`  [OK] ${'logo-mark'.padEnd(9)} viewBox ${mark[1]} · 峰谷折线 ${(mark[0].match(/<path /g) || []).length} 条`);
}

const fav = html.match(/rel="icon" href="data:image\/svg\+xml,([^"]+)"/);
if (!fav) { console.log('[X] 未找到 favicon'); bad++; }
else {
  const svg = decodeURIComponent(fav[1]);
  const vb = (svg.match(/viewBox='([^']+)'/) || [])[1] || '';
  const box = vb.split(/\s+/).map(Number);
  let ok = true;
  for (const [, d] of svg.matchAll(/<path d="([^"]+)"/g)) ok = checkPath(d, 'favicon', box) && ok;
  const open = (svg.match(/<[a-zA-Z]+/g) || []).length;
  const close = (svg.match(/\/>|<\/[a-zA-Z]+>/g) || []).length;
  if (open !== close) { console.log(`  [X] favicon 标签不配对 ${open}/${close}`); bad++; ok = false; }
  if (ok) console.log(`  [OK] ${'favicon'.padEnd(9)} viewBox ${vb} · 标签 ${open}/${close} 配对`);
}

console.log(`\n共校验 ${checked} 条路径 / ${values} 个数值 → ${bad ? `[X] ${bad} 处异常` : '[OK] 全部合法'}`);
process.exit(bad ? 1 : 0);
