/**
 * 数据访问层
 *
 * 职责边界：
 *   1. 库里是 snake_case，业务层用 camelCase，转换只在这里发生；
 *   2. 只做「查 / 写」，不做业务判断（价格怎么算、要不要发提醒都不在这层）；
 *   3. 分页在云数据库那边要手写 skip/limit，这里用 SQL 的 LIMIT/OFFSET。
 *
 * JSONB 字段（deltas / changes / source / series 等）读出来是对象，
 * 写进去要 JSON.stringify —— pg 不会自动处理。
 */
const db = require('../db');

/* ---------------- 通用转换 ---------------- */

/**
 * 把行转成 camelCase。
 *
 * ⚠️ 只有数值列才转数字，不能看到数字字符串就转 ——
 * fuelId 是 '92' / '95' / '98' / '0'，转成数字后前端
 * `p.fuelId === '92'` 这类判断会全部失效。
 *
 * 用列名白名单：要转的只有 price / change_amount / change_percent /
 * open / prev_close / high / low 这些确实需要当数字用的列。
 */
var NUMERIC_COLUMNS = {
  price: 1, changeamount: 1, changepercent: 1,
  open: 1, prevclose: 1, high: 1, low: 1
};

/**
 * DATE 列：pg 会转成 JS Date 对象，但业务层要的是 'YYYY-MM-DD' 字符串。
 *
 * ⚠️ 不转的话会出两个静默错误：
 *   1. dayDiff('2026-11-14', Date对象) → NaN，窗口的 daysLeft / progress 变 null；
 *   2. '2026-11-04' >= '2026-10-14' 之类的字符串比较失效，走势曲线空数组。
 * 页面和云函数那边拿到的都是日期字符串，所以这里必须对齐。
 */
var DATE_COLUMNS = {
  date: 1, changeat: 1, executeat: 1, cyclestart: 1
};

/** Date → 'YYYY-MM-DD'（按 UTC 取日期部分，和库里存的值一致） */
function toDateString(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v;
}

function toCamel(row) {
  if (!row) return row;
  var out = {};
  Object.keys(row).forEach(function (k) {
    var camel = k.replace(/_([a-z])/g, function (_, c) { return c.toUpperCase(); });
    var v = row[k];
    var lower = camel.toLowerCase();
    if (DATE_COLUMNS[lower] && v instanceof Date) {
      out[camel] = toDateString(v);
    } else if (NUMERIC_COLUMNS[lower] && typeof v === 'string' && v !== '') {
      // NUMERIC 在 pg 里默认返回字符串，这些列要转成数字，页面才不用自己 parse
      out[camel] = Number(v);
    } else {
      out[camel] = v;
    }
  });
  return out;
}

function mapRows(rows) {
  return (rows || []).map(toCamel);
}

/* ---------------- 当前价 ---------------- */

const prices = {
  async listByRegion(regionCode) {
    var rows = await db.query(
      'SELECT * FROM oil_prices WHERE region_code = $1 ORDER BY fuel_id',
      [regionCode]
    );
    return mapRows(rows);
  },

  async listAll() {
    var rows = await db.query('SELECT * FROM oil_prices ORDER BY region_code, fuel_id');
    return mapRows(rows);
  },

  async upsertMany(list) {
    if (!list.length) return;
    var values = [];
    var params = [];
    var tuples = list.map(function (item, i) {
      var b = i * 8;
      values.push('($' + (b + 1) + '::text, $' + (b + 2) + '::text, $' + (b + 3) + '::text, $' + (b + 4) + '::text, $' + (b + 5) + '::numeric, $' + (b + 6) + '::numeric, $' + (b + 7) + '::date, $' + (b + 8) + '::text)');
      params.push(item.regionCode, item.regionName || null, item.fuelId, item.fuelName || null, item.price, item.changeAmount || 0, item.changeAt || null, item.source || null);
      return values[i];
    });
    await db.query(
      'INSERT INTO oil_prices (region_code, region_name, fuel_id, fuel_name, price, change_amount, change_at, source) ' +
      'VALUES ' + tuples.join(', ') + ' ' +
      'ON CONFLICT (region_code, fuel_id) DO UPDATE SET ' +
      'region_name = EXCLUDED.region_name, fuel_name = EXCLUDED.fuel_name, ' +
      'price = EXCLUDED.price, change_amount = EXCLUDED.change_amount, ' +
      'change_at = EXCLUDED.change_at, source = EXCLUDED.source, updated_at = NOW()',
      params
    );
  },

  async removeBySource(source) {
    await db.query('DELETE FROM oil_prices WHERE source = $1', [source]);
  }
};

