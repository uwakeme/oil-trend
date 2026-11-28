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

/* ---------------- 软 403 / 错误页识别 ---------------- */

/**
 * 站点「拒绝访问」的几种常见表现。
 *
 * ⚠️ 关键：**不一定回 HTTP 403**。
 * xmgcn.com 在 2026-11-24 实测：请求任何路径都回 **HTTP 200**，
 * 正文却是 nginx 的 403 错误页（138 字节静态文件，last-modified 2025-06-05）。
 * 抓取层只看状态码就会把它当成「抓取成功」，解析器再报「解析不出字段」——
 * 排查的人会去查解析器，而真正的问题是**站点在拒绝我们**。
 *
 * 所以正文也要看：命中特征就是「被拒」，不是「页面结构变了」。
 */
var BLOCK_SIGNATURES = [
  { re: /403\s*Forbidden/i, label: '403 Forbidden' },
  { re: /<title>\s*[45]\d\d\b/i, label: 'nginx 错误页' },
  { re: /Access\s+Denied/i, label: 'Access Denied' },
  { re: /502\s+Bad\s+Gateway|503\s+Service\s+Unavailable|504\s+Gateway/i, label: '网关错误页' },
  { re: /Just a moment/i, label: 'WAF 人机校验页' },
  { re: /滑动验证|人机验证|安全验证/, label: 'WAF 人机校验页' }
];

/**
 * 判断正文是不是「错误页 / 拦截页」。
 *
 * ⚠️ 只在**短页面**上判定：真实页面几十 KB，错误页几百字节。
 * 不加长度限制的话，一篇正文里出现「安全验证」四个字就会误判成被拦。
 *
 * @param {string} body 响应正文
 * @returns {string|null} 命中的特征名；不是错误页返回 null
 */
function detectBlockPage(body) {
  var html = String(body || '');
  if (!html) return null;
  if (html.length > 4096) return null;
  for (var i = 0; i < BLOCK_SIGNATURES.length; i++) {
    if (BLOCK_SIGNATURES[i].re.test(html)) return BLOCK_SIGNATURES[i].label;
  }
  return null;
}

/* ---------------- 来源级熔断 ---------------- */

/**
 * 被拒的来源要停下来，别再敲。
 *
 * ⚠️ 为什么必须有：价格源一次要抓 31 个省，每个省还会重试一次 ——
 * 站点在拒绝我们的时候，这套流程等于每 30 分钟往对方脸上打 62 个请求，
 * 轻则白跑，重则把我们的出口 IP 也拉黑，连兜底源一起赔进去。
 *
 * 所以连续被拒就熔断：冷却期内这个来源**一个请求都不发**，
 * 直接让降级链的下一个源接手。
 *
 * 熔断按**来源**记，不按主机记：站点可能只拦某条路径
 * （xmgcn 的调价时间表被拦，省份页照常），按主机记会误伤还在正常工作的路径。
 */
var BLOCK_THRESHOLD = 3;                  // 连续几次被拒才熔断（别被偶发一次误伤）
var BLOCK_COOLDOWN_MS = 6 * 3600 * 1000;  // 熔断后冷却 6 小时再试（与价格源 6 小时新鲜期一致）
var blockedScopes = {};

function scopeKey(scope) {
  return String(scope || '');
}

/**
 * 记一次「被拒」。连续到阈值就开熔断。
 * @returns {object} 当前状态 { count, until, label, at }
 */
function markBlocked(scope, label) {
  var key = scopeKey(scope);
  if (!key) return null;
  var cur = blockedScopes[key] || { count: 0, until: 0, label: '', at: '' };
  cur.count += 1;
  cur.label = label || cur.label;
  cur.at = new Date().toISOString();
  if (cur.count >= BLOCK_THRESHOLD) {
    cur.until = Date.now() + BLOCK_COOLDOWN_MS;
  }
  blockedScopes[key] = cur;
  return cur;
}

/** 该来源是否处于冷却期（冷却期内不再发请求） */
function isBlocked(scope) {
  var cur = blockedScopes[scopeKey(scope)];
  return !!(cur && cur.until > Date.now());
}

/** 该来源的被拒记录（给运维看） */
function blockedInfo(scope) {
  return blockedScopes[scopeKey(scope)] || null;
}

/** 抓成功了：清掉被拒计数（站点恢复了就别再熔断） */
function clearBlocked(scope) {
  var key = scopeKey(scope);
  if (!key) return;
  if (blockedScopes[key]) {
    blockedScopes[key] = { count: 0, until: 0, label: '', at: '' };
  }
}

/** 清空全部熔断状态（测试用） */
function resetBlocked() {
  blockedScopes = {};
}

/**
 * 按响应编码解码正文。
 *
 * ⚠️ 新浪的行情接口回的是 **GB18030**（品种名是中文）：
 *    按 UTF-8 解会变成乱码。抓取层统一在这里处理，
 *    解析器拿到的保证是解码后的文本。
 *
 * 编码判断顺序：来源配置里指定的 charset → 响应头 content-type。
 *
 * @param {Buffer} buf         原始字节
 * @param {string} contentType 响应头 content-type
 * @param {string} [charset]   来源配置的 charset（如 'gbk'）
 * @returns {string} 解码后的文本
 */
