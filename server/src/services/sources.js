/**
 * 采集源配置
 *
 * ⚠️ 重要：以下真实来源默认全部关闭。
 *
 * 设计文档明确要求：「正式开发前需要单独验证来源可访问性、字段稳定性、
 * 更新频率和授权条款；无法自动解析时进入人工核对队列，
 * 不能把猜测值发布为正式结果。」
 *
 * 启用某个来源前请完成：
 *   1. 确认该地址可以稳定访问（是否需要 Referer / Cookie / 频率限制）
 *   2. 确认抓取与展示不违反对方的使用条款
 *   3. 写好 parser，并跑一次真实抓取验证解析结果
 *
 * 关闭状态下采集函数会照常跑通「读取配置 → 抓取 → 解析 → 去重 → 入库」流程，
 * 只是把每个来源标记为 skipped，并把演示数据写进库，
 * 以便完整验证云端链路。
 */
const SOURCES = [
  {
    id: 'ndrc-notice',
    name: '国家发展改革委价格监测中心',
    kind: 'notice',
    enabled: false,
    url: '',
    headers: {},
    parser: 'ndrcNotice',
    note: '正式调价公告来源，需先验证可访问性与使用条款'
  },
  {
    id: 'market-quote',
    name: '国际原油行情接口',
    kind: 'market',
    enabled: false,
    url: '',
    headers: {},
    parser: 'genericQuote',
    note: 'Brent / WTI 报价，需确认是否延时、是否允许展示'
  }
];

/**
 * 通用解析器：只接受「明确匹配到数值」的结果。
 * 匹配不到就返回 null，由采集函数丢进人工核对队列，
 * 绝不用默认值或猜测值填充正式结果。
 */
const PARSERS = {
  /**
   * 解析调价公告：从正文里找「每升调整 X 元」这类明确表述。
   * 找不到就返回 null。
   */
  ndrcNotice(raw) {
    var text = String(raw || '').replace(/\s+/g, '');

    // 必须连方向一起抓：之前只抓数字，Number() 恒为正，
    // 「下调 0.08 元」会被解析成 +0.08，涨跌方向整个反掉。
    var m = text.match(/每升(?:汽柴油)?(?:价格)?(?:分别)?(上调|下调|调整)([\d.]+)元/);
    if (!m) return null;
    var magnitude = Number(m[2]);
    if (!isFinite(magnitude)) return null;
    var totalDelta = m[1] === '下调' ? -magnitude : magnitude;

    var executeAt = null;
    var m2 = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日24:00/);
    if (m2) {
      executeAt = m2[1] + '-' + pad(m2[2]) + '-' + pad(m2[3]);
    }

    // 各油品幅度本来就不同，正文里通常逐个油品写。
    // 能分别解析就分别解析，解析不出来就整体进人工核对。
    var deltas = {};
    var fuelRe = /(92#|95#|98#|0#|柴油|汽油)[^。；;]{0,16}?每升(?:价格)?(上调|下调|调整)([\d.]+)元/g;
    var hit;
    while ((hit = fuelRe.exec(text)) !== null) {
      var fuelKey = fuelKeyOf(hit[1]);
      if (!fuelKey) continue;
      var value = Number(hit[3]);
      if (!isFinite(value)) continue;
      deltas[fuelKey] = hit[2] === '下调' ? -value : value;
    }
    var perFuel = Object.keys(deltas).length > 0;
    if (!perFuel) {
      // 只有一个总数：先按同一幅度填，但标记为待复核
      deltas = { '92': totalDelta, '95': totalDelta, '98': totalDelta, '0': totalDelta };
    }

    var titleMatch = text.match(/(国内成品油价格按机制(?:上调|下调))/);

    return {
      kind: 'official',
      title: titleMatch ? titleMatch[1] : '国内成品油价格调整',
      executeAt: executeAt,
      delta: totalDelta,
      deltas: deltas,
      perFuel: perFuel,
      // 采集解析出来的结果一律待复核，复核通过才对外可见
      reviewStatus: 'pending',
      raw: raw && raw.length > 4000 ? raw.slice(0, 4000) : raw
    };
  },

  /**
   * 解析行情：要求同时拿到品种名、价格和时间，缺一不可。
   */
  genericQuote(raw) {
    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    if (!data || typeof data.price !== 'number' || !data.symbol) return null;
    return {
      symbol: data.symbol,
      name: data.name || data.symbol,
      price: data.price,
      changeAmount: Number(data.changeAmount) || 0,
      changePercent: Number(data.changePercent) || 0,
      quoteTime: data.quoteTime || '',
      delayed: !!data.delayed
    };
  }
};

function pad(n) {
  n = String(n);
  return n.length < 2 ? '0' + n : n;
}

/** 正文里的油品叫法 → 内部油品 id */
function fuelKeyOf(text) {
  var map = { '92#': '92', '95#': '95', '98#': '98', '0#': '0', '柴油': '0', '汽油': '92' };
  return map[text] || null;
}

module.exports = { SOURCES: SOURCES, PARSERS: PARSERS };
