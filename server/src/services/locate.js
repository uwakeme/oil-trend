/**
 * 经纬度 → 省份
 *
 * 小程序拿到经纬度后要知道「这是哪个省」，才能自动切到当地油价。
 * 这里不依赖任何第三方逆地理编码 API：
 * 自带一份省级行政区边界（server/src/data/provinces.json，生成产物），
 * 用射线法判断点落在哪个省里。
 *
 * ⚠️ 坐标系是 GCJ-02，与 wx.getLocation 的 type:'gcj02' 一致。
 *    传 wgs84 会有 300~600 米的偏移，边界省份就会判错。
 */
const GEO = require('../data/provinces.json');
const { regionByCode } = require('../shared/shared');

/**
 * 点落在省界外多远之内还算「就近归属」。
 * 覆盖三种情况：
 *   1. 用户在海边、码头、跨海大桥上
 *   2. 落在小到没被抽稀掉的离岛（海南省那 133 个多边形就是这种情况）
 *   3. GCJ-02 与实际位置的几十米级误差
 */
var NEAREST_KM = 25;

/* ---------------- 索引 ---------------- */

var INDEX = null;

function parseRing(ring) {
  var out = [];
  for (var i = 0; i < ring.length; i++) {
    var parts = String(ring[i]).split(',');
    out.push([Number(parts[0]), Number(parts[1])]);
  }
  return out;
}

function buildIndex() {
  if (INDEX) return INDEX;
  INDEX = [];
  GEO.provinces.forEach(function (province) {
    var polygons = [];
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    province.polygons.forEach(function (poly) {
      var outer = parseRing(poly.outer);
      var holes = [];
      (poly.holes || []).forEach(function (hole) {
        holes.push(parseRing(hole));
      });
      polygons.push({ outer: outer, holes: holes });
      outer.forEach(function (pt) {
        if (pt[0] < minX) minX = pt[0];
        if (pt[0] > maxX) maxX = pt[0];
        if (pt[1] < minY) minY = pt[1];
        if (pt[1] > maxY) maxY = pt[1];
      });
    });
    INDEX.push({
      adcode: province.adcode,
      name: province.name,
      polygons: polygons,
      bbox: [minX, minY, maxX, maxY]
    });
  });
  return INDEX;
}

/* ---------------- 几何判断 ---------------- */

/** 射线法：点是否在环内 */
function pointInRing(x, y, ring) {
  var inside = false;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    var xi = ring[i][0];
    var yi = ring[i][1];
    var xj = ring[j][0];
    var yj = ring[j][1];
    // 半开区间判断，避免顶点算两次
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** 点是否在这个多边形里（外环内、且不在任何洞里） */
function pointInPolygon(x, y, polygon) {
  if (!pointInRing(x, y, polygon.outer)) return false;
  for (var i = 0; i < polygon.holes.length; i++) {
    if (pointInRing(x, y, polygon.holes[i])) return false;
  }
  return true;
}

/**
 * 点到线段的距离（公里）。
 * 用等距圆柱近似把经纬度换成平面公里坐标，
 * 几十公里范围内误差可以忽略。
 */
function segmentDistanceKm(pLat, pLng, aLat, aLng, bLat, bLng) {
  var k = 111.32 * Math.cos((pLat * Math.PI) / 180);
  var px = pLng * k;
  var py = pLat * 110.574;
  var ax = aLng * k;
  var ay = aLat * 110.574;
  var bx = bLng * k;
  var by = bLat * 110.574;
  var dx = bx - ax;
  var dy = by - ay;
  var t = 0;
  if (dx !== 0 || dy !== 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
    if (t < 0) t = 0;
    if (t > 1) t = 1;
  }
  var ex = ax + dx * t - px;
  var ey = ay + dy * t - py;
  return Math.sqrt(ex * ex + ey * ey);
}

/** 点到某个省所有边界的最短距离（公里） */
function distanceToProvinceKm(lat, lng, province) {
  var min = Infinity;
  for (var p = 0; p < province.polygons.length; p++) {
    var rings = [province.polygons[p].outer];
    for (var h = 0; h < province.polygons[p].holes.length; h++) {
      rings.push(province.polygons[p].holes[h]);
    }
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r];
      for (var i = 0; i < ring.length - 1; i++) {
        var d = segmentDistanceKm(lat, lng, ring[i][1], ring[i][0], ring[i + 1][1], ring[i + 1][0]);
        if (d < min) min = d;
      }
    }
  }
  return min;
}

/* ---------------- 对外 ---------------- */

/**
 * 判断经纬度落在哪个省。
 *
 * 返回字段固定，方便前端直接用：
 *   regionCode  行政区划码（'440000'），没匹配到时为 null
 *   regionName  简称（'广东'），没匹配到时为 null
 *   city        省会（'广州'），没匹配到时为 null
 *   match       'inside' 落在省内 / 'nearest' 靠近某省 / 'none' 没匹配到
 *   distanceKm  距该省界的距离（公里），落在省内时为 0
 */
function locateByLatLng(lat, lng) {
  var latNum = Number(lat);
  var lngNum = Number(lng);
  if (!isFinite(latNum) || !isFinite(lngNum)) {
    return { regionCode: null, regionName: null, city: null, match: 'none', distanceKm: null };
  }
  if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
    return { regionCode: null, regionName: null, city: null, match: 'none', distanceKm: null };
  }

  var index = buildIndex();

  // 1. 落在哪个省的界内
  for (var i = 0; i < index.length; i++) {
    var box = index[i].bbox;
    if (lngNum < box[0] || lngNum > box[2] || latNum < box[1] || latNum > box[3]) continue;
    for (var p = 0; p < index[i].polygons.length; p++) {
      if (pointInPolygon(lngNum, latNum, index[i].polygons[p])) {
        return describe(index[i], 'inside', 0);
      }
    }
  }

  // 2. 不在界内（海上、小岛、误差），找最近的省
  var best = null;
  var bestKm = Infinity;
  for (var j = 0; j < index.length; j++) {
    var km = distanceToProvinceKm(latNum, lngNum, index[j]);
    if (km < bestKm) {
      bestKm = km;
      best = index[j];
    }
  }
  if (best && bestKm <= NEAREST_KM) {
    return describe(best, 'nearest', Math.round(bestKm * 10) / 10);
  }

  return { regionCode: null, regionName: null, city: null, match: 'none', distanceKm: null };
}

/**
 * 把省界里的 adcode 换成地区信息。
 *
 * ⚠️ regionByCode 找不到时会静默返回 REGIONS[0]（上海），
 *    所以这里必须核对 code 对得上，对不上就说明这个省不在支持列表里。
 */
function describe(province, match, distanceKm) {
  var region = regionByCode(province.adcode);
  if (!region || region.code !== province.adcode) {
    return { regionCode: null, regionName: null, city: null, match: 'none', distanceKm: null };
  }
  return {
    regionCode: region.code,
    regionName: region.name,
    city: region.city,
    match: match,
    distanceKm: distanceKm
  };
}

module.exports = {
  locateByLatLng: locateByLatLng,
  NEAREST_KM: NEAREST_KM
};
