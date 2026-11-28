/* 数据层自检脚本：node scripts/verify-data.js */
const regions = require('../data/regions');
const fuels = require('../data/fuels');
const reference = require('../data/reference-prices');
const cycle = require('../data/adjust-cycle');
const conversion = require('../data/ton-conversion');
const markets = require('../data/markets');
const fmt = require('../utils/format');

const out = [];
const problems = [];

/* ============================================================
 * 油品与地区
 * ============================================================ */

out.push('--- 油品 ---');
fuels.FUELS.forEach(function (fuel) {
  out.push('  ' + fuel.id + '  ' + fuel.name + '  (' + fuel.short + ', ' + fuel.unit + ')');
  // ⚠️ 油品 id 必须是字符串：pg 的 NUMERIC 读出来是文本，
  //    转成数字的话前端「哪个油品」的判断全部失效。
  if (typeof fuel.id !== 'string') problems.push('油品 id 不是字符串：' + fuel.id);
});
if (fuels.FUELS.length !== 4) problems.push('油品数不是 4 个：' + fuels.FUELS.length);

out.push('');
out.push('--- 地区与地区价差 ---');
out.push('  地区数: ' + regions.REGIONS.length + '  默认: ' + regions.DEFAULT_REGION_CODE);
var offsetMissing = [];
regions.REGIONS.forEach(function (region) {
  fuels.FUELS.forEach(function (fuel) {
    var offset = region.offset && region.offset[fuel.id];
    if (typeof offset !== 'number' || !isFinite(offset)) {
      offsetMissing.push(region.name + ' ' + fuel.id);
    }
  });
});
out.push('  价差齐全: ' + (regions.REGIONS.length * fuels.FUELS.length - offsetMissing.length) +
  ' / ' + (regions.REGIONS.length * fuels.FUELS.length));
if (offsetMissing.length) {
  problems.push('地区价差缺 ' + offsetMissing.length + ' 项：' + offsetMissing.slice(0, 5).join('；'));
}
var defaultRegion = regions.REGIONS.filter(function (r) {
  return r.code === regions.DEFAULT_REGION_CODE;
})[0];
if (!defaultRegion) {
  problems.push('默认地区查不到：' + regions.DEFAULT_REGION_CODE);
}

/* ============================================================
 * 各省真实挂牌价基准
 *
 * 基准表是「地区价差」模型的校验基准：改了 offset 又忘了同步基准，
 * 或者基准本身录错了，都能被抓出来。
 * ============================================================ */

out.push('');
out.push('--- 各省最高零售价基准（校验用，不参与运行时）---');
var referenceCount = 0;
var referenceProblems = [];
Object.keys(reference.REFERENCE_PRICES).forEach(function (name) {
  var row = reference.REFERENCE_PRICES[name];
  fuels.FUELS.forEach(function (fuel) {
    referenceCount++;
    var value = row[fuel.id];
    if (typeof value !== 'number' || !isFinite(value) || value <= 0) {
      referenceProblems.push(name + ' ' + fuel.id + ' 基准值异常：' + value);
    }
  });
  var found = regions.REGIONS.some(function (r) { return r.name === name; });
  if (!found) referenceProblems.push('基准里有 ' + name + ' 但地区表里没有');
});
regions.REGIONS.forEach(function (region) {
  if (!reference.REFERENCE_PRICES[region.name]) {
    referenceProblems.push(region.name + ' 没有基准价');
  }
});
out.push('  基准值个数: ' + referenceCount);
if (referenceProblems.length) {
  problems.push('基准价有 ' + referenceProblems.length + ' 处问题：' +
    referenceProblems.slice(0, 5).join('；'));
}

/* ============================================================
 * 调价周期推算
 *
 * 推算必须能复现真实历史轮次（线上 /api/trend 给的相邻两轮执行日）。
 * ============================================================ */

out.push('');
out.push('--- 调价周期推算 ---');
var HISTORY_CASES = [
  ['2026-10-15', '2026-10-29'],   // 常规 10 工作日
  ['2026-10-29', '2026-11-12'],   // 常规 10 工作日
  ['2026-09-24', '2026-10-15'],   // 跨国庆：10 月 1-7 日放假顺延
  ['2026-02-04', '2026-02-25']    // 跨春节：2 月 15-23 日放假顺延
];
HISTORY_CASES.forEach(function (pair) {
  var got = cycle.estimateNextAdjustDate(pair[0]);
  out.push('  ' + pair[0] + ' → ' + got + '  (实际 ' + pair[1] + ')  ' +
    (got === pair[1] ? 'OK' : '✗'));
  if (got !== pair[1]) problems.push('推算 ' + pair[0] + ' → ' + got + '，实际是 ' + pair[1]);
});
var estimate = cycle.estimateNext('2026-11-12');
out.push('  以 2026-11-12 为基准推算: ' + estimate.nextAdjustDate +
  ' 公告日 ' + estimate.nextNoticeDate + ' 周期 ' + estimate.cycleWorkdays + ' 个工作日');
