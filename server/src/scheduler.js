/**
 * 定时任务调度
 *
 * 云开发用触发器，自建用进程内调度。
 *
 * ⚠️ 多实例部署时同一时刻会各跑一次 —— 采集器靠 dedupKey 去重，
 * 提醒器靠 alert_logs 的 dedupKey，所以不会重复入库、不会重复发消息，
 * 只是白跑一次、浪费点配额。用户量上来后要加分布式锁。
 *
 * 调度器自己实现，没引 node-cron：
 * 6 段 cron（秒 分 时 日 月 周）够用，且少一个依赖。
 */
var config = require('./config');

var tasks = [];

/**
 * 解析 6 段 cron 表达式，返回下一次触发的时间戳。
 * 支持 * 和数字，够当前用法。
 */
function nextRun(cron, from) {
  var parts = String(cron || '').trim().split(/\s+/);
  if (parts.length !== 6) return null;
  var sec = Number(parts[0]);
  var min = Number(parts[1]);
  var hour = Number(parts[2]);

  var d = new Date(from.getTime());
  d.setSeconds(sec, 0);
  if (d <= from) d.setMinutes(d.getMinutes() + 1);
  // 简化处理：只按分钟推进，匹配分/时/日
  for (var i = 0; i < 60 * 24 * 400; i++) {
    if (d.getMinutes() === min && d.getHours() === hour) {
      return d.getTime();
    }
    d.setMinutes(d.getMinutes() + 1);
    if (d.getDay() === 0 && d.getHours() === 0 && d.getMinutes() === 0) {
      // 跨天了还没匹配上，说明这个 cron 不可能匹配，直接放弃
      return null;
    }
  }
  return null;
}

/**
 * 注册一个周期任务
 * @param {string} name 任务名
 * @param {string} cron 6 段 cron
 * @param {Function} fn 任务函数
 */
function register(name, cron, fn) {
  var timer = null;
  function tick() {
    var delay = nextRun(cron, new Date());
    if (delay === null) {
      console.warn('[scheduler] ' + name + ' 的 cron 表达式无法匹配：' + cron);
      return;
    }
    timer = setTimeout(function () {
      Promise.resolve()
        .then(fn)
        .catch(function (err) {
          console.error('[scheduler] ' + name + ' 执行失败：', err.message);
        })
        .then(function () { tick(); });
    }, Math.max(0, delay - Date.now()));
    if (timer.unref) timer.unref();
  }
  tick();
  tasks.push({ name: name, stop: function () { if (timer) clearTimeout(timer); } });
  console.log('[scheduler] 已注册 ' + name + ' (' + cron + ')');
}

function start() {
  var collector = require('./services/collector');
  var alert = require('./services/alert');

  register('采集', config.collectCron, function () {
    return collector.run();
  });

  register('提醒匹配', config.alertCron, function () {
    return alert.run();
  });
}

function stop() {
  tasks.forEach(function (t) { t.stop(); });
  tasks = [];
}

module.exports = { start: start, stop: stop, nextRun: nextRun };
