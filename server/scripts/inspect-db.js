/**
 * 盘点数据库里的数据构成（只读，不改任何东西）
 *
 * 用来在清理前看清楚每张表里有什么、哪些是演示数据、哪些是真实数据。
 * 删之前不看清，删完才发现删错了就来不及了。
 *
 * 用法：node scripts/inspect-db.js
 */
const db = require('../src/db');

var TABLES = [
  { name: 'oil_prices', label: '当前价' },
  { name: 'oil_price_history', label: '历史价' },
  { name: 'oil_adjust_events', label: '调价节点' },
  { name: 'oil_notices', label: '调价通知' },
  { name: 'oil_windows', label: '调价窗口' },
  { name: 'oil_markets', label: '国际行情' },
  { name: 'alert_rules', label: '提醒规则' },
  { name: 'alert_logs', label: '提醒记录' },
  { name: 'oil_users', label: '用户' },
  { name: 'collector_runs', label: '采集运行记录' }
];

function countBy(table, column) {
  return db.query(
    'SELECT COALESCE(' + column + ", '(空)') AS k, COUNT(*) AS n FROM " + table +
    ' GROUP BY ' + column + ' ORDER BY n DESC'
  ).then(function (rows) {
    return rows.map(function (r) { return { k: String(r.k), n: Number(r.n) }; });
  });
}

function main() {
  var out = [];
  return TABLES.reduce(function (chain, t) {
    return chain.then(function () {
      return db.query('SELECT COUNT(*) AS n FROM ' + t.name)
        .then(function (rows) {
          var total = rows && rows[0] ? Number(rows[0].n) : 0;
          out.push({ table: t.name, label: t.label, total: total });
          return total > 0 ? null : null;
        });
    });
  }, Promise.resolve()).then(function () {
    return out.reduce(function (chain, item) {
      return chain.then(function () {
        var column = {
          oil_prices: 'source',
          oil_price_history: 'source',
          oil_adjust_events: 'source',
          oil_notices: 'review_status',
          oil_windows: 'source',
          oil_markets: 'source'
        }[item.table];
        if (!column || item.total === 0) return null;
        return countBy(item.table, column).then(function (groups) {
          item.groups = groups;
        });
      });
    }, Promise.resolve());
  }).then(function () {
    console.log('\n=== 数据库数据构成 ===');
    out.forEach(function (item) {
      console.log('\n' + item.label + ' (' + item.table + '): ' + item.total + ' 行');
      if (item.groups && item.groups.length) {
        item.groups.forEach(function (g) {
          console.log('    ' + g.k + ' → ' + g.n + ' 行');
        });
      }
    });
    console.log('');
  });
}

main().catch(function (err) {
  console.error('盘点失败：', err && err.message ? err.message : err);
  process.exit(1);
});
