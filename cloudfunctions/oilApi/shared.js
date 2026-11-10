/**
 * 云函数共享模块
 *
 * 小程序端的 data/ 与云函数端需要同一套「调价时间线 + 地区价差」规则，
 * 但云函数上传时各自独立打包，无法引用小程序根目录，
 * 因此把共享代码放在 cloudfunctions/_shared/，
 * 由 scripts/sync-cloud-shared.js 复制到各云函数目录。
 *
 * ⚠️ 修改后请执行：node scripts/sync-cloud-shared.js
 */
const FUELS = [
  { id: '92', name: '92# 汽油', short: '92#', unit: '元/升' },
  { id: '95', name: '95# 汽油', short: '95#', unit: '元/升' },
  { id: '98', name: '98# 汽油', short: '98#', unit: '元/升' },
  { id: '0',  name: '0# 柴油',  short: '0#',  unit: '元/升' }
];

const REGIONS = [
  { code: '440000', name: '广东', city: '广州', offset: 0.00 },
  { code: '410000', name: '河南', city: '郑州', offset: -0.02 },
  { code: '510000', name: '四川', city: '成都', offset: 0.09 },
  { code: '110000', name: '北京', city: '北京', offset: 0.05 },
  { code: '310000', name: '上海', city: '上海', offset: 0.13 },
  { code: '330000', name: '浙江', city: '杭州', offset: 0.08 },
  { code: '610000', name: '陕西', city: '西安', offset: 0.02 },
  { code: '230000', name: '黑龙江', city: '哈尔滨', offset: -0.06 },
  { code: '460000', name: '海南', city: '海口', offset: 0.15 },
  { code: '650000', name: '新疆', city: '乌鲁木齐', offset: 0.11 }
];

const DEFAULT_REGION_CODE = '440000';

/** 全国调价时间线：调整幅度全国统一，落地零售价按地区定价 */
const ADJUSTMENTS = [
  { date: '2026-11-02', title: '国内成品油价格按机制下调', deltas: { '92': -0.08, '95': -0.09, '98': -0.10, '0': -0.08 } },
  { date: '2026-10-20', title: '国内成品油价格按机制上调', deltas: { '92': 0.06, '95': 0.07, '98': 0.07, '0': 0.05 } },
  { date: '2026-09-28', title: '国内成品油价格按机制下调', deltas: { '92': -0.10, '95': -0.11, '98': -0.12, '0': -0.09 } },
  { date: '2026-09-07', title: '国内成品油价格按机制上调', deltas: { '92': 0.04, '95': 0.05, '98': 0.05, '0': 0.04 } }
];

const NATIONAL_BASE = { '92': 7.55, '95': 8.17, '98': 9.07, '0': 7.19 };

function round2(v) {
  return Math.round(v * 100) / 100;
}

function regionByCode(code) {
  for (var i = 0; i < REGIONS.length; i++) {
    if (REGIONS[i].code === code) return REGIONS[i];
  }
  return REGIONS[0];
}

/** 某油品的全国价格阶梯 */
function levels(fuelId) {
  var price = NATIONAL_BASE[fuelId];
  var list = [{ date: null, price: price, delta: 0 }];
  ADJUSTMENTS.forEach(function (item) {
    price = round2(price + item.deltas[fuelId]);
    list.push({ date: item.date, price: price, delta: item.deltas[fuelId], title: item.title });
  });
  return list;
}

/** 某地某油品价格 */
function priceOn(regionCode, fuelId) {
  var region = regionByCode(regionCode);
  var list = levels(fuelId);
  return round2(list[list.length - 1].price + region.offset);
}

function allPrices() {
  var out = [];
  REGIONS.forEach(function (region) {
    FUELS.forEach(function (fuel) {
      var list = levels(fuel.id);
      out.push({
        regionCode: region.code,
        regionName: region.name + ' · ' + region.city,
        fuelId: fuel.id,
        fuelName: fuel.name,
        price: priceOn(region.code, fuel.id),
        changeAmount: list[list.length - 1].delta,
        changeAt: list[list.length - 1].date
      });
    });
  });
  return out;
}

/**
 * 去重键：同一来源 + 同一执行日期 + 同一标题 = 同一条通知。
 * 只用标题会导致不同月份的重合标题被误判为重复，所以要带上执行日期。
 */
function dedupKey(sourceId, title, executeAt) {
  return [sourceId, String(executeAt || '').slice(0, 10), String(title || '').replace(/\s+/g, '')].join('::');
}

module.exports = {
  FUELS: FUELS,
  REGIONS: REGIONS,
  DEFAULT_REGION_CODE: DEFAULT_REGION_CODE,
  ADJUSTMENTS: ADJUSTMENTS,
  NATIONAL_BASE: NATIONAL_BASE,
  round2: round2,
  regionByCode: regionByCode,
  levels: levels,
  priceOn: priceOn,
  allPrices: allPrices,
  dedupKey: dedupKey
};
