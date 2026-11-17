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
  downAreaTo: 'rgba(19, 122, 82, 0)',
  // 十字光标：竖线对日期，横线对价格
  crosshair: '#8d9189',
  tipBg: '#142c23',
  tipText: '#fffef9',
  tipSub: '#b9bdb4'
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
/**
 * 算绘图区几何：内边距、绘图区大小、取值范围、每个点的横坐标。
 *
 * ⚠️ 手指选点与画图必须用**同一套**几何：
 *   两边各算一次的话，屏幕密度、边距改一处就会对不上，
 *   表现是「点一下高亮的点不是那个点」。
 *
 * @param {Array} points [{date, value}]
 * @param {object} options 绘图选项（min/max/showYAxis/pad* 都在里面）
 * @param {number} width 画布 CSS 宽
 * @param {number} height 画布 CSS 高
 * @returns {object} 几何信息
 */
function computeLayout(points, options, width, height) {
  var opts = options || {};
  var padTop = opts.padTop === undefined ? 18 : opts.padTop;
  var padBottom = opts.padBottom === undefined ? 14 : opts.padBottom;
  var padLeft = opts.padLeft === undefined ? (opts.showYAxis ? 44 : 4) : opts.padLeft;
  var padRight = opts.padRight === undefined ? 8 : opts.padRight;
  var w = width || 0;
  var h = height || 0;
  var plotW = Math.max(1, w - padLeft - padRight);
  var plotH = Math.max(1, h - padTop - padBottom);

  var values = (points || []).map(function (p) { return Number(p.value); });
  var min = opts.min !== undefined ? opts.min : Math.min.apply(null, values);
  var max = opts.max !== undefined ? opts.max : Math.max.apply(null, values);
  if (!isFinite(min) || !isFinite(max)) {
    min = 0;
    max = 0;
  }
  if (max - min < 1e-6) {
    min -= 0.05;
    max += 0.05;
  } else if (opts.min === undefined && opts.max === undefined) {
    var pad = (max - min) * 0.14;
    min -= pad;
    max += pad;
  }

  var xs = computeXs(points || [], padLeft, plotW);
  function yOf(v) {
    return padTop + plotH * (1 - (v - min) / (max - min));
  }

  return {
    width: w,
    height: h,
    padTop: padTop,
    padBottom: padBottom,
    padLeft: padLeft,
    padRight: padRight,
    plotW: plotW,
    plotH: plotH,
    min: min,
    max: max,
    values: values,
    xs: xs,
    yOf: yOf
  };
}

function drawSeries(ctx, size, options) {
  var opts = options || {};
  var points = opts.points || [];
  var width = size.width;
  var height = size.height;

  ctx.clearRect(0, 0, width, height);
  if (!points.length) return;

  var layout = computeLayout(points, opts, width, height);
  var padTop = layout.padTop;
  var padBottom = layout.padBottom;
  var padLeft = layout.padLeft;
  var padRight = layout.padRight;
  var plotW = layout.plotW;
  var plotH = layout.plotH;
  var values = layout.values;
  var min = layout.min;
  var max = layout.max;
  var xs = layout.xs;
  var yOf = layout.yOf;

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

  // 十字光标最后画：压在曲线上面
  if (opts.crosshair) {
    drawCrosshair(ctx, layout, opts.crosshair);
  }
}

/** 圆角矩形路径 */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * 画十字光标：竖线对日期，横线对价格，中间标出选中的点，
 * 旁边挂一个读数气泡（日期 + 价格）。
 *
 * ⚠️ 读数只能画在画布上：canvas 是独立原生渲染层，
 * WXML 浮层压不住它 —— 气泡画在 DOM 里会被画布盖住。
 *
 * @param {object} ctx Canvas 2D 上下文
 * @param {object} layout computeLayout 的结果
 * @param {object} cross { x, y, valueText, dateText }
 */
function drawCrosshair(ctx, layout, cross) {
  var x = cross.x;
  var y = cross.y;
  var plotBottom = layout.padTop + layout.plotH;
  var plotLeft = layout.padLeft;
  var plotRight = layout.padLeft + layout.plotW;

  ctx.save();
  // 竖线（日期）
  ctx.strokeStyle = COLORS.crosshair;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, layout.padTop);
  ctx.lineTo(Math.round(x) + 0.5, plotBottom);
  ctx.stroke();
  // 横线（价格）
  ctx.beginPath();
  ctx.moveTo(plotLeft, Math.round(y) + 0.5);
  ctx.lineTo(plotRight, Math.round(y) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);

  // 选中的点
  ctx.beginPath();
  ctx.arc(x, y, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = cross.dotColor || COLORS.point;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#fffef9';
  ctx.stroke();

  var lines = [];
  if (cross.valueText) lines.push(cross.valueText);
  if (cross.dateText) lines.push(cross.dateText);
  if (!lines.length) {
    ctx.restore();
    return;
  }

  // 气泡尺寸按文字量出来，别写死 —— 写死就会长短不一
  ctx.font = '600 12px sans-serif';
  var w1 = ctx.measureText(lines[0]).width;
  ctx.font = '10px sans-serif';
  var w2 = lines[1] ? ctx.measureText(lines[1]).width : 0;
  var tw = Math.min(layout.width - 4, Math.max(w1, w2) + 16);
  var th = lines.length > 1 ? 34 : 22;
  var gap = 12;

  var tx = x + gap;
  if (tx + tw > layout.width - 2) tx = x - gap - tw;
  if (tx < 2) tx = 2;
  var ty = y - th - gap;
  if (ty < 2) ty = y + gap;
  if (ty + th > layout.height - 2) ty = layout.height - th - 2;

  roundRect(ctx, tx, ty, tw, th, 6);
  ctx.fillStyle = COLORS.tipBg;
  ctx.fill();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.tipText;
  ctx.font = '600 12px sans-serif';
  ctx.fillText(lines[0], tx + 8, ty + (lines.length > 1 ? 12 : th / 2));
  if (lines.length > 1) {
    ctx.fillStyle = COLORS.tipSub;
    ctx.font = '10px sans-serif';
    ctx.fillText(lines[1], tx + 8, ty + 25);
  }
  ctx.restore();
}

/**
 * 手指横坐标 → 最近的点的下标。
 *
 * 单独抽出来是为了能单独测：选点算错的话，
 * 表现是「点哪儿高亮的不是哪儿」，静态检查看不出来。
 *
 * @param {Array} xs 每个点的横坐标
 * @param {number} x 手指横坐标（相对画布）
 * @returns {number} 下标；没有点时返回 -1
 */
function nearestIndex(xs, x) {
  if (!xs || !xs.length) return -1;
  var value = Number(x);
  if (!isFinite(value)) return -1;
  var best = 0;
  var bestDist = Infinity;
  for (var i = 0; i < xs.length; i++) {
    var d = Math.abs(xs[i] - value);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
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
  computeLayout: computeLayout,
  nearestIndex: nearestIndex,
  drawSeries: drawSeries,
  drawCrosshair: drawCrosshair,
  directionColors: directionColors
};
