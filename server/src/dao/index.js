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
  open: 1, prevclose: 1, high: 1, low: 1,
  // ⚠️ target_price 不转数字的话，提醒规则读出来是字符串 '7.20'，
  // 而 alert.js 判断目标价用的是 typeof === 'number' → 目标价提醒永远不触发
  targetprice: 1
};

/**
 * DATE 列：pg 会转成 JS Date 对象，但业务层要的是 'YYYY-MM-DD' 字符串。
 *
 * ⚠️ 不转的话会出两个静默错误：
 *   1. dayDiff('2026-11-14', Date对象) → NaN，窗口的 daysLeft / progress 变 null；
 *   2. '2026-11-04' >= '2026-10-14' 之类的字符串比较失效，走势曲线空数组。
 * 页面拿到的一律是日期字符串，所以这里必须对齐。
 */
var DATE_COLUMNS = {
  date: 1, changeat: 1, executeat: 1, cyclestart: 1, announcedat: 1
};

/**
 * Date → 'YYYY-MM-DD'。
 *
 * ⚠️ 必须按**本地**日历日取，不能用 toISOString()：
 *   node-postgres 把 DATE 解析成「本地零点」的 Date。
 *   服务器在 UTC+8 时，2026-11-12 的 Date 是 2026-11-11T16:00Z，
 *   toISOString().slice(0,10) 会得到 2026-11-11 —— 整体退一天。
 *   生产上真踩到了：窗口日期显示成昨天、daysLeft 变 -1。
 *   pg-mem 返回的是字符串，所以本地测试没暴露这个问题。
 */
