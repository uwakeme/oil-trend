/**
 * 生成服务端省界数据
 *
 * 用途：小程序拿到经纬度后，要判断「这是哪个省」。
 *       没有第三方逆地理编码 key、也不依赖外部配额，
 *       就得自己带一份省界几何数据。
 *
 * 数据来源：阿里云 DataV.GeoAtlas 省级行政区边界
 *   https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json
 *
 * ⚠️ 坐标系是 GCJ-02（火星坐标），与 wx.getLocation 的 type:'gcj02' 一致，
 *    两边不用再做偏移换算。 DataV 的北京 center 是 116.405285,39.904989，
 *    正是 GCJ-02 的北京坐标（WGS84 是 116.397128,39.916527）。
 *
 * 本脚本做三件事：
 *   1. 只保留 data/regions.js 里那 31 个省级行政区（不含港澳台）
 *   2. 用 Douglas-Peucker 抽稀省界（容差 0.01° ≈ 1.1km），
 *      省级别判定这点误差无感，但体积能砍掉一大半
 *   3. 抽稀后用多边形面积校验，误差超过 0.5% 就自动放宽容差重试
 *
 * 输出：server/src/data/provinces.json（**生成产物**，手改会被覆盖）
 *
 * 用法：node scripts/gen-province-geo.js
 */
const fs = require('fs');
const path = require('path');

const SOURCE_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json';
const OUT = path.resolve(__dirname, '..', 'server', 'src', 'data', 'provinces.json');

// 抽稀容差（度）。0.01° 在中纬度约合 1.1km。
const TOLERANCE = 0.01;
// 抽稀后允许的最大面积相对误差
const MAX_AREA_ERROR = 0.01;
// 小于这个面积（度²）算小岛，不参与面积校验
const SMALL_AREA = 0.005;
// 坐标保留小数位
const PRECISION = 4;

/* ---------------- 几何工具 ---------------- */

