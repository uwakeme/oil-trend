/**
 * 外部 HTTP 抓取客户端
 *
 * 为什么要自己写：
 *   wx-server-sdk 2.x 底层是 tcb-admin-node，带一个内置的 httpclient；
 *   4.x 换成 @cloudbase/node-sdk 后这个 API 整个没了。
 *   （实测 2.6.3 顶层本来也没有它 —— 那是 tcb-admin-node 的东西，
 *   4.x 换底层后一并消失。所以升级前这行代码其实也是坏的，
 *   只是所有采集源默认关闭，从没被真正执行过。）
 *
 * 用什么替代：
 *   云函数里发外部请求没有域名限制，直接用 Node 内置 https/http 即可，
 *   不必再引第三方 HTTP 库。这里用 https 走 TLS，超时和状态码自己控。
 *
 * 返回体统一给字符串：
 *   采集侧的解析器要的是原始文本（ndrcNotice 靠正则匹配公告正文，
 *   genericQuote 自己 JSON.parse），所以这里不做 JSON 解析，
 *   避免把「接口返回了 JSON」和「接口返回了 HTML」这两种情况混在一起。
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * 发起一次 GET 请求
 * @param {string} url 地址
 * @param {object} options { headers, timeout }
 * @returns {Promise<{statusCode:number, body:string}>}
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
          // 公告正文不会超过这个量级，超了说明不是预期的响应
          if (size > 5 * 1024 * 1024) {
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
