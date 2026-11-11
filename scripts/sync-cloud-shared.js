/**
 * 从小程序端的数据源生成云函数共享模块，并做一致性断言。
 *
 * 背景：之前 cloudfunctions/_shared/shared.js 是手写的另一份调价时间线
 * （4 条、倒序），和小程序端 data/adjustments.js（24 条、正序）对不上。
 * 部署 seed 之后从演示源切到云端，价格会从 7.36 变成 7.47，涨跌方向也反了。
 *
 * 现在改成单一真源：云函数侧的调价时间线、地区价差、油品定义
 * 全部由 data/ 下的文件生成，禁止再手工维护第二份。
 *
 * 用法：node scripts/sync-cloud-shared.js
 * 不一致时直接 exit 1。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const adjustments = require(path.join(ROOT, 'data', 'adjustments.js'));
const regions = require(path.join(ROOT, 'data', 'regions.js'));
const fuels = require(path.join(ROOT, 'data', 'fuels.js'));
const config = require(path.join(ROOT, 'config', 'index.js'));

const ANCHOR = config.demoAnchorDate || '2026-11-10';
const SHARED_DIR = path.join(ROOT, 'cloudfunctions', '_shared');
const TARGET = path.join(SHARED_DIR, 'shared.js');

function j(value) {
  return JSON.stringify(value, null, 2);
}

const template = [
  '/**',
  ' * 云函数共享模块 —— 由 scripts/sync-cloud-shared.js 自动生成，请勿手改。',
  ' *',
  ' * 数据真源在小程序端 data/ 下：',
  ' *   data/adjustments.js  调价时间线（全国统一幅度）',
  ' *   data/regions.js      地区价差',
  ' *   data/fuels.js        油品定义',
  ' *',
  ' * 改了上面任意一个文件，都要重新跑 scripts/sync-cloud-shared.js。',
  ' */',
  '',
  'var DEMO_ANCHOR = ' + JSON.stringify(ANCHOR) + ';',
  '',
  'var FUELS = ' + j(fuels.FUELS) + ';',
  '',
  'var REGIONS = ' + j(regions.REGIONS) + ';',
  '',
  'var DEFAULT_REGION_CODE = ' + JSON.stringify(regions.DEFAULT_REGION_CODE) + ';',
  '',
  'var ADJUSTMENTS = ' + j(adjustments.ADJUSTMENTS) + ';',
  '',
  'var NATIONAL_BASE = ' + j(adjustments.NATIONAL_BASE) + ';',
  '',
  '/* ---------- 演示时钟：与小程序端 utils/demo-clock.js 同一套规则 ---------- */',
  '',
  'function parseUtc(dateStr) {',
  '  var m = String(dateStr).slice(0, 10).match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);',
  '  if (!m) return null;',
  '  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));',
  '}',
  '',
  'function localDayNumber(date) {',
  '  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());',
  '}',
  '',
  'function offsetDays() {',
  '  var anchor = parseUtc(DEMO_ANCHOR);',
  '  if (anchor === null) return 0;',
  '  return Math.round((localDayNumber(new Date()) - anchor) / 86400000);',
  '}',
  '',
  'function shiftDate(dateStr) {',
  "  if (!dateStr) return '';",
  '  var base = parseUtc(dateStr);',
  '  if (base === null) return dateStr;',
  '  var d = new Date(base);',
  '  d.setUTCDate(d.getUTCDate() + offsetDays());',
  "  return d.toISOString().slice(0, 10);",
  '}',
  '',
  'function today() {',
  '  return shiftDate(DEMO_ANCHOR);',
  '}',
  '',
  'function daysUntil(dateStr) {',
  '  var target = parseUtc(dateStr);',
  '  if (target === null) return 0;',
  '  var todayTs = parseUtc(today());',
  '  return Math.round((target - todayTs) / 86400000);',
  '}',
  '',
  '/* ---------- 价格计算 ---------- */',
  '',
  'function round2(v) {',
  '  return Math.round(v * 100) / 100;',
  '}',
  '',
  'function regionByCode(code) {',
  '  for (var i = 0; i < REGIONS.length; i++) {',
  '    if (REGIONS[i].code === code) return REGIONS[i];',
  '  }',
  '  return REGIONS[0];',
  '}',
  '',
  'var LEVEL_CACHE = {};',
  '',
  'function levels(fuelId) {',
  '  if (LEVEL_CACHE[fuelId]) return LEVEL_CACHE[fuelId];',
  '  var price = NATIONAL_BASE[fuelId];',
  '  var list = [{ date: null, price: price, delta: 0, title: null }];',
  '  ADJUSTMENTS.forEach(function (item) {',
  '    price = round2(price + item.deltas[fuelId]);',
  '    list.push({',
  '      // 日期统一平移，和小程序端保持同一时间基准',
  '      date: shiftDate(item.date),',
  '      price: price,',
  '      delta: item.deltas[fuelId],',
  '      title: item.title',
  '    });',
  '  });',
  '  LEVEL_CACHE[fuelId] = list;',
  '  return list;',
  '}',
  '',
  'function nationalPriceOn(fuelId, dateStr) {',
  '  var list = levels(fuelId);',
  '  var price = list[0].price;',
  '  for (var i = 1; i < list.length; i++) {',
  '    if (list[i].date <= dateStr) price = list[i].price;',
  '    else break;',
  '  }',
  '  return price;',
  '}',
  '',
  'function priceOn(regionCode, fuelId, dateStr) {',
  '  var region = regionByCode(regionCode);',
  '  return round2(nationalPriceOn(fuelId, dateStr) + region.offset);',
  '}',
  '',
  'function currentPrice(regionCode, fuelId) {',
  '  return priceOn(regionCode, fuelId, today());',
  '}',
  '',
  'function allPrices() {',
  '  var out = [];',
  '  REGIONS.forEach(function (region) {',
  '    FUELS.forEach(function (fuel) {',
  '      var list = levels(fuel.id);',
  '      out.push({',
  "        regionCode: region.code,",
  "        regionName: region.name + ' · ' + region.city,",
  '        fuelId: fuel.id,',
  '        fuelName: fuel.name,',
  '        price: currentPrice(region.code, fuel.id),',
  '        changeAmount: list[list.length - 1].delta,',
  '        changeAt: list[list.length - 1].date',
  '      });',
  '    });',
  '  });',
  '  return out;',
  '}',
  '',
  'function dedupKey(sourceId, title, executeAt) {',
  "  return [sourceId, String(executeAt || '').slice(0, 10), String(title || '').replace(/\\s+/g, '')].join('::');",
  '}',
  '',
  'module.exports = {',
  '  DEMO_ANCHOR: DEMO_ANCHOR,',
  '  FUELS: FUELS,',
  '  REGIONS: REGIONS,',
  '  DEFAULT_REGION_CODE: DEFAULT_REGION_CODE,',
  '  ADJUSTMENTS: ADJUSTMENTS,',
  '  NATIONAL_BASE: NATIONAL_BASE,',
  '  round2: round2,',
  '  regionByCode: regionByCode,',
  '  levels: levels,',
  '  nationalPriceOn: nationalPriceOn,',
  '  priceOn: priceOn,',
  '  currentPrice: currentPrice,',
  '  allPrices: allPrices,',
  '  dedupKey: dedupKey,',
  '  clock: { today: today, shiftDate: shiftDate, daysUntil: daysUntil, offsetDays: offsetDays }',
  '};'
].join('\n');