function toDateString(v) {
  if (!(v instanceof Date)) return v;
  var y = v.getFullYear();
  var m = v.getMonth() + 1;
  var d = v.getDate();
  return y + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d);
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

  /**
   * 全量历史价（所有地区、所有油品、所有日期）。
   *
   * 用途：主源被站点拒绝、拿不到来源自己的历史表时，用库里累积的历史
   * 推导调价节点 —— 库里的历史不依赖某一个源还在不在。
   */
  async listAll() {
    var rows = await db.query('SELECT * FROM oil_price_history ORDER BY region_code, fuel_id, date');
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

  /**
   * 取一段日期范围内的全部历史价行。
   *
   * 「四油品每升幅度测算」要用它：给定调价执行日，
   * 找出执行日前后的挂牌价快照，算出这次调价实际落了多少元/升。
   */
  async listBetween(fromDate, toDate) {
    var rows = await db.query(
      'SELECT * FROM oil_price_history WHERE date >= $1 AND date <= $2 ORDER BY region_code, fuel_id, date',
      [fromDate, toDate]
    );
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

  /**
   * 写入调价节点（按 dedup_key 去重）。
   *
   * ⚠️ 原来只有 insertMany，每轮采集都会重复插一遍同一个节点 ——
   * 生产库里这张表永远是空的（采集器压根不写它），走势页的调价节点恒不显示。
   * 现在采集正式公告时同步补写，靠 dedup_key 保证不重复。
   */
  async upsertMany(list) {
    if (!list.length) return;
    var values = [];
    var params = [];
    var tuples = list.map(function (item, i) {
      var b = i * 5;
      values.push('($' + (b + 1) + '::text, $' + (b + 2) + '::date, $' + (b + 3) + '::text, $' + (b + 4) + '::jsonb, $' + (b + 5) + '::text)');
      params.push(item.dedupKey, item.date, item.title || null, JSON.stringify(item.deltas || {}), item.source || null);
      return values[i];
    });
    await db.query(
      'INSERT INTO oil_adjust_events (dedup_key, date, title, deltas, source) VALUES ' + tuples.join(', ') + ' ' +
      'ON CONFLICT (dedup_key) DO UPDATE SET date = EXCLUDED.date, title = EXCLUDED.title, ' +
      'deltas = EXCLUDED.deltas, source = EXCLUDED.source',
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
   *
   * review_status 是**机器判定**的可信度标记，不是人工审核结论：
   *   approved —— 逐项幅度明确且执行日期明确，可对外发布；
   *   pending  —— 正文写法与预期不符（只解析出总幅度 / 没抓到执行日期），
   *               存疑不发布，等人工核对。
   *
   * 「未复核的解析结果不能当正式结论发布」是硬约束，必须在查询层就挡住。
   */
  async listPublic(filter, limit, offset) {
    var params = ['approved'];
    var sql = "SELECT * FROM oil_notices WHERE review_status = $1";
    if (filter === 'forecast') {
      sql += " AND kind = 'forecast'";
    } else if (filter !== 'all') {
      // ⚠️ 'all' 是「全部」，不能静默落到 official ——
      // 调价页的「全部」筛选以前只看得到正式结果，预测结果被吞掉了。
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

  /**
   * 已复核、且带官方吨价的公告（按执行日倒序）。
   *
   * 口径互校要用「官方公布的每吨涨跌」换算成每升，跟各省挂牌价实测比一比。
   * ⚠️ 用公告而不是第三方时间表：公告是权威一手来源、采集时已经在库里了
   *    （零额外请求），也不会因为某个站点关页面就整个失效。
   */
  async listApprovedWithTon(limit) {
    var lim = Math.max(1, Math.floor(Number(limit) || 60));
    // LIMIT 直接内联数字，不走占位符（见上面的说明）
    var rows = await db.query(
      "SELECT * FROM oil_notices WHERE kind = 'official' AND review_status = 'approved' " +
      "AND execute_at IS NOT NULL AND ton_changes IS NOT NULL AND ton_changes <> '{}'::jsonb " +
      'ORDER BY execute_at DESC LIMIT ' + lim
    );
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

  /**
   * 找同来源、同标题的存疑通知。
   *
   * ⚠️ 去重键里带执行日期：解析器修好、日期补上之后键就变了，
   * 「存疑 → 可信」的覆盖更新根本不触发（键不一样），
   * 旧的那条 pending 会永远留在库里、新的 approved 又插一条。
   * 所以按 (来源, 标题) 再回退查一次。
   */
  /**
   * 按 (来源, 标题) 找最近的一条通知，不限状态。
   *
   * 采集器靠它在抓详情页之前判断「这条公告是不是已经处理过了」——
   * 已入库的公告不再重复抓详情，减少对来源站点的请求。
   */
  async findBySourceTitle(sourceId, title) {
    var rows = await db.query(
      'SELECT * FROM oil_notices WHERE title = $1 ORDER BY id DESC',
      [title]
    );
    var matched = mapRows(rows).filter(function (n) {
      return n.source && n.source.sourceId === sourceId;
    });
    return matched.length ? matched[0] : null;
  },

  async findPendingBySourceTitle(sourceId, title) {
    var rows = await db.query(
      "SELECT * FROM oil_notices WHERE review_status = 'pending' AND title = $1 ORDER BY id DESC",
      [title]
    );
    var matched = mapRows(rows).filter(function (n) {
      return n.source && n.source.sourceId === sourceId;
    });
    return matched.length ? matched[0] : null;
  },

  async insert(doc) {
    var rows = await db.query(
      'INSERT INTO oil_notices (dedup_key, kind, title, published_at, announced_at, execute_at, direction, ton_changes, changes, summary, prices, source, review_status, raw) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13, $14) RETURNING *',
      [
        doc.dedupKey,
        doc.kind || 'official',
        doc.title || null,
        doc.publishedAt || null,
        doc.announcedAt || null,
        doc.executeAt || null,
        doc.direction || null,
        // 官方吨价（汽/柴油，元/吨）：公告只给这个
        JSON.stringify(doc.tonChanges || {}),
        // 每升四油品幅度：公告不给，留空；展示层另给测算值
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

  /**
   * 覆盖一条通知。
   *
   * 用途：一条「存疑」的通知，等解析器修好、能解析出可信结果后，
   * 用更可信的结果覆盖它（否则去重键一样，重跑也进不来）。
   */
  async update(id, doc) {
    var rows = await db.query(
      'UPDATE oil_notices SET title = $2, published_at = $3, announced_at = $4, execute_at = $5, ' +
      'direction = $6, ton_changes = $7::jsonb, changes = $8::jsonb, ' +
      'summary = $9, source = $10::jsonb, review_status = $11, raw = $12, ' +
      // dedup_key 也要能改：解析器修好后补上执行日期，键就变了，
      // 不更新的话下一轮又按新键去查，还是找不到这一行。
      'dedup_key = COALESCE($13, dedup_key) WHERE id = $1 RETURNING *',
      [
        id,
        doc.title || null,
        doc.publishedAt || null,
        doc.announcedAt || null,
        doc.executeAt || null,
        doc.direction || null,
        JSON.stringify(doc.tonChanges || {}),
        JSON.stringify(doc.changes || {}),
        doc.summary || null,
        JSON.stringify(doc.source || {}),
        doc.reviewStatus || 'pending',
        doc.raw || null,
        doc.dedupKey || null
      ]
    );
    return rows.length ? toCamel(rows[0]) : null;
  },

  async removeBySourceId(sourceId) {
    await db.query("DELETE FROM oil_notices WHERE source->>'sourceId' = $1", [sourceId]);
  }
};

/* ---------------- 调价窗口 ---------------- */

const windows = {
  async latest() {
    // 同一天可能有多条（历史脏数据 / 并发写入），取 id 最大的那条，
    // 只按 date 排序时取到哪条是不确定的。
    var row = await db.one('SELECT * FROM oil_windows ORDER BY date DESC, id DESC LIMIT 1');
    return toCamel(row);
  },

  async latestBySource(source) {
    var row = await db.one('SELECT * FROM oil_windows WHERE source = $1 ORDER BY date DESC LIMIT 1', [source]);
    return toCamel(row);
  },

  /**
   * 按 dedup_key（来源::日期）落一条窗口。
   *
   * ⚠️ 原来只有「查最新再 update / insert」，多实例并发会插出同日期重复窗口，
   * 而 latest() 按 date DESC 取哪条不确定。
   * 现在靠 dedup_key 唯一索引走 upsert，并发下只有一条能落成。
   */
  async upsert(doc) {
    var rows = await db.query(
      'INSERT INTO oil_windows (dedup_key, date, time, cycle_start, is_official, basis, forecast, forecast_direction, source) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) ' +
      'ON CONFLICT (dedup_key) DO UPDATE SET date = EXCLUDED.date, time = EXCLUDED.time, ' +
      'cycle_start = EXCLUDED.cycle_start, is_official = EXCLUDED.is_official, basis = EXCLUDED.basis, ' +
      'forecast = EXCLUDED.forecast, forecast_direction = EXCLUDED.forecast_direction RETURNING *',
      [
        doc.dedupKey,
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
    return rows.length ? toCamel(rows[0]) : null;
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

  /**
   * 写入一条提醒规则。
   *
   * ⚠️ subscribeGranted 是**三态**：
   *   undefined —— 客户端这次没带这个字段（比如只是改了目标价），
   *               保持库里的原值不动；
   *   true     —— 客户端刚拿到微信的一次性授权，恢复额度并清掉「已用完」标记；
   *   false    —— 客户端明确撤销授权。
   * 写成布尔量之后，「已发完一条」和「从没授权过」就分不开了。
   */
  async upsert(rule) {
    await db.query(
      'INSERT INTO alert_rules (user_id, region_code, fuel_id, official_drop, target_price, predict_drop, target_enabled, subscribe_granted, subscribe_used_at, armed_at, extra, updated_at) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::boolean, FALSE), NULL, NOW(), $9::jsonb, NOW()) ' +
      'ON CONFLICT (user_id, region_code, fuel_id) DO UPDATE SET ' +
      'official_drop = EXCLUDED.official_drop, target_price = EXCLUDED.target_price, ' +
      'predict_drop = EXCLUDED.predict_drop, target_enabled = EXCLUDED.target_enabled, ' +
      'subscribe_granted = CASE WHEN $8::boolean IS NULL THEN alert_rules.subscribe_granted ELSE EXCLUDED.subscribe_granted END, ' +
      'subscribe_used_at = CASE WHEN $8::boolean = TRUE THEN NULL ELSE alert_rules.subscribe_used_at END, ' +
      // 只有重新授权才换额度版本；普通改条件不能阻止发送中的旧实例核销已用额度。
      'version = alert_rules.version + CASE WHEN $8::boolean IS TRUE THEN 1 ELSE 0 END, ' +
      // ⚠️ armed_at 每次保存都刷新：规则从保存这一刻起才开始接收事件，
      // 之前就已经发生的调价不该再补发通知。
      'armed_at = NOW(), ' +
      'extra = EXCLUDED.extra, updated_at = NOW()',
      [
        rule.userId,
        rule.regionCode,
        rule.fuelId,
        rule.officialDrop === undefined ? true : !!rule.officialDrop,
        rule.targetPrice === undefined ? null : rule.targetPrice,
        !!rule.predictDrop,
        rule.targetEnabled === undefined ? true : !!rule.targetEnabled,
        rule.subscribeGranted === undefined ? null : rule.subscribeGranted,
        JSON.stringify(rule.extra || {})
      ]
    );
  },

  /**
   * 一次性订阅的额度用掉了：置为未授权，并记下用掉的时间。
   *
   * 界面靠 subscribe_used_at 区分「授权已用完」和「从没授权过」——
   * 两者都显示成「未开启」会让人以为是自己没点同意。
   */
  async consumeSubscribe(rule) {
    var version = rule.version;
    // 兼容直接调用：没有快照时先读当前版本，仍然只做带条件的更新。
    // alert.js 一定传发送前的规则快照，用户中途重新授权后旧实例不会覆盖新额度。
    if (version === undefined || version === null) {
      var current = await db.one(
        'SELECT version FROM alert_rules WHERE user_id = $1 AND region_code = $2 AND fuel_id = $3',
        [rule.userId, rule.regionCode, rule.fuelId]
      );
      if (!current) return false;
      version = current.version;
    }
    var rows = await db.query(
      'UPDATE alert_rules SET subscribe_granted = FALSE, subscribe_used_at = NOW(), updated_at = NOW(), version = version + 1 ' +
      'WHERE user_id = $1 AND region_code = $2 AND fuel_id = $3 AND version = $4::bigint RETURNING id',
      [rule.userId, rule.regionCode, rule.fuelId, version]
    );
    return rows.length > 0;
  }
};

/* ---------------- 提醒记录 ---------------- */

/**
 * 未开始发送的占位最长存活时间。
 *
 * send_started_at IS NULL 说明进程只占了位、尚未调用外部发送接口，
 * 这种过期占位可以抢回来重发。一旦开始外部发送，未回填就意味着结果未知
 * （微信可能已经接收），无论过多久都不能自动重发。
 */
var STALE_PLACEHOLDER_MS = 10 * 60 * 1000;

/**
 * 按 dedup_key 查提醒记录。
 *
 * ⚠️ dedup_key 是**全局**唯一列，查询必须带上 user_id ——
 * 不带的话，A 用户的 key 能查到 B 用户的记录。
 */
async function findLogByDedupKey(key, userId) {
  if (userId) {
    var row = await db.one('SELECT * FROM alert_logs WHERE dedup_key = $1 AND user_id = $2', [key, userId]);
    return toCamel(row);
  }
  var rowAny = await db.one('SELECT * FROM alert_logs WHERE dedup_key = $1', [key]);
  return toCamel(rowAny);
}

const logs = {
  async listByUser(userId, limit) {
    // LIMIT 一律内联整数，不走占位符（与其余四处保持一致）。
    // ⚠️ 这条原来写的是 LIMIT $2 —— pg 其实能按 bigint 推断出来，
    // 真正的问题不是「会报错」，而是全项目风格不统一、还多一次类型推断风险。
    var lim = Math.max(0, Math.floor(Number(limit) || 50));
    var rows = await db.query(
      // 过滤掉「占位了但没回填结果」的僵尸行：
      // sent=FALSE 且 fail_reason 为空 = 尚未发送，或外部发送后结果未知。
      // 这种行对用户表现为「发送失败 · 未知原因」，没有意义，藏起来。
      'SELECT * FROM alert_logs WHERE user_id = $1 AND (sent = TRUE OR fail_reason IS NOT NULL) ' +
      'ORDER BY time DESC LIMIT ' + lim,
      [userId]
    );
    return mapRows(rows);
  },

  /**
   * 是否已经发过同一个事件。
   *
   * ⚠️ dedup_key 是**全局**唯一列，查询必须带上 user_id ——
   * 不带的话，A 用户的 key 能查到 B 用户的记录。
   */
  async findByDedupKey(key, userId) {
    return findLogByDedupKey(key, userId);
  },

  /**
   * 占位：先占住去重键，再去发消息。
   *
   * ⚠️ 原来是「查有没有发过 → 发消息 → 落库」，去重发生在副作用**之后**：
   * 两个实例同时跑时两边都查不到，都会发一遍，用户收到两条。
   * 现在先插入占位行，抢到行的人才有资格发 —— 去重前置到副作用之前。
   *
   * 返回 null = 这个键已经被别人占过了，直接跳过。
   *
   * ⚠️ 这里用「直接插入 + 捕获唯一键冲突」，不用
   * `ON CONFLICT DO NOTHING RETURNING *`：
   * pg-mem 在冲突时也会把已有行 RETURN 出来（真库返回 0 行），
   * 两种引擎行为不一致，自检就测不出「到底有没有抢到」。
   * 唯一键冲突的错误码是 23505，两边都一样。
   */
  async reserve(doc) {
    try {
      var rows = await db.query(
        'INSERT INTO alert_logs (user_id, dedup_key, sent, fail_reason, payload) ' +
        'VALUES ($1, $2, FALSE, NULL, $3::jsonb) RETURNING *',
        [
          doc.userId,
          doc.dedupKey,
          JSON.stringify(doc.payload || {})
        ]
      );
      return rows.length ? toCamel(rows[0]) : null;
    } catch (err) {
      var msg = String((err && err.message) || '');
      if ((err && err.code === '23505') || /duplicate key|duplicate/i.test(msg)) {
        // 键已被占：可能是「已经发过」，也可能是「上次进程崩了留下的空占位」。
        // 只有尚未开始外部发送（send_started_at IS NULL）的空占位才能回收。
        // 已开始发送但未回填 = 微信可能已接收，结果未知，坚决不自动重发。
        // 「time < 阈值」这个条件保证并发实例里只有一个能抢到，另一个拿到 0 行。
        var existing = await findLogByDedupKey(doc.dedupKey, doc.userId);
        if (existing && existing.sent === false && !existing.failReason && !existing.sendStartedAt) {
          var taken = await db.query(
            'UPDATE alert_logs SET time = NOW(), payload = $3::jsonb ' +
            'WHERE id = $1 AND sent = FALSE AND fail_reason IS NULL ' +
            'AND send_started_at IS NULL AND time < $2 RETURNING *',
            [
              existing.id,
              new Date(Date.now() - STALE_PLACEHOLDER_MS),
              JSON.stringify(doc.payload || {})
            ]
          );
          if (taken.length) return toCamel(taken[0]);
        }
        return null;
      }
      throw err;
    }
  },

  /**
   * 标记「即将开始外部发送」。
   *
   * 必须在调用微信接口之前成功落库；此后即使进程崩溃，也不能把这条
   * 未回填记录当成可重发占位，避免微信已接受的消息再发一遍。
   */
  async markSending(id) {
    var rows = await db.query(
      'UPDATE alert_logs SET send_started_at = NOW() ' +
      'WHERE id = $1 AND sent = FALSE AND fail_reason IS NULL AND send_started_at IS NULL RETURNING *',
      [id]
    );
    return rows.length ? toCamel(rows[0]) : null;
  },

  /** 占位之后回填结果：发成功了还是失败了 */
  async markResult(id, sent, failReason) {
    var rows = await db.query(
      'UPDATE alert_logs SET sent = $2, fail_reason = $3 WHERE id = $1 RETURNING *',
      [id, !!sent, failReason || null]
    );
    return rows.length ? toCamel(rows[0]) : null;
  },

  /**
   * 释放占位：可重试的失败要把 dedupKey 还回去。
   *
   * ⚠️ 之前不管成没成都把占位行留着 —— 网络抖动这种**本该重试**的失败
   * 也把 dedupKey 永久占住，这个事件再也不会发第二次。
   * 只删「没发成功」的：已经发出去的行是历史记录，不能删。
   */
  async release(id) {
    await db.query('DELETE FROM alert_logs WHERE id = $1 AND sent = FALSE', [id]);
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
      'INSERT INTO collector_runs (started_at, finished_at, status, source_name, results, needs_review, advisories) ' +
      'VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)',
      [
        run.startedAt || new Date().toISOString(),
        run.finishedAt || new Date().toISOString(),
        run.status || 'idle',
        run.sourceName || null,
        JSON.stringify(run.results || []),
        JSON.stringify(run.needsReview || []),
        JSON.stringify(run.advisories || [])
      ]
    );
  }
};

module.exports = {
  // 导出给自检用：DATE 转字符串在非 UTC 时区真踩过坑，要能被测试钉住
  toDateString: toDateString,
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
