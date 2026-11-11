/**
 * 油势 · 数据读取与规则存储云函数
 *
 * 小程序端 utils/api.js 会优先调用本函数（action 路由），
 * 失败或未配置云环境时自动回落到本地演示数据源。
 *
 * action 说明：
 *   regions       地区列表（含 92# 当前价）
 *   home          首页数据（当前价 / 调价窗口 / 30 天走势 / 最新通知）
 *   trend         走势数据（指定油品 + 周期）
 *   notices       调价通知列表
 *   market        国际行情
 *   rules.list    读取当前用户的提醒规则
 *   rules.save    保存当前用户的提醒规则
 *   history.list  读取当前用户的提醒记录
 *   history.save  保存当前用户的提醒记录
 *   openid        上报并返回当前用户 openid（用于订阅消息下发）
 *
 * 集合约定：
 *   oil_prices        当前价：每个 (regionCode, fuelId) 一条
 *   oil_price_history 历史价：每个 (regionCode, fuelId, date) 一条
 *   oil_adjust_events 调价节点：每次调价一条
 *   oil_notices       调价通知：带 dedupKey 去重
 *   oil_windows       下一轮调价窗口
 *   oil_markets       国际行情
 *   alert_rules       提醒规则（按 userId）
 *   alert_logs        提醒记录（按 userId）
 *   oil_users         用户标识
 */
const cloud = require('wx-server-sdk');
const shared = require('./shared');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const C = {
  prices: 'oil_prices',
  history: 'oil_price_history',
  events: 'oil_adjust_events',
  notices: 'oil_notices',
  windows: 'oil_windows',
  markets: 'oil_markets',
  rules: 'alert_rules',
  logs: 'alert_logs',
  users: 'oil_users'
};

function ok(data) {
  return { ok: true, data: data };
}

function fail(message, code) {
  return { ok: false, message: message, code: code || 'ERROR' };
}

