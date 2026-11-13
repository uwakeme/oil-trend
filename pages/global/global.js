const api = require('../../utils/api');
const fmt = require('../../utils/format');

const PERIODS = [
  { key: '1d', label: '1日' },
  { key: '1w', label: '1周' },
  { key: '1m', label: '1月' },
  { key: '3m', label: '3月' }
];

/**
 * 涨跌方向（三态）。
 *
 * ⚠️ 原来写成 `changeAmount < 0 ? 'down' : 'up'`：
 * 涨跌额为 0 时会被染成「上涨」。这里以涨跌额为准，
 * 涨跌额缺失时才退回方向字段。
 *
 * 涨跌额可能是字符串（pg 的 NUMERIC 读出来是文本），
 * 统一用 fmt.priceValue 转数字，转换不了算缺失。
 */
function directionOf(item) {
  var amount = fmt.priceValue(item.changeAmount);
  if (amount === null) {
    if (item.direction === 'down') return 'down';
    if (item.direction === 'up') return 'up';
    return 'flat';
  }
  if (amount < 0) return 'down';
  if (amount > 0) return 'up';
  return 'flat';
}

/**
 * 行情时效文案。
 *
 * ⚠️ 后端不一定给 delayMinutes（报价时间解析不出来时是 null），
 * 直接拼字符串会显示成「延时 undefined 分钟」。
 * 缺这个数时只说「延时行情」，不出现 undefined。
 *
 * @param {object} main   行情载荷
 * @param {string} prefix 前缀（页面顶部的徽章用「行情」，卡片里不用）
 */
function timelinessText(main, prefix) {
  if (!main.delayed) return prefix + '实时';
  var minutes = fmt.priceValue(main.delayMinutes);
  if (minutes === null || minutes <= 0) return '延时行情';
  return prefix + '延时 ' + minutes + ' 分钟';
}

Page({
  data: {
    loading: true,
    loadError: '',
    symbol: 'brent',
    period: '1d',
    periods: PERIODS,
    tabs: [],
    market: {},
    // 点少于 2 个画不出曲线：不渲染图表组件，改显示空态文案
    hasChart: false,
    // 后端明确标记「合法为空」时的空态文案
    dataEmpty: false,
    delayText: '',
    sourceNote: '',
    sourceText: '',
    sourceWarn: false
  },

  onLoad() {
    this.load();
  },

  onShow() {
    // 行情带时间戳，回来太久了就重新取一次，避免看到停住的价格。
    // _loadedAt 在 load() 开头就记了，首屏不会重复发一轮。
    if (!this._loadedAt || Date.now() - this._loadedAt > 60000) {
      this.load();
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
    var symbol = this.data.symbol;
    var period = this.data.period;
    // 请求序号：连点品种 / 周期会连发多轮请求，
    // 先发的那轮可能后到，不能让它把后一轮的结果盖回去。
    this._reqSeq = (this._reqSeq || 0) + 1;
    var seq = this._reqSeq;
    // 取数时刻在发请求之前就记下来：onShow 靠它判断要不要刷新。
    // 原来记在 .then 里，首屏 onLoad 的请求还没回来，
    // 紧接着的 onShow 看到 _loadedAt 是 undefined，又发一轮（首屏 4 个请求）。
    this._loadedAt = Date.now();
    this.setData({ loading: true, loadError: '' });

    // 选中的品种可能正好是 brent 或 wti，去重后再并发，省掉一次重复请求
    var wanted = {};
    wanted[symbol] = true;
    wanted.brent = true;
    wanted.wti = true;
    var symbols = Object.keys(wanted);

    return Promise.all(symbols.map(function (s) {
      return api.getMarket(s, period);
    })).then(function (res) {
      if (seq !== self._reqSeq) return;
      var map = {};
      symbols.forEach(function (s, i) { map[s] = res[i]; });
      self.applyMarket(map[symbol], map.brent, map.wti);
    }).catch(function () {
      if (seq !== self._reqSeq) return;
      // 能走到这里说明后端失败之后本地兜底也出错了 —— 那是数据源本身的问题
      self.setData({ loading: false, loadError: '行情数据读取失败，请稍后重试' });
    });
  },

  applyMarket(main, brent, wti) {
    if (!main) {
      this.setData({ loading: false, loadError: '没有拿到行情数据' });
      return;
    }
    var self = this;
    function tab(item) {
      item = item || {};
      var sym = item.symbol || '';
      return {
        symbol: sym,
        code: sym === 'wti' ? 'WTI' : 'BRENT',
        label: sym === 'wti' ? '纽约' : '布伦特',
        priceText: fmt.price(item.price),
        changeText: fmt.percent(item.changePercent),
        // direction 不能是 null，也不能把持平说成上涨
        direction: directionOf(item)
      };
    }
    // 演示数据（服务端还没采集到真实行情）不能标「实时」——
    // 那会把演示曲线说成真实行情，与「如实展示来源」冲突。
    var isDemo = !!(main.source && main.source.mode === 'demo');
    // direction 必须有值：trend-chart 声明它是 String 属性，传 null 会报类型警告。
    // 国际行情的涨跌方向要从涨跌幅算，不能直接用 main.direction（那里没有这个字段）。
    var marketDirection = directionOf(main);
    var delayText = isDemo ? '演示数据' : timelinessText(main, '');
    // 品种代码：后端会给 BRENT / WTI，没给时按 symbol 兜底，别显示空字符串
    var symbol = main.symbol || this.data.symbol;
    var code = main.code || (symbol === 'wti' ? 'WTI' : 'BRENT');
    // 来源提示条：后端挂了回落演示数据时必须是 warn 样式
    var sourceLine = fmt.sourceLine(main.source);
    // 后端明确说「合法为空」（还没采到行情）：显示空态，不回落演示数据
    var dataEmpty = main.empty === true;
    var points = dataEmpty ? [] : (main.points || []);
    // 只有一个点画不出曲线（canvas 只会画出一个孤点）
    var hasChart = points.length >= 2;

    this.setData({
      loading: false,
      loadError: '',
      tabs: [tab(brent), tab(wti)],
      market: {
        name: main.name,
        code: code,
        priceText: fmt.price(main.price),
        changeText: fmt.signed(main.changeAmount) + '  ' + fmt.percent(main.changePercent),
        // trend-chart 的 direction 是 String 属性，传 null 会报类型不兼容警告。
        direction: marketDirection,
        openText: fmt.price(main.open),
        prevText: fmt.price(main.prevClose),
        highText: fmt.price(main.high),
        lowText: fmt.price(main.low),
        quoteTime: main.quoteTime,
        delayText: delayText,
        points: points,
        axis: dataEmpty ? [] : (main.axis || [])
      },
      hasChart: hasChart,
      dataEmpty: dataEmpty,
      delayText: isDemo ? '演示数据' : timelinessText(main, '行情'),
      sourceNote: (main.source && main.source.note) || '',
      sourceText: sourceLine.text,
      sourceWarn: sourceLine.warn
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
