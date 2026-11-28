const api = require('../../utils/api');
const store = require('../../utils/store');
const subscribe = require('../../utils/subscribe');
const fmt = require('../../utils/format');
const config = require('../../config/index');

const STEP = 0.05;
// ⚠️ 区间与服务端一致（server/src/config.js 的 targetPriceMin/Max）——
// 两边各写一套的话，前端允许填的值服务端会拒收，用户只看到「保存失败」。
const MIN_TARGET = Number(config.targetPriceMin);
const MAX_TARGET = Number(config.targetPriceMax);

function clamp(value) {
  var v = Number(value);
  if (!isFinite(v)) v = MIN_TARGET;
  v = Math.round(v * 100) / 100;
  if (v < MIN_TARGET) v = MIN_TARGET;
  if (v > MAX_TARGET) v = MAX_TARGET;
  return v;
}

/**
 * 默认目标价：按当前价往下让一点。
 *
 * ⚠️ 原来固定写死 7.20 元 —— 换个地区换个油品，这个数经常比现价还高，
 * 界面于是显示「已低于目标价 0.00 元」，看着像坏了。
 */
function defaultTarget(price) {
  var p = Number(price);
  if (!isFinite(p) || p <= 0) return 7.20;   // 没有当前价时的兜底
  return clamp(Math.floor((p - 0.30) * 100) / 100);
}

/**
 * 额度用掉时间 → 「11月13日」。
 *
 * ⚠️ 服务端给的是 ISO 串（UTC），直接截前 10 位会差一天 ——
 * 凌晨发的提醒在 UTC 里还是前一天。统一按 UTC+8 折算成日历日。
 */
function usedAtText(value) {
  if (!value) return '';
  var t = new Date(value);
  if (isNaN(t.getTime())) return String(value).slice(0, 10);
  return fmt.cnDate(new Date(t.getTime() + 8 * 3600000).toISOString());
}

/**
 * 记录时间 → 'YYYY-MM-DD HH:mm'（UTC+8）。
 *
 * 后端存的是 TIMESTAMP，返回的是 ISO 串（UTC），
 * 直接截前 16 位会比本地时间差 8 小时。
 */
function historyTime(value) {
  if (!value) return '';
  var t = new Date(value);
  if (isNaN(t.getTime())) return String(value).slice(0, 16);
  var iso = new Date(t.getTime() + 8 * 3600000).toISOString();
  return iso.slice(0, 10) + ' ' + iso.slice(11, 16);
}

/**
 * 历史记录 → 统一的展示结构。
 *
 * 后端返回的记录是 {userId,dedupKey,sent,failReason,time,payload}，
 * 本机留存的记录是 {id,title,time,channel,priceText} —— 字段不一样，
 * 直接渲染的话后端记录会是一片空白。
 */
function historyView(item, index) {
  if (!item) return { id: 'history-' + index, title: '', time: '', channel: '', priceText: '', sent: false };
  if (item.dedupKey) {
    var payload = item.payload || {};
    return {
      id: item.dedupKey,
      title: payload.title || '提醒记录',
      time: historyTime(item.time),
      channel: item.sent ? '订阅消息' : ('发送失败 · ' + (item.failReason || '未知原因')),
      priceText: payload.price === undefined ? '' : fmt.price(payload.price),
      sent: !!item.sent
    };
  }
  return {
    id: item.id || ('history-' + index),
    title: item.title || '',
    time: item.time || '',
    channel: item.channel || '',
    priceText: item.priceText || '',
    // 本机留存的记录没有 sent 字段，按既有的成功记录语义展示。
    sent: item.sent !== false
  };
}

