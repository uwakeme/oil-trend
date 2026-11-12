/**
 * 调度器 cron 解析自测
 *
 * 为什么要有这个测试：第一版 nextRun 只认纯数字，
 * 默认配置的「每 30 分钟」那种带步长的表达式返回 null，
 * 采集器和提醒器在线上一次都没跑过，而没有任何测试覆盖到。
 *
 * ⚠️ 断言必须与运行时区无关：cron 按服务器本地时区解释，
 * 开发机是 UTC+8、CI 是 UTC —— 直接断言 getHours() === 10 会在 CI 挂。
 * 所以这里只断言「语义」：落点满足 cron 约束、间隔不超过周期、严格在 from 之后。
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

const MIN = 60 * 1000;

/** 从某个时刻算下次触发，返回 Date（null 表示解析不出） */
function next(cron, from) {
  const ts = scheduler.nextRun(cron, new Date(from.getTime()));
  return ts === null ? null : new Date(ts);
}

/** 断言下次触发在 from 之后、且不超过 maxGapMs */
function assertGap(t, from, maxGapMs, label) {
  const gap = t.getTime() - from.getTime();
  assert(gap > 0, label + ' 应严格晚于 from，实际间隔 ' + gap + 'ms');
  assert(gap <= maxGapMs, label + ' 间隔超期：' + Math.round(gap / MIN) + ' 分钟');
}

/* ---------- 默认配置必须能跑 ---------- */

check('采集 cron 能解析出下次时间', () => {
  const from = new Date();
  const t = next(config.collectCron, from);
  assert(t, '返回 null（采集器会停摆）：' + config.collectCron);
  assertGap(t, from, 31 * MIN, '采集');
});

check('提醒 cron 能解析出下次时间', () => {
  const from = new Date();
  const t = next(config.alertCron, from);
  assert(t, '返回 null（提醒器会停摆）：' + config.alertCron);
  assertGap(t, from, 11 * MIN, '提醒');
});

/* ---------- 步长语义 ---------- */

check('每 30 分钟：落在 :00/:30，间隔不超过 30 分', () => {
  const from = new Date(Date.UTC(2026, 10, 12, 2, 5));
  const t = next('0 */30 * * * *', from);
  assert(t, '返回 null');
  assert(t.getMinutes() % 30 === 0 && t.getSeconds() === 0, '不在整/半点：' + t.toString());
  assertGap(t, from, 30 * MIN, '每30分');
});

check('每 30 分钟：刚好在边界上时顺延到下一个', () => {
  // 取一个 :00 整点作为 from，结果必须严格晚于它、且仍落在整半点
  const from = new Date(Date.UTC(2026, 10, 12, 3, 0, 0));
  const t = next('0 */30 * * * *', from);
  assert(t, '返回 null');
  assert(t.getMinutes() % 30 === 0, '不在整/半点');
  assertGap(t, from, 30 * MIN, '边界');
});

check('每 10 分钟：落在 10 的倍数，间隔不超过 10 分', () => {
  const from = new Date(Date.UTC(2026, 10, 12, 2, 31));
  const t = next('0 */10 * * * *', from);
  assert(t, '返回 null');
  assert(t.getMinutes() % 10 === 0, '不是 10 的倍数：' + t.toString());
  assertGap(t, from, 10 * MIN, '每10分');
});

check('每小时整点：分钟为 0，间隔不超过 60 分', () => {
  const from = new Date(Date.UTC(2026, 10, 12, 2, 31));
  const t = next('0 0 * * * *', from);
  assert(t, '返回 null');
  assert(t.getMinutes() === 0 && t.getSeconds() === 0, '不是整点：' + t.toString());
  assertGap(t, from, 60 * MIN, '每小时');
});

check('每天 3:00：本地 3 点，间隔不超过 24 小时', () => {
  const from = new Date(Date.UTC(2026, 10, 12, 2, 31));
  const t = next('0 0 3 * * *', from);
  assert(t, '返回 null');
  assert(t.getHours() === 3 && t.getMinutes() === 0, '不在本地 3:00：' + t.toString());
  assertGap(t, from, 24 * 60 * MIN, '每天3点');
});

check('逗号列表：分钟只能是 5 或 35', () => {
  const from = new Date(Date.UTC(2026, 10, 12, 2, 10));
  const t = next('0 5,35 * * * *', from);
  assert(t, '返回 null');
  assert([5, 35].indexOf(t.getMinutes()) >= 0, '分钟不在列表里：' + t.toString());
  assertGap(t, from, 25 * MIN, '列表');
});

check('区间 9-18 点：落点小时在 9..18', () => {
  const from = new Date(Date.UTC(2026, 10, 12, 2, 0));
  const t = next('0 * 9-18 * * *', from);
  assert(t, '返回 null');
  assert(t.getHours() >= 9 && t.getHours() <= 18, '小时越界：' + t.toString());
  assertGap(t, from, 24 * 60 * MIN, '区间');
});

check('区间步长 8-18/5：小时只能是 8 / 13 / 18', () => {
  const from = new Date(Date.UTC(2026, 10, 12, 0, 0));
  const t = next('0 0 8-18/5 * * *', from);
  assert(t, '返回 null');
  assert([8, 13, 18].indexOf(t.getHours()) >= 0, '小时不在步长集合：' + t.toString());
  assertGap(t, from, 24 * 60 * MIN, '区间步长');
});

check('周字段：7 与 0 都表示周日', () => {
  const from = new Date(Date.UTC(2026, 10, 12, 10, 0));
  const a = next('0 0 3 * * 0', from);
  const b = next('0 0 3 * * 7', from);
  assert(a && b, '返回 null');
  assert(a.getDay() === 0, 'cron 0 没落到周日：' + a.toString());
  assert(a.getTime() === b.getTime(), '0 与 7 应等价');
  assertGap(a, from, 7 * 24 * 60 * MIN, '周日');
});

check('秒字段：指定 30 秒时落点秒数为 30', () => {
  const from = new Date(Date.UTC(2026, 10, 12, 2, 0, 10));
  const t = next('30 * * * * *', from);
  assert(t, '返回 null');
  assert(t.getSeconds() === 30, '秒数不是 30：' + t.toString());
  assertGap(t, from, 60 * 1000, '秒字段');
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