function dayDiff(fromDate, toDate) {
  var a = new Date(fromDate + 'T00:00:00Z').getTime();
  var b = new Date(toDate + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

function todayStr() {
  var d = new Date();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/* ---------------- 查询辅助 ---------------- */

async function getPrices(regionCode) {
  var where = regionCode ? { regionCode: regionCode } : {};
  var res = await db.collection(C.prices).where(where).get();
  return res.data || [];
}

async function getWindow() {
  var res = await db.collection(C.windows).orderBy('date', 'desc').limit(1).get();
  return (res.data && res.data[0]) || null;
}

async function getLatestNotice() {
  var res = await db.collection(C.notices)
    .where({ kind: 'official' })
    .orderBy('executeAt', 'desc')
    .limit(1)
    .get();
  return (res.data && res.data[0]) || null;
}

async function getNotices(filter) {
  var res = await db.collection(C.notices).orderBy('executeAt', 'desc').limit(100).get();
  var list = res.data || [];
  // 只有人工复核通过的通知才对外可见
  list = list.filter(function (n) { return n.reviewStatus === 'approved'; });
  return filter && filter !== 'all' ? list.filter(function (n) { return n.kind === filter; }) : list;
}

async function getAdjustEvents() {
  var res = await db.collection(C.events).orderBy('date', 'asc').get();
  return res.data || [];
}

async function getHistory(regionCode, fuelId, fromDate) {
  var where = { regionCode: regionCode, fuelId: fuelId };
  if (fromDate) where.date = db.command.gte(fromDate);
  // 单次 get() 有平台上限，分页取全，
  // 否则 orderBy('date','asc') 只会拿到最早的一批，走势终点不是当前价。
  var all = [];
  var skip = 0;
  var PAGE = 100;
  while (true) {
    var res = await db.collection(C.history).where(where).orderBy('date', 'asc').skip(skip).limit(PAGE).get();
    var batch = res.data || [];
    all = all.concat(batch);
    if (batch.length < PAGE) break;
    skip += PAGE;
    if (skip > 5000) break;
  }
  return all;
}

/* ---------------- 各 action ---------------- */

async function actionRegions() {
  var prices = await getPrices();
  var map = {};
  prices.forEach(function (p) {
    if (p.fuelId === '92') map[p.regionCode] = p;
  });
  var regions = shared.REGIONS.map(function (r) {
    var p = map[r.code];
    return {
      code: r.code,
      name: r.name,
      city: r.city,
      fullName: r.name + ' · ' + r.city,
      price92: p ? p.price : null
    };
  });
  return ok({ regions: regions });
}

function buildWindow(windowDoc) {
  if (!windowDoc) {
    return {
      date: todayStr(),
      time: '24:00',
      daysLeft: 0,
      isOfficial: false,
      basis: '暂无窗口数据',
      forecast: {}
    };
  }
  var daysLeft = dayDiff(todayStr(), windowDoc.date);
  var totalDays = Math.max(1, dayDiff(windowDoc.cycleStart || windowDoc.date, windowDoc.date));
  var passedDays = Math.max(0, totalDays - daysLeft);
  return {
    date: windowDoc.date,
    time: windowDoc.time || '24:00',
    daysLeft: daysLeft,
    cycleStart: windowDoc.cycleStart,
    cycleStarted: passedDays > 0,
    progress: Math.min(100, Math.max(0, Math.round(passedDays / totalDays * 100))),
    isOfficial: !!windowDoc.isOfficial,
    basis: windowDoc.basis || '',
    forecast: windowDoc.forecast || {}
  };
}

/**
 * 一次取回某个地区全部油品的历史价，按油品分组。
 * 之前每个油品查一次，4 个油品就是 4 次串行查询。
 */
async function getHistoryByRegion(regionCode, fromDate) {
  var where = { regionCode: regionCode };
  if (fromDate) where.date = db.command.gte(fromDate);
  var all = [];
  var skip = 0;
  var PAGE = 100;
  while (true) {
    var res = await db.collection(C.history).where(where).orderBy('date', 'asc').skip(skip).limit(PAGE).get();
    var batch = res.data || [];
    all = all.concat(batch);
    if (batch.length < PAGE) break;
    skip += PAGE;
    if (skip > 5000) break;
  }
  var byFuel = {};
  all.forEach(function (h) {
    if (!byFuel[h.fuelId]) byFuel[h.fuelId] = [];
    byFuel[h.fuelId].push(h);
  });
  return byFuel;
}

async function actionHome(payload) {
  var regionCode = payload.regionCode || shared.DEFAULT_REGION_CODE;
  var fuelId = payload.fuelId || '92';
  var region = shared.regionByCode(regionCode);

  var prices = await getPrices(regionCode);
  var priceList = prices.map(function (p) {
    return {
      id: p.fuelId,
      name: p.fuelName,
      short: p.fuelId + '#',
      unit: '元/升',
      price: p.price,
      changeAmount: p.changeAmount || 0,
      changeAt: p.changeAt || '',
      direction: (p.changeAmount || 0) < 0 ? 'down' : ((p.changeAmount || 0) > 0 ? 'up' : 'flat')
    };
  });
  priceList.sort(function (a, b) {
    return shared.FUELS.findIndex(function (f) { return f.id === a.id; }) -
      shared.FUELS.findIndex(function (f) { return f.id === b.id; });
  });

  var history = await getHistory(regionCode, fuelId);
  var today = todayStr();
  var from30 = new Date(new Date(today + 'T00:00:00Z').getTime() - 29 * 86400000).toISOString().slice(0, 10);
  var points30 = history.filter(function (h) { return h.date >= from30; }).map(function (h) {
    return { date: h.date, value: h.price };
  });

  var labels = [
    from30.slice(5).replace('-', '月') + '日',
    new Date(new Date(today + 'T00:00:00Z').getTime() - 14 * 86400000).toISOString().slice(0, 10).slice(5).replace('-', '月') + '日',
    today.slice(5).replace('-', '月') + '日'
  ];

  var win = await getWindow();
  var notice = await getLatestNotice();

  // 一次查完这个地区全部油品的历史价，再按油品分组
  var historyByFuel = await getHistoryByRegion(regionCode);
  var trend30 = {};
  for (var i = 0; i < shared.FUELS.length; i++) {
    var f = shared.FUELS[i];
    var fh = historyByFuel[f.id] || [];
    trend30[f.id] = {
      points: fh.filter(function (h) { return h.date >= from30; }).map(function (h) {
        return { date: h.date, value: h.price };
      }),
      labels: labels
    };
  }

  var changes = {};
  if (notice && notice.changes) {
    shared.FUELS.forEach(function (f) { changes[f.id] = notice.changes[f.id]; });
  }

  return ok({
    region: { code: region.code, name: region.name, city: region.city, fullName: region.name + ' · ' + region.city },
    prices: priceList,
    updatedAt: prices.length ? prices[0].updatedAt : new Date().toISOString(),
    window: buildWindow(win),
    trend30: trend30,
    latestNotice: notice ? {
      id: notice._id,
      title: notice.title,
      executeAt: notice.executeAt,
      changes: changes
    } : { id: '', title: '暂无通知', executeAt: '', changes: changes },
    source: { mode: 'cloud', name: '服务端定时采集', note: '数据来自服务端采集的官方公告' }
  });
}

async function actionTrend(payload) {
  var regionCode = payload.regionCode || shared.DEFAULT_REGION_CODE;
  var fuelId = payload.fuelId || '92';
  var period = payload.period || '3m';
  var months = { '3m': 3, '6m': 6, '1y': 12 }[period] || 3;
  var region = shared.regionByCode(regionCode);

  var today = todayStr();
  var fromDate = new Date(new Date(today + 'T00:00:00Z').getTime() - months * 30 * 86400000).toISOString().slice(0, 10);

  var history = await getHistory(regionCode, fuelId, fromDate);
  var events = (await getAdjustEvents()).filter(function (e) {
    return e.date >= fromDate && e.date <= today;
  });

  var values = history.map(function (h) { return h.price; });
  if (!values.length) {
    return fail('该区间暂无历史数据', 'NO_HISTORY');
  }
  var first = values[0];
  var last = values[values.length - 1];
  var deltaPercent = first ? Number((((last - first) / first) * 100).toFixed(2)) : 0;

  var points = history.map(function (h) { return { date: h.date, value: h.price }; });

  var prices = await getPrices(regionCode);
  var priceMap = {};
  prices.forEach(function (p) { priceMap[p.fuelId] = p.price; });

  return ok({
    region: { code: region.code, fullName: region.name + ' · ' + region.city },
    fuel: { id: fuelId, name: (shared.FUELS.filter(function (f) { return f.id === fuelId; })[0] || {}).name || fuelId },
    price: last,
    deltaPercent: deltaPercent,
    direction: deltaPercent > 0 ? 'up' : (deltaPercent < 0 ? 'down' : 'flat'),
    rangeLabel: { '3m': '近 3 个月', '6m': '近 6 个月', '1y': '近 1 年' }[period],
    low: Math.min.apply(null, values),
    high: Math.max.apply(null, values),
    count: events.length,
    axis: [
      fromDate.slice(0, 7).replace('-', '/'),
      new Date(new Date(fromDate + 'T00:00:00Z').getTime() + Math.floor((months * 30 * 86400000) / 2)).toISOString().slice(0, 7).replace('-', '/'),
      today.slice(0, 7).replace('-', '/')
    ],
    points: points,
    events: events.map(function (e) {
      return {
        date: e.date,
        title: e.title,
        amount: (e.deltas || {})[fuelId] || 0,
        direction: ((e.deltas || {})[fuelId] || 0) < 0 ? 'down' : 'up',
        priceAfter: priceMap[fuelId]
      };
    }),
    source: { mode: 'cloud', name: '服务端定时采集', note: '数据来自服务端采集的官方公告' }
  });
}

async function actionNotices(payload) {
  var regionCode = payload.regionCode || shared.DEFAULT_REGION_CODE;
  var fuelId = payload.fuelId || '92';
  var region = shared.regionByCode(regionCode);
  var notices = await getNotices(payload.filter);
  var win = await getWindow();
  var prices = await getPrices(regionCode);
  var priceMap = {};
  prices.forEach(function (p) { priceMap[p.fuelId] = p.price; });

  var run = (await db.collection('collector_runs').orderBy('startedAt', 'desc').limit(1).get());
  var lastRun = (run.data && run.data[0]) || null;

  return ok({
    region: { code: region.code, fullName: region.name + ' · ' + region.city },
    window: buildWindow(win),
    sync: {
      // 没有采集记录 / 真实来源全关时是 idle，不能报「同步正常」
      status: lastRun ? (lastRun.needsReview && lastRun.needsReview.length ? 'pending' : (lastRun.status || 'idle')) : 'idle',
      lastCheckedAt: lastRun ? lastRun.finishedAt : '',
      sourceName: lastRun ? lastRun.sourceName : '服务端定时采集',
      sourceUrl: ''
    },
    notices: notices.map(function (n) {
      return {
        id: n._id,
        kind: n.kind,
        title: n.title,
        publishedAt: n.publishedAt,
        executeAt: n.executeAt,
        changes: n.changes || {},
        summary: n.summary || '',
        prices: n.prices || {},
        source: n.source || {}
      };
    }),
    source: { mode: 'cloud', name: '服务端定时采集', note: '数据来自服务端采集的官方公告' }
  });
}

async function actionMarket(payload) {
  var symbol = payload.symbol === 'wti' ? 'wti' : 'brent';
  var res = await db.collection(C.markets).where({ symbol: symbol }).get();
  var doc = (res.data && res.data[0]) || null;
  if (!doc) return fail('暂无行情数据', 'NO_MARKET');
  return ok({
    symbol: doc.symbol,
    name: doc.name,
    code: doc.code,
    label: doc.label,
    price: doc.price,
    changeAmount: doc.changeAmount,
    changePercent: doc.changePercent,
    direction: (doc.changeAmount || 0) < 0 ? 'down' : 'up',
    open: doc.open,
    prevClose: doc.prevClose,
    high: doc.high,
    low: doc.low,
    unit: '美元/桶',
    quoteTime: doc.quoteTime,
    delayed: !!doc.delayed,
    delayMinutes: doc.delayMinutes || 0,
    period: (payload.period || '1d'),
    points: doc.series || [],
    axis: (doc.series || []).length ? [
      doc.series[0].date,
      doc.series[Math.floor(doc.series.length / 2)].date,
      doc.series[doc.series.length - 1].date
    ] : [],
    source: { mode: 'cloud', name: '服务端定时采集', note: '数据来自服务端采集的行情接口' }
  });
}

/* ---------------- 用户数据 ---------------- */

async function currentUser() {
  var ctx = cloud.getWXContext();
  var openid = ctx.OPENID;
  if (!openid) return null;
  var res = await db.collection(C.users).where({ openid: openid }).get();
  var doc = (res.data && res.data[0]) || null;
  if (!doc) {
    await db.collection(C.users).add({
      openid: openid,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString()
    });
  } else {
    await db.collection(C.users).where({ openid: openid }).update({
      data: { lastActiveAt: new Date().toISOString() }
    });
  }
  return { openid: openid };
}

async function actionRulesList() {
  var user = await currentUser();
  if (!user) return fail('无法获取用户标识', 'NO_OPENID');
  var res = await db.collection(C.rules).where({ userId: user.openid }).get();
  return ok({ rules: res.data || [] });
}

async function actionRulesSave(payload) {
  var user = await currentUser();
  if (!user) return fail('无法获取用户标识', 'NO_OPENID');
  var rules = payload.rules || [];
  var old = await db.collection(C.rules).where({ userId: user.openid }).get();
  var oldDocs = old.data || [];

  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    var matched = null;
    for (var j = 0; j < oldDocs.length; j++) {
      if (oldDocs[j].regionCode === rule.regionCode && oldDocs[j].fuelId === rule.fuelId) {
        matched = oldDocs[j];
        break;
      }
    }
    var doc = Object.assign({}, rule, {
      userId: user.openid,
      updatedAt: new Date().toISOString()
    });
    if (matched) {
      await db.collection(C.rules).doc(matched._id).update({ data: doc });
    } else {
      await db.collection(C.rules).add({ data: doc });
    }
  }
  return ok({ rules: rules });
}

async function actionHistoryList() {
  var user = await currentUser();
  if (!user) return fail('无法获取用户标识', 'NO_OPENID');
  var res = await db.collection(C.logs).where({ userId: user.openid }).orderBy('time', 'desc').limit(50).get();
  return ok({ history: res.data || [] });
}

async function actionHistorySave(payload) {
  var user = await currentUser();
  if (!user) return fail('无法获取用户标识', 'NO_OPENID');
  var history = payload.history || [];
  for (var i = 0; i < history.length; i++) {
    await db.collection(C.logs).add({
      data: Object.assign({}, history[i], { userId: user.openid, time: history[i].time || new Date().toISOString() })
    });
  }
  return ok({ history: history });
}

/* ---------------- 入口 ---------------- */

exports.main = async (event) => {
  var payload = event || {};
  try {
    switch (payload.action) {
      case 'regions': return await actionRegions();
      case 'home': return await actionHome(payload);
      case 'trend': return await actionTrend(payload);
      case 'notices': return await actionNotices(payload);
      case 'market': return await actionMarket(payload);
      case 'rules.list': return await actionRulesList();
      case 'rules.save': return await actionRulesSave(payload);
      case 'history.list': return await actionHistoryList();
      case 'history.save': return await actionHistorySave(payload);
      case 'openid': {
        var user = await currentUser();
        return ok({ openid: user ? user.openid : '' });
      }
      default:
        return fail('未知 action: ' + payload.action, 'UNKNOWN_ACTION');
    }
  } catch (err) {
    console.error('[oilApi] action failed', payload.action, err);
    return fail((err && err.errMsg) || String(err), 'INTERNAL_ERROR');
  }
};