fs.mkdirSync(SHARED_DIR, { recursive: true });
fs.writeFileSync(TARGET, template, 'utf8');
console.log('已生成 ' + path.relative(ROOT, TARGET));

/* ---------- 一致性断言 ---------- */

function fail(message) {
  console.error('✗ ' + message);
  process.exitCode = 1;
}

// 重新加载生成的模块，确保断言的是落盘后的内容
delete require.cache[require.resolve(TARGET)];
var shared = require(TARGET);
var demo = require(path.join(ROOT, 'data', 'demo.js'));

if (shared.ADJUSTMENTS.length !== adjustments.ADJUSTMENTS.length) {
  fail('调价条数不一致：云端 ' + shared.ADJUSTMENTS.length + ' ≠ 小程序端 ' + adjustments.ADJUSTMENTS.length);
}
if (shared.REGIONS.length !== regions.REGIONS.length) fail('地区数不一致');
if (shared.FUELS.length !== fuels.FUELS.length) fail('油品数不一致');

for (var i = 0; i < adjustments.ADJUSTMENTS.length; i++) {
  var a = adjustments.ADJUSTMENTS[i];
  var b = shared.ADJUSTMENTS[i];
  if (!b || a.date !== b.date || JSON.stringify(a.deltas) !== JSON.stringify(b.deltas)) {
    fail('第 ' + (i + 1) + ' 条调价不一致：' + JSON.stringify(a) + ' vs ' + JSON.stringify(b));
    break;
  }
}

// 每个地区 × 每个油品的当前价必须一致
var mismatches = 0;
regions.REGIONS.forEach(function (region) {
  fuels.FUELS.forEach(function (fuel) {
    var mini = demo.currentPrice(region.code, fuel.id);
    var cloud = shared.currentPrice(region.code, fuel.id);
    if (Math.abs(mini - cloud) > 0.0001) {
      mismatches++;
      console.error('✗ 价格不一致 ' + region.name + ' ' + fuel.name +
        '：小程序端 ' + mini + ' vs 云端 ' + cloud);
    }
  });
});
if (mismatches) fail(mismatches + ' 组价格不一致');

// 调价节点数也要一致
fuels.FUELS.forEach(function (fuel) {
  var miniTrend = demo.getTrend('440000', fuel.id, '1y');
  var cloudList = shared.levels(fuel.id);
  if (miniTrend.count !== cloudList.length - 1) {
    fail(fuel.name + ' 调价节点数不一致：' + miniTrend.count + ' vs ' + (cloudList.length - 1));
  }
});

if (process.exitCode) {
  console.error('\n共享规则与小程序端不一致，已中止。');
  process.exit(1);
}

/* ---------- 复制到各云函数目录 ---------- */

var functionsDir = path.join(ROOT, 'cloudfunctions');
var targets = fs.readdirSync(functionsDir).filter(function (name) {
  var full = path.join(functionsDir, name);
  return fs.statSync(full).isDirectory() && name !== '_shared';
});

targets.forEach(function (name) {
  var dest = path.join(functionsDir, name, 'shared.js');
  fs.copyFileSync(TARGET, dest);
  console.log('已同步 → ' + path.relative(ROOT, dest));
});

console.log('\n一致性断言全部通过，共同步 ' + targets.length + ' 个云函数。');
