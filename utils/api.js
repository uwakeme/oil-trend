/**
 * 数据服务层（唯一对外取数入口）
 *
 * 设计原则：**页面只认数据结构，不认数据来源**。
 *   1. 一切都走自建后端（见 utils/cloud.js）；
 *   2. 后端不可用 / 调用失败 / 返回不完整 → **如实失败**，页面显示失败态 + 重试；
 *   3. 后端明确说「合法为空」→ 页面显示空态；
 *   4. 每次取数都会回报来源，页面据此如实展示。
 *
 * ⚠️ 这里**没有本地兜底**，而且是刻意的：
 *    以前后端一挂就回落内置演示数据，用户看到的是一份「看起来很正常」的假价格，
 *    根本不知道服务已经挂了 —— 演示数据 2026-11-28 已全部删除。
 *    现在后端不可用就是失败态：宁可告诉用户「读不到」，也不给假数据。
 *
 * ⚠️ 这里没有「全局来源状态」：并发请求谁先返回谁覆盖，判定必然漂。
 * 来源一律随 payload.source 走，页面只认自己那份 payload。
 *
 * 换数据来源只需要改后端（server/），本文件与页面都不用动。
 */
const cloud = require('./cloud');
const store = require('./store');

/**
 * 来源 mode 白名单。
 *
 * 后端给的是 'server'（真实采集），小程序内部统一用 'live' 表示真实数据。
 *
 * ⚠️ 其它 mode 一律原样保留 —— 不认识的 mode 不能当成 live，
 * 那会把「来源不明」说成「真实行情」。
 */
function normalizeMode(mode) {
  if (mode === 'server') return 'live';
  return mode;
}

/**
 * 给返回值打上来源标记。
 *
 * 「后端配好了」不等于「这次数据来自后端」——
 * 后端自己标的 mode 优先（server → live），没标才用调用方给的。
 *
 * @param {object} data      后端返回的业务数据
 * @param {string} mode      调用方判定的来源
 * @param {string} transport 取数通道（给页面看内部名用）
 */
function stampSource(data, mode, transport) {
  if (data && typeof data === 'object') {
    var existing = data.source || {};
    data.source = Object.assign({}, existing, {
      mode: normalizeMode(existing.mode || mode),
      transport: transport
    });
  }
  return data;
}

/**
 * 后端返回必须带上业务字段才算成功。
 * 只判断「是不是 object」的话，后端返回 {} 会让页面拿到空数据却显示正常。
 *
 * keys     —— 必须**存在**的字段（null / undefined 视为缺）
 * valueKeys —— 必须**有值**的字段：数组要非空，数字要有限。
 *
 * ⚠️ 两类字段要分开：通知列表为空是合法的（后端确实还没有正式公告），
 * 那就显示空列表；价格表为空是真的没数据，不能拿别的东西顶上。
 */
function hasExpected(data, keys, valueKeys) {
  // 后端明确标记「合法为空」（该地区还没有历史价、还没采到价格、
  // 还没有行情）：这是真的没数据，不是「后端没给成」。
  // 这种情况直接放行，页面显示空态。
  if (data && data.empty === true) return true;
  if (!keys || !keys.length) return true;
  for (var i = 0; i < keys.length; i++) {
    if (data[keys[i]] === undefined || data[keys[i]] === null) return false;
  }
  if (!valueKeys || !valueKeys.length) return true;
  for (var j = 0; j < valueKeys.length; j++) {
    var v = data[valueKeys[j]];
    if (v === undefined || v === null) return false;
    if (Array.isArray(v) && v.length === 0) return false;
    if (typeof v === 'number' && !isFinite(v)) return false;
  }
  return true;
}

/**
 * 调后端。**没有本地兜底**：失败就如实失败。
 *
 * 三条路径：
 *   1. 后端给了完整数据 → 用它
 *   2. 后端调用失败       → reject（页面显示失败态 + 重试按钮）
 *   3. 后端返回了但不完整 → reject（页面显示失败态，不拿假数据顶上）
 *
 * 后端明确标 empty:true 的「合法为空」不算失败 —— 那是真没数据，页面显示空态。
 *
 * @param {string} name       接口名（云函数时代的 action 名，现用于路由映射）
 * @param {object} payload    业务参数（必须含 action）
 * @param {Array}  expectKeys 后端返回必须包含的业务字段
 * @param {Array}  valueKeys  后端返回必须有值的字段（数组非空 / 数字有限）
 */
function fetchBackend(name, payload, expectKeys, valueKeys) {
  return cloud.callFunction(name, payload).then(function (data) {
    if (!data || typeof data !== 'object' || !hasExpected(data, expectKeys, valueKeys)) {
      // 后端连上了但没给全 —— 是「后端暂无该数据」，不是「连接失败」，
      // 但对用户来说都是「拿不到数据」：页面只有失败态可显示，如实失败。
      throw new Error('后端返回的数据不完整');
    }
    return stampSource(data, 'live', cloud.backendName());
  });
}

/** 地区列表 */
function getRegions() {
  return fetchBackend('oilApi', { action: 'regions' }, ['regions']).then(function (res) {
    return res.regions || [];
  });
}

/**
 * 经纬度 → 省份
 *
 * 只有后端能反查（省界数据在服务端），没有本地版本。
 *
 * 返回 { regionCode, regionName, city, match }
 * 或 { error: 'no-match'（坐标不在支持的省份里）| 'unavailable'（后端挂了）| 'no-backend' }
 */
function locate(lat, lng) {
  if (!cloud.isReady()) return Promise.resolve({ error: 'no-backend' });
  return cloud.callFunction('oilApi', { action: 'locate', lat: lat, lng: lng })
    .then(function (data) {
      if (data && data.regionCode) return data;
      return { error: 'no-match' };
    })
    .catch(function () {
      return { error: 'unavailable' };
    });
}

