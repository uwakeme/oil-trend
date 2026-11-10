const api = require('../../utils/api');
const store = require('../../utils/store');
const fmt = require('../../utils/format');

function changeMeta(amount) {
  var value = Number(amount) || 0;
  if (!value) return { text: '持平', direction: 'flat', verb: '持平', value: '0.00' };
  var down = value < 0;
  return {
    text: (down ? '↓ ' : '↑ ') + Math.abs(value).toFixed(2),
    direction: down ? 'down' : 'up',
    verb: down ? '降价' : '涨价',
    value: Math.abs(value).toFixed(2)
  };
}

Page({
  data: {
    loading: true,
    loadError: '',
    filters: [
      { key: 'all', label: '全部' },
      { key: 'official', label: '正式结果' },
      { key: 'forecast', label: '市场预测' }
    ],
    filter: 'all',
    fuelId: '92',
    window: {},
    sync: {},
    notices: [],
    sheetVisible: false,
    sheetKind: 'official',
    detail: {}
  },

  onLoad() {
    var prefs = store.getPrefs();
    this.setData({ fuelId: prefs.fuelId || '92' });
    this.load();
  },

  onShow() {
  },

  load() {
    var self = this;
    var prefs = store.getPrefs();
    this.setData({ loading: true, loadError: '' });
    api.getNotices(prefs.regionCode, this.data.filter, prefs.fuelId)
      .then(function (payload) { self.applyNotices(payload); })
      .catch(function () {
        self.setData({ loading: false, loadError: '调价通知加载失败，请稍后重试' });
      });
  },

  applyNotices(payload) {
    if (!payload) {
      this.setData({ loading: false, loadError: '没有拿到通知数据' });
      return;
    }
    var win = payload.window || {};
    var sync = payload.sync || {};
    var self = this;

    var notices = (payload.notices || []).map(function (n) {
      var fuelId = prefsFuelId();
      var meta = changeMeta((n.changes || {})[fuelId]);
      return {
        id: n.id,
        kind: n.kind,
        kindLabel: n.kind === 'official' ? '正式结果' : '市场预测',
        title: n.title,
        publishedText: fmt.dateOnly(n.publishedAt),
        executeText: fmt.cnDate(n.executeAt.slice(0, 10)) + ' ' + (n.executeAt.slice(11, 16) || '') + ' 执行',
        changeText: meta.text,
        direction: meta.direction,
        raw: n
      };
    });

    function prefsFuelId() {
      return self.data.fuelId || '92';
    }

    this.setData({
      loading: false,
      loadError: '',
      window: {
        dateText: fmt.cnDate(win.date),
        time: win.time,
        progress: win.progress === undefined ? 0 : win.progress,
        cycleStarted: !!win.cycleStarted,
        countdownText: fmt.countdown(win.daysLeft)
      },
      sync: {
        statusText: sync.status === 'ok' ? '自动同步正常' : (sync.status === 'pending' ? '等待人工核对' : '同步异常'),
        className: sync.status === 'ok' ? '' : (sync.status === 'pending' ? 'warn' : 'error'),
        checkedText: fmt.dateTime(sync.lastCheckedAt) + ' 检查更新'
      },
      notices: notices
    });
  },

  onRetry() {
    this.load();
  },

  onSelectFilter(e) {
    var filter = e.currentTarget.dataset.filter;
    if (!filter || filter === this.data.filter) return;
    this.setData({ filter: filter });
    this.load();
  },

  onOpenNotice(e) {
    var id = e.currentTarget.dataset.id;
    var kind = e.currentTarget.dataset.kind;
    var notice = null;
    for (var i = 0; i < this.data.notices.length; i++) {
      if (this.data.notices[i].id === id) { notice = this.data.notices[i]; break; }
    }
    if (!notice) return;

    var raw = notice.raw;
    var prices = [];
    var fuelId = this.data.fuelId || '92';
    Object.keys(raw.prices || {}).forEach(function (key) {
      var item = raw.prices[key];
      var meta = changeMeta(item.delta);
      prices.push({
        id: key,
        name: fuelNameOf(key),
        afterText: fmt.price(item.after),
        deltaText: (item.delta > 0 ? '+' : item.delta < 0 ? '-' : '') + Math.abs(item.delta).toFixed(2),
        direction: meta.direction
      });
    });

    function fuelNameOf(key) {
      var map = { '92': '92# 汽油', '95': '95# 汽油', '98': '98# 汽油', '0': '0# 柴油' };
      return map[key] || key + '#';
    }

    this.setData({
      sheetVisible: true,
      sheetKind: kind,
      detail: {
        title: raw.title,
        summary: raw.summary,
        verb: changeMeta((raw.changes || {})[fuelId]).verb,
        direction: changeMeta((raw.changes || {})[fuelId]).direction,
        prices: prices,
        sourceName: (raw.source && raw.source.name) || '未标注来源',
        publishedText: fmt.dateTime(raw.publishedAt)
      }
    });
  },

  onSheetClose() {
    this.setData({ sheetVisible: false });
  }
});
