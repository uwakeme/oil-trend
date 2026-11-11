/**
 * 云函数共享模块 —— 由 scripts/sync-cloud-shared.js 自动生成，请勿手改。
 *
 * 数据真源在小程序端 data/ 下：
 *   data/adjustments.js  调价时间线（全国统一幅度）
 *   data/regions.js      地区价差
 *   data/fuels.js        油品定义
 *
 * 改了上面任意一个文件，都要重新跑 scripts/sync-cloud-shared.js。
 */

var DEMO_ANCHOR = "2026-11-10";

var FUELS = [
  {
    "id": "92",
    "name": "92# 汽油",
    "short": "92#",
    "unit": "元/升"
  },
  {
    "id": "95",
    "name": "95# 汽油",
    "short": "95#",
    "unit": "元/升"
  },
  {
    "id": "98",
    "name": "98# 汽油",
    "short": "98#",
    "unit": "元/升"
  },
  {
    "id": "0",
    "name": "0# 柴油",
    "short": "0#",
    "unit": "元/升"
  }
];

var REGIONS = [
  {
    "code": "440000",
    "name": "广东",
    "city": "广州",
    "offset": 0
  },
  {
    "code": "410000",
    "name": "河南",
    "city": "郑州",
    "offset": -0.02
  },
  {
    "code": "510000",
    "name": "四川",
    "city": "成都",
    "offset": 0.09
  },
  {
    "code": "110000",
    "name": "北京",
    "city": "北京",
    "offset": 0.05
  },
  {
    "code": "310000",
    "name": "上海",
    "city": "上海",
    "offset": 0.13
  },
  {
    "code": "330000",
    "name": "浙江",
    "city": "杭州",
    "offset": 0.08
  },
  {
    "code": "610000",
    "name": "陕西",
    "city": "西安",
    "offset": 0.02
  },
  {
    "code": "230000",
    "name": "黑龙江",
    "city": "哈尔滨",
    "offset": -0.06
  },
  {
    "code": "460000",
    "name": "海南",
    "city": "海口",
    "offset": 0.15
  },
  {
    "code": "650000",
    "name": "新疆",
    "city": "乌鲁木齐",
    "offset": 0.11
  }
];

var DEFAULT_REGION_CODE = "440000";

var ADJUSTMENTS = [
  {
    "date": "2025-11-15",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.1,
      "92": 0.1,
      "95": 0.11,
      "98": 0.12
    }
  },
  {
    "date": "2025-11-28",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.13,
      "92": -0.14,
      "95": -0.15,
      "98": -0.17
    }
  },
  {
    "date": "2025-12-12",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.05,
      "92": 0.05,
      "95": 0.06,
      "98": 0.06
    }
  },
  {
    "date": "2025-12-26",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.15,
      "92": -0.16,
      "95": -0.17,
      "98": -0.19
    }
  },
  {
    "date": "2026-01-15",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.11,
      "92": 0.12,
      "95": 0.13,
      "98": 0.14
    }
  },
  {
    "date": "2026-01-29",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.09,
      "92": -0.1,
      "95": -0.11,
      "98": -0.12
    }
  },
  {
    "date": "2026-02-12",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.07,
      "92": 0.08,
      "95": 0.09,
      "98": 0.09
    }
  },
  {
    "date": "2026-02-26",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.11,
      "92": -0.12,
      "95": -0.13,
      "98": -0.14
    }
  },
  {
    "date": "2026-03-12",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.05,
      "92": 0.06,
      "95": 0.07,
      "98": 0.07
    }
  },
  {
    "date": "2026-03-26",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.08,
      "92": -0.09,
      "95": -0.1,
      "98": -0.11
    }
  },
  {
    "date": "2026-04-12",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.1,
      "92": 0.11,
      "95": 0.12,
      "98": 0.13
    }
  },
  {
    "date": "2026-04-26",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.06,
      "92": -0.07,
      "95": -0.08,
      "98": -0.08
    }
  },
  {
    "date": "2026-05-12",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.05,
      "92": -0.06,
      "95": -0.07,
      "98": -0.07
    }
  },
  {
    "date": "2026-05-26",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.08,
      "92": 0.09,
      "95": 0.1,
      "98": 0.11
    }
  },
  {
    "date": "2026-06-12",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.12,
      "92": 0.13,
      "95": 0.14,
      "98": 0.15
    }
  },
  {
    "date": "2026-06-26",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.14,
      "92": -0.15,
      "95": -0.16,
      "98": -0.18
    }
  },
  {
    "date": "2026-07-12",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.06,
      "92": 0.07,
      "95": 0.08,
      "98": 0.08
    }
  },
  {
    "date": "2026-07-26",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.07,
      "92": -0.08,
      "95": -0.09,
      "98": -0.1
    }
  },
  {
    "date": "2026-08-12",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.04,
      "92": -0.05,
      "95": -0.06,
      "98": -0.06
    }
  },
  {
    "date": "2026-08-26",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.09,
      "92": 0.1,
      "95": 0.11,
      "98": 0.12
    }
  },
  {
    "date": "2026-09-07",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.04,
      "92": 0.04,
      "95": 0.05,
      "98": 0.05
    }
  },
  {
    "date": "2026-09-28",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.09,
      "92": -0.1,
      "95": -0.11,
      "98": -0.12
    }
  },
  {
    "date": "2026-10-20",
    "title": "国内成品油价格按机制上调",
    "deltas": {
      "0": 0.05,
      "92": 0.06,
      "95": 0.07,
      "98": 0.07
    }
  },
  {
    "date": "2026-11-02",
    "title": "国内成品油价格按机制下调",
    "deltas": {
      "0": -0.08,
      "92": -0.08,
      "95": -0.09,
      "98": -0.1
    }
  }
];

