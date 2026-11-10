/**
 * 地区列表与地区价差（演示数据）
 *
 * offset = 该地区零售价 - 全国价，单位：元/升。
 * 首版手动选择地区并记住，定位只作为可选增强。
 */
const REGIONS = [
  { code: '440000', name: '广东',     city: '广州',     offset:  0.00 },
  { code: '410000', name: '河南',     city: '郑州',     offset: -0.02 },
  { code: '510000', name: '四川',     city: '成都',     offset:  0.09 },
  { code: '110000', name: '北京',     city: '北京',     offset:  0.05 },
  { code: '310000', name: '上海',     city: '上海',     offset:  0.13 },
  { code: '330000', name: '浙江',     city: '杭州',     offset:  0.08 },
  { code: '610000', name: '陕西',     city: '西安',     offset:  0.02 },
  { code: '230000', name: '黑龙江',   city: '哈尔滨',   offset: -0.06 },
  { code: '460000', name: '海南',     city: '海口',     offset:  0.15 },
  { code: '650000', name: '新疆',     city: '乌鲁木齐', offset:  0.11 }
];

const DEFAULT_REGION_CODE = '440000';

module.exports = { REGIONS, DEFAULT_REGION_CODE };
