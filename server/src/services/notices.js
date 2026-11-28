/**
 * 调价通知、国际行情、同步状态
 *
 * 逻辑与早期云函数实现一致（云函数已下线，见 git 历史）。
 */
const dao = require('../dao');
const shared = require('../shared/shared');
const query = require('./query');
// 挂牌价测算：公告只给吨价，每升四油品幅度靠各地挂牌价的前后快照差值
const measure = require('./measure');
// 通知详情装配：与首页同一份（口径必须一致）
const noticeDetail = require('./notice-detail');
const sources = require('./sources');
const httpClient = require('./http-client');

/* ---------------- 调价通知 ---------------- */

var NOTICE_PAGE = 20;

/**
 * 通知的对外载荷统一由 notice-detail.js 装配：
 * 每升幅度四档来源（官方公布 → 本地区实测 → 各省中位数 → 吨价折算）
 * + 本地区调价前后价（快照优先，没有快照才按幅度推算并标口径）。
 */
function actionNotices(payload) {
  var regionCode = payload.regionCode || shared.DEFAULT_REGION_CODE;
  var filter = payload.filter || 'official';
  var skip = Number(payload.skip) || 0;
  var region = query.resolveRegion(regionCode);

  return Promise.all([
    dao.notices.listPublic(filter, NOTICE_PAGE, skip),
    query.getWindow(),
    dao.runs.latest(),
    // 推算下一轮调价日的基准：最近一次实际调价日
    query.latestAdjustDate(),
    // 本地区当前挂牌价：这一轮还没挂出新价时，详情里的调后价从它推
    dao.prices.listByRegion(regionCode)
  ]).then(function (r0) {
    var notices = r0[0];
    var win = r0[1];
    var lastRun = r0[2];
    var lastAdjustDate = r0[3];
    var priceRows = r0[4] || [];

    var priceMap = {};
    priceRows.forEach(function (p) {
      priceMap[p.fuelId] = { price: p.price, changeAt: p.changeAt || '' };
    });
    var today = query.todayStr();

    // 挂牌价测算：一次查这一页所有公告的生效日
    // 按生效日带上官方吨价 —— 测算的合理区间跟着公告走
    var execDates = notices.map(function (n) { return n.executeAt; });
    var tonByDate = {};
    // 各生效日的官方方向：用来筛掉方向相反的价格变化（错轮次的价差）
    var signByDate = {};
    notices.forEach(function (n) {
      if (n.executeAt) {
        tonByDate[n.executeAt] = n.tonChanges || {};
        signByDate[n.executeAt] = noticeDetail.signOfDirection(n.direction);
      }
    });
    return Promise.all([
      // 各省中位数（全国口径）：列表里那一行「每升幅度」
      measure.measureMany(execDates, tonByDate),
      // 本地区前后快照（本地区口径）：详情里的「调价前后各多少钱」
      measure.localSnapshotsOf(execDates, regionCode, { expectSignByDate: signByDate })
    ]).then(function (r1) {
      var measuredByDate = r1[0];
      var localByDate = r1[1];
      return {
        region: { code: region.code, fullName: region.name + ' · ' + region.city },
        window: query.buildWindow(win, lastAdjustDate),
        sync: {
          // 没有采集记录 / 真实来源全关时是 idle，不能报「同步正常」
          status: lastRun ? (lastRun.needsReview && lastRun.needsReview.length ? 'pending' : (lastRun.status || 'idle')) : 'idle',
          lastCheckedAt: lastRun ? lastRun.finishedAt : '',
          sourceName: lastRun ? lastRun.sourceName : '服务端定时采集',
          sourceUrl: '',
          // 内部源的问题：不影响对外数据，但要能查到
          advisories: lastRun ? (lastRun.advisories || []) : [],
          // 每个来源这一轮的状态（主源被拒、备源接管一眼看得出）
          sources: sourceHealth(lastRun)
        },
        notices: notices.map(function (n) {
          var measured = (measuredByDate[n.executeAt] || {});
          // 测算值只有在方向与公告一致时才摆出来：方向矛盾说明用错了快照
          var measuredChanges = measure.agreesWithDirection(measured, n.direction) ? measured : {};
          return noticeDetail.buildNotice(n, {
            // 各省实测中位数（全国口径）
            measured: measuredChanges,
            // 本地区前后快照（本地区口径）
            snapshots: (localByDate[n.executeAt] || {}),
            // 本地区当前挂牌价
            prices: priceMap,
            // 今天：只有「当前这一轮」才允许拿现价推调后价
            today: today
          });
        }),
        source: { mode: 'server', name: '服务端定时采集', note: '数据来自服务端采集的官方公告' }
      };
    });
  });
}