var NATIONAL_BASE = {
  "0": 7.19,
  "92": 7.55,
  "95": 8.17,
  "98": 9.07
};

/* ---------- 演示时钟：与小程序端 utils/demo-clock.js 同一套规则 ---------- */

function parseUtc(dateStr) {
  var m = String(dateStr).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function localDayNumber(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function offsetDays() {
  var anchor = parseUtc(DEMO_ANCHOR);
  if (anchor === null) return 0;
  return Math.round((localDayNumber(new Date()) - anchor) / 86400000);
}

function shiftDate(dateStr) {
  if (!dateStr) return '';
  var base = parseUtc(dateStr);
  if (base === null) return dateStr;
  var d = new Date(base);
  d.setUTCDate(d.getUTCDate() + offsetDays());
  return d.toISOString().slice(0, 10);
}

function today() {
  return shiftDate(DEMO_ANCHOR);
}

function daysUntil(dateStr) {
  var target = parseUtc(dateStr);
  if (target === null) return 0;
  var todayTs = parseUtc(today());
  return Math.round((target - todayTs) / 86400000);
}

/* ---------- 价格计算 ---------- */

function round2(v) {
  return Math.round(v * 100) / 100;
}

function regionByCode(code) {
  for (var i = 0; i < REGIONS.length; i++) {
    if (REGIONS[i].code === code) return REGIONS[i];
  }
  return REGIONS[0];
}

var LEVEL_CACHE = {};

function levels(fuelId) {
  if (LEVEL_CACHE[fuelId]) return LEVEL_CACHE[fuelId];
  var price = NATIONAL_BASE[fuelId];
  var list = [{ date: null, price: price, delta: 0, title: null }];
  ADJUSTMENTS.forEach(function (item) {
    price = round2(price + item.deltas[fuelId]);
    list.push({
      // 日期统一平移，和小程序端保持同一时间基准
      date: shiftDate(item.date),
      price: price,
      delta: item.deltas[fuelId],
      title: item.title
    });
  });
  LEVEL_CACHE[fuelId] = list;
  return list;
}

function nationalPriceOn(fuelId, dateStr) {
  var list = levels(fuelId);
  var price = list[0].price;
  for (var i = 1; i < list.length; i++) {
    if (list[i].date <= dateStr) price = list[i].price;
    else break;
  }
  return price;
}

function priceOn(regionCode, fuelId, dateStr) {
  var region = regionByCode(regionCode);
  return round2(nationalPriceOn(fuelId, dateStr) + region.offset);
}

function currentPrice(regionCode, fuelId) {
  return priceOn(regionCode, fuelId, today());
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
        price: currentPrice(region.code, fuel.id),
        changeAmount: list[list.length - 1].delta,
        changeAt: list[list.length - 1].date
      });
    });
  });
  return out;
}

function dedupKey(sourceId, title, executeAt) {
  return [sourceId, String(executeAt || '').slice(0, 10), String(title || '').replace(/\s+/g, '')].join('::');
}

module.exports = {
  DEMO_ANCHOR: DEMO_ANCHOR,
  FUELS: FUELS,
  REGIONS: REGIONS,
  DEFAULT_REGION_CODE: DEFAULT_REGION_CODE,
  ADJUSTMENTS: ADJUSTMENTS,
  NATIONAL_BASE: NATIONAL_BASE,
  round2: round2,
  regionByCode: regionByCode,
  levels: levels,
  nationalPriceOn: nationalPriceOn,
  priceOn: priceOn,
  currentPrice: currentPrice,
  allPrices: allPrices,
  dedupKey: dedupKey,
  clock: { today: today, shiftDate: shiftDate, daysUntil: daysUntil, offsetDays: offsetDays }
};