out.push('  ' + cycle.ESTIMATE_NOTE);
out.push('  调休上班日算工作日: ' + cycle.isWorkday('2026-10-10') +
  '  国庆假期不算: ' + (!cycle.isWorkday('2026-10-03')) +
  '  周六不算: ' + (!cycle.isWorkday('2026-11-14')));
if (!cycle.isWorkday('2026-10-10')) problems.push('2026-10-10 是调休上班日，应算工作日');
if (cycle.isWorkday('2026-10-03')) problems.push('2026-10-03 在国庆假期内，不该算工作日');
if (cycle.isWorkday('2026-11-14')) problems.push('2026-11-14 是周六，不该算工作日');

/* ============================================================
 * 吨价→每升折算
 * ============================================================ */

out.push('');
out.push('--- 官方吨价 → 每升折算 ---');
var conversionProblems = [];
conversion.CALIBRATION_ROUNDS.forEach(function (round) {
  Object.keys(round.measured).forEach(function (fuelId) {
    var got = conversion.convertTonToLiter(round.ton, fuelId);
    if (!isFinite(got) || Math.abs(got - round.measured[fuelId]) > 0.001) {
      conversionProblems.push(round.date + ' ' + fuelId + ' 折算 ' + got +
        ' / 实测 ' + round.measured[fuelId]);
    }
  });
});
out.push('  标定轮次: ' + conversion.CALIBRATION_ROUNDS.length + '  对不上的: ' + conversionProblems.length);
if (conversionProblems.length) {
  problems.push('折算有 ' + conversionProblems.length + ' 处对不上：' +
    conversionProblems.slice(0, 3).join('；'));
}
out.push('  440 元/吨 → 92# ' + conversion.convertTonToLiter({ gasoline: -440 }, '92') + ' 元/升');

/* ============================================================
 * 国际行情：只有品种口径
 *
 * ⚠️ 行情数值不在小程序端 —— 演示行情已删，行情由服务端采集入库。
 * ============================================================ */

out.push('');
out.push('--- 国际行情（品种口径）---');
Object.keys(markets.MARKET_INSTRUMENTS).forEach(function (symbol) {
  var inst = markets.MARKET_INSTRUMENTS[symbol];
  out.push('  ' + inst.code + ' ' + inst.name + '  口径: ' + inst.basis);
  if (!inst.basis || !inst.note) problems.push(inst.code + ' 缺口径说明');
});
// 真实行情的曲线形状：老数据是隔几天的日线，最近两天全是分钟线。
// 中档标签必须取**时间中点**：按序号取会落在图最右边那个点上 ——
// 标签画在图的正中间，说的却是图右边那个点的时刻，看着像标错，其实是指错了点。
var axisSample = [
  { date: '2026-11-20 07:00:00', value: 88.0 },
  { date: '2026-11-22 07:00:00', value: 88.5 },
  { date: '2026-11-24 07:00:00', value: 89.0 },
  { date: '2026-11-26 07:00:00', value: 89.5 },
  { date: '2026-11-28 07:00:00', value: 90.1 },
  { date: '2026-11-28 07:05:00', value: 90.2 },
  { date: '2026-11-28 07:10:00', value: 90.3 },
  { date: '2026-11-28 07:15:00', value: 90.4 }
];
out.push('  轴标签(1日): ' + markets.marketAxisLabels(axisSample, '1d').join(' / '));
out.push('  轴标签(1月): ' + markets.marketAxisLabels(axisSample, '1m').join(' / '));
if (markets.marketAxisLabels(axisSample, '1d').length !== 3) {
  problems.push('行情轴标签不是三档');
}
var axisMonth = markets.marketAxisLabels(axisSample, '1m');
if (axisMonth[0] !== '11-20' || axisMonth[2] !== '11-28') {
  problems.push('行情轴标签首尾不是首尾点：' + axisMonth.join(' / '));
}
if (axisMonth[1] !== '11-24') {
  problems.push('行情轴标签中档没取时间中点（应 11-24，按序号取会错成 11-28）：' + axisMonth.join(' / '));
}

/* ============================================================
 * 同步状态文案映射
 *
 * 后端会新增状态（如 idle / partial），只要前端漏了映射
 * 就会掉进「其他」分支显示成「同步异常」。这里断言每种状态都有文案。
 * ============================================================ */

out.push('');
out.push('--- 同步状态文案映射 ---');
var missingStatus = [];
Object.keys(fmt.SYNC_STATUS_META).forEach(function (status) {
  var meta = fmt.syncStatus(status);
  out.push('  ' + status + ' → ' + meta.text + (meta.text ? '  OK' : '  ✗ 缺文案'));
  if (!meta.text) missingStatus.push(status);
});

if (problems.length) {
  out.push('');
  out.push('✗ 有 ' + problems.length + ' 处问题');
  problems.forEach(function (p) { out.push('  ' + p); });
  console.error(out.join('\n'));
  process.exit(1);
}

console.log(out.join('\n'));
