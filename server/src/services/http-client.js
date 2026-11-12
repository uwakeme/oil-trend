/**
 * 外部 HTTP 抓取客户端
 *
 * 采集器要抓站点的 HTML 页面（汽油价格网的地区页），也要抓 JSON 接口，
 * 所以统一封一层：超时、响应体上限、状态码自己控。
 *
 * 返回体统一给**字符串**：解析器要的是原始文本
 * （qiyoujiageRegion 靠正则切 HTML，genericQuote 自己 JSON.parse），
 * 这里不做 JSON 解析，避免把「返回了 JSON」和「返回了 HTML」两种情况混在一起。
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

var MAX_BYTES = 5 * 1024 * 1024;

/**
 * 发起一次 GET 请求
 * @param {string} url 地址
 * @param {object} options { headers, timeout }
 * @returns {Promise<{statusCode:number, body:string}>}
 *   失败时 reject 的 Error.message 是稳定标识：URL_INVALID / PROTOCOL_UNSUPPORTED
 *   / TIMEOUT / RESPONSE_TOO_LARGE / 或底层网络错误码
 */
function get(url, options) {
  var opts = options || {};
  var timeout = opts.timeout || 15000;
  return new Promise(function (resolve, reject) {
    var target;
    try {
      target = new URL(url);
    } catch (e) {
      reject(new Error('URL_INVALID'));
      return;
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      reject(new Error('PROTOCOL_UNSUPPORTED'));
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
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );

    req.setTimeout(timeout, function () {
      req.destroy();
      reject(new Error('TIMEOUT'));
    });
    req.on('error', function (err) {
      reject(err);
    });
    req.end();
  });
}

module.exports = { get: get };
