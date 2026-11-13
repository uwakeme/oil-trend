/**
 * 数据库连接池
 *
 * 用 PostgreSQL：油价数据是强结构化的（地区 × 油品 × 日期），
 * 关系库比文档库更合适，也方便建唯一索引做去重。
 */
const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', function (err) {
  // 后台错误（如连接被服务端断开）不能让进程崩掉，
  // 否则 pm2/systemd 会不断重启
  console.error('[db] 空闲连接出错：', err.message);
});

/**
 * 真正要用数据库时才校验配置。
 *
 * 不在模块加载期校验：加载期抛错会让 scripts/check-modules.js
 * 这类「只要能 require 进来」的检查误报失败 ——
 * 而配置文件被加载并不代表真的要连库。
 */
function assertConfigured() {
  // 自检用 pg-mem 跑，没有真实的连接串 —— 这种情况放行。
  if (!config.databaseUrl && !process.env.OIL_ALLOW_NO_DATABASE) {
    throw new Error('缺少环境变量 DATABASE_URL，见 server/.env.example');
  }
}

/** 执行查询，返回 rows */
function query(text, params) {
  assertConfigured();
  return pool.query(text, params).then(function (res) {
    return res.rows;
  });
}

/** 执行查询，返回第一行或 null */
function one(text, params) {
  return query(text, params).then(function (rows) {
    return rows.length ? rows[0] : null;
  });
}

/**
 * 在事务里执行一组操作
 *
 * ⚠️ pool.connect() 返回的是 **Promise**，不是 client ——
 * 原来写成 `var client = pool.connect(); client.query(...)`，
 * 一调用就抛「client.query is not a function」。全项目没有调用点，
 * 但留着就是个随时会踩的雷。
 */
function transaction(fn) {
  return pool.connect().then(function (client) {
    return client.query('BEGIN')
      .then(function () { return fn(client); })
      .then(function (result) {
        return client.query('COMMIT').then(function () { return result; });
      })
      .catch(function (err) {
        // 回滚本身也可能失败（比如连接断了），别把原始错误盖掉
        return client.query('ROLLBACK').then(function () { throw err; }, function () { throw err; });
      })
      .finally(function () { client.release(); });
  });
}

module.exports = { pool: pool, query: query, one: one, transaction: transaction };
