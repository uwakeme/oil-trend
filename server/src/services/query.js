/**
 * 查询类业务
 *
 * ⚠️ 返回结构必须与小程序端的期望完全一致 ——
 * 小程序端 utils/api.js 的 hasExpected() 会检查必需字段，
 * 结构对不上就会静默回落到演示数据，页面看着正常但实际没走服务端。
 *
 * 查询逻辑与早期云函数实现一致（云函数已下线，见 git 历史），算法部分没改。
 */
const dao = require('../dao');
const shared = require('../shared/shared');
// 挂牌价测算：公告只给吨价，每升四油品幅度靠各地挂牌价的前后快照差值
const measure = require('./measure');
const sources = require('./sources');

/* ---------------- 时间辅助 ---------------- */

function todayStr() {
  // 统一按 UTC+8 日历日算（与 collector.js / alert.js 一致）：
  // 服务器可能跑在 UTC，用本地时区会在早上 8 点前差一天 ——
  // 推算下一轮调价日时差一天，整张窗口卡上的日期就都错了。
  var d = new Date(Date.now() + 8 * 3600000);
  var m = d.getUTCMonth() + 1;
  var day = d.getUTCDate();
  return d.getUTCFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

function dayDiff(fromDate, toDate) {
  var a = new Date(fromDate + 'T00:00:00Z').getTime();
  var b = new Date(toDate + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

/* ---------------- 公共读取 ---------------- */

/**
 * 解析地区代码。
 *
 * ⚠️ 不能直接用 shared.regionByCode —— 它找不到时会静默回退上海（REGIONS[0]），
 * 传 ?regionCode=999999 会返回「上海 · 上海」但价格、走势都是空的，
 * 用户拿到的是自相矛盾的数据，而且没有任何错误码。
 * 传错了要明确报错（「没传」才用默认地区）。
 */
function resolveRegion(regionCode) {
  var code = regionCode || shared.DEFAULT_REGION_CODE;
  var region = shared.findRegion ? shared.findRegion(code) : null;
  if (!region) {
    var err = new Error('地区代码不存在：' + code);
    err.code = 'INVALID_REGION';
    throw err;
  }
  return region;
}

function getPrices(regionCode) {
  return dao.prices.listByRegion(regionCode);
}

function getWindow() {
  return dao.windows.latest();
}

function getLatestNotice() {
  return dao.notices.latestOfficial();
}

function getAdjustEvents() {
  return dao.events.listAll();
}

/**
 * 最近一次**实际调价日（执行日）** —— 推算下一轮调价日的基准。
 *
 * ⚠️ 两张表的日期不是一个口径，混着取最大值会整体多推一天：
 *   - 官方公告节点的 executeAt 就是**执行日**（公告写「X月X日24时起」的那个 X）；
 *   - 历史推导节点（oil_adjust_events）的 date 是**挂牌价生效日** ——
 *     新价从执行日次日 00:00 才开始挂牌，所以推导节点要减一天才是执行日。
 *
 * 实测：官方公告 2026-11-12 执行 → 推导节点记的是 2026-11-13；
 *       不减一天的话，下一轮会推成 11-27 而不是 11-26。
 *
 * 未来的节点不算「已发生」（来源可能已经预告了下一轮）。
 *
 * @returns {Promise<string>} 'YYYY-MM-DD'；没有任何节点时返回空串
 */
function latestAdjustDate() {
  return Promise.all([
    dao.notices.listPublic('official', 60, 0),
    dao.events.listAll()
  ]).then(function (r) {
    var today = todayStr();
    var best = '';
    // 官方公告：日期本身就是执行日
    (r[0] || []).forEach(function (n) {
      var d = String(n.executeAt || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today && d > best) best = d;
    });
    // 历史推导：日期是生效日，减一天才是执行日
    (r[1] || []).forEach(function (e) {
      var d = shiftDate(String(e.date || '').slice(0, 10), -1);
      if (d && d <= today && d > best) best = d;
    });
    return best;
  });
}

/**
 * 历史价的来源说明。
 *
 * ⚠️ 必须如实写清数据的来源与覆盖范围：走势图画的是**各省公布的挂牌价**，
 * 不是官方公告。写「官方数据」是把实测值说成官方公布值，口径就错了。
 * 调价幅度也是各省挂牌价的前后差值（实测），不是官方公布的每升幅度。
 */
function historyNote(history) {
  if (!history || !history.length) return '';
  var ids = {};
  history.forEach(function (h) { if (h.source) ids[h.source] = 1; });
  var names = Object.keys(ids).map(function (id) {
    var s = sources.SOURCES.filter(function (x) { return x.id === id; })[0];
    return s ? s.name : id;
  });
  var dates = {};
  history.forEach(function (h) { dates[h.date] = 1; });
  var periods = Object.keys(dates).length;
  return '历史价来自' + names.join('、') +
    '，覆盖 ' + history[0].date + ' 起 ' + periods + ' 期 · 调价幅度据各省挂牌价实测';
}

/**
 * 一次取回某个地区全部油品的历史价，按油品分组。
 * 之前每个油品查一次，4 个油品就是 4 次串行查询。
 */
function getHistoryByRegion(regionCode, fromDate) {
  return dao.history.listByRegion(regionCode, fromDate).then(function (all) {
    var byFuel = {};
    all.forEach(function (h) {
      if (!byFuel[h.fuelId]) byFuel[h.fuelId] = [];
      byFuel[h.fuelId].push(h);
    });
    return byFuel;
  });
}

function buildWindow(windowDoc, lastAdjustDate) {
  var today = todayStr();
  // 推算下一轮调价日。
  //
  // ⚠️ 推算值不是官方公布值：预测源在两轮之间会空窗（站点把区块改成公布上一轮结果），
  // 这段时间里来源没有下一轮窗口可给。界面上必须标「推算 · 非官方」，
  // 来源一旦公布真实窗口，就用真实值覆盖推算值。
  var estimate = lastAdjustDate
    ? shared.ADJUST_CYCLE.estimateNext(lastAdjustDate, undefined, today)
    : null;
  if (!windowDoc) {
    // 来源根本没有窗口记录时，日期留空 ——
    // 写 date=today 会让倒计时显示成「就是今天」，那是假结论。
    // 前端拿到空日期会改用推算值（并标「推算 · 非官方」）；
    // 连推算依据都没有时就不渲染窗口卡，比显示一个假日期强。
    return {
      date: '',
      time: '24:00',
      daysLeft: 0,
      isOfficial: false,
      basis: '暂无窗口数据',
      forecast: {},
      estimate: estimate
    };
  }
  var daysLeft = dayDiff(today, windowDoc.date);
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
    forecast: windowDoc.forecast || {},
    // 幅度可能解析不出来（forecast 为空对象），方向单独给 ——
    // 前端靠它区分「持平」和「有方向但幅度待公布」
    forecastDirection: windowDoc.forecastDirection || '',
    // 推算的下一轮调价日与下次公告发布日（来源没公布时用）
    estimate: estimate
  };
}

/* ---------------- 地区列表 ---------------- */

function actionRegions() {
  return Promise.all([getPrices(shared.DEFAULT_REGION_CODE), dao.prices.listAll()]).then(function (all) {
    var allPrices = all[1];
    var map = {};
    allPrices.forEach(function (p) {
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
    return { regions: regions };
  });
}

/* ---------------- 首页 ---------------- */

/**
 * 本地区最近一次调价：从历史序列里找最后一次价格变化。
 *
 * 口径与价格行的 changeAmount 一致：**本地区**挂牌价的前后差值。
 * 不用各省中位数 —— 那是通知卡的口径，两边混了会对不上账。
 *
 * @param {Array} rows 历史价行（按日期升序）
 * @param {string} fuelId
 * @returns {object} { amount, date } 或 null
 */
function lastAdjustmentOf(rows, fuelId) {
  var list = (rows || []).filter(function (h) { return h.fuelId === fuelId; });
  for (var i = list.length - 1; i > 0; i--) {
    var now = Number(list[i].price);
    var prev = Number(list[i - 1].price);
    if (!isFinite(now) || !isFinite(prev)) continue;
    if (now !== prev) {
      return { amount: Math.round((now - prev) * 100) / 100, date: list[i].date };
    }
  }
  return null;
}

function actionHome(payload) {
  var regionCode = payload.regionCode || shared.DEFAULT_REGION_CODE;
  var region = resolveRegion(regionCode);

  return Promise.all([
    getPrices(regionCode),
    getWindow(),
    getLatestNotice(),
    // 推算下一轮调价日的基准：最近一次实际调价日
    latestAdjustDate()
  ]).then(function (r0) {
    var prices = r0[0];
    var win = r0[1];
    var notice = r0[2];
    var lastAdjustDate = r0[3];

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

    // 最后采集时间：取本地区价格里最新的 updatedAt。
    // ⚠️ 后端原来不返回这个字段，前端拼出来的是「 更新」（空日期 + 更新两个字）。
    var updatedAt = '';
    prices.forEach(function (p) {
      if (p.updatedAt && (!updatedAt || p.updatedAt > updatedAt)) updatedAt = p.updatedAt;
    });

    var today = todayStr();
    var from30 = new Date(new Date(today + 'T00:00:00Z').getTime() - 29 * 86400000).toISOString().slice(0, 10);

    var labels = [
      from30.slice(5).replace('-', '月') + '日',
      new Date(new Date(today + 'T00:00:00Z').getTime() - 14 * 86400000).toISOString().slice(0, 10).slice(5).replace('-', '月') + '日',
      today.slice(5).replace('-', '月') + '日'
    ];

    return Promise.all([
      getHistoryByRegion(regionCode, from30),
      // 挂牌价测算：公告只给吨价，每升四油品幅度靠各地挂牌价的前后快照差值
      notice ? measure.measureOne(notice.executeAt, notice.tonChanges) : Promise.resolve({}),
      // 全量历史：给价格行补基线用（见下面的补基线逻辑）
      dao.history.listByRegion(regionCode)
    ]).then(function (r1) {
      var historyByFuel = r1[0];
      var measuredRaw = r1[1];
      var fullHistory = r1[2];

      // 价格行没有基线（changeAt 为空）时，用本地区历史序列补出最近一次调价。
      // 换源那一轮同源基线取不到，采集器会把它清空；采集器已改成从本源历史表重建，
      // 但采集有 6 小时新鲜期，最长要等下一轮真抓才生效 —— 这里先兜住，
      // 免得首页四个油品长时间显示「暂无调价对比」。
      // ⚠️ 口径必须是**本地区**前后差值，不能拿各省中位数来充。
      if (fullHistory && fullHistory.length) {
        priceList.forEach(function (item) {
          if (item.changeAt) return;
          var adj = lastAdjustmentOf(fullHistory, item.id);
          if (!adj) return;
          item.changeAmount = adj.amount;
          item.changeAt = adj.date;
          item.direction = adj.amount < 0 ? 'down' : (adj.amount > 0 ? 'up' : 'flat');
        });
      }
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

      // 首页的来源说明：四个油品的历史合起来算覆盖范围
      var homeHistory = [];
      shared.FUELS.forEach(function (f) {
        (historyByFuel[f.id] || []).forEach(function (h) { homeHistory.push(h); });
      });
      homeHistory.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
      var homeNote = historyNote(homeHistory);

      var changes = {};
      if (notice && notice.changes) {
        shared.FUELS.forEach(function (f) { changes[f.id] = notice.changes[f.id]; });
      }

      // 测算值只有在方向与公告一致时才摆出来：方向矛盾说明用错了快照，
      // 摆出来比不摆更糟。
      var measuredChanges = (notice && measure.agreesWithDirection(measuredRaw, notice.direction))
        ? measuredRaw
        : {};
      var noticePayload = notice ? {
        id: notice.id,
        kind: notice.kind,
        title: notice.title,
        publishedAt: notice.publishedAt,
        // 公告发布日
        announcedAt: notice.announcedAt || '',
        executeAt: notice.executeAt,
        // 官方方向 up/down/flat
        direction: notice.direction || '',
        // 官方吨价（汽/柴油，元/吨）
        tonChanges: notice.tonChanges || {},
        // 官方公布的每升四油品幅度（发改委公告不给这一项）
        changes: notice.changes || {},
        // 挂牌价测算的每升四油品幅度 —— 不是官方公布值
        measuredChanges: measuredChanges,
        changesMeasured: Object.keys(measuredChanges).length > 0,
        summary: notice.summary || '',
        source: notice.source || {}
      } : null;

      return {
        region: { code: region.code, fullName: region.name + ' · ' + region.city },
        prices: priceList,
        // 合法为空要标出来：这个地区还没采到价，不是「后端没给成」。
        // 前端据此显示空态，而不是回落演示数据。
        empty: priceList.length === 0,
        window: buildWindow(win, lastAdjustDate),
        trend30: trend30,
        changes: changes,
        notice: noticePayload,
        // ⚠️ 小程序端读的是 latestNotice，后端原来只给 notice ——
        // 字段漂移的根源，首页通知在真实后端下整块失真。
        // 两个名字都给，前端读哪个都不会空。
        latestNotice: noticePayload,
        publishedAt: notice ? notice.publishedAt : '',
        updatedAt: updatedAt,
        source: { mode: 'server', name: '服务端定时采集', note: homeNote }
      };
    });
  });
}

/* ---------------- 走势 ---------------- */

/**
 * 调价节点之后的挂牌价。
 *
 * 生效是「X月X日24时起」，所以新价从 X+1 开始 —— 取生效日之后的第一条历史价。
 */
function priceAfterOf(history, executeAt, fallback) {
  for (var i = 0; i < history.length; i++) {
    if (history[i].date > executeAt) return history[i].price;
  }
  return fallback;
}

/**
 * 日期平移（天）。解析不出来返回 null。
 */
function shiftDate(dateStr, days) {
  var t = Date.parse(dateStr + 'T00:00:00Z');
  if (!isFinite(t)) return null;
  return new Date(t + days * 86400000).toISOString().slice(0, 10);
}

/**
 * 合并官方公告节点与历史推导节点。
 *
 * 同一次调价在两边的日期会差一天：公告写「11月12日24时起」，
 * 挂牌价从次日 00:00 生效 —— 官方节点是 11-12，推导节点是 11-13。
 * 只按精确日期合并的话，同一次调价会被数成两次：节点列表里挨着出现两条，
 * 调价次数也多算一次。所以官方节点落地时，把前后一天内的推导节点收编：
 * 保留官方节点（日期与公告一致、标题更权威），
 * 官方测不出幅度时用被收编节点的实测幅度兜底。
 *
 * @param {Array} derived 历史推导节点（oil_adjust_events）
 * @param {Array} official 官方公告节点
 * @returns {Array} 按日期升序的合并结果
 */
function mergeAdjustNodes(derived, official) {
  var merged = {};
  (derived || []).forEach(function (e) {
    merged[e.date] = e;
  });
  // 官方节点的日期集合：官方日期上的节点不许被别的官方节点收编
  var officialDates = {};
  (official || []).forEach(function (e) { officialDates[e.date] = true; });
  (official || []).forEach(function (e) {
    var fallback = null;
    // 前后一天里的推导节点 = 同一次调价
    var absorbed = null;
    [-1, 1].forEach(function (d) {
      var near = shiftDate(e.date, d);
      if (!near || officialDates[near]) return;
      var cand = merged[near];
      if (!cand || cand.measured !== true) return;
      if (!absorbed || near < absorbed) absorbed = near;
    });
    if (absorbed) {
      fallback = merged[absorbed];
      delete merged[absorbed];
    } else {
      var same = merged[e.date];
      if (same) fallback = same;
    }
    if (!e.amountKnown && fallback && fallback.amountKnown) {
      e = Object.assign({}, e, { amount: fallback.amount, amountKnown: true, measured: true });
    }
    merged[e.date] = e;
  });
  return Object.keys(merged).sort().map(function (d) { return merged[d]; });
}

function actionTrend(payload) {
  var regionCode = payload.regionCode || shared.DEFAULT_REGION_CODE;
  var fuelId = payload.fuelId || '92';
  var period = payload.period || '3m';
  var months = { '3m': 3, '6m': 6, '1y': 12 }[period] || 3;
  var region = resolveRegion(regionCode);

  var today = todayStr();
  var fromDate = new Date(new Date(today + 'T00:00:00Z').getTime() - months * 30 * 86400000).toISOString().slice(0, 10);

  return Promise.all([
    dao.history.listByRegionFuel(regionCode, fuelId, fromDate),
    getAdjustEvents(),
    getPrices(regionCode),
    dao.notices.listPublic('official', 60, 0)
  ]).then(function (r0) {
    var history = r0[0];
    var allEvents = r0[1];
    var prices = r0[2];
    var allNotices = r0[3] || [];
    // 先按当前视图截取公告，后面的吨价映射与每升幅度测算都只处理这些轮次。
    // 3 个月视图不必把查回来的 60 条历史公告全部测算一遍。
    var notices = allNotices.filter(function (n) {
      return n.executeAt && n.executeAt >= fromDate && n.executeAt <= today;
    });
    // ⚠️ 下一轮的执行日通常在**未来**（发改委提前约 10 天公布）——
    //   它不进测算列表，但**必须**留着当变化点窗口的边界（measure.js 的 nextDate）。
    //   少了它，最新一轮的每升幅度会取到下一轮的价格变化（整轮错位）。
    var nextExecDate = '';
    allNotices.forEach(function (n) {
      if (n.executeAt && n.executeAt > today && (!nextExecDate || n.executeAt < nextExecDate)) {
        nextExecDate = n.executeAt;
      }
    });

    var events = allEvents.filter(function (e) {
      return e.date >= fromDate && e.date <= today;
    });

    var values = history.map(function (h) { return h.price; });
    if (!values.length) {
      // ⚠️ 「该地区还没有历史价」是**合法的空**，不是故障。
      // 以前抛 NO_HISTORY → 前端当失败处理 → 回落演示数据，
      // 用户看到一堆假价格还以为服务挂了。
      // 现在明确标 empty:true，前端显示「暂无数据」的空态。
      return {
        region: { code: region.code, fullName: region.name + ' · ' + region.city },
        fuel: { id: fuelId, name: (shared.FUELS.filter(function (f) { return f.id === fuelId; })[0] || {}).name || fuelId },
        price: null,
        deltaPercent: 0,
        direction: 'flat',
        rangeLabel: { '3m': '近 3 个月', '6m': '近 6 个月', '1y': '近 1 年' }[period],
        low: null,
        high: null,
        count: 0,
        axis: [],
        points: [],
        events: [],
        empty: true,
        source: { mode: 'server', name: '服务端定时采集', note: '数据来自服务端采集的官方公告' }
      };
    }
    var first = values[0];
    var last = values[values.length - 1];
    var deltaPercent = first ? Number((((last - first) / first) * 100).toFixed(2)) : 0;

    var points = history.map(function (h) { return { date: h.date, value: h.price }; });

    var priceMap = {};
    prices.forEach(function (p) { priceMap[p.fuelId] = p.price; });

    // 调价当天的价格：历史节点不能都显示当前价，否则一屏节点看着像同一条
    var priceByDate = {};
    history.forEach(function (h) { priceByDate[h.date] = h.price; });

    // 调价节点优先用官方公告：公告是权威来源，
    // 每升四油品幅度由各地挂牌价的前后快照差值测算（measure.js）。
    var execDates = notices.map(function (n) { return n.executeAt; });
    // 按生效日把官方吨价带上：测算的合理区间要跟着公告走，
    // 写死阈值会把大轮调价（如 645 元/吨 ≈ 0.5 元/升）整轮剔光。
    var tonByDate = {};
    notices.forEach(function (n) {
      if (n.executeAt) tonByDate[n.executeAt] = n.tonChanges || {};
    });
    // 下一轮执行日一起传进去：变化点窗口不得越过它（见 measure.js 的 nextExecDate）
    return measure.measureMany(execDates, tonByDate, nextExecDate).then(function (measuredByDate) {
      var officialEvents = notices.map(function (n) {
        var measured = (measuredByDate[n.executeAt] || {})[fuelId];
        var known = typeof measured === 'number';
        // 幅度算不出来时用公告方向，界面显示「方向已知 · 幅度待公布」
        var dir = known
          ? (measured < 0 ? 'down' : (measured > 0 ? 'up' : 'flat'))
          : (n.direction === 'up' ? 'up' : (n.direction === 'down' ? 'down' : 'flat'));
        return {
          date: n.executeAt,
          title: n.title,
          amount: known ? measured : null,
          amountKnown: known,
          // 公告只给吨价，这里的每升金额来自挂牌价前后快照测算
          measured: known,
          direction: dir,
          priceAfter: priceAfterOf(history, n.executeAt, priceMap[fuelId])
        };
      });

      // 合并两类调价节点：
      //   官方公告 —— 覆盖最近几轮，有权威标题与方向；
      //   历史推导 —— 从各省挂牌价的前后差值推导，补齐全年节点
      //                （oil_adjust_events，采集器写）。
      //
      // ⚠️ 以前是二选一（officialEvents.length ? 官方 : 推导），
      // 公告只覆盖最近几轮 → 一年视图只有几个节点，其余全空。
      // 现在按日期合并：同一个日期两边都有时以官方为准；
      // 官方测不出幅度时用实测推导值兜底（推导值是各省挂牌价实测差值，
      // 界面上要标「据各地挂牌价测算」，不能写成官方公布值）。
      // 历史推导节点：幅度是各省挂牌价的前后差值（实测），不是官方公布值
      var derivedNodes = events.map(function (e) {
        var raw = (e.deltas || {})[fuelId];
        // ⚠️ 幅度解析不出来时不能直接置 0 —— 那会把「幅度未知」显示成「持平 0.00」。
        // 公告里没写这个油品，就是没有，不是零调整。
        var known = typeof raw === 'number';
        var delta = known ? raw : 0;
        return {
          date: e.date,
          title: e.title,
          amount: known ? delta : null,
          amountKnown: known,
          // 三态：幅度为 0 是「持平」，不是「上涨」。
          // 原来写成 < 0 ? 'down' : 'up'，持平的节点会被染成上涨色。
          direction: known ? (delta < 0 ? 'down' : (delta > 0 ? 'up' : 'flat')) : 'flat',
          measured: true,
          priceAfter: priceByDate[e.date] !== undefined ? priceByDate[e.date] : priceMap[fuelId]
        };
      });
      // 官方节点与推导节点合并：同一次调价两边日期差一天，要收编成一个
      var finalEvents = mergeAdjustNodes(derivedNodes, officialEvents);

      return {
        region: { code: region.code, fullName: region.name + ' · ' + region.city },
        fuel: { id: fuelId, name: (shared.FUELS.filter(function (f) { return f.id === fuelId; })[0] || {}).name || fuelId },
        price: last,
        deltaPercent: deltaPercent,
        direction: deltaPercent > 0 ? 'up' : (deltaPercent < 0 ? 'down' : 'flat'),
        rangeLabel: { '3m': '近 3 个月', '6m': '近 6 个月', '1y': '近 1 年' }[period],
        low: Math.min.apply(null, values),
        high: Math.max.apply(null, values),
        count: finalEvents.length,
        axis: [
          fromDate.slice(0, 7).replace('-', '/'),
          new Date(new Date(fromDate + 'T00:00:00Z').getTime() + Math.floor((months * 30 * 86400000) / 2)).toISOString().slice(0, 7).replace('-', '/'),
          today.slice(0, 7).replace('-', '/')
        ],
        points: points,
        events: finalEvents,
        source: { mode: 'server', name: '服务端定时采集', note: historyNote(history) }
      };
    });
  });
}

module.exports = {
  actionRegions: actionRegions,
  actionHome: actionHome,
  actionTrend: actionTrend,
  resolveRegion: resolveRegion,
  getPrices: getPrices,
  getWindow: getWindow,
  getLatestNotice: getLatestNotice,
  getAdjustEvents: getAdjustEvents,
  getHistoryByRegion: getHistoryByRegion,
  buildWindow: buildWindow,
  latestAdjustDate: latestAdjustDate,
  mergeAdjustNodes: mergeAdjustNodes,
  lastAdjustmentOf: lastAdjustmentOf,
  todayStr: todayStr
};
