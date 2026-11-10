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
