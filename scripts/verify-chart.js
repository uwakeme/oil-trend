/**
 * 走势图自检：node scripts/verify-chart.js
 *
 * 验三件事：
 *   1. 绘图几何（横坐标、取值范围）
 *   2. 「手指横坐标 → 最近的点」的选点算法
 *   3. 组件的触摸链路（用假的 Canvas 上下文真跑一遍 onTouchStart）
 *
 * 为什么要有这个：十字光标「点哪儿高亮哪儿」全靠坐标算。
 * 静态检查（WXML 绑定、模块加载）看不出算错了，
 * 用户只有在图上乱点才发现「高亮的不是那个点」—— 那时候已经上线了。
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const chart = require(path.join(ROOT, 'utils', 'chart.js'));

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log('  OK   ' + name);
  } else {
    console.log('  FAIL ' + name + (detail ? (' —— ' + detail) : ''));
    failures++;
  }
}

/* ---------- 造一段确定的序列 ---------- */
const POINTS = [];
for (let i = 0; i < 30; i++) {
  const d = new Date(Date.UTC(2025, 10, 1 + i * 15));
  POINTS.push({
    date: d.toISOString().slice(0, 10),
    value: Math.round((7 + Math.sin(i / 3) * 0.6 + i * 0.03) * 100) / 100
  });
}
const WIDTH = 331;
const HEIGHT = 176;
const OPTIONS = { points: POINTS, mode: 'step', gridLines: 4, showYAxis: true, endDot: true };

console.log('\n--- 绘图几何 ---');
const layout = chart.computeLayout(POINTS, OPTIONS, WIDTH, HEIGHT);
let mono = true;
let inside = true;
for (let i = 0; i < layout.xs.length; i++) {
  if (i > 0 && layout.xs[i] <= layout.xs[i - 1]) mono = false;
  if (layout.xs[i] < layout.padLeft - 0.01 || layout.xs[i] > layout.padLeft + layout.plotW + 0.01) inside = false;
}
check('横坐标单调递增', mono);
check('横坐标都落在绘图区内', inside, 'left=' + layout.padLeft + ' plotW=' + layout.plotW);
check('首点贴着左边、末点贴着右边',
  Math.abs(layout.xs[0] - layout.padLeft) < 0.01 &&
  Math.abs(layout.xs[layout.xs.length - 1] - (layout.padLeft + layout.plotW)) < 0.01);
const vals = POINTS.map(function (p) { return p.value; });
const vmin = Math.min.apply(null, vals);
const vmax = Math.max.apply(null, vals);
check('取值范围把上下留了余量', layout.min < vmin && layout.max > vmax,
  '范围 ' + layout.min.toFixed(2) + '~' + layout.max.toFixed(2) + ' 数据 ' + vmin + '~' + vmax);

console.log('\n--- 选点：手指横坐标 → 最近的点 ---');
let miss = 0;
for (let i = 0; i < layout.xs.length; i++) {
  if (chart.nearestIndex(layout.xs, layout.xs[i]) !== i) miss++;
}
check('按在点上就选中该点', miss === 0, '错 ' + miss + ' 个');
let midMiss = 0;
for (let i = 0; i < layout.xs.length - 1; i++) {
  const xm = (layout.xs[i] + layout.xs[i + 1]) / 2;
  const idx = chart.nearestIndex(layout.xs, xm);
  if (idx !== i && idx !== i + 1) midMiss++;
}
check('两点中间取到相邻的一个', midMiss === 0, '错 ' + midMiss + ' 个');
check('越界取到两端',
  chart.nearestIndex(layout.xs, -100) === 0 &&
  chart.nearestIndex(layout.xs, 99999) === layout.xs.length - 1);
check('没有点时给 -1', chart.nearestIndex([], 100) === -1);

console.log('\n--- 组件触摸链路（假的 Canvas 上下文） ---');
// 组件里的 Component() 与 wx.getWindowInfo 在 node 里没有，先补上
let componentDef = null;
global.Component = function (def) { componentDef = def; };
global.wx = { getWindowInfo: function () { return { pixelRatio: 2 }; } };
require(path.join(ROOT, 'components', 'trend-chart', 'index.js'));
delete global.Component;
// wx 要留到组件跑完：它在 render 时才读 wx.getWindowInfo
check('组件能被加载', !!componentDef);

