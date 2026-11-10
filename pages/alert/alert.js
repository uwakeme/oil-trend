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
      subscribeGranted: false
    },
    subscription: { icon: 'bell-amber', title: '', text: '', buttonText: '' },
    targetText: '7.20',
    targetCaption: '',
    targetWarn: false,
    history: [],
    sheetVisible: false,
    hasTemplate: false
  },

  onLoad() {
    this.load();
  },

  onShow() {
    var tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null;
    if (tabBar) tabBar.setData({ selected: 4 });

    var prefs = store.getPrefs();
    // 首页可能换了油品或地区，这里对齐一次
    if (prefs.fuelId !== this.data.fuelId || prefs.regionCode !== this.data.region.code) {
      this.load();
    }
  },

  load() {
    var self = this;
    var prefs = store.getPrefs();
    this.setData({ loading: true, loadError: '' });

    Promise.all([
      api.getHome(prefs.regionCode, prefs.fuelId),
      api.getAlertRules(),
      api.getAlertHistory()
    ]).then(function (res) {
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
          subscribeGranted: false
        };
      }

      self._rules = rules;
      self._price = price;

      var fuelName = '92# 汽油';
      for (var k = 0; k < priceList.length; k++) {
        if (priceList[k].id === prefs.fuelId) { fuelName = priceList[k].name; break; }
      }

      self.setData({
        loading: false,
        loadError: '',
        region: home.region || { fullName: '' },
        fuelId: prefs.fuelId,
        fuelName: fuelName,
        currentPriceText: fmt.price(price),
        rule: rule,
        history: history,
        hasTemplate: subscribe.hasTemplate()
      });
      self.applyRule();
    }).catch(function () {
      self.setData({ loading: false, loadError: '提醒规则加载失败，请稍后重试' });
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
      targetCaption: diff >= 0
        ? '低于目标价 ' + diff.toFixed(2) + ' 元时提醒'
        : '目标价高于当前价，将在达到时提醒',
      subscription: this.subscriptionView(rule)
    });
  },

  subscriptionView(rule) {
    // 注意：这里必须带 .png 后缀，WXML 里拼的是 /assets/icons/{{icon}}
    if (!subscribe.hasTemplate()) {
      return {
        active: false,
        enabled: false,
        icon: 'bell-amber.png',
        title: '订阅消息未配置',
        text: '需先申请订阅消息模板并填入 config/index.js',
        buttonText: '查看说明'
      };
    }
    if (rule.subscribeGranted) {
      return {
        active: true,
        enabled: true,
        icon: 'bell-green.png',
        title: '微信提醒已开启',
        text: '正式降价、目标价到达时发送订阅消息',
        buttonText: '管理'
      };
    }
    return {
      active: false,
      enabled: true,
      icon: 'bell-muted.png',
      title: '微信提醒未开启',
      text: '订阅消息后，规则才能在后台触发',
      buttonText: '去开启'
    };
  },

  persist(nextRule) {
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
    api.saveAlertRules(rules);
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
        self.persist(rule);
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
