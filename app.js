const { initCloud } = require('./utils/cloud');
const store = require('./utils/store');

App({
  globalData: {
    // 启动时填充：当前选中的地区与油品，页面之间共享
    region: null,
    fuelId: '92',
    cloudReady: false
  },

  onLaunch() {
    this.globalData.cloudReady = initCloud(this);
    const prefs = store.getPrefs();
    this.globalData.fuelId = prefs.fuelId || '92';
    store.seedRegionIfNeeded();
  },

  onShow() {
    const prefs = store.getPrefs();
    this.globalData.fuelId = prefs.fuelId || '92';
  }
});
