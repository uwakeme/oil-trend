/**
 * 地区列表与地区价差
 *
 * offset = 该地区零售价 - 当期全国均价，单位：元/升，**按油品分别存**。
 *
 * 覆盖全国 31 个省级行政区（不含港澳台）。行政区划代码用国标 GB/T 2260 的
 * 省级代码，city 取省会（直辖市就是本市）。
 *
 * ⚠️ 为什么 offset 要按油品分开：
 *   现实中各省的「标号结构」并不一样 —— 98# 相对 92# 的溢价，各省从
 *   山西的 -0.15 到甘肃的 +1.17，差 1.3 元/升；柴油相对 92# 的差额同样分化。
 *   用一套 offset 套四个油品，98# 的误差最大能到 0.9 元/升。
 *   所以这里存四组值，价格 = 全国价(该油品) + offset(该地区, 该油品)。
 *
 * ⚠️ 数据来源与口径：
 *   取 2026-10-29 24 时那轮调价后各省公布的最高零售价（92# / 95# / 98# / 0# 柴油），
 *   减去同期同油品的全国均价（算术平均）。各油品全国均价分别是
 *   92# 8.939、95# 9.537、98# 10.795、柴油 8.582 元/升。
 *   92# 与 95# 两个独立来源交叉核对过，数值一致。
 *
 * 首版手动选择地区并记住，定位只作为可选增强。
 *
 * slug = 汽油价格网（qiyoujiage.com）地区页路径名，采集器用它拼 URL：
 *   http://www.qiyoujiage.com/{slug}.shtml
 * ⚠️ 山西是 shanxi、陕西是 shanxi-3 —— 拼音撞名，站点用 -3 区分，别按拼音猜。
 */
