// 从 timor.tech 抓取法定节假日日历，生成可内嵌的 JS 字面量
const YEARS = [2025, 2026, 2027];
const out = {};

for (const y of YEARS) {
  const r = await fetch(`https://timor.tech/api/holiday/year/${y}/`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  const holidays = {}, workdays = {};
  for (const v of Object.values(j.holiday || {})) {
    if (v.holiday) holidays[v.date] = v.name;
    else workdays[v.date] = v.name;
  }
  out[y] = { holidays, workdays };
  console.log(`${y}: 放假 ${Object.keys(holidays).length} 天 | 调休上班 ${Object.keys(workdays).length} 天`);
  console.log('   调休上班:', Object.entries(workdays).map(([d, n]) => `${d}(${n})`).join(', ') || '无');
}

console.log('\n===== 内嵌用 JS =====');
for (const y of Object.keys(out)) {
  const hol = JSON.stringify(out[y].holidays, null, 0).replace(/","/g, '", "');
  const wk = JSON.stringify(out[y].workdays, null, 0).replace(/","/g, '", "');
  console.log(`    ${y}: {`);
  console.log(`      holidays: ${hol.replace(/^\{/, '{ ').replace(/\}$/, ' }')},`);
  console.log(`      workdays: ${wk.replace(/^\{/, '{ ').replace(/\}$/, ' }')}`);
  console.log('    },');
}