/* ---------------- 历史价 ---------------- */

const history = {
  async listByRegionFuel(regionCode, fuelId, fromDate) {
    var params = [regionCode, fuelId];
    var sql = 'SELECT * FROM oil_price_history WHERE region_code = $1 AND fuel_id = $2';
    if (fromDate) {
      params.push(fromDate);
      sql += ' AND date >= $3';
    }
    sql += ' ORDER BY date ASC';
    var rows = await db.query(sql, params);
    return mapRows(rows);
  },

  async listByRegion(regionCode, fromDate) {
    var params = [regionCode];
    var sql = 'SELECT * FROM oil_price_history WHERE region_code = $1';
    if (fromDate) {
      params.push(fromDate);
      sql += ' AND date >= $2';
    }
    sql += ' ORDER BY date ASC';
    var rows = await db.query(sql, params);
    return mapRows(rows);
  },

  async upsertMany(list) {
    if (!list.length) return;
    var values = [];
    var params = [];
    var tuples = list.map(function (item, i) {
      var b = i * 5;
      values.push('($' + (b + 1) + '::text, $' + (b + 2) + '::text, $' + (b + 3) + '::date, $' + (b + 4) + '::numeric, $' + (b + 5) + '::text)');
      params.push(item.regionCode, item.fuelId, item.date, item.price, item.source || null);
      return values[i];
    });
    await db.query(
      'INSERT INTO oil_price_history (region_code, fuel_id, date, price, source) VALUES ' + tuples.join(', ') + ' ' +
      'ON CONFLICT (region_code, fuel_id, date) DO UPDATE SET price = EXCLUDED.price, source = EXCLUDED.source',
      params
    );
  },

  async removeBySource(source) {
    await db.query('DELETE FROM oil_price_history WHERE source = $1', [source]);
  }
};

/* ---------------- 调价节点 ---------------- */

const events = {
  async listAll() {
    var rows = await db.query('SELECT * FROM oil_adjust_events ORDER BY date ASC');
    return mapRows(rows);
  },

  async insertMany(list) {
    if (!list.length) return;
    var values = [];
    var params = [];
    var tuples = list.map(function (item, i) {
      var b = i * 4;
      values.push('($' + (b + 1) + '::date, $' + (b + 2) + '::text, $' + (b + 3) + '::jsonb, $' + (b + 4) + '::text)');
      params.push(item.date, item.title || null, JSON.stringify(item.deltas || {}), item.source || null);
      return values[i];
    });
    await db.query(
      'INSERT INTO oil_adjust_events (date, title, deltas, source) VALUES ' + tuples.join(', '),
      params
    );
  },

  async removeBySource(source) {
    await db.query('DELETE FROM oil_adjust_events WHERE source = $1', [source]);
  }
};

/* ---------------- 调价通知 ---------------- */

const notices = {
  /**
   * 只有 review_status = 'approved' 的才对外可见。
   * 「未复核的解析结果不能当正式结论发布」是硬约束，必须在查询层就挡住。
   */
  async listPublic(filter, limit, offset) {
    var params = ['approved'];
    var sql = "SELECT * FROM oil_notices WHERE review_status = $1";
    if (filter === 'forecast') {
      sql += " AND kind = 'forecast'";
    } else {
      sql += " AND kind = 'official'";
    }
    // ORDER BY 放在 LIMIT 之前：两种顺序 Postgres 都接受，但这个顺序兼容性更好
    sql += ' ORDER BY execute_at DESC';
    if (limit !== undefined && limit !== null) {
      // LIMIT/OFFSET 直接内联数字，不走占位符：
      // pg 协议把参数序列化成文本，LIMIT $1 传过来是 '20'，Postgres 直接报错。
      // 这两个值都是内部算出来的整数（先 Number() 过一遍），没有注入风险。
      var lim = Math.max(0, Math.floor(Number(limit) || 0));
      sql += ' LIMIT ' + lim;
      if (offset) {
        sql += ' OFFSET ' + Math.max(0, Math.floor(Number(offset) || 0));
      }
    }
    var rows = await db.query(sql, params);
    return mapRows(rows);
  },

  async latestOfficial() {
    var rows = await db.query(
      "SELECT * FROM oil_notices WHERE kind = 'official' AND review_status = 'approved' ORDER BY execute_at DESC LIMIT 1"
    );
    return rows.length ? toCamel(rows[0]) : null;
  },

  async latestByKind(kind) {
    var rows = await db.query(
      "SELECT * FROM oil_notices WHERE kind = $1 AND review_status = 'approved' ORDER BY execute_at DESC LIMIT 1",
      [kind]
    );
    return rows.length ? toCamel(rows[0]) : null;
  },

  async findByDedupKey(key) {
    var row = await db.one('SELECT * FROM oil_notices WHERE dedup_key = $1', [key]);
    return toCamel(row);
  },

  async insert(doc) {
    var rows = await db.query(
      'INSERT INTO oil_notices (dedup_key, kind, title, published_at, execute_at, changes, summary, prices, source, review_status, raw) ' +
      'VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb, $10, $11) RETURNING *',
      [
        doc.dedupKey,
        doc.kind || 'official',
        doc.title || null,
        doc.publishedAt || null,
        doc.executeAt || null,
        JSON.stringify(doc.changes || {}),
        doc.summary || null,
        JSON.stringify(doc.prices || {}),
        JSON.stringify(doc.source || {}),
        doc.reviewStatus || 'pending',
        doc.raw || null
      ]
    );
    return toCamel(rows[0]);
  },

  async removeBySourceId(sourceId) {
    await db.query("DELETE FROM oil_notices WHERE source->>'sourceId' = $1", [sourceId]);
  }
};

