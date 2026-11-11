/* 数据层自检脚本：node scripts/verify-data.js */
const demo = require('../data/demo');
const { ADJUSTMENTS } = require('../data/adjustments');

const out = [];
out.push('调价事件总数: ' + ADJUSTMENTS.length);
out.push('今天(演示): ' + require('../utils/demo-clock').today());

const home = demo.getHome('440000', '92');
out.push('--- 广东·广州 当前价 ---');
home.prices.forEach(p => out.push('  ' + p.name + ' = ' + p.price + '  (' + p.changeAmount + ', ' + p.changeAt + ')'));
out.push('窗口: ' + home.window.date + '  剩 ' + home.window.daysLeft + ' 天  预测 ' + home.window.forecast['92']);
out.push('30天走势点数: ' + home.trend30['92'].points.length + ' 首末: ' + home.trend30['92'].points[0].value + ' -> ' + home.trend30['92'].points[29].value);
out.push('最新通知: ' + home.latestNotice.title + '  92# ' + home.latestNotice.changes['92']);

out.push('--- 走势 ---');
['3m','6m','1y'].forEach(p => {
  const t = demo.getTrend('440000', '92', p);
  out.push('  ' + p + ': 价 ' + t.price + ' 涨跌 ' + t.deltaPercent + '%  低 ' + t.low + ' 高 ' + t.high + ' 次数 ' + t.count + ' 点数 ' + t.points.length);
  out.push('      轴: ' + t.axis.join(' / '));
  out.push('      值: ' + t.points.map(x => x.value).join(','));
});

out.push('--- 通知 ---');
const notices = demo.getNotices('440000', 'all', '92');
out.push('  条数: ' + notices.notices.length + '  同步: ' + notices.sync.status + ' @ ' + notices.sync.lastCheckedAt);
notices.notices.forEach(n => out.push('  [' + n.kind + '] ' + n.title + '  92#=' + n.changes['92'] + '  执行 ' + n.executeAt));

out.push('--- 国际行情 ---');
['brent','wti'].forEach(s => {
  const m = demo.getMarket(s, '1d');
  out.push('  ' + m.name + ' ' + m.price + ' ' + m.changeAmount + ' (' + m.changePercent + '%) 时间 ' + m.quoteTime + ' 延时 ' + m.delayMinutes + '分 点数 ' + m.points.length);
  out.push('      曲线: ' + m.points.map(p => p.value).join(','));
});

out.push('--- 其他地区 92# ---');
demo.getRegions().forEach(r => out.push('  ' + r.fullName + ' ' + r.price92));

console.log(out.join('\n'));

/* ============================================================
 * 未来日期退化检查
 *
 * 演示数据的日期会按「今天 - 锚点日」整体平移。如果平移只做了一半
 * （比如调价节点没跟着平移），过几周就会出现「调价次数 0」「窗口进度
 * 恒为 0 后跳 100%」「首页标签多平移一次」这类退化。
 *
 * 这里伪造系统时间跑几个未来时点，断言演示数据不会随时间失真。
 * ============================================================ */

/** 伪造「今天」，跑完恢复 */
function withFakeToday(offsetDays, fn) {
  var RealDate = Date;
  var base = new RealDate();
  var shifted = new RealDate(base.getTime() + offsetDays * 86400000);

  function FakeDate() {
    var args = Array.prototype.slice.call(arguments);
    if (args.length === 0) return new RealDate(shifted.getTime());
    return new (Function.prototype.bind.apply(RealDate, [null].concat(args)))();
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = function () { return shifted.getTime(); };
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  global.Date = FakeDate;

  try {
    return fn();
  } finally {
    global.Date = RealDate;
  }
}

/** 重新加载演示数据源（levels 有缓存，换时间必须重载） */
function freshDemo() {
  var p = require.resolve('../data/demo.js');
  delete require.cache[p];
  return require(p);
}

var futureChecks = [];
var offsets = [0, 30, 60, 120, 240];

offsets.forEach(function (offset) {
  withFakeToday(offset, function () {
    var demo = freshDemo();
    var home = demo.getHome('440000', '92');
    var trend = demo.getTrend('440000', '92', '3m');
    var today = require('../utils/demo-clock').today();
    var window = home.window;

    var points30 = home.trend30['92'].points;
    var lastPrice = points30.length ? points30[points30.length - 1].value : null;
    var current = demo.currentPrice('440000', '92');

    // 1) 30 天走势必须每天都有点，末点等于当前价
    var okPoints = points30.length === 30 && Math.abs(lastPrice - current) < 0.0001;
    // 2) 调价窗口永远是 14 天后（跟着今天一起平移）
    var okWindow = window.daysLeft === 14;
    // 3) 窗口进度在 0~100 之间且不为 0（周期已经开始）
    var okProgress = window.progress > 0 && window.progress <= 100;
    // 4) 首页第一个标签正好是 29 天前（没有二次平移）
    var okLabel = home.trend30['92'].labels[0] === labelOf(29);
    // 5) 3 个月区间必须有调价节点，且末点等于当前价
    var okTrend = trend.count >= 1 && Math.abs(trend.price - current) < 0.0001;

    futureChecks.push({
      offset: offset,
      today: today,
      window: window.date + ' 剩' + window.daysLeft + '天 进度' + window.progress + '%',
      points: points30.length,
      events3m: trend.count,
      label0: home.trend30['92'].labels[0],
      ok: okPoints && okWindow && okProgress && okLabel && okTrend
    });

    function labelOf(daysAgo) {
      var clock = require('../utils/demo-clock');
      return clock.daysAgo(daysAgo).slice(5).replace('-', '月') + '日';
    }
  });
});

out.push('');
out.push('--- 未来日期退化检查 ---');
futureChecks.forEach(function (c) {
  out.push('  +' + c.offset + '天  today=' + c.today +
    '  窗口=' + c.window +
    '  30天点数=' + c.points +
    '  3m调价=' + c.events3m +
    '  标签0=' + c.label0 +
    '  ' + (c.ok ? 'OK' : '✗ 退化'));
});

var degraded = futureChecks.filter(function (c) { return !c.ok; });
if (degraded.length) {
  out.push('');
  out.push('✗ 有 ' + degraded.length + ' 个未来时点出现退化');
  console.error(out.join('\n'));
  process.exit(1);
}
console.log(out.join('\n'));
