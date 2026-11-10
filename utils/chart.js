/**
 * Canvas 2D 绘图工具
 *
 * 为什么用 Canvas 而不是 SVG：
 *   微信小程序 WXML 不支持内联 svg，Canvas 2D 是原生绘图路径。
 *
 * 阶梯线（step）是刻意选的：
 *   国内成品油价格只在调价日变化，其余时间保持不变。
 *   画成连续折线等于伪造了高频成交价，与设计原则冲突。
 */
const COLORS = {
  grid: '#e1ded4',
  axis: '#979b95',
  line: '#142c23',
  areaFrom: 'rgba(20, 44, 35, .18)',
  areaTo: 'rgba(20, 44, 35, 0)',
  point: '#e9a928',
  up: '#ce493b',
  down: '#137a52',
  upAreaFrom: 'rgba(206, 73, 59, .18)',
  upAreaTo: 'rgba(206, 73, 59, 0)',
  downAreaFrom: 'rgba(19, 122, 82, .18)',
  downAreaTo: 'rgba(19, 122, 82, 0)'
};

function toTimestamp(dateStr) {
  if (!dateStr) return 0;
  var m = String(dateStr).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * 计算横坐标：
 * 有点和时间就按时间比例排（阶梯段宽度反映真实间隔），否则按序号均分。
 */
function computeXs(points, padLeft, plotW) {
  var hasTime = points.length > 1 && points.every(function (p) { return !!p.date; });
  if (hasTime) {
    var t0 = toTimestamp(points[0].date);
    var t1 = toTimestamp(points[points.length - 1].date);
    var span = t1 - t0;
    // 时间戳解析不出来（跨度为 0）时回落成按序号均分，
    // 否则所有点会叠在同一个横坐标上，曲线变成一根竖线。
    if (span > 0) {
      return points.map(function (p) {
        return padLeft + plotW * (toTimestamp(p.date) - t0) / span;
      });
    }
  }
  return points.map(function (p, i) {
    return padLeft + plotW * i / Math.max(1, points.length - 1);
  });
}

/**
 * 绘制价格曲线
 *
 * options:
 *   points      [{ date, value }]
 *   mode        'step' | 'line'
 *   lineColor / areaFrom / areaTo
 *   gridLines   横向网格线数量
 *   showYAxis   是否绘制左侧数值轴
 *   endDot      是否绘制末端圆点
 *   yAxisFormat (v) => string
 *   min / max   强制取值范围
 */
function drawSeries(ctx, size, options) {
  var opts = options || {};
  var points = opts.points || [];
  var width = size.width;
  var height = size.height;

  ctx.clearRect(0, 0, width, height);
  if (!points.length) return;

  var padTop = opts.padTop === undefined ? 18 : opts.padTop;
  var padBottom = opts.padBottom === undefined ? 14 : opts.padBottom;
  var padLeft = opts.padLeft === undefined ? (opts.showYAxis ? 44 : 4) : opts.padLeft;
  var padRight = opts.padRight === undefined ? 8 : opts.padRight;
  var plotW = Math.max(1, width - padLeft - padRight);
  var plotH = Math.max(1, height - padTop - padBottom);

  var values = points.map(function (p) { return Number(p.value); });
  var min = opts.min !== undefined ? opts.min : Math.min.apply(null, values);
  var max = opts.max !== undefined ? opts.max : Math.max.apply(null, values);
  if (max - min < 1e-6) {
    min -= 0.05;
    max += 0.05;
  } else if (opts.min === undefined && opts.max === undefined) {
    var pad = (max - min) * 0.14;
    min -= pad;
    max += pad;
  }

  var xs = computeXs(points, padLeft, plotW);
  function yOf(v) {
    return padTop + plotH * (1 - (v - min) / (max - min));
  }

  var gridCount = opts.gridLines === undefined ? 4 : opts.gridLines;

  ctx.save();
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  for (var g = 0; g <= gridCount; g++) {
    var gy = Math.round(padTop + plotH * g / gridCount) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padLeft, gy);
    ctx.lineTo(width - padRight, gy);
    ctx.stroke();
  }
  ctx.restore();

  if (opts.showYAxis) {
    ctx.save();
    ctx.fillStyle = COLORS.axis;
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var g2 = 0; g2 <= gridCount; g2++) {
      var value = max - (max - min) * g2 / gridCount;
      var gy2 = padTop + plotH * g2 / gridCount;
      var text = opts.yAxisFormat ? opts.yAxisFormat(value) : value.toFixed(2);
      ctx.fillText(text, padLeft - 8, Math.min(height - 6, Math.max(6, gy2)));
    }
    ctx.restore();
  }

  var isStep = opts.mode !== 'line';
  var path = [];
  for (var i = 0; i < points.length; i++) {
    var px = xs[i];
    var py = yOf(values[i]);
    if (i === 0) {
      path.push([px, py]);
    } else if (isStep) {
      path.push([px, path[path.length - 1][1]]);
      path.push([px, py]);
    } else {
      path.push([px, py]);
    }
  }

  if (opts.areaFrom) {
    var grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    grad.addColorStop(0, opts.areaFrom);
    grad.addColorStop(1, opts.areaTo || 'rgba(20, 44, 35, 0)');
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(path[0][0], path[0][1]);
    for (var k = 1; k < path.length; k++) ctx.lineTo(path[k][0], path[k][1]);
    ctx.lineTo(xs[xs.length - 1], padTop + plotH);
    ctx.lineTo(xs[0], padTop + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  ctx.strokeStyle = opts.lineColor || COLORS.line;
  ctx.lineWidth = opts.lineWidth || 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(path[0][0], path[0][1]);
  for (var m = 1; m < path.length; m++) ctx.lineTo(path[m][0], path[m][1]);
  ctx.stroke();
  ctx.restore();

  if (opts.endDot !== false) {
    var lastX = xs[xs.length - 1];
    var lastY = yOf(values[values.length - 1]);
    ctx.save();
    ctx.beginPath();
    ctx.arc(lastX, lastY, opts.dotRadius || 4, 0, Math.PI * 2);
    ctx.fillStyle = opts.dotColor || COLORS.point;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = opts.dotStroke || '#fffef9';
    ctx.stroke();
    ctx.restore();
  }
}

/** 按涨跌方向取一组配色 */
function directionColors(direction) {
  if (direction === 'up') {
    return { lineColor: COLORS.up, areaFrom: COLORS.upAreaFrom, areaTo: COLORS.upAreaTo };
  }
  if (direction === 'down') {
    return { lineColor: COLORS.down, areaFrom: COLORS.downAreaFrom, areaTo: COLORS.downAreaTo };
  }
  return { lineColor: COLORS.line, areaFrom: COLORS.areaFrom, areaTo: COLORS.areaTo };
}

module.exports = {
  COLORS: COLORS,
  drawSeries: drawSeries,
  directionColors: directionColors
};
