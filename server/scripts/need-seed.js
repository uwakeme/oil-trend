/**
 * 检查数据库是否需要灌演示数据
 *
 * 只在当前价表为空时返回 yes，不覆盖采集器写进来的真实数据。
 *
 * ⚠️ 部署流水线默认**不**调用它 —— 自动灌会导致每次部署都把
 * 演示数据灌回去，清理完下一次部署又白清。
 * 需要灌的时候显式设 SEED_DEMO=true。
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
