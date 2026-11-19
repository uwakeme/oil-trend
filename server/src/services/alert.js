/**
 * 提醒匹配与订阅消息下发
 *
 * 逻辑与早期云函数实现一致（云函数已下线，见 git 历史），
 * 订阅消息走微信官方 HTTP 接口，数据访问走 DAO。
 *
 * 匹配优先级（与设计文档一致）：
 *   1. 官方正式降价 —— 可信度最高，默认开启
 *   2. 达到用户目标价 —— 按地区 + 油品匹配
 *   3. 预测下调 —— 默认关闭，需用户主动开启
 *
 * ⚠️ 订阅消息是**一次性**授权：用户每次点同意只够发一条。
 * 所以命中多条也只发第一条，发成功后把这条规则的订阅额度用掉，
 * 用户要再收必须重新授权（提醒页会如实显示「授权已用完」）。
 */
const dao = require('../dao');
const shared = require('../shared/shared');
const subscribe = require('./subscribe');
const templates = require('./subscribe-templates');
// 挂牌价测算：官方公告只给吨价，每升幅度要靠各地挂牌价的前后快照差值
const measure = require('./measure');

/**
 * 模板字段映射
 *
 * ⚠️ 字段名必须与「微信公众平台 → 订阅消息 → 模板详情」里的占位符**一字不差**，
 * 自己起名（thing1、price…）平台一律拒收（errcode 47003）。
 *
 * 当前模板「油价调整提醒」（编号 1103，信息查询）只有 5 个字段：
 *   thing5  油品种类  thing  （≤20 字符）
 *   amount2 调整价格  amount （≤10 字符，形如 "0.13元"）
 *   phrase1 调整方向  phrase （≤5 字符）
 *   date3   调整日期  date   （"2026年11月24日"）
 *   thing4  温馨提示  thing  （≤20 字符）
 *
 * 模板里**没有**「地区」「当前价」「目标价」字段，
 * 地区与当前价只能塞进「温馨提示」。
 *
 * 字段名的唯一真源是 subscribe-templates.js（平台模板的镜像），
 * 这里不再另写一份，换模板只改契约表。
 */
function templateFieldsOf(templateId) {
  var tpl = templates.templateOf(templateId);
  if (!tpl) return null;
  var fields = {};
  Object.keys(tpl.fields).forEach(function (key) {
    fields[key] = tpl.fields[key].label;
  });
  return fields;
}

var REMINDER_FIELDS = templateFieldsOf(templates.PRIMARY_TEMPLATE_ID);

/** 三种提醒共用同一个模板：字段语义一样，只是填的值不同 */
var TEMPLATE_FIELDS = {
  officialDrop: { page: 'pages/index/index', fields: REMINDER_FIELDS },
  targetPrice: { page: 'pages/index/index', fields: REMINDER_FIELDS },
  forecastDrop: { page: 'pages/index/index', fields: REMINDER_FIELDS }
};

function fuelName(id) {
  return { '92': '92# 汽油', '95': '95# 汽油', '98': '98# 汽油', '0': '0# 柴油' }[id] || id + '#';
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/**
 * 地区名。
 *
 * ⚠️ alert_rules 表里**没有** region_name 列，rule.regionName 永远是 undefined，
 * 以前写 rule.regionName || rule.regionCode 拿到的是 '440000' 这种代码。
 * 而且 shared.regionByCode 找不到时会静默回退上海 —— 这里自己查，
 * 查不到就退回原始代码，不能张冠李戴。
 */
function regionNameOf(regionCode) {
  var list = shared.REGIONS || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].code === regionCode) return list[i].name;
  }
  return regionCode || '';
}

/**
 * 服务器「今天」（按 UTC+8 日历日）。
 *
 * ⚠️ 不能用 shared.clock.today()：那是**演示数据**的平移日期，
 * 线上真实场景拿来当今天会算错日期。
 */
function todayCN() {
  var t = new Date(Date.now() + 8 * 3600000);
  return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate());
}

