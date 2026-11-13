/**
 * 定时任务调度
 *
 * 云开发用触发器，自建用进程内调度。
 *
 * ⚠️ 多实例部署时同一时刻会各跑一次 —— 采集器靠 dedupKey 去重，
 * 提醒器靠 alert_logs 的 dedupKey，所以不会重复入库、不会重复发消息，
 * 只是白跑一次、浪费点配额。用户量上来后要加分布式锁。
 *
 * 调度器自己实现，没引 node-cron：6 段 cron（秒 分 时 日 月 周）够用。
 *
 * ⚠️ 第一版只认纯数字，带星号步长的表达式（每 30 分钟那种）会解析成 NaN、
 * 永远匹配不上 —— 结果采集器在线上一次都没被触发过（collector_runs 一直是空表）。
 * 现在支持：星号、数字、星号步长、区间 a-b、区间步长 a-b/N、逗号列表。
 *
 * ⚠️ cron 按**服务器本地时区**解释（用 Date 的本地取值比较）。
 * 默认配置是「每 30 / 每 10 分钟」，与时区无关；但如果写「每天 3 点」，
 * 指的是服务器本地 3 点 —— 服务器在 UTC 时就是东八区 11 点。
 */
var config = require('./config');

var tasks = [];

var FIELD_RANGES = [
  { min: 0, max: 59 },  // 秒
  { min: 0, max: 59 },  // 分
  { min: 0, max: 23 },  // 时
  { min: 1, max: 31 },  // 日
  { min: 1, max: 12 },  // 月
  { min: 0, max: 7 }    // 周（7 与 0 都是周日）
];

/**
 * 展开一段 cron 字段成允许值集合。
 * @returns {object|null} 形如 { 0: true, 30: true }；非法表达式返回 null
 */
function parseField(expr, min, max) {
  var text = String(expr === undefined || expr === null ? '' : expr).trim();
  if (!text) return null;

  var allowed = {};
  var parts = text.split(',');
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    if (!part) return null;

    var step = 1;
    var hasStep = false;
    var range = part;
    var slash = part.indexOf('/');
    if (slash >= 0) {
      range = part.slice(0, slash).trim();
      hasStep = true;
      step = Number(part.slice(slash + 1));
      if (!isFinite(step) || step < 1 || Math.floor(step) !== step) return null;
    }

    var lo;
    var hi;
    if (range === '*') {
      lo = min;
      hi = max;
    } else {
      var m = range.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) return null;
      lo = Number(m[1]);
      if (m[2] !== undefined) {
        hi = Number(m[2]);
      } else {
        // 单值带步长（如 5/10）按「从该值到上界」处理，与常见 cron 实现一致
        hi = hasStep ? max : lo;
      }
    }
    if (lo < min || hi > max || lo > hi) return null;

    for (var v = lo; v <= hi; v += step) allowed[v] = true;
  }
  return Object.keys(allowed).length ? allowed : null;
}

/**
 * 解析 6 段 cron，返回下一次触发的时间戳；表达式非法或一年内无匹配返回 null。
 *
 * 日与周同时受限时按「且」处理（标准 cron 是「或」）——
 * 本项目没有这种写法，简化不影响使用。
 */
function nextRun(cron, from) {
  var parts = String(cron === undefined || cron === null ? '' : cron).trim().split(/\s+/);
  if (parts.length !== 6) return null;

  var fields = [];
  for (var i = 0; i < 6; i++) {
    var f = parseField(parts[i], FIELD_RANGES[i].min, FIELD_RANGES[i].max);
    if (!f) return null;
    fields.push(f);
  }

  var secs = fields[0];
  var mins = fields[1];
  var hours = fields[2];
  var doms = fields[3];
  var mons = fields[4];
  var dows = fields[5];
  // 7 也表示周日，统一成 0，否则 getDay() 永远匹配不到 7
  if (dows[7]) dows[0] = true;

  var secList = Object.keys(secs).map(Number).sort(function (a, b) { return a - b; });

  // 从「当前这一分钟」开始往后找，最多看 366 天
  var d = new Date(from.getTime());
  d.setSeconds(0, 0);
  var limit = 366 * 24 * 60;
  for (var n = 0; n < limit; n++) {
    if (mons[d.getMonth() + 1] && doms[d.getDate()] && dows[d.getDay()] &&
        hours[d.getHours()] && mins[d.getMinutes()]) {
      for (var k = 0; k < secList.length; k++) {
        var t = new Date(d.getTime());
        t.setSeconds(secList[k], 0);
        if (t.getTime() > from.getTime()) return t.getTime();
      }
    }
    d.setMinutes(d.getMinutes() + 1);
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
  var scheduled = false;

  // setTimeout 的延时上限是 2^31-1 ms（约 24.8 天）。
  // 月/年级的 cron 一次要等那么久，超了就溢出成 1ms —— 任务立刻触发、
  // 接着又立刻排下一次，进程变成忙循环。
  var MAX_TIMEOUT = 2147483647;

  function schedule(waitMs) {
    timer = setTimeout(function () {
      var remain = delayTarget - Date.now();
      if (remain > 0) {
        // 刚才只是等到了 setTimeout 上限，任务还没到点 —— 重新排一次，别执行
        schedule(Math.min(remain, MAX_TIMEOUT));
        return;
      }
      Promise.resolve()
        .then(fn)
        .catch(function (err) {
          console.error('[scheduler] ' + name + ' 执行失败：', err.message);
        })
        .then(function () { tick(); });
    }, Math.max(0, waitMs));
    if (timer.unref) timer.unref();
  }

  var delayTarget = 0;

  function tick() {
    var delay = nextRun(cron, new Date());
    if (delay === null) {
      // 注册失败要说清楚「已停用」，不能既报错又打「已注册」误导排查
      console.warn('[scheduler] ' + name + ' 的 cron 无法匹配，该任务已停用：' + cron);
      return;
    }
    delayTarget = delay;
    schedule(Math.min(Math.max(0, delay - Date.now()), MAX_TIMEOUT));
    if (!scheduled) {
      scheduled = true;
      console.log('[scheduler] 已注册 ' + name + ' (' + cron + ')，下次 ' +
        new Date(delay).toISOString());
    }
  }

  tick();
  tasks.push({ name: name, stop: function () { if (timer) clearTimeout(timer); } });
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

module.exports = { start: start, stop: stop, nextRun: nextRun, parseField: parseField };
