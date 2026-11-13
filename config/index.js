/**
 * 全局配置
 *
 * 接入真实数据前，在这里填入：
 *   1. apiBaseUrl            —— 自建后端地址（见 server/ 与 docs/server-deploy.md）
 *   2. subscribeTemplateIds  —— 订阅消息模板 ID（从微信公众平台申请）
 *
 * dataSource 说明：
 *   'demo' —— 只用内置演示数据源（克隆即可跑通全部交互）
 *   'auto' —— 优先走后端，失败时自动回落演示数据源
 *
 * ⚠️ 引用方式必须是 '../config/index'，不能写 '../config'：
 *   微信小程序运行时的 require 不做目录 index 解析，
 *   只写 '../config' 会报 "module 'config.js' is not defined"。
 */
module.exports = {
  // 订阅消息模板 ID（微信公众平台 → 订阅消息 → 我的模板）
  // ⚠️ 必须是**正式** AppID 申请的模板，测试号拿不到。
  // 模板字段与取值格式见 server/src/services/subscribe-templates.js（平台模板的镜像），
  // 换模板时这两处 + 服务端 .env 的 OIL_SUBSCRIBE_TEMPLATE_ID 要同步改。
  subscribeTemplateIds: ['OaHgjTXlhVAUOtdvqE_yxWZkt8r0cZdbhwuD4kq9Rqg'],

  // 后端地址：自建服务器（server/ 部署的那台）。
  // 留空则一律使用本地演示数据。
  // ⚠️ 必须已在公众平台「服务器域名 → request 合法域名」里配好，
  //   否则小程序端请求会被直接拦掉，页面一直显示演示数据。
  apiBaseUrl: 'https://oil-trend.uwakeme.top',

  // 'auto' 会在后端可用时自动优先走后端；'demo' 强制只用本地演示源
  dataSource: 'auto',

  // 演示数据集的锚点日期：所有演示日期会按「今天 - 锚点」整体平移，
  // 保证数据集永远看起来是最近发生的，而不是一堆过期日期。
  demoAnchorDate: '2026-11-10'
};
