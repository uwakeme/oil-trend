const api = require('../../utils/api');
const store = require('../../utils/store');
const fmt = require('../../utils/format');
const { FUELS } = require('../../data/fuels');

Page({
  data: {
    loading: true,
    loadError: '',
    fuels: FUELS,
    fuelId: '92',
    fuelName: '92# 汽油',
    region: {},
    period: '3m',
    periods: [
      { key: '3m', label: '近 3 月' },
      { key: '6m', label: '近 6 月' },
      { key: '1y', label: '近 1 年' }
    ],
    points: [],
    axis: [],
    events: [],
    priceText: '--',
    deltaText: '--',
    direction: 'flat',
    rangeLabel: '',
    lowText: '--',
    highText: '--',
    countText: '--',
    sourceNote: ''
  },

  onLoad() {
    var prefs = store.getPrefs();
    this.setData({ fuelId: prefs.fuelId || '92' });
    this.load();
  },

  onShow() {
    var tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null;
    if (tabBar) tabBar.setData({ selected: 1 });

    var prefs = store.getPrefs();
    var fuelId = prefs.fuelId || '92';
    if (fuelId !== this.data.fuelId) {
      this.setData({ fuelId: fuelId });
      this.load();
    }
  },

  load() {
    var self = this;
    var prefs = store.getPrefs();
    this.setData({ loading: true, loadError: '' });
    api.getTrend(prefs.regionCode, this.data.fuelId, this.data.period)
      .then(function (payload) { self.applyTrend(payload); })
      .catch(function () {
        self.setData({ loading: false, loadError: '走势数据加载失败，请稍后重试' });
      });
  },

  applyTrend(payload) {
    if (!payload) {
      this.setData({ loading: false, loadError: '没有拿到走势数据' });
      return;
    }
    var fuelName = (payload.fuel && payload.fuel.name) || '92# 汽油';
    this.setData({
      loading: false,
      loadError: '',
      region: payload.region || {},
      fuelName: fuelName,
      points: payload.points || [],
      axis: payload.axis || [],
      priceText: fmt.price(payload.price),
      deltaText: fmt.percent(payload.deltaPercent),
      direction: payload.direction || 'flat',
      rangeLabel: payload.rangeLabel || '',
      lowText: fmt.price(payload.low),
      highText: fmt.price(payload.high),
      countText: (payload.count || 0) + ' 次',
      sourceNote: (payload.source && payload.source.note) || '',
      events: (payload.events || []).map(function (e) {
        return {
          dateText: fmt.shortDate(e.date),
          title: e.title,
          priceText: fmt.price(e.priceAfter),
          deltaText: (e.amount > 0 ? '+' : '') + e.amount.toFixed(2),
          direction: e.direction
        };
      })
    });
  },

  onRetry() {
    this.load();
  },

  onSelectFuel(e) {
    var fuelId = e.currentTarget.dataset.fuel;
    if (!fuelId || fuelId === this.data.fuelId) return;
    store.setPrefs({ fuelId: fuelId });
    this.setData({ fuelId: fuelId });
    this.load();
  },

  onSelectPeriod(e) {
    var period = e.currentTarget.dataset.period;
    if (!period || period === this.data.period) return;
    this.setData({ period: period });
    this.load();
  }
});
