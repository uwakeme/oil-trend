/**
 * 调价通知复核看板（只读）
 *
 * review_status 是**机器判定**的可信度标记，不是人工审核结论：
 *   approved —— 逐项幅度明确且执行日期明确，已对外发布；
 *   pending  —— 解析存疑（只解析出总幅度 / 没抓到执行日期），没对外发布。
 *
 * ⚠️ 这个脚本只看不改。存疑的通知有两条出路：
 *   1. 解析器修好后重跑采集 —— 同一条去重键会被更可信的结果**自动覆盖**；
 *   2. 人工核对原文后另行补录。
 *   它不是审核入口：把猜出来的幅度点成 approved，
 *   正是「绝不把猜测值发布成正式结果」要防的事。
 *
 * 用法：
 *   node scripts/review-notices.js
 *   node scripts/review-notices.js --limit 50
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');

/** 从 .env 读 DATABASE_URL */
function readEnv() {
  var envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return {};
  var out = {};
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(function (line) {
    var m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) return;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
  return out;
}

function arg(name, fallback) {
  var i = process.argv.indexOf('--' + name);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return Number(process.argv[i + 1]) || fallback;
}

/** 把 changes 里的幅度排成一行人能读的文本 */
function deltasText(changes) {
  var keys = Object.keys(changes || {});
  if (!keys.length) return '（空）';
  return keys.map(function (k) {
    return k + '# ' + changes[k];
  }).join('、');
}

/** 判断这条卡在哪 */
function stuckReason(row) {
  var reasons = [];
  if (!row.execute_at) reasons.push('没解析出执行日期');
  if (!Object.keys(row.changes || {}).length) reasons.push('没解析出分油品幅度（只有总幅度或全是猜测）');
  if (!reasons.length) reasons.push('解析完整，但复核状态不是 approved');
  return reasons.join('；');
}

async function main() {
  var env = readEnv();
  var url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) {
    console.error('缺少 DATABASE_URL（环境变量或 server/.env 里都要有）');
    process.exit(1);
  }

  var limit = arg('limit', 20);
  var client = new Client({ connectionString: url });

  await client.connect();

  try {
    var counts = await client.query(
      'SELECT review_status, count(*)::int AS n FROM oil_notices GROUP BY review_status ORDER BY review_status'
    );
    console.log('\n--- 各状态条数 ---');
    if (!counts.rows.length) console.log('（通知表是空的 —— 还没有 notice 类来源在跑）');
    counts.rows.forEach(function (r) {
      console.log('  ' + r.review_status + ': ' + r.n);
    });

    var pending = await client.query(
      "SELECT id, title, execute_at, changes, summary, raw, published_at FROM oil_notices " +
      "WHERE review_status <> 'approved' ORDER BY id DESC LIMIT " + Math.max(1, Math.floor(limit))
    );

    console.log('\n--- 存疑通知（不对外发布）---');
    if (!pending.rows.length) {
      console.log('（没有存疑通知）');
    }
    pending.rows.forEach(function (row) {
      console.log('\n  #' + row.id + '  ' + (row.title || '(无标题)'));
      console.log('    采集时间：' + (row.published_at || '-'));
      console.log('    执行日期：' + (row.execute_at || '（没解析出来）'));
      console.log('    解析幅度：' + deltasText(row.changes));
      console.log('    卡在    ：' + stuckReason(row));
      console.log('    摘要    ：' + (row.summary || '-'));
      var raw = String(row.raw || '').replace(/\s+/g, ' ').trim();
      if (raw) {
        console.log('    原文    ：' + (raw.length > 260 ? raw.slice(0, 260) + '…' : raw));
      }
    });

    console.log('\n--- 提示 ---');
    console.log('  · 上面这些不是审核队列，脚本不会替你放行');
    console.log('  · 解析器修好后重跑采集，同一去重键会被更可信的结果自动覆盖');
    console.log('  · 确实是解析器覆盖不到的特殊公告，人工核对原文后另行补录');
  } finally {
    await client.end();
  }
}

main().catch(function (err) {
  console.error('\n查询失败：', err.message);
  process.exit(1);
});
