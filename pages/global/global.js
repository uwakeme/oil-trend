const api = require('../../utils/api');
const fmt = require('../../utils/format');

const PERIODS = [
  { key: '1d', label: '1日' },
  { key: '1w', label: '1周' },
  { key: '1m', label: '1月' },
  { key: '3m', label: '3月' }
];

Page({
  data: {
    loading: true,
    loadError: '',
    symbol: 'brent',
    period: '1d',
    periods: PERIODS,
    tabs: [],
    market: {},
    delayText: '',
    sourceNote: ''
  },

  onLoad() {
    this.load();
  },

  onShow() {
    var tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null;
    if (tabBar) tabBar.setData({ selected: 3 });
  },

  load() {
    var self = this;
    this.setData({ loading: true, loadError: '' });
    Promise.all([
      api.getMarket(this.data.symbol, this.data.period),
      api.getMarket('brent', this.data.period),
      api.getMarket('wti', this.data.period)
    ]).then(function (res) {
      self.applyMarket(res[0], res[1], res[2]);
    }).catch(function () {
      self.setData({ loading: false, loadError: '行情数据加载失败，请稍后重试' });
    });
  },

  applyMarket(main, brent, wti) {
    if (!main) {
      this.setData({ loading: false, loadError: '没有拿到行情数据' });
      return;
    }
    var self = this;
    function tab(item) {
      return {
        symbol: item.symbol,
        code: item.symbol === 'brent' ? 'BRENT' : 'WTI',
        label: item.symbol === 'brent' ? '布伦特' : '纽约',
        priceText: fmt.price(item.price),
        changeText: fmt.percent(item.changePercent),
        direction: item.direction
      };
    }
    this.setData({
      loading: false,
      loadError: '',
      tabs: [tab(brent), tab(wti)],
      market: {
        name: main.name,
        code: main.code,
        priceText: fmt.price(main.price),
        changeText: fmt.signed(main.changeAmount) + '  ' + fmt.percent(main.changePercent),
        direction: main.direction,
        openText: fmt.price(main.open),
        prevText: fmt.price(main.prevClose),
        highText: fmt.price(main.high),
        lowText: fmt.price(main.low),
        quoteTime: main.quoteTime,
        delayText: main.delayed ? ('延时 ' + main.delayMinutes + ' 分钟') : '实时',
        points: main.points || [],
        axis: main.axis || []
      },
      delayText: main.delayed ? ('行情延时 ' + main.delayMinutes + ' 分钟') : '行情实时',
      sourceNote: (main.source && main.source.note) || ''
    });
  },

  onRetry() {
    this.load();
  },

  onSelectMarket(e) {
    var symbol = e.currentTarget.dataset.symbol;
    if (!symbol || symbol === this.data.symbol) return;
    this.setData({ symbol: symbol });
    this.load();
  },

  onSelectPeriod(e) {
    var period = e.currentTarget.dataset.period;
    if (!period || period === this.data.period) return;
    this.setData({ period: period });
    this.load();
  }
});
