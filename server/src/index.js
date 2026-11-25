/**
 * 服务入口
 *
 * 启动 HTTP 服务 + 注册定时任务（采集、提醒匹配）。
 * 定时任务用进程内调度：不用管部署环境的 crontab，日志也在同一个进程里。
 */
const config = require('./config');
const { createApp } = require('./app');
const scheduler = require('./scheduler');
const db = require('./db');

function start() {
  // ⚠️ 启动前必须体检配置。
  // 以前这里什么都不查：空密钥的服务照常启动、照常签发 token，
  // 等于把「随便伪造任意用户身份」的能力开放出去。
  var check = config.validate();
  check.warnings.forEach(function (w) {
    console.warn('[server] ⚠ ' + w);
  });
  if (check.errors.length) {
    console.error('[server] 配置不完整，拒绝启动：');
    check.errors.forEach(function (e) {
      console.error('[server]   - ' + e);
    });
    process.exit(1);
    return;
  }

  var app = createApp();
  var server = app.listen(config.port, function () {
    console.log('[server] 已启动，监听 ' + config.port);
    console.log('[server] 采集任务：' + config.collectCron);
    console.log('[server] 提醒任务：' + config.alertCron);
  });

  scheduler.start();

  // 优雅退出：停调度并等在途任务 → 关 HTTP → 关数据库池。
  // 重复信号只返回同一个 Promise，避免重复 close / process.exit。
  var shutdownPromise = null;
  function shutdown(signal) {
    if (shutdownPromise) return shutdownPromise;
    console.log('[server] 收到 ' + signal + '，开始退出');
    var forceTimer = setTimeout(function () { process.exit(0); }, 10000);
    forceTimer.unref();

    shutdownPromise = Promise.resolve()
      .then(function () { return scheduler.stop(); })
      .then(function () {
        return new Promise(function (resolve, reject) {
          server.close(function (err) {
            if (err) reject(err);
            else resolve();
          });
        });
      })
      .then(function () { return db.close(); })
      .then(function () {
        clearTimeout(forceTimer);
        console.log('[server] 已退出');
        process.exit(0);
      })
      .catch(function (err) {
        clearTimeout(forceTimer);
        console.error('[server] 退出时清理失败：', err);
        process.exit(1);
      });
    return shutdownPromise;
  }

  process.on('SIGTERM', function () { shutdown('SIGTERM'); });
  process.on('SIGINT', function () { shutdown('SIGINT'); });

  return server;
}

if (require.main === module) {
  start();
}

module.exports = { start: start };