/* ---------------- 国际行情 ---------------- */

/** 行情周期对应的天数跨度 */
var MARKET_PERIOD_DAYS = { '1d': 1, '1w': 7, '1m': 30, '3m': 90 };

/**
 * 'YYYY-MM-DD HH:mm:ss' / 'YYYY-MM-DD' → 时间戳；解析不出来返回 null
 *
 * ⚠️ 曲线上的时间一律按 **UTC+8 的墙上时间** 解释（东财的 K 线标签、
 *    新浪的报价时刻都是北京时间）：统一减 8 小时，日线点与分钟线点
 *    才落在同一条时间轴上，否则两者会差 8 小时、切周期时错位。
 * ⚠️ 纯日期（日 K）也要认：日线点没有时刻，解析不出来的话
 *    1周/1月/3月 的切片会全部落空，只剩最后一个点。
 */
function seriesTime(dateStr) {
  var m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
  if (!m) return null;
  var h = m[4] ? Number(m[4]) : 0;
  var mi = m[5] ? Number(m[5]) : 0;
  var se = m[6] ? Number(m[6]) : 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, mi, se) - 8 * 3600000;
}

/** 'YYYY-MM-DD HH:mm:ss' → 'MM-DD HH:mm:ss'（展示用，与演示源同格式） */
function shortQuoteTime(value) {
  var s = String(value || '');
  if (/^\d{4}-\d{2}-\d{2} /.test(s)) return s.slice(5);
  return s;
}

/** 行情来源的口径说明（取来源配置里的 note） */
function marketSourceNote(doc) {
  var cfg = (sources.SOURCES || []).filter(function (s) { return s.id === doc.source; })[0];
  return cfg ? (cfg.note || '') : '';
}

/**
 * 按周期裁剪曲线。
 * 之前 payload.period 只是原样回显，切 1日/1周/1月/3月 拿到的永远是同一条线。
 */
function sliceSeries(series, period) {
  var list = series || [];
  if (!list.length) return [];
  var days = MARKET_PERIOD_DAYS[period] || 1;
  // ⚠️ 必须传 **p.date**，不能直接把点对象丢给 seriesTime：
  //   以前写的是 list.map(seriesTime)，回调收到的是 {date, value} 整个对象，
  //   String(对象) = '[object Object]' → 全部解析不出来 → last 为 null
  //   → 曲线永远只剩最后一个点（真实行情入库后国际页就画不出曲线了）。
  var times = list.map(function (p) { return seriesTime(p && p.date); });
  var last = null;
  for (var i = times.length - 1; i >= 0; i--) {
    if (times[i] !== null) { last = times[i]; break; }
  }
  if (last === null) return list.slice(-1);
  var from = last - days * 86400000;
  var out = [];
  for (var j = 0; j < list.length; j++) {
    if (times[j] === null || times[j] >= from) out.push(list[j]);
  }
  return out.length ? out : list.slice(-1);
}

/**
 * 解析行情报价时刻 → 时间戳（毫秒）；解析不出来返回 null。
 *
 * ⚠️ 报价时刻有两种写法，两种都不能直接交给 Date.parse：
 *   'MM-DD HH:mm:ss'     —— 缺年份（演示源与部分行情源的写法）。
 *     Date.parse 把缺年份的补成 2001 年，「现在 - 报价时刻」算出来是
 *     1300 多万分钟（≈25 年），线上接口实际吐出的是 13148652 分钟。
 *   'YYYY-MM-DD HH:mm:ss' —— 服务端共享模块的写法。
 * 无时区标注的一律按 UTC+8 解释（与项目日历口径一致）；
 * 带 Z / ±HH:MM 的按其偏移量折算。
 *
 * @param {string} value 报价时刻字符串
 * @returns {number|null} 毫秒时间戳
 */