/**
 * 规则从哪一天开始接收事件。
 *
 * ⚠️ alert_rules.armed_at 是「规则最后一次保存的时间」。
 * 事件日期早于它 → 这条事件在规则生效前就发生了，不该再补发通知
 * （新装的用户会收到一堆早就过去的调价通知）。
 *
 * 比的是**事件本身的日子**（官方公告的执行日 / 预测的调价日），
 * 不是「消息什么时候发出去」—— 公告提前几天发布是常事，
 * 按发布时间比会把刚公布的下一轮也判成过期。
 */
function armedDateOf(rule) {
  var v = rule && rule.armedAt;
  if (!v) return '';
  var t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  if (!isFinite(t)) return '';
  var d = new Date(t + 8 * 3600000);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

/**
 * 事件日期是否不早于规则生效日。
 *
 * 老规则没有 armed_at 字段 → 不限制（别因为缺字段把提醒全灭掉）。
 * 事件日期解析不出来 → 也不限制（不猜）。
 */
function eventAfterArmed(rule, eventDate) {
  var armed = armedDateOf(rule);
  if (!armed) return true;
  var d = String(eventDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return true;
  return d >= armed;
}

/**
 * 官方方向 → 期望的涨跌符号：下调 -1 / 上调 1 / 不明 0。
 *
 * 用来筛掉方向相反的价格变化：窗口里可能混着上一轮遗留的价差，
 * 方向不对就不是本轮的变化点。
 */
function signOfDirection(direction) {
  if (direction === 'down') return -1;
  if (direction === 'up') return 1;
  return 0;
}

/**
 * 官方降价提醒里的「每升调整幅度」。
 *
 * ⚠️ 口径不能混算，优先级从准到粗：
 *   1. official —— 来源直接公布了每升四油品幅度，原样用；
 *   2. local    —— 本地区挂牌价的前后快照差值（实测），温馨提示标「本地区实测」；
 *   3. median   —— 各省挂牌价前后差值的中位数（测算），温馨提示标「测算」；
 *   4. 都没有   → null：模板的「调整价格」填不了就不填，这条不发。
 *
 * 官方公告只给吨价（汽/柴油，元/吨），不给每升幅度 ——
 * 直接拿吨价填「调整价格」会把两个口径混在一起，
 * 用户会看到「调整价格 645元」，以为每升降了 645 元。
 */
function officialAmountOf(notice, fuelId, ctx) {
  var options = ctx || {};
  var dir = notice.direction || '';
  var candidates = [];

  var official = (notice.changes || {})[fuelId];
  if (typeof official === 'number' && isFinite(official)) {
    candidates.push({ amount: official, source: 'official' });
  }
  var local = options.localAmount;
  if (local && typeof local.delta === 'number' && isFinite(local.delta) && local.delta !== 0) {
    candidates.push({ amount: local.delta, source: 'local' });
  }
  var median = options.medianAmounts ? options.medianAmounts[fuelId] : null;
  if (typeof median === 'number' && isFinite(median) && median !== 0) {
    candidates.push({ amount: median, source: 'median' });
  }

  // ⚠️ 方向一致性：幅度必须与公告方向**同向**。
  // 脏快照或错窗口会给出反方向的差值（公告说下调，快照却是上涨）——
  // 直接取绝对值发出去，等于把「上涨」包装成「官方降价」。
  // 反向的一律不用；都反向了就一个都不用（宁可不发）。
  var want = dir === 'up' ? 1 : (dir === 'down' ? -1 : 0);
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (!want) {
      // 方向不明：只有**官方公布**的幅度可以用（官方给什么就是什么）
      if (c.source === 'official') return c;
      continue;
    }
    if (want > 0 ? c.amount > 0 : c.amount < 0) return c;
  }
  return null;
}

/** 官方降价的温馨提示：地区、现价，以及幅度是什么口径 */
function officialTip(regionName, currentText, source) {
  var base = regionName + '现价' + currentText + '元';
  if (source === 'local') return base + '·本地区实测';
  if (source === 'median') return base + '·测算';
  return base;
}

/**
 * 把调价窗口整理成「预测提醒」能用的形状。
 *
 * ⚠️ 预测提醒的真正来源是 oil_windows（预测源写的那一条），
 * 不是 oil_notices —— 预测源只写窗口，从不写 kind='forecast' 的通知，
 * 以前去通知表里取最新预测永远取不到，预测提醒从来没触发过。
 *
 * 窗口已经过去 = 这一轮已经执行了，挂在下面的预测早就失效 → 不给。
 */
function forecastOf(windowDoc, today) {
  if (!windowDoc) return null;
  var forecast = windowDoc.forecast || {};
  var dir = windowDoc.forecastDirection || forecast.direction || '';
  if (!dir) return null;
  var date = String(windowDoc.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (date < today) return null;
  return {
    kind: 'forecast',
    executeAt: date,
    direction: dir,
    literMin: typeof forecast.literMin === 'number' ? forecast.literMin : null,
    literMax: typeof forecast.literMax === 'number' ? forecast.literMax : null
  };
}

/** 预测提醒的温馨提示：区间 + 非官方 */
function forecastTip(min, max) {
  return '约' + min.toFixed(2) + '-' + max.toFixed(2) + '元·整轮·非官方';
}

/**
 * 组装一条订阅消息的 data。
 *
 * 值一律走 subscribe-templates.js 的格式化函数：
 *   amount2 只能给「数字+元」，"0.13 元/升" 会被平台判格式非法；
 *   date3   只能给中文年月日，"2026-11-24" 解析不了；
 *   phrase1 最多 5 个字符，thing 最多 20 个字符。
 */
function buildData(opts) {
  return {
    thing5: templates.formatThing(opts.fuel),
    amount2: templates.formatAmount(opts.amount),
    phrase1: templates.formatPhrase(opts.direction),
    date3: templates.formatDate(opts.date),
    thing4: templates.formatThing(opts.tip)
  };
}

/**
 * 下发一条订阅消息
 *
 * 发之前先按模板契约自检：字段名对不上、值格式不合法，
 * 平台会直接拒收（47003 / 47002），报错还很难看出是哪一项。
 * 自己先拦下来，日志里才有可读的原因。
 */
function sendSubscribe(openid, template, templateData) {
  var templateId = subscribe.templateId();
  if (!templateId) {
    return Promise.resolve({ sent: false, reason: 'TEMPLATE_NOT_CONFIGURED' });
  }
  // 模板 ID 没登记在契约表里 → 不知道该填哪几个字段，硬发只会被拒
  if (!templates.templateOf(templateId)) {
    return Promise.resolve({ sent: false, reason: 'TEMPLATE_NOT_REGISTERED:' + templateId });
  }
  var check = templates.validate(templateId, templateData);
  if (!check.ok) {
    return Promise.resolve({ sent: false, reason: 'TEMPLATE_DATA_INVALID:' + check.errors.join(',') });
  }
  return subscribe.send({
    openid: openid,
    templateId: templateId,
    page: template.page,
    data: templateData
  });
}

/**
 * 匹配单条规则
 */
function matchRule(rule, prices, latestNotice, forecastNotice, ctx) {
  var hits = [];
  var options = ctx || {};

  var priceDoc = null;
  prices.forEach(function (p) {
    if (p.regionCode === rule.regionCode && p.fuelId === rule.fuelId) priceDoc = p;
  });
  if (!priceDoc) return hits;

  var regionName = regionNameOf(rule.regionCode);
  var currentText = Number(priceDoc.price).toFixed(2);

  /* --- 1. 官方正式降价 --- */
  if (rule.officialDrop && latestNotice && latestNotice.kind === 'official') {
    var officialChanges = latestNotice.changes || {};
    var officialDelta = officialChanges[rule.fuelId];
    var noticeDir = latestNotice.direction || '';
    // 方向明确是下调才提醒。
    // ⚠️ 以前这里只看 latestNotice.changes[fuelId] —— 发改委公告入库时
    // changes 是空的（公告只给吨价），于是官方降价提醒**一次都没触发过**。
    // 方向没解析出来时，只有「官方公布了这一油品的每升降幅」才算数 ——
    // 幅度本身就是官方的说法。
    var isDrop = noticeDir === 'down' ||
      (!noticeDir && typeof officialDelta === 'number' && officialDelta < 0);
    if (isDrop && eventAfterArmed(rule, latestNotice.executeAt)) {
      var amount = officialAmountOf(latestNotice, rule.fuelId, options);
      // 每升幅度算不出来就不发：模板的「调整价格」填不了不能空着，
      // 也不能拿吨价凑一个数字上去。
      if (amount) {
        hits.push({
          type: 'officialDrop',
          dedupKey: [rule.userId, rule.regionCode, rule.fuelId, 'official', latestNotice.executeAt].join('::'),
          title: rule.fuelId + '# ' + fuelName(rule.fuelId) + ' 官方降价',
          price: priceDoc.price,
          template: TEMPLATE_FIELDS.officialDrop,
          data: buildData({
            fuel: fuelName(rule.fuelId),
            amount: Math.abs(amount.amount),
            direction: '下调',
            date: latestNotice.executeAt,
            // 模板没有「地区」字段，地区和当前价只能写进温馨提示
            tip: officialTip(regionName, currentText, amount.source)
          })
        });
      } else if (options.skipped) {
        // 公告方向明确是下调，但每升幅度一个都拿不到（快照还没采到 / 方向对不上）。
        // 记一笔，让运维看得见「为什么这条提醒没发出去」，
        // 而不是安静地什么都不发。
        options.skipped.push({
          type: 'officialDrop',
          reason: 'NO_LITER_AMOUNT',
          regionCode: rule.regionCode,
          fuelId: rule.fuelId,
          executeAt: latestNotice.executeAt
        });
      }
    }
  }

  /* --- 2. 目标价 --- */
  if (rule.targetEnabled && typeof rule.targetPrice === 'number') {
    if (priceDoc.price <= rule.targetPrice) {
      // 去重键带上「价格事件」：
      // ⚠️ 原来只带目标价，同一目标价发过一次之后，
      // 用户重新授权也发不出来 —— 旧的 dedupKey 把它永久挡住了，
      // 界面却提示「重新授权才能再收」。
      // 口径：目标价提醒按**价格变化**触发 —— 同一轮价格变化只提醒一次，
      // 下一轮价格变化后可以再次提醒。
      var eventKey = priceDoc.changeAt || String(priceDoc.price);
      hits.push({
        type: 'targetPrice',
        dedupKey: [rule.userId, rule.regionCode, rule.fuelId, 'target', rule.targetPrice, eventKey].join('::'),
        title: '已达目标价 ' + rule.targetPrice.toFixed(2),
        price: priceDoc.price,
        template: TEMPLATE_FIELDS.targetPrice,
        data: buildData({
          fuel: fuelName(rule.fuelId),
          // 「调整价格」在目标价场景填目标价，方向填「已达目标」
          amount: rule.targetPrice,
          direction: '已达目标',
          date: todayCN(),
          tip: regionName + '现价' + currentText + '元'
        })
      });
    }
  }

  /* --- 3. 预测下调（默认关闭） --- */
  //
  // ⚠️ 预测源给的是**整轮区间**（元/升），没有分油品幅度 ——
  // 把区间中值复制给四个油品等于替来源猜了四个数。
  // 模板的「调整价格」只能放一个数字，这里放来源给的**区间下界**，
  // 区间与「非官方」写进温馨提示，不编中值。
  if (rule.forecastDrop && forecastNotice && forecastNotice.direction === 'down' &&
      eventAfterArmed(rule, forecastNotice.executeAt)) {
    var fMin = forecastNotice.literMin;
    var fMax = forecastNotice.literMax;
    // 幅度没解析出来时不能编：宁可不发这条，也不填一个猜的数。
    if (typeof fMin === 'number' && typeof fMax === 'number') {
      hits.push({
        type: 'forecastDrop',
        dedupKey: [rule.userId, rule.regionCode, rule.fuelId, 'forecast', forecastNotice.executeAt].join('::'),
        title: '预测下调（非官方）',
        price: priceDoc.price,
        template: TEMPLATE_FIELDS.forecastDrop,
        data: buildData({
          fuel: fuelName(rule.fuelId),
          amount: fMin,
          direction: '预计下调',
          date: forecastNotice.executeAt,
          tip: forecastTip(fMin, fMax)
        })
      });
    }
  }

  return hits;
}

/**
 * 失败分类：可重试 / 不可重试。
 *
 * 可重试 —— 网络抖动、平台限流（45009）、access_token 失效（40001/40014）：
 *   下一轮重来就行，占位必须释放，否则这个事件被永久锁死。
 * 不可重试 —— 模板没配 / 数据不合契约 / 用户没有订阅额度（43101）：
 *   再发多少次都一样，占位留着当失败凭据，额度一并用掉。
 */
function classifyFailure(reason) {
  var s = String(reason || '');
  if (!s) return 'retryable';
  // 平台侧配置/参数问题：TEMPLATE_NOT_CONFIGURED / TEMPLATE_DATA_INVALID …
  if (/^TEMPLATE_/.test(s)) return 'permanent';
  var m = s.match(/^(\d{4,5}):/);
  if (m) {
    var code = m[1];
    // 43101 无订阅额度、47002/47003 值或模板非法、40003 openid 非法
    if (code === '43101' || code === '47002' || code === '47003' || code === '40003') return 'permanent';
    return 'retryable';
  }
  // 没有错误码的（网络异常、请求超时等）都能再试
  return 'retryable';
}

/**
 * 按顺序找第一条没发过的事件发出去。
 *
 * ⚠️ 一次性订阅的授权额度只有 1 条：命中多条也只发第一条，
 * 发完这条规则的额度就没了。
 */
function sendFirstHit(rule, hits, summary) {
  var index = 0;

  function step() {
    if (index >= hits.length) {
      summary.skipped++;
      return Promise.resolve(null);
    }
    var hit = hits[index++];
    // ⚠️ 去重要**前置**：先占住去重键，占到的人才有资格发消息。
    // 原来是「查有没有发过 → 发 → 落库」，去重发生在副作用之后：
    // 两个实例同时跑时两边都查不到，都会发一遍，用户收到两条。
    return dao.logs.reserve({
      userId: rule.userId,
      dedupKey: hit.dedupKey,
      payload: { type: hit.type, title: hit.title, price: hit.price, data: hit.data }
    }).then(function (reserved) {
      // 占不到 = 这个键已经被人处理过了，换下一条
      if (!reserved) return step();
      summary.matched++;
      return sendSubscribe(rule.userId, hit.template, hit.data).then(function (result) {
        if (result.sent) {
          return dao.logs.markResult(reserved.id, true, null).then(function () {
            summary.details.push({
              userId: rule.userId,
              type: hit.type,
              sent: true,
              reason: ''
            });
            summary.sent++;
            // 一次性订阅：额度用掉，用户要再收必须重新授权
            return dao.rules.consumeSubscribe(rule).then(function () { return null; });
          });
        }
        // 失败：分「可重试」和「不可重试」两种处理
        var reason = result.reason || 'UNKNOWN';
        summary.details.push({
          userId: rule.userId,
          type: hit.type,
          sent: false,
          reason: reason
        });
        summary.failed++;
        if (classifyFailure(reason) === 'retryable') {
          // 把占位释放掉：这一轮没发成，下一轮还能重试。
          // ⚠️ 之前不管成没成都把占位行留着 —— 网络抖动一次，
          // 这个事件的 dedupKey 就被永久占住，再也发不出第二次。
          return dao.logs.release(reserved.id).then(function () { return null; });
        }
        // 不可重试：留着失败记录当凭据，并把额度用掉（再发也是白发）
        return dao.logs.markResult(reserved.id, false, reason).then(function () {
          return dao.rules.consumeSubscribe(rule).then(function () { return null; });
        });
      });
    });
  }

  return step();
}

function run() {
  var summary = { checked: 0, matched: 0, sent: 0, skipped: 0, failed: 0, details: [] };

  return Promise.all([
    dao.rules.listAll(1000, 0),
    dao.prices.listAll(),
    dao.notices.latestByKind('official'),
    // 预测提醒的来源是调价窗口（oil_windows）——
    // ⚠️ 以前这里取的是 notices.latestByKind('forecast')，
    // 而预测源只写 oil_windows、从不写 kind='forecast' 的通知，
    // 查出来永远是 null：预测提醒在生产上从来没有过数据入口。
    dao.windows.latest()
  ]).then(function (r0) {
    var rules = r0[0];
    var prices = r0[1];
    var latestNotice = r0[2];
    var forecast = forecastOf(r0[3], todayCN());

    // 本地区快照缓存：同一个 (地区, 油品, 生效日) 只查一次历史价
    var snapshotCache = {};

    // 官方每升幅度的中位数：各省挂牌价实测差值，一轮算一次，所有规则共用
    var medianTask = (latestNotice && latestNotice.direction === 'down')
      ? measure.measureOne(latestNotice.executeAt, latestNotice.tonChanges)
      : Promise.resolve({});

    return medianTask.then(function (medianAmounts) {
      // 「为什么没发」也要看得见：公告说下调但每升幅度拿不到时，
      // 安静地跳过会让人以为提醒链路坏了。
      var skippedReasons = [];
      summary.skipReasons = skippedReasons;
      return rules.reduce(function (chain, rule) {
        return chain.then(function () {
          summary.checked++;

          // 没授权订阅就不发
          if (!rule.subscribeGranted) {
            summary.skipped++;
            return null;
          }

          // 本地区这一轮的前后快照（实测）：官方公告只给吨价，
          // 每升幅度要靠本地区挂牌价的前后差值
          var localTask = Promise.resolve(null);
          if (rule.officialDrop && latestNotice && latestNotice.executeAt) {
            var cacheKey = rule.regionCode + '|' + rule.fuelId + '|' + latestNotice.executeAt;
            if (!snapshotCache[cacheKey]) {
              snapshotCache[cacheKey] = measure.localSnapshotOf(
                rule.regionCode, rule.fuelId, latestNotice.executeAt,
                // 已知官方方向时，方向相反的价格变化不算本轮的变化点
                { expectSign: signOfDirection(latestNotice.direction) });
            }
            localTask = snapshotCache[cacheKey];
          }

          return localTask.then(function (localAmount) {
            var hits = matchRule(rule, prices, latestNotice, forecast, {
              medianAmounts: medianAmounts,
              localAmount: localAmount,
              skipped: skippedReasons
            });
            if (!hits.length) return null;

            return sendFirstHit(rule, hits, summary);
          });
        });
      }, Promise.resolve());
    });
  }).then(function () {
    return summary;
  });
}

module.exports = {
  run: run,
  matchRule: matchRule,
  buildData: buildData,
  // 导出给自检用：失败分类决定占位放不放，两边必须一致
  classifyFailure: classifyFailure,
  regionNameOf: regionNameOf,
  todayCN: todayCN,
  // 导出给自检用：规则生效时间与预测窗口的整理规则
  armedDateOf: armedDateOf,
  eventAfterArmed: eventAfterArmed,
  forecastOf: forecastOf,
  officialAmountOf: officialAmountOf,
  TEMPLATE_FIELDS: TEMPLATE_FIELDS
};
