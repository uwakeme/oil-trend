/**
 * 灌演示数据到数据库
 *
 * 用来打通服务端链路：表建好了但没数据时，接口能通但页面是空的。
 * 只写 source = 'seed' 的数据，不会碰采集器写进来的真实数据。
 *
 * 用法：node scripts/seed.js
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
