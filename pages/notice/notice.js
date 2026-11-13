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
    // 后端明确标记「合法为空」时的空态文案
    dataEmpty: false,
    emptyText: '',
    emptyHint: '',
    notices: [],
    sourceText: '',
    sourceWarn: false,
    sheetVisible: false,
    sheetKind: 'official',
    detail: {}
  },

  onLoad() {
    var prefs = store.getPrefs();
    this._prefsKey = store.prefsKey(prefs);
    this.setData({ fuelId: prefs.fuelId || '92' });
    this.load();
  },

  onShow() {
    // 换地区后通知里的调价幅度会变，回到页面要重新取
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
    // 请求序号：切筛选条件会连发请求，先发的那轮可能后到，
    // 不能让它把新筛选条件的结果盖回去。
    this._reqSeq = (this._reqSeq || 0) + 1;
    var seq = this._reqSeq;
    this.setData({ loading: true, loadError: '' });
    return api.getNotices(prefs.regionCode, this.data.filter, prefs.fuelId)
      .then(function (payload) {
        if (seq !== self._reqSeq) return;
        self.applyNotices(payload);
      })
      .catch(function () {
        if (seq !== self._reqSeq) return;
        // 能走到这里说明后端失败之后本地兜底也出错了 —— 那是数据源本身的问题
        self.setData({ loading: false, loadError: '调价通知读取失败，请稍后重试' });
      });
  },

  applyNotices(payload) {
    if (!payload) {
      this.setData({ loading: false, loadError: '没有拿到通知数据' });
      return;
    }
    var win = payload.window || {};
    var sync = payload.sync || {};
    // 同步状态要同时看 payload.source：
    // 演示数据下报「自动同步正常」是误导（看到的不是采集结果）
    var syncMeta = fmt.syncStatus(sync.status, payload.source);
    // 有待人工核对的记录时不能只报「同步正常」
    if (sync.needsReview && sync.needsReview.length && syncMeta.style !== 'error') {
      syncMeta = {
        text: fmt.SYNC_STATUS_META.pending.text + '（' + sync.needsReview.length + ' 条）',
        style: 'warn'
      };
    }
    // 后端明确说「合法为空」：显示空态，不回落演示数据也不当加载失败
    var dataEmpty = payload.empty === true;
    var self = this;

    var notices = (payload.notices || []).map(function (n) {
      var fuelId = prefsFuelId();
      var delta = (n.changes || {})[fuelId];
      // 幅度缺失时不能拿 0 顶上：那等于替来源猜了一个幅度
      var known = typeof delta === 'number' && isFinite(delta);
      var meta = known ? changeMeta(delta) : { text: '待公布', direction: 'flat' };
      return {
        id: n.id,
        kind: n.kind,
        kindLabel: n.kind === 'official' ? '正式结果' : '市场预测',
        title: n.title,
        publishedText: fmt.dateOnly(n.publishedAt),
        executeText: fmt.cnDate(String(n.executeAt || '').slice(0, 10)) +
          ' ' + (String(n.executeAt || '').slice(11, 16) || '') + ' 执行',
        changeText: meta.text,
        direction: meta.direction,
        raw: n
      };
    });

    function prefsFuelId() {
      return self.data.fuelId || '92';
    }

    var srcLine = fmt.sourceLine(payload.source);

    // 空列表要说清楚为什么空：
    // 演示数据 → 提示换个筛选；真实来源 → 直说还没有正式公告
    var emptyText = '该分类下暂无通知';
    var emptyHint = '切换筛选条件查看其它记录';
    var isDemo = !!(payload.source && payload.source.mode === 'demo');
    // 后端明确说「合法为空」时也按真实来源的空态说（别让演示源的说法混进来）
    if (!isDemo || dataEmpty) {
      if (this.data.filter === 'forecast') {
        emptyText = '暂无市场预测';
        emptyHint = '预测来源接入后会自动同步';
      } else {
        emptyText = '还没有正式调价公告';
        emptyHint = '正式公告发布后会自动同步到这里';
      }
    }

    this.setData({
      loading: false,
      loadError: '',
      sourceText: srcLine.text,
      sourceWarn: srcLine.warn,
      window: {
        // 没有真实窗口日期就别渲染窗口卡（否则倒计时会写成「就是今天」）
        hasDate: !!win.date,
        dateText: fmt.cnDate(win.date),
        time: win.time,
        progress: win.progress === undefined ? 0 : win.progress,
        cycleStarted: !!win.cycleStarted,
        countdownText: fmt.countdown(win.daysLeft),
        // 过期窗口的标题与首页共用一套规则（utils/format.windowTitle）
        expired: fmt.windowExpired(win.daysLeft),
        titleText: fmt.windowTitle(win.daysLeft)
      },
      sync: {
        // 状态文案由 format.syncStatus 统一映射，新增状态不会再漏
        statusText: syncMeta.text,
        className: syncMeta.style,
        // 没有采集发生就没有检查时刻，别显示「 检查更新」这种空壳
        checkedText: sync.lastCheckedAt ? (fmt.dateTime(sync.lastCheckedAt) + ' 检查更新') : ''
      },
      notices: notices,
      dataEmpty: dataEmpty,
      emptyText: emptyText,
      emptyHint: emptyHint
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

    var rawSource = raw.source || {};
    var rawDelta = (raw.changes || {})[fuelId];
    var rawKnown = typeof rawDelta === 'number' && isFinite(rawDelta);
    var rawMeta = rawKnown ? changeMeta(rawDelta) : { verb: '待公布', direction: 'flat' };
    var publishedText = fmt.dateTime(raw.publishedAt);

    this.setData({
      sheetVisible: true,
      sheetKind: kind,
      detail: {
        title: raw.title,
        summary: raw.summary,
        verb: rawMeta.verb,
        direction: rawMeta.direction,
        prices: prices,
        sourceName: rawSource.name || '未标注来源',
        // 原文链接：没有就不给，别留个点不动的空壳
        sourceUrl: rawSource.url || '',
        sourceLine: (rawSource.name || '未标注来源') +
          (publishedText ? (' · 发布于 ' + publishedText) : ''),
        publishedText: publishedText
      }
    });
  },

  /**
   * 「查看原文」。
   *
   * 小程序的 navigator 只能跳站内页，打不开外部网页，
   * 所以把链接复制到剪贴板，用户自己去浏览器打开。
   */
  onOpenSource() {
    var url = this.data.detail.sourceUrl;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: function () {
        wx.showToast({ title: '原文链接已复制', icon: 'none' });
      },
      fail: function () {
        wx.showToast({ title: '复制失败，请手动复制链接', icon: 'none' });
      }
    });
  },

  onSheetClose() {
    this.setData({ sheetVisible: false });
  },

  /**
   * 切走时把弹层收掉。
   *
   * 只复位弹层状态 —— _reqSeq、已选油品都留着，
   * 否则切回来会重复取数、丢掉用户的选择。
   */
  onHide() {
    if (this.data.sheetVisible) {
      this.setData({ sheetVisible: false });
    }
  }
});