Page({
  data: {
    loading: true,
    loadError: '',
    region: {},
    fuelName: '92# 汽油',
    currentPriceText: '--',
    rule: {
      officialDrop: true,
      targetEnabled: true,
      targetPrice: 7.20,
      forecastDrop: false,
      subscribeGranted: false,
      subscribeUsedAt: null
    },
    subscription: { icon: 'bell-amber', title: '', text: '', buttonText: '' },
    targetText: '7.20',
    targetCaption: '',
    targetWarn: false,
    // 规则保存状态：saving / saved / failed
    // ⚠️ 以前保存失败也被弹成「订阅已开启」，用户以为规则生效了。
    saveState: 'idle',
    saveText: '',
    // 两段规则摘要：开关关掉时要如实写「已停用」，
    // 不能不管开关状态都写「向我发送微信订阅消息」。
    officialSummary: '',
    targetSummary: '',
    forecastSummary: '',
    history: [],
    sourceText: '',
    sourceWarn: false,
    sheetVisible: false,
    hasTemplate: false
  },

  onLoad() {
    var prefs = store.getPrefs();
    // 快照在 onLoad 记下：首屏 onShow 比对相同，不会重复发一轮请求
    this._prefsKey = store.prefsKey(prefs);
    this.load();
  },

  onShow() {
    // 首页可能换了油品或地区，这里对齐一次
    var prefs = store.getPrefs();
    var key = store.prefsKey(prefs);
    if (this._prefsKey && key !== this._prefsKey) {
      this._prefsKey = key;
      this.load();
    } else if (!this._loadedAt || Date.now() - this._loadedAt > 60000) {
      this.load();
    }
  },

  onHide() {
    // 弹层状态跨 tab 残留：离开页面时复位。
    // 只复位弹层，不动 _reqSeq，也不清用户已选的地区 / 油品。
    //
    // ⚠️ 只在真的开着的时候才 setData：
    // 无条件 setData 会让每次切走都触发一次无谓的视图更新。
    if (this.data.sheetVisible) {
      this.setData({ sheetVisible: false });
    }
  },

  onPullDownRefresh() {
    // 无论成功、失败还是被竞态丢弃，都要停掉下拉刷新，
    // 否则菊花会一直转。
    var stop = function () { wx.stopPullDownRefresh(); };
    this.load().then(stop, stop);
  },

  load() {
    var self = this;
    var prefs = store.getPrefs();
    // 请求序号：切换地区 / 油品会连发两轮请求，
    // 先发的那轮可能后到，不能让它把新一轮的结果盖回去。
    this._reqSeq = (this._reqSeq || 0) + 1;
    var seq = this._reqSeq;
    // 发请求前记时间：首屏 onShow 不会重复取数，停留超过 60 秒再刷新。
    this._loadedAt = Date.now();
    this.setData({ loading: true, loadError: '' });

    return Promise.all([
      api.getHome(prefs.regionCode, prefs.fuelId),
      api.getAlertRules(),
      api.getAlertHistory()
    ]).then(function (res) {
      if (seq !== self._reqSeq) return;
      var home = res[0] || {};
      var rulesRes = res[1];
      // ⚠️ 规则可能来自本地副本（后端读失败 / 未配置后端）——
      // 那不是服务端确认过的状态，订阅卡片不能据此显示「已开启」。
      var rules = Array.isArray(rulesRes) ? rulesRes : ((rulesRes && rulesRes.rules) || []);
      var rulesConfirmed = Array.isArray(rulesRes) ? true : !!(rulesRes && rulesRes.confirmed);
      var history = res[2] || [];

      var price = null;
      var priceList = home.prices || [];
      for (var i = 0; i < priceList.length; i++) {
        if (priceList[i].id === prefs.fuelId) { price = priceList[i].price; break; }
      }
      if (price === null && priceList.length) price = priceList[0].price;

      var rule = null;
      for (var j = 0; j < rules.length; j++) {
        if (rules[j].regionCode === prefs.regionCode && rules[j].fuelId === prefs.fuelId) {
          rule = rules[j];
          break;
        }
      }
      if (!rule) {
        rule = {
          id: 'rule-' + prefs.regionCode + '-' + prefs.fuelId,
          regionCode: prefs.regionCode,
          fuelId: prefs.fuelId,
          officialDrop: true,
          targetEnabled: true,
          targetPrice: defaultTarget(price),
          forecastDrop: false,
          subscribeGranted: false,
          subscribeUsedAt: null
        };
      } else if (rule.targetPrice === null || rule.targetPrice === undefined ||
        !isFinite(Number(rule.targetPrice))) {
        // 库里没存目标价（新建的规则）：按当前价给一个合理的默认值
        rule = Object.assign({}, rule, { targetPrice: defaultTarget(price) });
      }

      self._rules = rules;
      self._rulesConfirmed = rulesConfirmed;
      self._price = price;

      var fuelName = '92# 汽油';
      for (var k = 0; k < priceList.length; k++) {
        if (priceList[k].id === prefs.fuelId) { fuelName = priceList[k].name; break; }
      }

      // 来源：提醒页的当前价来自 home，home.source 原来被整份丢掉了，
      // 现在存下来如实展示 —— 后端读不到时也要有记录可看。
      var sourceLine = fmt.sourceLine(home.source, '目标价以此为基准');
      // 历史记录是不是后端的：后端返回的记录带 dedupKey，
      // 本机留存的记录没有这个字段（{id,title,time,channel,priceText}）。
      // ⚠️ 不看模块级全局来源状态：那种状态被 home / rules / history
      self.setData({
        loading: false,
        loadError: '',
        region: home.region || { fullName: '' },
        fuelId: prefs.fuelId,
        fuelName: fuelName,
        currentPriceText: fmt.price(price),
        rule: rule,
        history: history.map(historyView),
        sourceText: sourceLine.text,
        sourceWarn: sourceLine.warn,
        hasTemplate: subscribe.hasTemplate()
      });
      self.applyRule();
    }).catch(function () {
      if (seq !== self._reqSeq) return;
      // 后端读不到数据 —— 如实报失败（没有本地兜底，不拿假数据顶上）
      self.setData({ loading: false, loadError: '提醒数据读取失败，请稍后重试' });
    });
  },

  applyRule() {
    var rule = this.data.rule;
    var price = this._price;
    var hasPrice = price !== null && price !== undefined && isFinite(Number(price));
    var target = clamp(rule.targetPrice);
    var diff = hasPrice ? Number(price) - target : null;

    var caption;
    if (!hasPrice) {
      // ⚠️ 没有当前价时不能写「再降 0.00 元时提醒」——
      // 那是把「不知道」当成「差 0 元」，看着像已经达到目标价了。
      caption = '暂无当前价，无法计算差额';
    } else if (diff >= 0) {
      // diff = 当前价 - 目标价：差多少就还要再降多少
      caption = '再降 ' + diff.toFixed(2) + ' 元时提醒';
    } else {
      caption = '已低于目标价 ' + Math.abs(diff).toFixed(2) + ' 元';
    }

    var where = (this.data.region && this.data.region.fullName) ? this.data.region.fullName : '本地区';
    var fuel = this.data.fuelName || '该油品';

    this.setData({
      targetText: target.toFixed(2),
      targetWarn: hasPrice && diff < 0,
      targetCaption: caption,
      subscription: this.subscriptionView(rule),
      // 摘要要跟着开关走：开关关掉了还写「向我发送微信订阅消息」是在骗人
      officialSummary: rule.officialDrop
        ? ('当 ' + where + ' 的 ' + fuel + ' 出现正式降价公告时，向我发送微信订阅消息。')
        : '官方降价提醒已停用，打开开关后才会通知。',
      targetSummary: rule.targetEnabled
        ? ('当 ' + where + ' 的 ' + fuel + ' 价格降到 ' + target.toFixed(2) + ' 元/升 或更低时，向我发送微信订阅消息。')
        : '目标价提醒已停用，打开开关后才会通知。',
      forecastSummary: rule.forecastDrop
        ? ('当 ' + where + ' 的 ' + fuel + ' 出现预测下调时，向我发送微信订阅消息（预测非官方，以正式公告为准）。')
        : '预测下调提醒已停用，打开开关后才会通知。'
    });
  },

  subscriptionView(rule) {
    // 注意：这里必须带 .png 后缀，WXML 里拼的是 /assets/icons/{{icon}}
    if (!subscribe.hasTemplate()) {
      return {
        active: false,
        enabled: false,
        icon: 'bell-amber',
        title: '订阅消息未配置',
        text: '需先申请订阅消息模板并填入 config/index.js',
        buttonText: '查看说明'
      };
    }
    // ⚠️ 规则只存在本机（后端读失败 / 未配置后端）：
    // 本地副本不能当成「提醒已经开着」—— 服务端没有这条规则，提醒不会来。
    if (this._rulesConfirmed === false) {
      return {
        active: false,
        enabled: true,
        icon: 'bell-muted',
        title: '规则未同步到服务器',
        text: '当前只有本机留存的副本，提醒不会触发',
        buttonText: '重新同步'
      };
    }
    // ⚠️ 授权拿到了但规则没存上：不能显示成「已开启」，
    // 否则用户以为提醒开着，其实服务端一条规则都没有。
    if (this._pendingGrant) {
      return {
        active: false,
        enabled: true,
        icon: 'bell-muted',
        title: '授权已取得，服务端未生效',
        text: '规则没能保存到服务器，重试成功前不会收到提醒',
        buttonText: '重试保存'
      };
    }
    if (rule.subscribeGranted) {
      return {
        active: true,
        enabled: true,
        icon: 'bell-green',
        title: '微信提醒已开启',
        text: '一次授权可发一条，用完后需重新开启',
        buttonText: '管理'
      };
    }
    // 额度用掉了 ≠ 从没授权过。这两种都显示「未开启」会让人以为自己没点同意。
    if (rule.subscribeUsedAt) {
      return {
        active: false,
        enabled: true,
        icon: 'bell-muted',
        title: '授权已用完',
        text: '上一条提醒已于 ' + usedAtText(rule.subscribeUsedAt) + ' 发出，重新授权才能再收',
        buttonText: '重新开启'
      };
    }
    return {
      active: false,
      enabled: true,
      icon: 'bell-muted',
      title: '微信提醒未开启',
      text: '订阅消息后，规则才能在后台触发',
      buttonText: '去开启'
    };
  },

  /**
   * 保存规则。
   *
   * ⚠️ 订阅授权是一次性的：只有「刚拿到授权」的那一次保存才把
   * subscribeGranted 发给后端，其余保存一律不带 ——
   * 否则服务端把额度用掉之后，用户随便拨个开关就会把额度又续上，
   * 微信那边其实已经没额度了，界面却还显示「已开启」。
   */
  persist(nextRule, opts) {
    var self = this;
    var grant = !!(opts && opts.grant);
    var rules = (this._rules || []).slice();
    var found = false;
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].regionCode === nextRule.regionCode && rules[i].fuelId === nextRule.fuelId) {
        rules[i] = nextRule;
        found = true;
        break;
      }
    }
    if (!found) rules.push(nextRule);
    this._rules = rules;

    // 只把当前这一条发给后端：服务端是 upsert 语义，
    // 一次把整组规则发过去只是多写几行别人的规则。
    //
    // 载荷和本地留存的副本要分开：载荷里只有授权那一次带 subscribeGranted，
    // 其余保存一律不带 —— 否则服务端把额度用掉之后，
    // 界面上随便拨个开关就会把额度又续上，而微信那边其实已经没额度了。
    var payloadRule = Object.assign({}, nextRule);
    delete payloadRule.subscribeGranted;
    if (grant) {
      payloadRule.subscribeGranted = true;
    } else if (this._pendingGrant && nextRule.subscribeGranted) {
      // 上一次「拿到授权但没存上」，重试时要把授权带上 ——
      // 微信的一次性授权用过就没了，补不回来。
      payloadRule.subscribeGranted = true;
    }
    var payload = [payloadRule];

    // 步进的延迟保存还没发出去就取消，避免同一条规则连发两次
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }

    this.setData({ saveState: 'saving', saveText: '保存中…' });
    // ⚠️ 串行化：同一页面的保存请求排队，后一次等前一次完成。
    // 不排队的话，连点开关时两个请求可能反序到达服务端，
    // 旧请求后写就把新状态盖掉了，而页面还显示「已保存」。
    var prev = this._saveChain || Promise.resolve();
    var next = prev.then(function () {
      return api.saveAlertRules(rules, payload);
    }, function () {
      return api.saveAlertRules(rules, payload);
    });
    // 让后面的保存等这一次结束（成功失败都算）
    this._saveChain = next.then(function () {}, function () {});
    return next.then(function (res) {
      // 只有真的写到服务器才敢说「已保存到服务器」：
      // 未配置后端与离线只是存了本机副本，不能当成服务端已确认。
      var online = !!(res && res.ok && !res.offline);
      if (online) {
        self._pendingGrant = false;
        self._rulesConfirmed = true;
      } else if (grant) {
        // 授权拿到了但没存上：记下来，重试时要带上 subscribeGranted；
        // 卡片据此显示「授权已取得，服务端未生效」，不再显示「已开启」
        self._pendingGrant = true;
      }
      // 三态：已存到服务器 / 只存在本机 / 保存失败。
      // ⚠️ 没配后端时规则**已经存到本机**了，
      //   写成「失败」会弹出「重试保存」按钮，而没配后端时重试毫无意义。
      var offline = !!(res && res.ok && res.offline);
      self.setData({
        saveState: online ? 'saved' : (offline ? 'offline' : 'failed'),
        saveText: online ? '已保存到服务器' : ((res && res.message) || '保存失败，请重试')
      });
      // 服务端确认状态可能刚变化，立即重算订阅卡片，不等下一次 load。
      self.applyRule();
      return res;
    });
  },

  /**
   * 保存并把失败说清楚。
   *
   * ⚠️ 以前保存失败也被弹成「订阅已开启」—— 用户以为规则生效了，
   * 服务端一条都没写。
   */
  saveAndReport(nextRule, opts) {
    return this.persist(nextRule, opts).then(function (res) {
      if (!res || !res.ok) {
        wx.showToast({ title: '规则未保存', icon: 'none' });
      } else if (res.offline) {
        // 只存在本机：不是失败，别弹「规则未保存」，与下面那行提示自相矛盾
        wx.showToast({ title: '规则只保存在本机', icon: 'none' });
      }
      return res;
    });
  },

  /* ---------- 开关 ---------- */

  onToggleOfficial() {
    var rule = Object.assign({}, this.data.rule, { officialDrop: !this.data.rule.officialDrop });
    this.setData({ rule: rule });
    this.saveAndReport(rule);
    this.applyRule();
  },

  onToggleTarget() {
    var rule = Object.assign({}, this.data.rule, { targetEnabled: !this.data.rule.targetEnabled });
    this.setData({ rule: rule });
    this.saveAndReport(rule);
    this.applyRule();
  },

  onToggleForecast() {
    var rule = Object.assign({}, this.data.rule, { forecastDrop: !this.data.rule.forecastDrop });
    this.setData({ rule: rule });
    this.saveAndReport(rule);
    this.applyRule();
  },

  /* ---------- 目标价步进 ---------- */

  onTargetMinus() {
    this.stepTarget(-STEP);
  },

  onTargetPlus() {
    this.stepTarget(STEP);
  },

  stepTarget(delta) {
    var self = this;
    var rule = Object.assign({}, this.data.rule, {
      targetPrice: clamp((Number(this.data.rule.targetPrice) || 0) + delta)
    });
    this.setData({ rule: rule });
    this.applyRule();
    // ⚠️ 每点一下就存一次：连点十下就是十次请求，
    // 服务端被无谓地打一遍，用户还看不到任何反馈。
    // 改成停手 600ms 后存一次。
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(function () {
      self._persistTimer = null;
      self.saveAndReport(rule);
    }, 600);
  },

  /* ---------- 订阅授权 ---------- */

  /** 订阅卡片只有一个入口：先补保存，未同步时同步，其余才发起授权。 */
  onSubscriptionAction() {
    if (!subscribe.hasTemplate()) {
      this.onOpenPermission();
      return;
    }
    if (this._pendingGrant || this._rulesConfirmed === false) {
      // 重试使用已取得的一次性授权，不重新弹微信授权。
      this.onRetrySave();
      return;
    }
    this.onOpenPermission();
  },

  onOpenPermission() {
    this.setData({ sheetVisible: true });
  },

  onSheetClose() {
    this.setData({ sheetVisible: false });
  },

  onConfirmPermission() {
    var self = this;
    if (!subscribe.hasTemplate()) {
      this.setData({ sheetVisible: false });
      wx.showToast({ title: '尚未配置订阅消息模板', icon: 'none' });
      return;
    }
    subscribe.requestSubscribe().then(function (res) {
      self.setData({ sheetVisible: false });
      if (res.granted && res.granted.length) {
        var rule = Object.assign({}, self.data.rule, { subscribeGranted: true });
        self.setData({ rule: rule });
        // grant: 只有这一次保存带 subscribeGranted=true
        // ⚠️ 必须等保存结果再报喜：微信授权成功 ≠ 规则已生效。
        // 以前是授权完立刻弹「订阅已开启」，后端写失败也照弹 ——
        // 用户以为提醒已经开着，实际上服务端一条规则都没有。
        self.persist(rule, { grant: true }).then(function (result) {
          if (result && result.ok && !result.offline) {
            wx.showToast({ title: '订阅已开启', icon: 'success' });
          } else {
            wx.showToast({ title: '授权成功，规则未保存', icon: 'none' });
          }
        });
      } else {
        wx.showToast({ title: res.message || '未获得订阅授权', icon: 'none' });
      }
    });
  },

  onRetry() {
    this.load();
  },

  /** 保存失败后的重试：只补发保存，不重新请求订阅授权。 */
  onRetrySave() {
    this.saveAndReport(this.data.rule);
  }
});
