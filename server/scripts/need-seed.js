/**
 * 检查数据库是否需要灌演示数据
 *
 * 用途：表建好了但没数据时，接口能通、页面却是空的。
 * 只在当前价表为空时灌，不覆盖采集器写进来的真实数据。
 *
 * 用法：node scripts/need-seed.js   → 打印 yes / no
 */
const db = require('../src/db');

db.query('SELECT COUNT(*) AS n FROM oil_prices')
  .then(function (rows) {
    var n = rows && rows[0] ? Number(rows[0].n) : 0;
    console.log(n === 0 ? 'yes' : 'no');
    process.exit(0);
  })
  .catch(function () {
    // 查不了就当「有数据」，不灌 —— 宁可不灌，也别误覆盖
    console.log('no');
    process.exit(0);
  });
