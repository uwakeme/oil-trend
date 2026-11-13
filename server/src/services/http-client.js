/**
 * 外部 HTTP 抓取客户端
 *
 * 采集器要抓站点的 HTML 页面（汽油价格网的地区页），也要抓 JSON 接口，
 * 所以统一封一层：超时、响应体上限、状态码、重定向自己控。
 *
 * 返回体统一给**字符串**：解析器要的是原始文本
 * （qiyoujiageRegion 靠正则切 HTML，genericQuote 自己 JSON.parse），
 * 这里不做 JSON 解析，避免把「返回了 JSON」和「返回了 HTML」两种情况混在一起。
 *
 * ⚠️ 三条硬约束（都踩过）：
 *   1. 总时限：req.setTimeout 是**空闲**超时，对方慢慢吐数据会不断重置它，
 *      请求能一直挂着不结束。这里额外加一个跨跳的总预算。
 *   2. 重定向：站点改成 https 或换域名时会 301/302，
 *      不跟就直接判失败（每 30 分钟静默失败一次）；
 *      跟了又不能跟到任意地方 —— 目标 host 必须在白名单里。
 *   3. 响应体上限：超了直接掐断，别让对方把内存吃满。
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

var MAX_BYTES = 5 * 1024 * 1024;

/**
 * 发起一次 GET 请求
 * @param {string} url 地址
 * @param {object} options { headers, timeout, totalTimeout, maxRedirects, allowedHosts }
 * @returns {Promise<{statusCode:number, body:string, url:string}>}
 *   失败时 reject 的 Error.message 是稳定标识：
 *   URL_INVALID / PROTOCOL_UNSUPPORTED / TIMEOUT / TOTAL_TIMEOUT /
 *   RESPONSE_TOO_LARGE / TOO_MANY_REDIRECTS / REDIRECT_BLOCKED
 */
function get(url, options) {
  var opts = options || {};
  var timeout = opts.timeout || 15000;
  var maxRedirects = opts.maxRedirects === undefined ? 3 : opts.maxRedirects;
  // 总预算 = 单跳超时的两倍，至少覆盖一次跳转
  var deadline = Date.now() + (opts.totalTimeout || timeout * 2);
  var firstHost = null;

  function attempt(currentUrl, redirectsLeft) {
    return new Promise(function (resolve, reject) {
      var target;
      try {
        target = new URL(currentUrl);
      } catch (e) {
        reject(new Error('URL_INVALID'));
        return;
      }
      if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        reject(new Error('PROTOCOL_UNSUPPORTED'));
        return;
      }
      // 总时限：所有跳转加起来不能超过这个预算
      var remaining = deadline - Date.now();
      if (remaining <= 0) {
        reject(new Error('TOTAL_TIMEOUT'));
        return;
      }
      if (!firstHost) firstHost = target.host;
      // 只允许跳到白名单里的 host。不给白名单时，只允许同 host。
      var allowed = opts.allowedHosts && opts.allowedHosts.length
        ? opts.allowedHosts
        : [firstHost];
      if (allowed.indexOf(target.host) < 0) {
        reject(new Error('REDIRECT_BLOCKED'));
        return;
      }

      var lib = target.protocol === 'https:' ? https : http;
      var req = lib.request(
        target.toString(),
        {
          method: 'GET',
          headers: opts.headers || {}
        },
        function (res) {
          var status = res.statusCode;
          // 3xx：跟随（最多 maxRedirects 跳），目标必须在白名单里
          if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
            var location = res.headers.location;
            res.resume();
            if (!location) {
              reject(new Error('REDIRECT_WITHOUT_LOCATION'));
              return;
            }
            if (redirectsLeft <= 0) {
              reject(new Error('TOO_MANY_REDIRECTS'));
              return;
            }
            var next = new URL(location, target.toString()).toString();
            attempt(next, redirectsLeft - 1).then(resolve, reject);
            return;
          }

          var chunks = [];
          var size = 0;
          var tooLarge = false;
          res.on('data', function (chunk) {
            size += chunk.length;
            // 油价页只有几十 KB，超这个量级说明拿到的不是预期响应
            if (size > MAX_BYTES) {
              tooLarge = true;
              req.destroy();
              reject(new Error('RESPONSE_TOO_LARGE'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', function () {
            if (tooLarge) return;
            resolve({
              statusCode: status,
              body: Buffer.concat(chunks).toString('utf8'),
              url: target.toString()
            });
          });
        }
      );

      req.setTimeout(Math.min(timeout, remaining), function () {
        req.destroy();
        reject(new Error('TIMEOUT'));
      });
      req.on('error', function (err) {
        reject(err);
      });
      req.end();
    });
  }

  return attempt(url, maxRedirects);
}

module.exports = { get: get };