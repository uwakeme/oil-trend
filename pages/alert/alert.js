const api = require('../../utils/api');
const store = require('../../utils/store');
const subscribe = require('../../utils/subscribe');
const fmt = require('../../utils/format');

const STEP = 0.05;
const MIN_TARGET = 5.00;
const MAX_TARGET = 10.00;

function clamp(value) {
  var v = Math.round(value * 100) / 100;
  if (v < MIN_TARGET) v = MIN_TARGET;
  if (v > MAX_TARGET) v = MAX_TARGET;
  return v;
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
 * 本地演示记录是 {id,title,time,channel,priceText} —— 字段不一样，
 * 直接渲染的话后端记录会是一片空白。
 */
function historyView(item, index) {
  if (!item) return { id: 'history-' + index, title: '', time: '', channel: '', priceText: '' };
  if (item.dedupKey) {
    var payload = item.payload || {};
    return {
      id: item.dedupKey,
      title: payload.title || '提醒记录',
      time: historyTime(item.time),
      channel: item.sent ? '订阅消息' : ('发送失败 · ' + (item.failReason || '未知原因')),
      priceText: payload.price === undefined ? '' : fmt.price(payload.price)
    };
  }
  return {
    id: item.id || ('history-' + index),
    title: item.title || '',
    time: item.time || '',
    channel: item.channel || '',
    priceText: item.priceText || ''
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
    history: [],
    // 历史记录是不是演示数据（后端返回的记录带 dedupKey）
    historyIsDemo: false,
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
    this.setData({ loading: true, loadError: '' });

    return Promise.all([
      api.getHome(prefs.regionCode, prefs.fuelId),
      api.getAlertRules(),
      api.getAlertHistory()
    ]).then(function (res) {
      if (seq !== self._reqSeq) return;
      var home = res[0] || {};
      var rules = res[1] || [];
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
          targetPrice: 7.20,
          forecastDrop: false,
          subscribeGranted: false,
          subscribeUsedAt: null
        };
      }

      self._rules = rules;
      self._price = price;

      var fuelName = '92# 汽油';
      for (var k = 0; k < priceList.length; k++) {
        if (priceList[k].id === prefs.fuelId) { fuelName = priceList[k].name; break; }
      }

      // 来源：提醒页的当前价来自 home，home.source 原来被整份丢掉了，
      // 现在存下来如实展示 —— 后端挂了回落演示数据时必须看得见。
      var sourceLine = fmt.sourceLine(home.source, '目标价以此为基准');
      // 历史记录是不是演示的：后端返回的记录带 dedupKey，
      // 本地演示记录没有这个字段（{id,title,time,channel,priceText}）。
      // ⚠️ 不看模块级全局来源状态：那种状态被 home / rules / history
      // 三个并发请求互相覆盖，判定会漂。来源一律随 payload.source 走。
      var isBackendHistory = history.length > 0 && !!history[0].dedupKey;

      self.setData({
        loading: false,
        loadError: '',
        region: home.region || { fullName: '' },
        fuelId: prefs.fuelId,
        fuelName: fuelName,
        currentPriceText: fmt.price(price),
        rule: rule,
        history: history.map(historyView),
        historyIsDemo: history.length > 0 && !isBackendHistory,
        sourceText: sourceLine.text,
        sourceWarn: sourceLine.warn,
        hasTemplate: subscribe.hasTemplate()
      });
      self.applyRule();
    }).catch(function () {
      if (seq !== self._reqSeq) return;
      // 能走到这里说明后端失败之后本地兜底也出错了 —— 那是数据源本身的问题
      self.setData({ loading: false, loadError: '提醒数据读取失败，请稍后重试' });
    });
  },

  applyRule() {
    var rule = this.data.rule;
    var price = this._price;
    var target = clamp(rule.targetPrice);
    var diff = (price === null || price === undefined) ? 0 : price - target;

    this.setData({
      targetText: target.toFixed(2),
      targetWarn: diff < 0,
      // diff = 当前价 - 目标价：差多少就还要再降多少
      targetCaption: diff >= 0
        ? '再降 ' + diff.toFixed(2) + ' 元时提醒'
        : '已低于目标价 ' + Math.abs(diff).toFixed(2) + ' 元',
      subscription: this.subscriptionView(rule)
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

    // 载荷和本地留存的副本要分开：载荷里只有授权那一次带 subscribeGranted
    var payload = rules.map(function (r) {
      var copy = Object.assign({}, r);
      delete copy.subscribeGranted;
      if (grant && r === nextRule) copy.subscribeGranted = true;
      return copy;
    });
    api.saveAlertRules(rules, payload);
  },

  /* ---------- 开关 ---------- */

  onToggleOfficial() {
    var rule = Object.assign({}, this.data.rule, { officialDrop: !this.data.rule.officialDrop });
    this.setData({ rule: rule });
    this.persist(rule);
    this.applyRule();
  },

  onToggleTarget() {
    var rule = Object.assign({}, this.data.rule, { targetEnabled: !this.data.rule.targetEnabled });
    this.setData({ rule: rule });
    this.persist(rule);
    this.applyRule();
  },

  onToggleForecast() {
    var rule = Object.assign({}, this.data.rule, { forecastDrop: !this.data.rule.forecastDrop });
    this.setData({ rule: rule });
    this.persist(rule);
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
    var rule = Object.assign({}, this.data.rule, {
      targetPrice: clamp((Number(this.data.rule.targetPrice) || 0) + delta)
    });
    this.setData({ rule: rule });
    this.persist(rule);
    this.applyRule();
  },

  /* ---------- 订阅授权 ---------- */

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
        self.persist(rule, { grant: true });
        self.applyRule();
        wx.showToast({ title: '订阅已开启', icon: 'success' });
      } else {
        wx.showToast({ title: res.message || '未获得订阅授权', icon: 'none' });
      }
    });
  },

  onRetry() {
    this.load();
  }
});
