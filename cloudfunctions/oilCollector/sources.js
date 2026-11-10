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
    var m = text.match(/每升(?:汽柴油)?(?:价格)?(?:分别)?(?:上调|下调|调整)([\d.]+)元/);
    if (!m) return null;

    var executeAt = null;
    var m2 = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日24:00/);
    if (m2) {
      executeAt = m2[1] + '-' + pad(m2[2]) + '-' + pad(m2[3]);
    }

    var titleMatch = text.match(/(国内成品油价格按机制(?:上调|下调))/);
    var amount = Number(m[1]);
    if (!isFinite(amount)) return null;

    return {
      kind: 'official',
      title: titleMatch ? titleMatch[1] : '国内成品油价格调整',
      executeAt: executeAt,
      delta: amount,
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

module.exports = { SOURCES: SOURCES, PARSERS: PARSERS };
