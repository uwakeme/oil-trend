/**
 * 油品定义
 * 顺序即展示顺序：首页小卡、走势分段控件、提醒条件全部按这个顺序，
 * 切换大卡时其余油品不会重排。
 */
const FUELS = [
  { id: '92', name: '92# 汽油', short: '92#', unit: '元/升' },
  { id: '95', name: '95# 汽油', short: '95#', unit: '元/升' },
  { id: '98', name: '98# 汽油', short: '98#', unit: '元/升' },
  { id: '0',  name: '0# 柴油',  short: '0#',  unit: '元/升' }
];

const FUEL_MAP = FUELS.reduce(function (acc, fuel) {
  acc[fuel.id] = fuel;
  return acc;
}, {});

function getFuel(id) {
  return FUEL_MAP[id] || FUELS[0];
}

module.exports = { FUELS, FUEL_MAP, getFuel };
