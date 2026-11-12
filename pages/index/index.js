const api = require('../../utils/api');
const store = require('../../utils/store');
const fmt = require('../../utils/format');
const location = require('../../utils/location');

/**
 * 定位入口的提示文案。
 * key 与 utils/location.js、utils/api.js 返回的 error 码一一对应。
 */
var LOCATE_DESC = {
  idle: '打开定位，识别所在省份并切换',
  locating: '正在获取位置…',
  denied: '未获得位置权限，点此去设置开启',
  privacy: '需要同意隐私协议才能定位',
  unavailable: '定位失败，请检查定位服务后重试',
  'no-match': '没识别出所在省份，请手动选择',
  'no-backend': '服务暂时不可用，请手动选择'
};

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
    allRegions: [],
    regionKeyword: '',
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
    sheetType: '',
    locateHint: '',
    locateAction: '',
    locateCode: '',
    locating: false,
    locateCurrentDesc: LOCATE_DESC.idle,
    locateCurrentAction: ''
  },

  onLoad() {
    var prefs = store.getPrefs();
    // 快照在 onLoad 就记下：首屏 onShow 比对相同，不会重复发一轮请求
    this._prefsKey = store.prefsKey(prefs);
    this.setData({ fuelId: prefs.fuelId || '92' });
    this.load(prefs.regionCode);
    this.detectLocation();
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
    // 请求序号：定位切换地区会连发两轮请求，
    // 先发的那轮可能后到，不能让它把新地区的结果盖回去。
    this._reqSeq = (this._reqSeq || 0) + 1;
    var seq = this._reqSeq;
    this.setData({ loading: true, loadError: '' });
    return api.getHome(regionCode, this.data.fuelId).then(function (payload) {
      if (seq !== self._reqSeq) return;
      self._raw = payload;
      self.applyHome(payload);
    }).catch(function () {
      if (seq !== self._reqSeq) return;
      self.setData({ loading: false, loadError: '油价数据加载失败，请检查网络后重试' });
    });
  },

  /**
   * 自动定位所在省份。
   *
   * 规则：
   *   - 用户没手动选过地区 → 直接切到定位到的省并重新取数
   *   - 用户手动选过       → 不动用户的选择，只提示「检测到你在 XX，点此切换」
   *   - 定位失败或被拒绝   → 保持原地区，给一个「开启定位」的入口
   *
   * 定位是锦上添花，任何一步失败都不该影响首页取数。
   */
  detectLocation() {
    var self = this;
    return location.detectRegion().then(function (hit) {
      if (!hit) return;
      if (hit.error) {
        // 只有「用户拒绝过权限」才值得给入口，其余情况静默降级
        if (hit.error === 'denied') {
          self.setData({
            locateHint: '开启定位，自动识别所在省份',
            locateAction: 'openSetting'
          });
        }
        return;
      }
      var prefs = store.getPrefs();
      if (prefs.regionCode === hit.regionCode) {
        self.setData({ locateHint: '', locateAction: '' });
        return;
      }
      if (store.getRegionSource() === 'manual') {
        self.setData({
          locateHint: '检测到你现在在' + hit.regionName + '，点此切换',
          locateAction: 'switch',
          locateCode: hit.regionCode
        });
        return;
      }
      store.setRegion(hit.regionCode, 'auto');
      self._prefsKey = store.prefsKey(store.getPrefs());
      self.setData({ locateHint: '', locateAction: '' });
      self.load(hit.regionCode);
    }).catch(function () {
      // 定位失败就算了，不打扰用户
    });
  },

  /**
   * 定位并切到当前所在省。
   *
   * 不管用户之前手动选过什么 —— 他明确点了「当前位置」，就该以位置为准。
   *
   * 返回 { switched, same, regionName } 或 { error }
   */
  locateAndSwitch() {
    var self = this;
    return location.detectRegion().then(function (hit) {
      if (!hit) return { error: 'unavailable' };
      if (hit.error) return hit;
      if (store.getPrefs().regionCode === hit.regionCode) {
        return { same: true, regionName: hit.regionName };
      }
      store.setRegion(hit.regionCode, 'auto');
      self._prefsKey = store.prefsKey(store.getPrefs());
      self.setData({ sheetType: '', locateHint: '', locateAction: '', locateCode: '' });
      self.load(hit.regionCode);
      return { switched: true, regionName: hit.regionName };
    });
  },

  /**
   * 地区弹层里的「当前位置」：手动再定位一次。
   *
   * 失败时把原因直接写在条目上，别只弹个 toast 让人一头雾水；
   * 用户拒绝过权限的话，下一次点击直接拉起系统设置页。
   */
  onLocateCurrent() {
    var self = this;
    if (this.data.locating) return;

    // 上次点开过「去设置开启」，这次直接去设置
    if (this.data.locateCurrentAction === 'openSetting') {
      this.setData({ locating: true, locateCurrentDesc: '正在打开设置…' });
      return location.openSetting().then(function (granted) {
        self.setData({ locating: false });
        if (!granted) {
          self.setData({ locateCurrentDesc: LOCATE_DESC.denied });
          return;
        }
        self.setData({ locateCurrentDesc: LOCATE_DESC.idle, locateCurrentAction: '' });
        self.onLocateCurrent();
      });
    }

    this.setData({ locating: true, locateCurrentDesc: LOCATE_DESC.locating });
    return this.locateAndSwitch().then(function (result) {
      self.setData({ locating: false });
      if (result.error) {
        self.setData({
          locateCurrentDesc: LOCATE_DESC[result.error] || LOCATE_DESC.unavailable,
          locateCurrentAction: result.error === 'denied' ? 'openSetting' : ''
        });
        return;
      }
      if (result.same) {
        self.setData({ locateCurrentDesc: '你当前就在' + result.regionName });
        wx.showToast({ title: '当前已在' + result.regionName, icon: 'none' });
        return;
      }
      self.setData({ locateCurrentDesc: LOCATE_DESC.idle });
      wx.showToast({ title: '已切换到' + result.regionName, icon: 'none' });
    });
  },

  onLocateHintTap() {
    var self = this;
    var action = this.data.locateAction;
    if (action === 'switch') {
      var code = this.data.locateCode;
      if (!code) return;
      store.setRegion(code, 'auto');
      this._prefsKey = store.prefsKey(store.getPrefs());
      this.setData({ locateHint: '', locateAction: '', locateCode: '' });
      this.load(code);
      return;
    }
    if (action === 'openSetting') {
      location.openSetting().then(function (granted) {
        if (!granted) return;
        self.setData({ locateHint: '', locateAction: '' });
        self.detectLocation();
      });
    }
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
    // 幅度解析不出来时后端给的是空 forecast + 单独的方向字段。
    // 这时不能套 changeMeta —— 它会把 undefined 当成 0，
    // 界面就变成「持平」，等于替来源猜了一个幅度。
    var forecastKnown = forecastAmount !== undefined && forecastAmount !== null;
    var forecastMeta;
    if (forecastKnown) {
      forecastMeta = changeMeta(forecastAmount);
    } else {
      var dir = windowData.forecastDirection || '';
      forecastMeta = {
        text: dir === 'up' ? '预计上调' : (dir === 'down' ? '预计下调' : '待公布'),
        direction: dir === 'up' ? 'up' : (dir === 'down' ? 'down' : 'flat'),
        caption: dir === 'up' ? '幅度待公布 · 非官方' : (dir === 'down' ? '幅度待公布 · 非官方' : '方向未定 · 非官方')
      };
    }

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
        text: forecastKnown
          ? (forecastAmount < 0 ? '↓ ' : forecastAmount > 0 ? '↑ ' : '') + Math.abs(forecastAmount || 0).toFixed(2)
          : forecastMeta.text,
        direction: forecastMeta.direction,
        // 幅度未知时单位不该写「元/升」，改成说明文案
        caption: forecastMeta.caption || (fuelId + '# · 元/升 · 非官方')
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
        // 后端通知可能没有发布时间，缺了就不写「发布于 …」，别留个空壳
        publishedText: fmt.dateTime(latest.publishedAt),
        sourceLine: (source.name || '未标注来源') + (source.mode === 'demo' ? '（演示数据）' : '') +
          (latest.publishedAt ? (' · 发布于 ' + fmt.dateTime(latest.publishedAt)) : '')
      },
      updatedLabel: fmt.dateTime(payload.updatedAt) + ' 更新',
      sourceName: source.name || '未知来源',
      sourceNote: source.note || '',
      cloudStatus: source.mode === 'live'
        ? ('本次数据来自' + (source.name || source.transport || '后端服务'))
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

  /* ---------- 地区搜索 ---------- */

  /**
   * 地区列表有 31 个省，滚动翻找太慢 —— 加个搜索框。
   * 省份名、城市名、拼音首字母都能匹配。
   */
  onRegionSearch(e) {
    var keyword = String((e && e.detail && e.detail.value) || '').trim();
    var all = this.data.allRegions || [];
    var filtered = all;
    if (keyword) {
      var kw = keyword.toLowerCase();
      filtered = all.filter(function (r) {
        return r.name.indexOf(keyword) >= 0 ||
          r.city.indexOf(keyword) >= 0 ||
          (r.pinyin && r.pinyin.indexOf(kw) >= 0);
      });
    }
    this.setData({ regionKeyword: keyword, regions: filtered });
  },

  onClearRegionSearch() {
    var all = this.data.allRegions || [];
    this.setData({ regionKeyword: '', regions: all });
  },

  onPickRegion() {
    var self = this;
    // 弹层里的「当前位置」入口要按当前授权状态给提示
    location.currentAuthState().then(function (state) {
      if (state === 'denied') {
        self.setData({ locateCurrentDesc: LOCATE_DESC.denied, locateCurrentAction: 'openSetting' });
      } else {
        self.setData({ locateCurrentDesc: LOCATE_DESC.idle, locateCurrentAction: '' });
      }
    });
    api.getRegions().then(function (regions) {
      var list = (regions || []).map(function (r) {
        return Object.assign({}, r, { priceText: fmt.price(r.price92) });
      });
      self.setData({
        allRegions: list,
        regions: list,
        regionKeyword: '',
        sheetType: 'city'
      });
    }).catch(function () {
      wx.showToast({ title: '地区列表获取失败', icon: 'none' });
    });
  },

  onSelectRegion(e) {
    var code = e.currentTarget.dataset.code;
    if (!code) return;
    // 手动选的地区要记成 'manual'：之后自动定位只提示，不再覆盖用户的选择
    store.setRegion(code, 'manual');
    this.setData({ sheetType: '', locateHint: '', locateAction: '', locateCode: '' });
    this._prefsKey = store.prefsKey(store.getPrefs());
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
  }
});
