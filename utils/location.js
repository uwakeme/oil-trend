/**
 * 定位：读取用户位置 → 反查所在省份
 *
 * 三步：
 *   1. 隐私协议授权（wx.requirePrivacyAuthorize）
 *   2. wx.getLocation 拿经纬度
 *   3. 调后端 /api/locate 把经纬度换算成省份
 *
 * ⚠️ 坐标系必须是 gcj02：
 *    服务端的省界数据是 GCJ-02，用 wgs84 会有 300~600 米偏移，
 *    江苏/河北这种贴着的省份会判错。
 *
 * ⚠️ 任何一步失败都静默返回 null：
 *    定位是锦上添花，拿不到位置不该影响首页取数，
 *    也不该弹错误提示打扰用户。
 */
const api = require('./api');

/** 位置授权的 scope */
var SCOPE = 'scope.userLocation';

/**
 * 隐私协议授权。
 *
 * 位置信息属于用户隐私，2023 年起小程序必须先取得用户的隐私协议同意，
 * 否则接口直接被拦。基础库 2.32.3 以下没这个接口，跳过即可。
 */
function authorizePrivacy() {
  return new Promise(function (resolve) {
    if (typeof wx.requirePrivacyAuthorize !== 'function') {
      resolve(true);
      return;
    }
    wx.requirePrivacyAuthorize({
      success: function () { resolve(true); },
      fail: function () { resolve(false); }
    });
  });
}

/**
 * 查位置授权状态。
 * 返回 'granted' / 'denied' / 'unknown'
 *   denied  = 用户之前明确拒绝过，再调 getLocation 只会立刻 auth deny，
 *             不该再去打扰一次，只能引导去设置页
 *   unknown = 从没问过，这次调用会弹系统授权框
 */
function authState() {
  return new Promise(function (resolve) {
    if (typeof wx.getSetting !== 'function') {
      resolve('unknown');
      return;
    }
    wx.getSetting({
      success: function (res) {
        var auth = (res && res.authSetting) || {};
        if (auth[SCOPE] === true) resolve('granted');
        else if (auth[SCOPE] === false) resolve('denied');
        else resolve('unknown');
      },
      fail: function () { resolve('unknown'); }
    });
  });
}

/** 拿一次经纬度 */
function requestPosition() {
  return new Promise(function (resolve) {
    if (typeof wx.getLocation !== 'function') {
      resolve(null);
      return;
    }
    wx.getLocation({
      type: 'gcj02',
      isHighAccuracy: false,
      highAccuracyExpireTime: 3000,
      success: function (res) {
        if (res && typeof res.latitude === 'number' && typeof res.longitude === 'number') {
          resolve({ latitude: res.latitude, longitude: res.longitude });
          return;
        }
        resolve(null);
      },
      fail: function () { resolve(null); }
    });
  });
}

/**
 * 定位一次。
 * 返回 { latitude, longitude } 或 null
 */
function detectPosition() {
  return authorizePrivacy().then(function (ok) {
    if (!ok) return null;
    return authState().then(function (state) {
      if (state === 'denied') return null;
      return requestPosition();
    });
  });
}

/**
 * 定位所在省份。
 *
 * 返回 { regionCode, regionName, city, match } 或 null。
 * match: inside 落在省界内 / nearest 就近归属 / none 没匹配到
 */
function detectRegion() {
  return detectPosition().then(function (pos) {
    if (!pos) return null;
    return api.locate(pos.latitude, pos.longitude);
  });
}

/**
 * 当前的位置授权状态，供页面决定要不要给「开启定位」的入口。
 */
function currentAuthState() {
  return authState();
}

/**
 * 拉起系统设置页，让用户重新打开位置权限。
 * 用户拒绝过定位后，这是唯一的补救路径。
 */
function openSetting() {
  return new Promise(function (resolve) {
    if (typeof wx.openSetting !== 'function') {
      resolve(false);
      return;
    }
    wx.openSetting({
      success: function (res) {
        resolve(!!(res && res.authSetting && res.authSetting[SCOPE]));
      },
      fail: function () { resolve(false); }
    });
  });
}

module.exports = {
  detectPosition: detectPosition,
  detectRegion: detectRegion,
  currentAuthState: currentAuthState,
  openSetting: openSetting
};