/* ---------------- 调价窗口 ---------------- */

const windows = {
  async latest() {
    var row = await db.one('SELECT * FROM oil_windows ORDER BY date DESC LIMIT 1');
    return toCamel(row);
  },

  async latestBySource(source) {
    var row = await db.one('SELECT * FROM oil_windows WHERE source = $1 ORDER BY date DESC LIMIT 1', [source]);
    return toCamel(row);
  },

  async update(id, doc) {
    var rows = await db.query(
      'UPDATE oil_windows SET date = $2, time = $3, cycle_start = $4, is_official = $5, basis = $6, ' +
      'forecast = $7::jsonb, forecast_direction = $8, source = $9 ' +
      'WHERE id = $1 RETURNING *',
      [
        id,
        doc.date,
        doc.time || '24:00',
        doc.cycleStart || null,
        !!doc.isOfficial,
        doc.basis || null,
        JSON.stringify(doc.forecast || {}),
        doc.forecastDirection || null,
        doc.source || null
      ]
    );
    return toCamel(rows[0]);
  },

  async insert(doc) {
    var rows = await db.query(
      'INSERT INTO oil_windows (date, time, cycle_start, is_official, basis, forecast, forecast_direction, source) ' +
      'VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING *',
      [
        doc.date,
        doc.time || '24:00',
        doc.cycleStart || null,
        !!doc.isOfficial,
        doc.basis || null,
        JSON.stringify(doc.forecast || {}),
        doc.forecastDirection || null,
        doc.source || null
      ]
    );
    return toCamel(rows[0]);
  },

  async removeBySource(source) {
    await db.query('DELETE FROM oil_windows WHERE source = $1', [source]);
  }
};

/* ---------------- 国际行情 ---------------- */

const markets = {
  async listAll() {
    var rows = await db.query('SELECT * FROM oil_markets ORDER BY symbol');
    return mapRows(rows);
  },

  async findBySymbol(symbol) {
    var row = await db.one('SELECT * FROM oil_markets WHERE symbol = $1', [symbol]);
    return toCamel(row);
  },

  async upsert(doc) {
    var rows = await db.query(
      'INSERT INTO oil_markets (symbol, name, price, change_amount, change_percent, open, prev_close, high, low, series, delayed, quote_time, source) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13) ' +
      'ON CONFLICT (symbol) DO UPDATE SET name = EXCLUDED.name, price = EXCLUDED.price, ' +
      'change_amount = EXCLUDED.change_amount, change_percent = EXCLUDED.change_percent, ' +
      'open = EXCLUDED.open, prev_close = EXCLUDED.prev_close, high = EXCLUDED.high, low = EXCLUDED.low, ' +
      'series = EXCLUDED.series, delayed = EXCLUDED.delayed, quote_time = EXCLUDED.quote_time, updated_at = NOW() RETURNING *',
      [
        doc.symbol,
        doc.name || null,
        doc.price,
        doc.changeAmount || 0,
        doc.changePercent || 0,
        doc.open === undefined ? null : doc.open,
        doc.prevClose === undefined ? null : doc.prevClose,
        doc.high === undefined ? null : doc.high,
        doc.low === undefined ? null : doc.low,
        JSON.stringify(doc.series || []),
        !!doc.delayed,
        doc.quoteTime || null,
        doc.source || null
      ]
    );
    return toCamel(rows[0]);
  },

  async removeBySource(source) {
    await db.query('DELETE FROM oil_markets WHERE source = $1', [source]);
  }
};