function parseQuoteTime(value) {
  var str = String(value == null ? '' : value).trim();
  if (!str) return null;

  var full = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/);
  if (full) {
    var y = Number(full[1]);
    var mo = Number(full[2]);
    var d = Number(full[3]);
    var h = Number(full[4]);
    var mi = Number(full[5]);
    var se = full[6] ? Number(full[6]) : 0;
    var tz = full[7];
    // 无时区标注：按 UTC+8 解释
    if (!tz) return Date.UTC(y, mo - 1, d, h, mi, se) - 8 * 3600000;
    if (tz === 'Z') return Date.UTC(y, mo - 1, d, h, mi, se);
    var sign = tz.charAt(0) === '-' ? -1 : 1;
    var tzMin = Number(tz.slice(-2)) + Number(tz.slice(1, 3)) * 60;
    return Date.UTC(y, mo - 1, d, h, mi, se) - sign * tzMin * 60000;
  }

  // 缺年份：按 UTC+8 的当前年补上
  var shortM = str.match(/^(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (shortM) {
    var cn = new Date(Date.now() + 8 * 3600000);
    return Date.UTC(cn.getUTCFullYear(), Number(shortM[1]) - 1, Number(shortM[2]),
      Number(shortM[3]), Number(shortM[4]), shortM[5] ? Number(shortM[5]) : 0) - 8 * 3600000;
  }

  var t = Date.parse(str);
  return isFinite(t) ? t : null;
}

/**
 * 延时分钟数。
 *
 * ⚠️ 后端原来不返回这个字段，前端直接拼「延时 undefined 分钟」。
 * 行情源给的 quoteTime 是报价时刻，延时 = 现在 - 报价时刻；
 * 算不出来就返回 null（界面显示「延时行情」，不显示 undefined）。
 */
function delayMinutesOf(doc) {
  if (!doc || !doc.delayed) return 0;
  var t = parseQuoteTime(doc.quoteTime);
  if (t === null) return null;
  var minutes = Math.round((Date.now() - t) / 60000);
  return minutes > 0 ? minutes : null;
}

/** 品种代码：BRENT / WTI */
function marketCode(symbol) {
  return symbol === 'wti' ? 'WTI' : 'BRENT';
}

function actionMarket(payload) {
  var symbol = payload.symbol === 'wti' ? 'wti' : 'brent';
  var period = payload.period || '1d';

  return dao.markets.findBySymbol(symbol).then(function (doc) {
    if (!doc) {
      // 库里还没有这个品种：回落到共享模块生成的演示载荷，
      // 保证接口结构完整（前端会检查 price / points 字段）
      var fallback = shared.buildMarketPayload(symbol, period);
      return {
        symbol: fallback.symbol,
        name: fallback.name,
        code: marketCode(symbol),
        // 演示数据也标口径：用户点进来看到的是哪个品种、哪个报价口径
        basis: (shared.MARKET_INSTRUMENTS[symbol] || {}).basis || '',
        price: fallback.price,
        changeAmount: fallback.changeAmount,
        changePercent: fallback.changePercent,
        direction: fallback.direction,
        open: fallback.open,
        prevClose: fallback.prevClose,
        high: fallback.high,
        low: fallback.low,
        points: fallback.points,
        axis: fallback.axis,
        delayed: fallback.delayed,
        delayMinutes: delayMinutesOf({ delayed: fallback.delayed, quoteTime: fallback.quoteTime }),
        quoteTime: fallback.quoteTime,
        // mode 必须标 demo：前端靠它判断该不该显示「（演示数据）」，
        // 以及该不该把延迟状态写成「实时」。
        source: { mode: 'demo', name: '服务端定时采集', note: '演示数据（尚未采集真实行情）' }
      };
    }

    // 库里存的是 points 数组（{date, value}），不是 {date, price}
    var series = doc.series || [];
    var sliced = sliceSeries(series, period);
    var points = sliced.map(function (p) {
      return { date: p.date, value: p.value !== undefined ? p.value : p.price };
    });

    var changeAmount = doc.changeAmount || 0;
    // 品种口径（名称 + 口径说明）：真源在 data/markets.js，服务端是它的同步副本。
    // 布伦特是 CFD 报价、纽约是 NYMEX 近月 —— 不标出来用户没法跟新闻对账。
    var instrument = shared.MARKET_INSTRUMENTS[doc.symbol] || {};
    return {
      symbol: doc.symbol,
      name: instrument.name || doc.name || doc.symbol,
      code: marketCode(doc.symbol),
      basis: instrument.basis || '',
      price: doc.price,
      changeAmount: changeAmount,
      changePercent: doc.changePercent || 0,
      // direction 是前端 trend-chart 的必传属性（String），
      // 演示源 data/markets.js 也有，这里必须补上，否则前端拿到 null。
      // 三态：涨跌额为 0 是「持平」，不能染成上涨。
      direction: changeAmount < 0 ? 'down' : (changeAmount > 0 ? 'up' : 'flat'),
      open: doc.open,
      prevClose: doc.prevClose,
      high: doc.high,
      low: doc.low,
      points: points,
      // ⚠️ axis 必须是**数组**（首/中/尾三档标签）：
      //    以前这里塞的是「最后一个点的时刻」这个字符串，
      //    小程序 wx:for 遍历字符串会把字符一个个渲染出来。
      axis: shared.marketAxisLabels(points, period),
      delayed: !!doc.delayed,
      delayMinutes: delayMinutesOf(doc),
      quoteTime: shortQuoteTime(doc.quoteTime),
      source: { mode: 'server', name: '服务端定时采集', note: marketSourceNote(doc) }
    };
  });
}

/* ---------------- 同步状态 ---------------- */

/**
 * 来源健康：每个来源这一轮是什么状态。
 *
 * ⚠️ 为什么要有：主源被站点拒绝时，价格会由备源顶上，数据照样是新的 ——
 *    但如果没人看得见，就会一直以为「一切正常」。
 *    2026-11-24 实测就是这样：主源被拒、31 个省全在用备源的价，
 *    而界面上一个字都没提。
 *
 * 被拒的来源还会带上熔断信息（冷却到什么时候、被拒几次）。
 */
function sourceHealth(lastRun) {
  var list = [];
  var results = (lastRun && lastRun.results) || [];
  results.forEach(function (r) {
    var cfg = sources.SOURCES.filter(function (x) { return x.id === r.sourceId; })[0] || null;
    var blocked = httpClient.blockedInfo(r.sourceId);
    list.push({
      id: r.sourceId,
      name: r.sourceName || (cfg ? cfg.name : r.sourceId),
      status: r.status,
      reason: r.reason || '',
      message: r.message || '',
      saved: typeof r.saved === 'number' ? r.saved : null,
      checked: typeof r.checked === 'number' ? r.checked : null,
      // 主源挂掉时有多少省份改由备源供数
      takenOver: typeof r.takenOver === 'number' ? r.takenOver : 0,
      degraded: Array.isArray(r.degraded) ? r.degraded.length : 0,
      // 内部源：数据不展示给用户，它的问题不算「对外数据有问题」
      // ⚠️ 只看 source 自己声明的 internal，**不能**把 advisory 也算进去 ——
      //    advisory 的意思是「降级了但不进待核对队列」，
      //    主源被拒、备源接管就是这种情况，它照样要告诉用户「来源变了」。
      internal: r.internal === true,
      // 被拒 / 熔断信息
      blocked: !!blocked,
      blockedLabel: blocked ? blocked.label : '',
      blockedCount: blocked ? blocked.count : 0,
      blockedAt: blocked ? blocked.at : ''
    });
  });
  return list;
}

/**
 * 采集同步状态。
 * 早期是 actionHome 顺带返回的，这里拆成独立接口 ——
 * 它只被调价页用，不必混进首页响应。
 */
function actionSyncStatus() {
  return dao.runs.latest().then(function (lastRun) {
    if (!lastRun) {
      return {
        status: 'idle',
        sourceName: '服务端定时采集',
        lastCheckedAt: '',
        needsReview: [],
        source: { mode: 'server', name: '服务端定时采集', note: '真实数据源尚未接入' }
      };
    }
    return {
      status: (lastRun.needsReview && lastRun.needsReview.length) ? 'pending' : (lastRun.status || 'idle'),
      sourceName: lastRun.sourceName || '服务端定时采集',
      lastCheckedAt: lastRun.finishedAt || '',
      needsReview: lastRun.needsReview || [],
      // 内部源（口径互校之类）的问题：不进 needsReview，但要让运维看得见
      advisories: lastRun.advisories || [],
      // 每个来源这一轮的状态（主源被拒、备源接管一眼看得出）
      sources: sourceHealth(lastRun),
      source: { mode: 'server', name: lastRun.sourceName || '服务端定时采集', note: '数据来自服务端采集的官方公告' }
    };
  });
}

module.exports = {
  actionNotices: actionNotices,
  actionMarket: actionMarket,
  actionSyncStatus: actionSyncStatus,
  sourceHealth: sourceHealth,
  sliceSeries: sliceSeries,
  seriesTime: seriesTime,
  parseQuoteTime: parseQuoteTime
};
