const api = require('../../utils/api');
const store = require('../../utils/store');
const fmt = require('../../utils/format');

function changeMeta(amount) {
  // ⚠️ 幅度缺失 ≠ 幅度为零。
  // Number(null) 是 0，不先挡掉空值，「幅度待公布」会显示成「持平 0.00」。
  if (amount === undefined || amount === null || amount === '' || !isFinite(Number(amount))) {
    return { text: '幅度待公布', direction: 'flat', verb: '待公布', value: '--' };
  }
  var value = Number(amount);
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
    } else if (!this._loadedAt || Date.now() - this._loadedAt > 60000) {
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
    // 发请求前记时间：首屏 onShow 不会重复取数，停留超过 60 秒再刷新。
    this._loadedAt = Date.now();
    this.setData({ loading: true, loadError: '' });
    return api.getNotices(prefs.regionCode, this.data.filter, prefs.fuelId)
      .then(function (payload) {
        if (seq !== self._reqSeq) return;
        self.applyNotices(payload);
      })
      .catch(function () {
        if (seq !== self._reqSeq) return;
        // 后端读不到数据 —— 如实报失败（没有本地兜底，不拿假数据顶上）
        self.setData({ loading: false, loadError: '调价通知读取失败，请稍后重试' });
      });
  },

  applyNotices(payload) {
    if (!payload) {
      this.setData({ loading: false, loadError: '没有拿到通知数据' });
      return;
    }
    var win = payload.window || {};
    // 窗口卡的展示规则与首页共用一套（utils/format.windowMeta）：
    // 来源还没公布下一轮时，主日期改用推算值并标「推算 · 非官方」，
    // 同时给出「下次通知」= 下一轮调价公告的发布日。
    var winMeta = fmt.windowMeta(win);
    var sync = payload.sync || {};
    var syncMeta = fmt.syncStatus(sync.status);
    // 有待人工核对的记录时不能只报「同步正常」
    if (sync.needsReview && sync.needsReview.length && syncMeta.style !== 'error') {
      syncMeta = {
        text: fmt.SYNC_STATUS_META.pending.text + '（' + sync.needsReview.length + ' 条）',
        style: 'warn'
      };
    }
    // 后端明确说「合法为空」：显示空态，不当加载失败
    var dataEmpty = payload.empty === true;
    var self = this;

    var notices = (payload.notices || []).map(function (n) {
      var fuelId = prefsFuelId();
      // 每升四油品幅度取哪一份：后端已按「官方公布 → 本地区实测 → 各省中位数 →
      // 官方吨价折算」的顺序取好，这里只管用，并把来源标出来
      var deltaSource = fmt.noticeDeltas(n);
      var delta = deltaSource.deltas[fuelId];
      // 当前油品的幅度来自哪一份（官方公布 / 本地区实测 / 各省中位数 / 吨价折算）
      var basis = deltaSource.sources[fuelId] || '';
      // 幅度缺失时不能拿 0 顶上：那等于替来源猜了一个幅度
      var known = typeof delta === 'number' && isFinite(delta);
      // 搁浅轮次是「不作调整」，不是「待公布」
      var flat = n.direction === 'flat';
      var meta = known ? changeMeta(delta)
        : (flat ? { text: '不作调整', direction: 'flat' } : { text: '待公布', direction: 'flat' });
      var executeAt = String(n.executeAt || '').trim();
      var executeText = '';
      if (executeAt) {
        var executeTime = executeAt.slice(11, 16);
        executeText = fmt.cnDate(executeAt.slice(0, 10)) +
          (executeTime ? (' ' + executeTime) : '') + ' 执行';
      }
      return {
        id: n.id,
        kind: n.kind,
        kindLabel: n.kind === 'official' ? '正式结果' : '市场预测',
        title: n.title,
        // 发布日用 announcedAt（真实公告发布日），不是 publishedAt（采集入库时刻）
        publishedText: n.announcedAt ? fmt.dateOnly(n.announcedAt) : '',
        executeText: executeText,
        changeText: meta.text,
        direction: meta.direction,
        // 官方公告给的方向与汽/柴油吨价
        officialText: fmt.noticeOfficialText(n),
        // 每升幅度是不是挂牌价测算值
        // 每升幅度的来源标签（非官方才标）与口径说明
        deltaTag: fmt.basisTagOf(basis),
        deltaNote: fmt.deltaNoteOf(basis),
        raw: n
      };
    });

    function prefsFuelId() {
      return self.data.fuelId || '92';
    }

    var srcLine = fmt.sourceLine(payload.source);

    // 空列表要说清楚为什么空：预测分类还没有预测源，就直说「暂无市场预测」；
    // 正式公告分类则说明「公告发布后会自动同步到这里」。
    var emptyText = '该分类下暂无通知';
    var emptyHint = '切换筛选条件查看其它记录';
    if (this.data.filter === 'forecast') {
      emptyText = '暂无市场预测';
      emptyHint = '预测来源接入后会自动同步';
    } else {
      emptyText = '还没有正式调价公告';
      emptyHint = '正式公告发布后会自动同步到这里';
    }

    this.setData({
      loading: false,
      loadError: '',
      sourceText: srcLine.text,
      sourceWarn: srcLine.warn,
      window: {
        // 没有真实窗口日期就别渲染窗口卡（否则倒计时会写成「就是今天」）
        hasDate: winMeta.hasDate,
        dateText: winMeta.dateOnlyText,
        time: winMeta.time,
        // 日期下面那行小字：用推算值时写「推算 · 非官方」
        dateNote: winMeta.dateNote,
        progress: winMeta.progress,
        cycleStarted: winMeta.cycleStarted,
        countdownText: winMeta.countdownText,
        // 过期窗口的标题与首页共用一套规则（utils/format.windowMeta）
        expired: winMeta.expired,
        estimated: winMeta.estimated,
        titleText: winMeta.titleText,
        // 下次通知时间：下一轮调价公告的发布日
        noticeText: winMeta.noticeText,
        noticeNote: winMeta.noticeNote
      },
      sync: {
        // 状态文案由 format.syncStatus 统一映射，新增状态不会再漏
        statusText: syncMeta.text,
        className: syncMeta.style,
        // 没有采集发生就没有检查时刻，别显示「 检查更新」这种空壳
        checkedText: sync.lastCheckedAt ? (fmt.dateTime(sync.lastCheckedAt) + ' 检查更新') : '',
        // 主源不可用、备源接管时要说明白（数据是新的，但来源变了）
        hintText: fmt.syncSourceHint(sync.sources)
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
    var fuelId = this.data.fuelId || '92';
    var rawSource = raw.source || {};
    // 详情里的每升幅度按同一套优先级取（官方公布 → 本地区实测 → 各省中位数 → 吨价折算）
    var rawDeltaSource = fmt.noticeDeltas(raw);
    // 调价前后价表：与首页共用同一份装配（utils/format.noticePriceRows）
    var priceRows = fmt.noticePriceRows(raw, rawDeltaSource.sources);
    var rawDelta = rawDeltaSource.deltas[fuelId];
    var rawKnown = typeof rawDelta === 'number' && isFinite(rawDelta);
    var rawMeta = rawKnown ? changeMeta(rawDelta) : { verb: '待公布', direction: 'flat' };
    // 当前油品的幅度来自哪一份
    var rawBasis = rawDeltaSource.sources[fuelId] || '';
    var rawOfficialText = fmt.noticeOfficialText(raw);
    // 公告发布日（announcedAt）。publishedAt 是采集入库时刻，不是发布日。
    var announcedText = raw.announcedAt ? fmt.dateOnly(raw.announcedAt) : '';

    this.setData({
      sheetVisible: true,
      sheetKind: kind,
      detail: {
        title: raw.title,
        // 官方口径（方向 + 汽/柴油吨价）优先；没有官方口径才用后端摘要
        summary: rawOfficialText || raw.summary,
        // 每升幅度是不是挂牌价测算值
        // 每升幅度的来源标签（非官方才标）与口径说明
        deltaTag: fmt.basisTagOf(rawBasis),
        deltaNote: fmt.deltaNoteOf(rawBasis),
        // 调价前后价表：调价前 → 调价后 + 每升幅度
        prices: priceRows,
        // 价格表的口径（实测快照还是折算推的，得说清楚）
        priceNote: fmt.priceTableNote(priceRows),
        sourceName: rawSource.name || '未标注来源',
        // 原文链接：没有就不给，别留个点不动的空壳
        sourceUrl: rawSource.url || '',
        sourceLine: (rawSource.name || '未标注来源') +
          (announcedText ? (' · 公告发布于 ' + announcedText) : ''),
        publishedText: announcedText
      }
    });
  },

  /**
   * 「复制原文链接」。
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
        wx.showToast({ title: '复制失败，请重试', icon: 'none' });
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
