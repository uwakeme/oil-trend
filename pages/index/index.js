const api = require('../../utils/api');
const store = require('../../utils/store');
const fmt = require('../../utils/format');

/** 把调价幅度转成展示文案 */
function changeMeta(amount) {
  var value = Number(amount) || 0;
  if (!value) {
    return { text: '与上次持平', direction: 'flat', verb: '持平', value: '0.00' };
  }
  var down = value < 0;
  return {
    text: (down ? '↓ ' : '↑ ') + Math.abs(value).toFixed(2) + ' 较上次调价',
    direction: down ? 'down' : 'up',
    verb: down ? '下调' : '上调',
    value: Math.abs(value).toFixed(2)
  };
}

Page({
  data: {
    loading: true,
    loadError: '',
    region: { code: '', fullName: '' },
    regions: [],
    prices: [],
    fuelId: '92',
    hero: {},
    window: {},
    forecast: {},
    trend: { points: [], labels: [], direction: 'flat' },
    notice: {},
    updatedLabel: '',
    sourceName: '',
    sourceNote: '',
    cloudStatus: '',
    aboutNote: '',
    sheetType: ''
  },

  onLoad() {
    var prefs = store.getPrefs();
    // 快照在 onLoad 就记下：首屏 onShow 比对相同，不会重复发一轮请求
    this._prefsKey = store.prefsKey(prefs);
    this.setData({ fuelId: prefs.fuelId || '92' });
    this.load(prefs.regionCode);
  },

  onShow() {
    // 地区或油品可能在别的页面改过，对比快照决定要不要重取
    var prefs = store.getPrefs();
    var key = store.prefsKey(prefs);
    if (this._prefsKey && key !== this._prefsKey) {
      this._prefsKey = key;
      this.setData({ fuelId: prefs.fuelId || '92' });
      this.load(prefs.regionCode);
    }
  },

  onPullDownRefresh() {
    var prefs = store.getPrefs();
    this.load(prefs.regionCode).then(function () {
      wx.stopPullDownRefresh();
    });
  },

  load(regionCode) {
    var self = this;
    this.setData({ loading: true, loadError: '' });
    return api.getHome(regionCode, this.data.fuelId).then(function (payload) {
      self._raw = payload;
      self.applyHome(payload);
    }).catch(function () {
      self.setData({ loading: false, loadError: '油价数据加载失败，请检查网络后重试' });
    });
  },

  applyHome(payload) {
    if (!payload) {
      this.setData({ loading: false, loadError: '没有拿到油价数据' });
      return;
    }
    var prices = (payload.prices || []).map(function (p) {
      var meta = changeMeta(p.changeAmount);
      return Object.assign({}, p, {
        priceText: fmt.price(p.price),
        changeText: meta.text,
        direction: meta.direction
      });
    });

    var fuelId = this.data.fuelId;
    var hero = null;
    for (var i = 0; i < prices.length; i++) {
      if (prices[i].id === fuelId) { hero = prices[i]; break; }
    }
    if (!hero) hero = prices[0];
    if (hero) fuelId = hero.id;

    var windowData = payload.window || {};
    var forecastAmount = (windowData.forecast || {})[fuelId];
    var forecastMeta = changeMeta(forecastAmount);

    var trendRaw = (payload.trend30 || {})[fuelId] || { points: [], labels: [] };
    var points = trendRaw.points || [];
    var trendDirection = 'flat';
    if (points.length >= 2) {
      var diff = points[points.length - 1].value - points[0].value;
      trendDirection = diff > 0 ? 'up' : (diff < 0 ? 'down' : 'flat');
    }

    var latest = payload.latestNotice || {};
    var noticeMeta = changeMeta((latest.changes || {})[fuelId]);
    var noticePrices = prices.map(function (p) {
      var delta = (latest.changes || {})[p.id] || 0;
      var meta = changeMeta(delta);
      return {
        id: p.id,
        name: p.name,
        priceText: fmt.price(p.price),
        direction: meta.direction,
        deltaText: (delta > 0 ? '+' : delta < 0 ? '-' : '') + Math.abs(delta).toFixed(2)
      };
    });

    var executeDate = String(latest.executeAt || '');
    var dayParts = executeDate.slice(0, 10).split('-');

    var source = payload.source || {};

    this.setData({
      loading: false,
      loadError: '',
      region: payload.region || {},
      prices: prices,
      fuelId: fuelId,
      hero: hero,
      window: {
        dateText: fmt.cnDate(windowData.date) + ' ' + (windowData.time || ''),
        daysLeft: windowData.daysLeft
      },
      forecast: {
        text: (forecastAmount < 0 ? '↓ ' : forecastAmount > 0 ? '↑ ' : '') + Math.abs(forecastAmount || 0).toFixed(2),
        direction: forecastMeta.direction
      },
      trend: {
        points: points,
        labels: trendRaw.labels || [],
        direction: trendDirection
      },
      notice: {
        id: latest.id,
        title: latest.title,
        day: dayParts.length === 3 ? dayParts[2] : '--',
        month: dayParts.length === 3 ? Number(dayParts[1]) + '月' : '',
        fuelName: hero ? hero.name : '',
        verb: noticeMeta.verb,
        value: noticeMeta.value,
        changeDirection: noticeMeta.direction,
        executeText: fmt.fullDate(executeDate.slice(0, 10)) + ' ' + (executeDate.slice(11, 16) || '') + ' 时执行。以下为本地各油品调整后的零售价格。',
        prices: noticePrices,
        sourceName: (source.name || '未标注来源') + (source.mode === 'demo' ? '（演示数据）' : ''),
        publishedText: fmt.dateTime(latest.publishedAt)
      },
      updatedLabel: fmt.dateTime(payload.updatedAt) + ' 更新',
      sourceName: source.name || '未知来源',
      sourceNote: source.note || '',
      cloudStatus: source.mode === 'cloud'
        ? ('本次数据来自' + (source.name || '云端服务'))
        : ('本次数据来自' + (source.transport || '本地演示源')),
      aboutNote: '国内成品油价格按调价节点展示，不代表实时成交价。国际原油仅作市场参考，与国内零售价之间存在税费与定价周期差异。'
    });
  },

  onRetry() {
    var prefs = store.getPrefs();
    this.load(prefs.regionCode);
  },

  /* ---------- 交互 ---------- */

  onSelectFuel(e) {
    var fuelId = e.currentTarget.dataset.fuel;
    if (!fuelId || fuelId === this.data.fuelId) return;
    store.setPrefs({ fuelId: fuelId });
    this.setData({ fuelId: fuelId });
    this.applyHome(this._raw);
    wx.showToast({ title: '已切换到 ' + fuelId + '#', icon: 'none', duration: 1400 });
  },

  onPickRegion() {
    var self = this;
    api.getRegions().then(function (regions) {
      self.setData({
        regions: (regions || []).map(function (r) {
          return Object.assign({}, r, { priceText: fmt.price(r.price92) });
        }),
        sheetType: 'city'
      });
    }).catch(function () {
      wx.showToast({ title: '地区列表获取失败', icon: 'none' });
    });
  },

  onSelectRegion(e) {
    var code = e.currentTarget.dataset.code;
    if (!code) return;
    store.setPrefs({ regionCode: code });
    this.setData({ sheetType: '' });
    this.load(code);
  },

  onOpenNotice() {
    this.setData({ sheetType: 'notice' });
  },

  onOpenAbout() {
    this.setData({ sheetType: 'about' });
  },

  onSheetClose() {
    this.setData({ sheetType: '' });
  },

  goTrend() {
    wx.switchTab({ url: '/pages/trend/trend' });
  },

  goNotice() {
    wx.switchTab({ url: '/pages/notice/notice' });
  },

  goAlert() {
    wx.switchTab({ url: '/pages/alert/alert' });
  }
});
