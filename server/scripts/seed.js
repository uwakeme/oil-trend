/**
 * 灌演示数据到数据库
 *
 * 只在需要临时演示时手动跑：
 *   node scripts/seed.js
 *
 * ⚠️ 正式环境不应该有演示数据。
 * 部署流水线默认不灌（要灌得显式设 SEED_DEMO=true），
 * 免得每次部署都把演示数据重新灌回去，清理完白清。
 *
 * 只写 source = 'seed' 的数据，不会碰采集器写进来的真实数据。
 */
require('../src/services/collector').seed()
  .then(function (r) {
    console.log('[seed] 完成：' + JSON.stringify(r));
    process.exit(0);
  })
  .catch(function (err) {
    console.error('[seed] 失败：', (err && err.message) || err);
    process.exit(1);
  });
