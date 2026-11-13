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
    // 点少于 2 个画不出曲线：不渲染图表组件，改显示空态文案
    hasChart: false,
    // 后端明确标记「合法为空」时的空态文案
    dataEmpty: false,
    chartEmptyText: '',
    chartEmptyHint: '',
    events: [],
    priceText: '--',
    deltaText: '--',
    direction: 'flat',
    rangeLabel: '',
    lowText: '--',
    highText: '--',
    countText: '--',
    sourceNote: '',
    sourceText: '',
    sourceWarn: false
  },

  onLoad() {
    var prefs = store.getPrefs();
    this._prefsKey = store.prefsKey(prefs);
    this.setData({ fuelId: prefs.fuelId || '92' });
    this.load();
  },

  onShow() {
    // 换地区也会影响走势，之前只比油品，地区变了不刷新
    var prefs = store.getPrefs();
    var key = store.prefsKey(prefs);
    if (this._prefsKey && key !== this._prefsKey) {
      this._prefsKey = key;
      this.setData({ fuelId: prefs.fuelId || '92' });
      this.load();
    }
  },

  onPullDownRefresh() {
    // 无论成功失败都要停掉下拉刷新动画：
    // 只在 then 里停的话，请求被后来的请求顶掉时会一直转圈。
    var stop = function () { wx.stopPullDownRefresh(); };
    this.load().then(stop, stop);
  },

  load() {
    var self = this;
    var prefs = store.getPrefs();
    // 请求序号：切油品 / 切周期会连发请求，先发的那轮可能后到，
    // 不能让它把新条件的结果盖回去。
    this._reqSeq = (this._reqSeq || 0) + 1;
    var seq = this._reqSeq;
    this.setData({ loading: true, loadError: '' });
    return api.getTrend(prefs.regionCode, this.data.fuelId, this.data.period)
      .then(function (payload) {
        if (seq !== self._reqSeq) return;
        self.applyTrend(payload);
      })
      .catch(function () {
        if (seq !== self._reqSeq) return;
        // 能走到这里说明后端失败之后本地兜底也出错了 —— 那是数据源本身的问题
        self.setData({ loading: false, loadError: '走势数据读取失败，请稍后重试' });
      });
  },

  applyTrend(payload) {
    if (!payload) {
      this.setData({ loading: false, loadError: '没有拿到走势数据' });
      return;
    }
    var fuelName = (payload.fuel && payload.fuel.name) || '92# 汽油';
    var srcLine = fmt.sourceLine(payload.source);
    // 后端明确说「合法为空」（该地区还没有历史价）：显示空态，不回落演示数据
    var dataEmpty = payload.empty === true;
    var points = dataEmpty ? [] : (payload.points || []);
    // 只有一个点画不出曲线（canvas 只会画出一个孤点）
    var hasChart = points.length >= 2;
    var chartEmptyText = dataEmpty ? '该地区暂无历史价格数据' : '暂无走势数据';
    var chartEmptyHint = dataEmpty
      ? '采集到该地区历史挂牌价后会自动显示'
      : '历史价格正在积累中';
    this.setData({
      loading: false,
      loadError: '',
      sourceText: srcLine.text,
      sourceWarn: srcLine.warn,
      region: payload.region || {},
      fuelName: fuelName,
      points: points,
      axis: dataEmpty ? [] : (payload.axis || []),
      hasChart: hasChart,
      dataEmpty: dataEmpty,
      chartEmptyText: chartEmptyText,
      chartEmptyHint: chartEmptyHint,
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
          // WXML 的 wx:key 指向 date，字段不能少
          date: e.date,
          dateText: fmt.shortDate(e.date),
          title: e.title,
          priceText: fmt.price(e.priceAfter),
          deltaText: (Number(e.amount) > 0 ? '+' : '') + Number(e.amount || 0).toFixed(2),
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