function fakeCtx() {
  const state = {};
  return new Proxy(state, {
    get(target, prop) {
      if (prop === 'measureText') return function (t) { return { width: String(t).length * 6 }; };
      if (prop in target) return target[prop];
      return function () {};
    },
    set(target, prop, value) { target[prop] = value; return true; }
  });
}

const captured = [];
const origDraw = chart.drawSeries;
chart.drawSeries = function (ctx, size, options) { captured.push(options); };

const inst = Object.assign({}, componentDef.methods);
inst.data = {
  points: POINTS,
  mode: 'step',
  height: 176,
  showYAxis: true,
  direction: 'flat',
  lineColor: '',
  areaFrom: '',
  areaTo: '',
  dotColor: '',
  gridLines: 4,
  endDot: true,
  visible: true,
  interactive: true,
  unit: '元/升'
};
inst.createSelectorQuery = function () {
  return {
    select: function () {
      return {
        fields: function () {
          return {
            exec: function (cb) {
              cb([{
                node: {
                  width: 0,
                  height: 0,
                  getContext: function () { return fakeCtx(); },
                  requestAnimationFrame: function (fn) { fn(); return 1; },
                  cancelAnimationFrame: function () {}
                },
                width: WIDTH,
                height: HEIGHT,
                left: 0,
                top: 0
              }]);
            }
          };
        }
      };
    }
  };
};

inst.render();
check('首帧画出来了', captured.length === 1, '抓到 ' + captured.length + ' 帧');
check('没选中时没有十字光标', !captured[0].crosshair);

const x15 = inst._layout.xs[15];
inst.onTouchStart({ touches: [{ x: x15, y: 90 }] });
const after = captured[captured.length - 1];
check('点一下就选中了最近的那个点', inst._active === 15, '_active=' + inst._active);
check('十字光标画在选中点上',
  !!after.crosshair && Math.abs(after.crosshair.x - x15) < 0.01 &&
  Math.abs(after.crosshair.y - inst._layout.yOf(POINTS[15].value)) < 0.01,
  JSON.stringify(after.crosshair));
check('读数带着日期与价格',
  !!after.crosshair && after.crosshair.valueText.indexOf(POINTS[15].value.toFixed(2)) >= 0 &&
  !!after.crosshair.dateText, JSON.stringify(after.crosshair));

// 再点同一个点 = 收起读数
inst.onTouchStart({ touches: [{ x: x15, y: 90 }] });
check('再点同一个点收起读数', inst._active === null, '_active=' + inst._active);
check('收起后不再画十字光标', !captured[captured.length - 1].crosshair);

// 拖动 = 跟着手指走
inst.onTouchStart({ touches: [{ x: inst._layout.xs[3], y: 90 }] });
inst.onTouchMove({ touches: [{ x: inst._layout.xs[9], y: 90 }] });
check('拖动时跟着手指换点', inst._active === 9, '_active=' + inst._active);

// 关掉交互时不应该有反应
inst.data.interactive = false;
inst._active = null;
inst.onTouchStart({ touches: [{ x: x15, y: 90 }] });
check('interactive=false 时点了没反应', inst._active === null);

console.log('\n--- 读数日期文案 ---');
// 国际行情的点日期是 'YYYY-MM-DD HH:mm:ss'，油品历史是 'YYYY-MM-DD'。
// 两种都带 'YYYY-MM-DD' 开头，早先只按日期匹配，国际行情就只剩 '11/17'，
// 日内那 15 分钟一个点根本分不清是几点。
check('油品历史只显示月日',
  inst._dateText({ date: '2026-11-13' }) === '11/13',
  inst._dateText({ date: '2026-11-13' }));
check('国际行情显示到分钟',
  inst._dateText({ date: '2026-11-17 22:45:00' }) === '11-17 22:45',
  inst._dateText({ date: '2026-11-17 22:45:00' }));

chart.drawSeries = origDraw;
delete global.wx;

console.log('\n--- 汇总 ---');
if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
console.log('全部通过。');