/** 首页数据 */
function getHome(regionCode, fuelId) {
  return fetchBackend('oilApi', {
    action: 'home',
    regionCode: regionCode,
    fuelId: fuelId
  }, ['prices', 'window'], ['prices']);
}

/** 走势数据 */
function getTrend(regionCode, fuelId, period) {
  return fetchBackend('oilApi', {
    action: 'trend',
    regionCode: regionCode,
    fuelId: fuelId,
    period: period
  }, ['points'], ['points']);
}

/**
 * 调价通知数据
 *
 * ⚠️ 通知列表**允许为空**：后端确实还没有正式公告时就是空数组，
 * 这时显示空列表，不能凭空造出几条假的调价通知。
 * 所以这里不校验数组长度。
 */
function getNotices(regionCode, filter, fuelId) {
  return fetchBackend('oilApi', {
    action: 'notices',
    regionCode: regionCode,
    filter: filter,
    fuelId: fuelId
  }, ['notices']);
}

/**
 * 国际行情
 *
 * 后端查不到这个品种时返回 empty:true（合法为空）→ 页面显示空态；
 * 连不上后端 → reject → 页面显示失败态。
 * 两条路都不给假曲线。
 */
function getMarket(symbol, period) {
  return fetchBackend('oilApi', {
    action: 'market',
    symbol: symbol,
    period: period
  }, ['price', 'points'], ['points']);
}

/* ---------- 提醒规则与记录 ---------- */

/**
 * 读取提醒规则。
 *
 * ⚠️ 额外返回 confirmed：这份规则是不是**服务端确认过**的。
 * 后端不可达时回落本地副本 —— 那份只是本机留存的，
 * 不能当成「服务端已经有这条规则」：
 * 否则界面会显示「微信提醒已开启」，而服务端其实一条规则都没有，
 * 提醒永远不会来。
 *
 * @returns {Promise<{rules: Array, confirmed: boolean}>}
 */
function getAlertRules() {
  if (!cloud.isReady()) {
    return Promise.resolve({ rules: store.getRules(), confirmed: false });
  }
  return cloud.callFunction('oilApi', { action: 'rules.list' }).then(function (data) {
    if (data && Array.isArray(data.rules)) {
      return { rules: data.rules, confirmed: true };
    }
    // 后端没给规则 → 用本地留存的副本（提醒页的来源条按 home.source 显示，
    // 这里不再往全局状态里记 —— 那个状态没人消费，还会被并发请求带偏）
    return { rules: store.getRules(), confirmed: false };
  }).catch(function () {
    return { rules: store.getRules(), confirmed: false };
  });
}

/**
 * 保存提醒规则。
 *
 * @param {Array} rules 本地留存的规则（带界面状态）
 * @param {Array} [payload] 发给后端的载荷，默认与 rules 相同。
 *   两者分开是因为订阅授权是一次性的：只有「刚拿到授权」的那一次保存
 *   才带 subscribeGranted=true，之后任何保存都不带 ——
 *   否则服务端把额度用掉之后，界面上随便拨个开关就会把额度又续上，
 *   而微信那边其实已经没额度了。
 */
function saveAlertRules(rules, payload) {
  store.saveRules(rules);
  if (!cloud.isReady()) {
    return Promise.resolve({
      ok: true,
      offline: true,
      message: '未配置后端，规则只保存在本机'
    });
  }
  var body = payload || rules;
  return cloud.callFunction('oilApi', { action: 'rules.save', rules: body })
    .then(function () {
      return { ok: true, offline: false, message: '' };
    })
    .catch(function (err) {
      // ⚠️ 这里以前是 .catch(function () { return rules; }) ——
      // 后端写失败也照样 resolve，页面紧接着弹「订阅已开启」。
      // 用户以为规则生效了，服务端一条都没写，下次打开还是老样子。
      // 现在把失败如实交回去，让页面显示「未保存」并允许重试。
      return {
        ok: false,
        offline: true,
        message: (err && err.message)
          ? ('规则未保存到服务器：' + err.message)
          : '规则未保存到服务器'
      };
    });
}

/**
 * 提醒记录。
 *
 * ⚠️ 后端读不到时回落**本机留存的**记录（用户自己那条），
 * 不再回落演示记录 —— 演示数据已删，凭空造两条「发送记录」是骗用户。
 *
 * 注：本机留存的记录目前**没有写入方**（store.saveHistory 无人调用，
 * 老版本这里回落的是演示记录）。所以这条分支实际总是空数组 ——
 * 留着是为了「将来本机记录真的有内容时」不用重新设计，
 * 但别指望它现在能给出什么记录。
 */
function getAlertHistory() {
  if (!cloud.isReady()) {
    return Promise.resolve(localHistory());
  }
  return cloud.callFunction('oilApi', { action: 'history.list' }).then(function (data) {
    if (data && Array.isArray(data.history)) return data.history;
    return localHistory();
  }).catch(function () {
    return localHistory();
  });
}

/** 本地提醒记录：只有用户自己那条，没有就是空 */
function localHistory() {
  var stored = store.getHistory();
  return stored && stored.length ? stored : [];
}

module.exports = {
  getRegions: getRegions,
  locate: locate,
  getHome: getHome,
  getTrend: getTrend,
  getNotices: getNotices,
  getMarket: getMarket,
  getAlertRules: getAlertRules,
  saveAlertRules: saveAlertRules,
  getAlertHistory: getAlertHistory,
  cloudReady: cloud.isReady,
  cloudError: cloud.lastError
};
