/**
 * 调度器 cron 解析自测
 *
 * 为什么要有这个测试：第一版 nextRun 只认纯数字，
 * 默认配置的「每 30 分钟」那种带步长的表达式返回 null，
 * 采集器和提醒器在线上一次都没跑过，而没有任何测试覆盖到。
 *
 * 用法：node scripts/scheduler-test.js
 */
const path = require('path');
const scheduler = require(path.join(__dirname, '..', 'src', 'scheduler'));
const config = require(path.join(__dirname, '..', 'src', 'config'));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('✓ ' + name);
  } catch (e) {
    failures++;
    console.error('✗ ' + name + '：' + e.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

/** 从某个时刻算出下次触发，返回 Date */
function next(cron, fromIso) {
  const ts = scheduler.nextRun(cron, new Date(fromIso));
  return ts === null ? null : new Date(ts);
}

/* ---------- 默认配置必须能跑 ---------- */

check('采集 cron 能解析出下次时间', () => {
  const t = next(config.collectCron, '2026-11-12T10:05:00+08:00');
  assert(t, '返回 null（采集器会停摆）：' + config.collectCron);
  assert(t > new Date('2026-11-12T10:05:00+08:00'), '下次时间必须在未来');
});

check('提醒 cron 能解析出下次时间', () => {
  const t = next(config.alertCron, '2026-11-12T10:05:00+08:00');
  assert(t, '返回 null（提醒器会停摆）：' + config.alertCron);
});

/* ---------- 步长语义 ---------- */

check('每 30 分钟：10:05 → 10:30', () => {
  const t = next('0 */30 * * * *', '2026-11-12T10:05:00+08:00');
  assert(t && t.getMinutes() === 30 && t.getHours() === 10, '实际 ' + (t && t.toISOString()));
});

check('每 30 分钟：10:30 → 11:00（跨小时）', () => {
  const t = next('0 */30 * * * *', '2026-11-12T10:30:00+08:00');
  assert(t && t.getMinutes() === 0 && t.getHours() === 11, '实际 ' + (t && t.toISOString()));
});

check('每 30 分钟：10:31 → 11:00（当前分钟已过秒数也算下一次）', () => {
  const t = next('0 */30 * * * *', '2026-11-12T10:31:00+08:00');
  assert(t && t.getMinutes() === 0 && t.getHours() === 11, '实际 ' + (t && t.toISOString()));
});

check('每 10 分钟：10:31 → 10:40', () => {
  const t = next('0 */10 * * * *', '2026-11-12T10:31:00+08:00');
  assert(t && t.getMinutes() === 40, '实际 ' + (t && t.toISOString()));
});

check('每小时整点：10:31 → 11:00', () => {
  const t = next('0 0 * * * *', '2026-11-12T10:31:00+08:00');
  assert(t && t.getMinutes() === 0 && t.getHours() === 11, '实际 ' + (t && t.toISOString()));
});

check('每天 3:00：当天已过则顺延到明天', () => {
  const t = next('0 0 3 * * *', '2026-11-12T10:31:00+08:00');
  assert(t && t.getHours() === 3 && t.getDate() === 13, '实际 ' + (t && t.toISOString()));
});

check('逗号列表 5,35 分', () => {
  const t = next('0 5,35 * * * *', '2026-11-12T10:10:00+08:00');
  assert(t && t.getMinutes() === 35, '实际 ' + (t && t.toISOString()));
});

check('区间 办公时段 9-18 点每分钟', () => {
  const t = next('0 * 9-18 * * *', '2026-11-12T20:00:00+08:00');
  assert(t && t.getHours() === 9 && t.getDate() === 13, '实际 ' + (t && t.toISOString()));
});

check('区间步长 8-18/5 点', () => {
  const t = next('0 0 8-18/5 * * *', '2026-11-12T09:00:00+08:00');
  assert(t && t.getHours() === 13, '实际 ' + (t && t.toISOString()));
});

check('周字段：7 与 0 都表示周日', () => {
  // 2026-11-12 是周四，下一个周日是 11-15
  const a = next('0 0 3 * * 0', '2026-11-12T10:00:00+08:00');
  const b = next('0 0 3 * * 7', '2026-11-12T10:00:00+08:00');
  assert(a && a.getDay() === 0, 'cron 0 没落到周日：' + (a && a.toISOString()));
  assert(b && b.getTime() === a.getTime(), '0 与 7 应等价');
});

check('秒字段：指定 30 秒', () => {
  const t = next('30 * * * * *', '2026-11-12T10:00:10+08:00');
  assert(t && t.getSeconds() === 30, '实际 ' + (t && t.toISOString()));
});

/* ---------- 非法表达式必须返回 null（不能静默跑错） ---------- */

check('非法表达式返回 null', () => {
  ['', '* * * * *', '0 0 0 0 0 0 0', 'abc * * * * *', '0 60 * * * *',
   '0 * 24 * * *', '0 0 0 32 * *', '0 */0 * * * *', '0 5-1 * * * *']
    .forEach(c => {
      assert(scheduler.nextRun(c, new Date()) === null, '应返回 null：' + JSON.stringify(c));
    });
});

console.log('');
if (failures) {
  console.error(failures + ' 个用例失败');
  process.exit(1);
}
console.log('调度器 cron 解析全部通过');