/* ---------------- 用户 ---------------- */

const users = {
  async touch(openid) {
    var row = await db.one('SELECT * FROM oil_users WHERE openid = $1', [openid]);
    if (!row) {
      await db.query(
        'INSERT INTO oil_users (openid) VALUES ($1) ON CONFLICT (openid) DO NOTHING',
        [openid]
      );
    } else {
      await db.query('UPDATE oil_users SET last_active_at = NOW() WHERE openid = $1', [openid]);
    }
    return { openid: openid };
  }
};

/* ---------------- 提醒规则 ---------------- */

const rules = {
  async listByUser(userId) {
    var rows = await db.query('SELECT * FROM alert_rules WHERE user_id = $1 ORDER BY id', [userId]);
    return mapRows(rows);
  },

  async listAll(limit, offset) {
    var params = [];
    var sql = 'SELECT * FROM alert_rules ORDER BY id';
    if (limit) {
      // 同上：LIMIT/OFFSET 内联数字
      sql += ' LIMIT ' + Math.max(0, Math.floor(Number(limit) || 0));
      if (offset) {
        sql += ' OFFSET ' + Math.max(0, Math.floor(Number(offset) || 0));
      }
    }
    var rows = await db.query(sql, params);
    return mapRows(rows);
  },

  async upsert(rule) {
    await db.query(
      'INSERT INTO alert_rules (user_id, region_code, fuel_id, official_drop, target_price, predict_drop, subscribe_granted, extra, updated_at) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW()) ' +
      'ON CONFLICT (user_id, region_code, fuel_id) DO UPDATE SET ' +
      'official_drop = EXCLUDED.official_drop, target_price = EXCLUDED.target_price, ' +
      'predict_drop = EXCLUDED.predict_drop, subscribe_granted = EXCLUDED.subscribe_granted, ' +
      'extra = EXCLUDED.extra, updated_at = NOW()',
      [
        rule.userId,
        rule.regionCode,
        rule.fuelId,
        rule.officialDrop === undefined ? true : !!rule.officialDrop,
        rule.targetPrice === undefined ? null : rule.targetPrice,
        !!rule.predictDrop,
        !!rule.subscribeGranted,
        JSON.stringify(rule.extra || {})
      ]
    );
  }
};

/* ---------------- 提醒记录 ---------------- */

const logs = {
  async listByUser(userId, limit) {
    var rows = await db.query(
      'SELECT * FROM alert_logs WHERE user_id = $1 ORDER BY time DESC LIMIT $2',
      [userId, limit || 50]
    );
    return mapRows(rows);
  },

  async findByDedupKey(key) {
    var row = await db.one('SELECT * FROM alert_logs WHERE dedup_key = $1', [key]);
    return toCamel(row);
  },

  async insert(doc) {
    var rows = await db.query(
      'INSERT INTO alert_logs (user_id, dedup_key, sent, fail_reason, payload) ' +
      'VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (dedup_key) DO NOTHING RETURNING *',
      [
        doc.userId,
        doc.dedupKey,
        !!doc.sent,
        doc.failReason || null,
        JSON.stringify(doc.payload || {})
      ]
    );
    return rows.length ? toCamel(rows[0]) : null;
  }
};

/* ---------------- 采集运行记录 ---------------- */

const runs = {
  async latest() {
    var row = await db.one('SELECT * FROM collector_runs ORDER BY started_at DESC LIMIT 1');
    return toCamel(row);
  },

  async insert(run) {
    await db.query(
      'INSERT INTO collector_runs (started_at, finished_at, status, source_name, results, needs_review) ' +
      'VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)',
      [
        run.startedAt || new Date().toISOString(),
        run.finishedAt || new Date().toISOString(),
        run.status || 'idle',
        run.sourceName || null,
        JSON.stringify(run.results || []),
        JSON.stringify(run.needsReview || [])
      ]
    );
  }
};

module.exports = {
  prices: prices,
  history: history,
  events: events,
  notices: notices,
  windows: windows,
  markets: markets,
  users: users,
  rules: rules,
  logs: logs,
  runs: runs
};