const REGIONS = [
  { code: '310000', name: '上海', city: '上海', pinyin: 'sh', slug: 'shanghai',
    offset: { '92': -0.09, '95': -0.13, '98': +0.62, '0': -0.01 } },
  { code: '530000', name: '云南', city: '昆明', pinyin: 'yn', slug: 'yunnan',
    offset: { '92': +0.10, '95': +0.16, '98': -0.41, '0': +0.07 } },
  { code: '150000', name: '内蒙古', city: '呼和浩特', pinyin: 'nmg', slug: 'neimenggu',
    offset: { '92': -0.05, '95': -0.09, '98': -0.47, '0': -0.16 } },
  { code: '110000', name: '北京', city: '北京', pinyin: 'bj', slug: 'beijing',
    offset: { '92': -0.05, '95': -0.08, '98': +0.17, '0': +0.07 } },
  { code: '220000', name: '吉林', city: '长春', pinyin: 'jl', slug: 'jilin',
    offset: { '92': -0.09, '95': +0.01, '98': -0.39, '0': -0.08 } },
  { code: '510000', name: '四川', city: '成都', pinyin: 'sc', slug: 'sichuan',
    offset: { '92': +0.04, '95': +0.05, '98': +0.16, '0': +0.04 } },
  { code: '120000', name: '天津', city: '天津', pinyin: 'tj', slug: 'tianjin',
    offset: { '92': -0.06, '95': -0.15, '98': +0.10, '0': +0.02 } },
  { code: '640000', name: '宁夏', city: '银川', pinyin: 'nx', slug: 'ningxia',
    offset: { '92': -0.16, '95': -0.27, '98': -0.24, '0': -0.12 } },
  { code: '340000', name: '安徽', city: '合肥', pinyin: 'ah', slug: 'anhui',
    offset: { '92': -0.11, '95': -0.11, '98': +0.14, '0': +0.05 } },
  { code: '370000', name: '山东', city: '济南', pinyin: 'sd', slug: 'shandong',
    offset: { '92': -0.09, '95': -0.05, '98': -0.30, '0': -0.08 } },
  { code: '140000', name: '山西', city: '太原', pinyin: 'sx', slug: 'shanxi',
    offset: { '92': -0.12, '95': -0.01, '98': -0.08, '0': +0.09 } },
  { code: '440000', name: '广东', city: '广州', pinyin: 'gd', slug: 'guangdong',
    offset: { '92': -0.03, '95': +0.11, '98': +0.86, '0': +0.02 } },
  { code: '450000', name: '广西', city: '南宁', pinyin: 'gx', slug: 'guangxi',
    offset: { '92': +0.00, '95': +0.12, '98': +0.15, '0': +0.06 } },
  { code: '650000', name: '新疆', city: '乌鲁木齐', pinyin: 'xj', slug: 'xinjiang',
    offset: { '92': -0.25, '95': -0.25, '98': -0.24, '0': -0.23 } },
  { code: '320000', name: '江苏', city: '南京', pinyin: 'js', slug: 'jiangsu',
    offset: { '92': -0.09, '95': -0.13, '98': +0.69, '0': -0.03 } },
  { code: '360000', name: '江西', city: '南昌', pinyin: 'jx', slug: 'jiangxi',
    offset: { '92': -0.10, '95': -0.05, '98': +0.20, '0': +0.06 } },
  { code: '130000', name: '河北', city: '石家庄', pinyin: 'hb', slug: 'hebei',
    offset: { '92': -0.06, '95': -0.15, '98': -0.58, '0': +0.02 } },
  { code: '410000', name: '河南', city: '郑州', pinyin: 'hn', slug: 'henan',
    offset: { '92': -0.04, '95': -0.04, '98': -0.63, '0': +0.00 } },
  { code: '330000', name: '浙江', city: '杭州', pinyin: 'zj', slug: 'zhejiang',
    offset: { '92': -0.09, '95': -0.12, '98': +0.13, '0': -0.01 } },
  { code: '460000', name: '海南', city: '海口', pinyin: 'hi', slug: 'hainan',
    offset: { '92': +1.06, '95': +1.09, '98': +0.84, '0': +0.10 } },
  { code: '420000', name: '湖北', city: '武汉', pinyin: 'hb', slug: 'hubei',
    offset: { '92': -0.04, '95': -0.01, '98': +0.14, '0': +0.00 } },
  { code: '430000', name: '湖南', city: '长沙', pinyin: 'hn', slug: 'hunan',
    offset: { '92': -0.11, '95': -0.16, '98': -0.21, '0': +0.08 } },
  { code: '620000', name: '甘肃', city: '兰州', pinyin: 'gs', slug: 'gansu',
    offset: { '92': -0.05, '95': -0.05, '98': -0.73, '0': -0.10 } },
  { code: '350000', name: '福建', city: '福州', pinyin: 'fj', slug: 'fujian',
    offset: { '92': -0.10, '95': -0.10, '98': +0.15, '0': +0.00 } },
  { code: '540000', name: '西藏', city: '拉萨', pinyin: 'xz', slug: 'xizang',
    offset: { '92': +0.81, '95': +0.78, '98': +0.71, '0': +0.53 } },
  { code: '520000', name: '贵州', city: '贵阳', pinyin: 'gz', slug: 'guizhou',
    offset: { '92': +0.08, '95': -0.01, '98': -0.26, '0': +0.11 } },
  { code: '210000', name: '辽宁', city: '沈阳', pinyin: 'ln', slug: 'liaoning',
    offset: { '92': +0.02, '95': +0.04, '98': -0.29, '0': -0.10 } },
  { code: '500000', name: '重庆', city: '重庆', pinyin: 'cq', slug: 'chongqing',
    offset: { '92': +0.00, '95': -0.09, '98': +0.61, '0': +0.06 } },
  { code: '610000', name: '陕西', city: '西安', pinyin: 'sn', slug: 'shanxi-3',
    offset: { '92': -0.18, '95': -0.28, '98': -0.20, '0': -0.11 } },
  { code: '630000', name: '青海', city: '西宁', pinyin: 'qh', slug: 'qinghai',
    offset: { '92': -0.09, '95': -0.06, '98': -0.46, '0': -0.08 } },
  { code: '230000', name: '黑龙江', city: '哈尔滨', pinyin: 'hlj', slug: 'heilongjiang',
    offset: { '92': -0.09, '95': -0.06, '98': -0.04, '0': -0.22 } }
];

const DEFAULT_REGION_CODE = '440000';

module.exports = { REGIONS, DEFAULT_REGION_CODE };