function decodeBody(buf, contentType, charset) {
  var cs = String(charset || '').toLowerCase();
  if (!cs) {
    var m = String(contentType || '').match(/charset=([\w-]+)/i);
    if (m) cs = m[1].toLowerCase();
  }
  if (/gbk|gb2312|gb18030/.test(cs)) {
    // GB18030 是 GBK 的超集：标注 gb18030 就按 gb18030 解
    var label = cs.indexOf('gb18030') >= 0 ? 'gb18030' : 'gbk';
    try {
      return new TextDecoder(label).decode(buf);
    } catch (e) {
      // Node 没带完整 ICU 时降级：数字字段仍解析得出来，中文会乱码
      return buf.toString('utf8');
    }
  }
  return buf.toString('utf8');
}

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
  // 熔断期内的来源一个请求都不发：站点在拒绝我们时，再打 62 次只会把出口 IP 也搭进去
  if (opts.scope && isBlocked(opts.scope)) {
    return Promise.reject(new Error('SOURCE_BLOCKED_COOLDOWN'));
  }
  // 总预算 = 单跳超时的两倍，至少覆盖一次跳转
  var deadline = Date.now() + (opts.totalTimeout || timeout * 2);
  var firstHost = null;

  function attempt(currentUrl, redirectsLeft) {
    return new Promise(function (resolve, reject) {
      // 只结算一次：请求、超时、预算三条路径都可能先到
      var settled = false;
      var budgetTimer = null;
      function settle(fn, arg) {
        if (settled) return;
        settled = true;
        if (budgetTimer) clearTimeout(budgetTimer);
        fn(arg);
      }
      var target;
      try {
        target = new URL(currentUrl);
      } catch (e) {
        settle(reject, new Error('URL_INVALID'));
        return;
      }
      if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        settle(reject, new Error('PROTOCOL_UNSUPPORTED'));
        return;
      }
      // 总时限：所有跳转加起来不能超过这个预算
      var remaining = deadline - Date.now();
      if (remaining <= 0) {
        settle(reject, new Error('TOTAL_TIMEOUT'));
        return;
      }
      if (!firstHost) firstHost = target.host;
      // 只允许跳到白名单里的 host。不给白名单时，只允许同 host。
      var allowed = opts.allowedHosts && opts.allowedHosts.length
        ? opts.allowedHosts
        : [firstHost];
      if (allowed.indexOf(target.host) < 0) {
        settle(reject, new Error('REDIRECT_BLOCKED'));
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
              settle(reject, new Error('REDIRECT_WITHOUT_LOCATION'));
              return;
            }
            if (redirectsLeft <= 0) {
              settle(reject, new Error('TOO_MANY_REDIRECTS'));
              return;
            }
            var next;
            try {
              next = new URL(location, target.toString()).toString();
            } catch (e) {
              // Location 是服务端给的非受信字符串，畸形值必须走正常拒绝路径，
              // 不能从 response 回调里抛出未捕获异常。
              settle(reject, new Error('URL_INVALID'));
              return;
            }
            attempt(next, redirectsLeft - 1).then(function (result) {
              settle(resolve, result);
            }, function (err) {
              settle(reject, err);
            });
            return;
          }

          var chunks = [];
          var size = 0;
          var tooLarge = false;
          res.on('data', function (chunk) {
            // ⚠️ 总时限必须在**单跳内**也生效。
            // req.setTimeout 是**空闲**超时：对方慢慢吐数据会不断把它重置，
            // 请求能一直挂着不结束 —— 跨跳预算只在下一次跳转时才检查，
            // 单跳里根本没有检查点。
            if (Date.now() >= deadline) {
              tooLarge = true;
              req.destroy();
              settle(reject, new Error('TOTAL_TIMEOUT'));
              return;
            }
            size += chunk.length;
            // 油价页只有几十 KB，超这个量级说明拿到的不是预期响应
            if (size > MAX_BYTES) {
              tooLarge = true;
              req.destroy();
              settle(reject, new Error('RESPONSE_TOO_LARGE'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', function () {
            if (tooLarge) return;
            var body = decodeBody(Buffer.concat(chunks), res.headers['content-type'], opts.charset);
            // 站点可能用「HTTP 200 + 错误页」拒绝访问（xmgcn 就是这么干的），
            // 状态码看不出被拒，得看正文。命中就把这次记成「被拒」并计入熔断。
            var blocked = detectBlockPage(body);
            if (blocked) {
              markBlocked(opts.scope, blocked);
            } else if (opts.scope) {
              clearBlocked(opts.scope);
            }
            settle(resolve, {
              statusCode: status,
              body: body,
              blocked: blocked,
              url: target.toString()
            });
          });
        }
      );

      req.setTimeout(Math.min(timeout, remaining), function () {
        req.destroy();
        settle(reject, new Error('TIMEOUT'));
      });
      req.on('error', function (err) {
        settle(reject, err);
      });

      // 硬预算：不管对方吐不吐字节，到点就掐断。
      // 单靠 req.setTimeout（空闲超时）挡不住「慢速滴水」式的拖挂。
      budgetTimer = setTimeout(function () {
        req.destroy();
        settle(reject, new Error('TOTAL_TIMEOUT'));
      }, Math.max(1, remaining));

      req.end();
    });
  }

  return attempt(url, maxRedirects);
}

module.exports = {
  get: get,
  decodeBody: decodeBody,
  detectBlockPage: detectBlockPage,
  markBlocked: markBlocked,
  isBlocked: isBlocked,
  blockedInfo: blockedInfo,
  clearBlocked: clearBlocked,
  resetBlocked: resetBlocked
};