/** 点到线段的距离平方 */
function sqSegDist(p, a, b) {
  var x = a[0];
  var y = a[1];
  var dx = b[0] - x;
  var dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    var t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

/** Douglas-Peucker：抽稀一条开放折线 */
function douglasPeucker(points, tol) {
  if (!points || points.length < 3) return (points || []).slice();
  var sqTol = tol * tol;
  var keep = new Array(points.length);
  keep[0] = true;
  keep[points.length - 1] = true;
  var stack = [[0, points.length - 1]];
  while (stack.length) {
    var range = stack.pop();
    var first = range[0];
    var last = range[1];
    var maxSq = 0;
    var index = -1;
    for (var i = first + 1; i < last; i++) {
      var sq = sqSegDist(points[i], points[first], points[last]);
      if (sq > maxSq) {
        maxSq = sq;
        index = i;
      }
    }
    if (maxSq > sqTol && index !== -1) {
      keep[index] = true;
      stack.push([first, index]);
      stack.push([index, last]);
    }
  }
  var out = [];
  for (var k = 0; k < points.length; k++) {
    if (keep[k]) out.push(points[k]);
  }
  return out;
}

/** 去掉重复点 */
function dedupe(points) {
  var out = [];
  for (var i = 0; i < points.length; i++) {
    var p = points[i];
    var last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 1e-9 || Math.abs(last[1] - p[1]) > 1e-9) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 抽稀一个闭合环。
 *
 * 闭合环不能直接丢给 Douglas-Peucker（首尾同点会让它退化），
 * 所以先找一个锚点把环拆成两段开放折线，分别抽稀后再拼回去。
 */
function simplifyRing(ring, tol) {
  var pts = dedupe(ring);
  if (pts.length < 4) return pts;

  // 锚点取离质心最远的点
  var cx = 0;
  var cy = 0;
  var i;
  for (i = 0; i < pts.length; i++) {
    cx += pts[i][0];
    cy += pts[i][1];
  }
  cx /= pts.length;
  cy /= pts.length;
  var anchor = 0;
  var best = -1;
  for (i = 0; i < pts.length; i++) {
    var d = (pts[i][0] - cx) * (pts[i][0] - cx) + (pts[i][1] - cy) * (pts[i][1] - cy);
    if (d > best) {
      best = d;
      anchor = i;
    }
  }

  // chain 从锚点绕一圈回到锚点
  var n = pts.length;
  var chain = [];
  for (i = 1; i <= n; i++) chain.push(pts[(anchor + i) % n]);
  var mid = Math.floor(chain.length / 2);
  var s1 = douglasPeucker(chain.slice(0, mid + 1), tol);
  var s2 = douglasPeucker(chain.slice(mid), tol);
  var out = s1.concat(s2.slice(1));
  // 首尾补齐成闭合环
  var head = out[0];
  var tail = out[out.length - 1];
  if (Math.abs(head[0] - tail[0]) > 1e-9 || Math.abs(head[1] - tail[1]) > 1e-9) {
    out.push([head[0], head[1]]);
  }
  return out;
}

/** 环的有向面积（鞋带公式） */
function ringArea(ring) {
  var sum = 0;
  for (var i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

/** 坐标取整 */
function round(coords) {
  var f = Math.pow(10, PRECISION);
  return Math.round(coords[0] * f) / f + ',' + Math.round(coords[1] * f) / f;
}

/* ---------------- 主流程 ---------------- */

function pick(list) {
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (item) out.push(item);
  }
  return out;
}

async function main() {
  console.log('拉取省界数据：' + SOURCE_URL);
  var res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  var raw = await res.json();

  var want = {};
  require('../data/regions').REGIONS.forEach(function (r) {
    want[r.code] = r.name;
  });

  var provinces = [];
  var skipped = [];

  raw.features.forEach(function (feature) {
    var adcode = String(feature.properties.adcode || '');
    if (!want[adcode]) {
      skipped.push(feature.properties.name || adcode);
      return;
    }
    // geometry 可能是 Polygon（一个环数组）也可能是 MultiPolygon（环数组的数组）。
    // 内蒙古就是 Polygon，不做归一化会被当成 MultiPolygon 读错。
    var geom = feature.geometry.coordinates;
    var polyList = feature.geometry.type === 'Polygon' ? [geom] : geom;

    // 容差按省独立：某个省抽不干净，不该把后面所有省一起拖到极小容差。
    var tol = TOLERANCE;
    var polygons = [];
    polyList.forEach(function (poly) {
      var outer = poly[0] || [];
      var holes = poly.slice(1) || [];
      var areaBefore = Math.abs(ringArea(outer));
      // 小岛（礁石、离岛）本来就没多少面积，抽狠一点无所谓，
      // 但拿它做面积校验会把容差一路减半 —— 所以小岛跳过校验。
      var isSmall = areaBefore < SMALL_AREA;
      var sOuter = simplifyRing(outer, isSmall ? tol * 4 : tol);
      if (!isSmall) {
        var areaAfter = Math.abs(ringArea(sOuter));
        var guard = 0;
        while (areaBefore > 0 && Math.abs(areaAfter - areaBefore) / areaBefore > MAX_AREA_ERROR && guard < 5) {
          tol = tol / 2;
          sOuter = simplifyRing(outer, tol);
          areaAfter = Math.abs(ringArea(sOuter));
          guard++;
        }
      }
      var sHoles = [];
      holes.forEach(function (hole) {
        var sh = simplifyRing(hole, tol);
        if (sh.length >= 4) sHoles.push(sh.map(round));
      });
      if (sOuter.length >= 4) {
        polygons.push({ outer: sOuter.map(round), holes: sHoles });
      }
    });
    if (polygons.length) {
      provinces.push({ adcode: adcode, name: feature.properties.name, polygons: polygons });
    }
  });

  provinces.sort(function (a, b) {
    return a.adcode < b.adcode ? -1 : 1;
  });

  var payload = {
    source: SOURCE_URL,
    generatedAt: new Date().toISOString().slice(0, 10),
    crs: 'GCJ-02',
    tolerance: TOLERANCE,
    note: '生成产物，改法见 scripts/gen-province-geo.js',
    provinces: provinces
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  var text = JSON.stringify(payload);
  fs.writeFileSync(OUT, text, 'utf8');

  console.log('省界 ' + provinces.length + ' 个（跳过：' + skipped.join('、') + '）');
  console.log('基准容差 ' + TOLERANCE + '，体积 ' + (text.length / 1024).toFixed(1) + ' KB');
  console.log('写入 ' + path.relative(process.cwd(), OUT));
}

main().catch(function (err) {
  console.error('生成失败：', err && err.message ? err.message : err);
  process.exit(1);
});
