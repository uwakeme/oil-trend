/**
 * 全局配置
 *
 * 接入真实数据前，在这里填入：
 *   1. cloudEnvId        —— 微信云开发环境 ID（留空则使用默认环境）
 *   2. subscribeTemplateIds —— 订阅消息模板 ID（从微信公众平台申请）
 *
 * dataSource 说明：
 *   'demo'  —— 使用内置演示数据源（默认，克隆即可跑通全部交互）
 *   'cloud' —— 优先走云函数 oilApi，失败时自动回落演示数据源
 *
 * ⚠️ 引用方式必须是 '../config/index'，不能写 '../config'：
 *   微信小程序运行时的 require 不做目录 index 解析，
 *   只写 '../config' 会报 "module 'config.js' is not defined"。
 */
module.exports = {
  cloudEnvId: 'cloud1-d8ghtbekgdfa26c8f',
  subscribeTemplateIds: [],

  // 'auto' 会在云端可用时自动优先云端；'demo' 强制只用本地演示源
  dataSource: 'auto',

  // 演示数据集的锚点日期：所有演示日期会按「今天 - 锚点」整体平移，
  // 保证数据集永远看起来是最近发生的，而不是一堆过期日期。
  demoAnchorDate: '2026-11-10'
};
