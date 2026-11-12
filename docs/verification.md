# 验证记录

小程序不能只靠肉眼看。这次用了开发者工具的自动化接口做逐页验证，
踩到的坑和结论都记在这里，免得下次再踩一遍。

## 怎么跑

### 1. 开服务端口

开发者工具 → 设置 → 安全设置 → 服务端口 打开。
命令行第一次跑会问一次「是否开启工具服务」，输 y 即可。

### 2. 起自动化服务

```bash
"<微信开发者工具目录>/cli.bat" auto --project "<项目目录>" --auto-port 9421 --lang zh
```

端口会监听一个 WebSocket。`scripts/verify-in-devtools.js` 连上去之后：
逐页 switchTab → 读页面数据 → 截图 → 收集运行时日志。

### 3. 跑验证

```bash
npm i --prefix .tooling ws
node scripts/verify-in-devtools.js
```

## 为什么要自己写协议客户端

当初是 IDE 2.01.2510290，它的 `Tool.getInfo` 只返回 `{ version }`，
而 miniprogram-automator 0.13 读的是 `SDKVersion`，握手阶段直接抛
「Cannot read properties of undefined (reading 'split')」。

现在 IDE 升到 2.02.2609250，`Tool.getInfo` 已经同时返回
`{ version: '2.02.2609250', SDKVersion: '3.8.10' }`，automator 当年的握手障碍不存在了。
但脚本仍然保留自己的协议实现 —— 几十行就够，且不受 automator 版本变动影响；
实际依赖只有 `ws` 一个包，`miniprogram-automator` 并不需要安装。

## 截图里的 Canvas 内容（2026-11-11 更新）

**旧版 IDE（2.01.x）**：`App.captureScreenshot` 只截 DOM 层，不合成 canvas 图层，
自动截图里图表区域是空白的。那时的做法是临时给 `components/trend-chart/index.js`
注入导出钩子（`wx.canvasToTempFilePath({ canvas })` → base64 → 写进 storage），
再把画布 PNG 贴回页面截图。

**当前 IDE（2.02.2609250）已经会合成 canvas 图层**，直接跑
`node scripts/verify-in-devtools.js` 拿到的就是带图表的成品图。
旧的导出 + 合成两步因此被删除（`scripts/export-canvas.js`、`scripts/compose-screenshots.py`）——
留着反而会出错：截图里已经有画布了，再贴一次会出现两张错位的曲线。

判断有没有画出来，看截图里曲线在不在就行；也可以从小程序内部读
`ctx.getImageData()` 统计非透明像素交叉验证。

跑验证脚本之前先把 IDE 自动化服务起起来：
`cli.bat auto --project <path> --auto-port <port>`（端口用 `AUTO_WS` 环境变量覆盖，
脚本默认连 `ws://127.0.0.1:9421`）。

两个坑：

- 自动化桥的返回值统一包了一层 `{ result: ... }`，直接读 `res.token` 永远匹配不上
- 开发者工具监听项目根目录下**任意**文件变化就触发重编译，往 `docs/screenshots/` 写截图
  会把正在跑的页面冲掉 —— `verify-in-devtools.js` 因此改成先把截图攒在内存、跑完统一落盘

## 这次抓出来的真 bug

| 问题 | 表现 | 原因 |
| --- | --- | --- |
| WXML 编译失败 | `unexpected end tag: view` | `<br>` 不是 WXML 内置标签，被当成自定义组件 |
| 页面启动就抛异常 | `module 'config.js' is not defined` | 小程序 require 不做目录 index 解析，得写 `../config/index` |
| 图表空白 | 画布区域没内容 | `ctx.scale(dpr,dpr)` 是累乘，组件重复渲染时缩放变成 dpr 的 n 次方，图形画到画布外；改用 `ctx.setTransform` |
| 国际行情图是一根竖线 | 所有点叠在同一个 x | 行情的 date 是 `MM-DD HH:mm:ss`，时间轴正则要的是 `YYYY-MM-DD`，解析全返回 0 |
| 订阅卡图标不显示 | 白方块 | 动态 src 的值漏了 `.png` 后缀 |
| 自定义 tabBar 点不动 | switchTab 拿不到 url | `wx:for` 里写 `{{path}}`，应写 `{{item.path}}` |
| 五个页面同时白屏 | `Page.getData` 报 page destroyed | `utils/api.js` 里删了 `saveAlertHistory` 的函数体却忘了删 `module.exports` 的同名导出项，模块一被 require 就抛 ReferenceError。`node --check` 只查语法查不出来，靠 `scripts/check-modules.js` 兜住 |
| 走势图盖在弹层上 | 打开「选择油价地区」，绿色曲线浮在弹层内容上方 | canvas 走的是**独立原生渲染层**，不在网页的层叠上下文里 —— 把弹层 z-index 提到 99999、图表压到 0 都不影响。改成弹层打开时用 `trend-chart` 的 `visible` 属性把画布从 DOM 里摘掉 |
| 云端也是同一个坑 | 部署后才炸 | 云函数原先没有加载期门禁，`scripts/check-modules.js` 现在会 stub 掉 `wx-server-sdk` 再加载三个云函数入口及其本地模块 |

前两个是模拟器才会暴露的问题，静态检查查不出来。
`scripts/lint-wxml.js` 后来补了「标签必须是 WXML 内置标签或已声明的自定义组件」这条规则，
`<br>` 就是在那一轮被改掉的。

## 真机上 tabBar 没有吸底

用户拿真机扫码预览后反馈：底部菜单栏没有固定在下方，要滚动到底才能看到。

在模拟器里量过：`.tab-bar` 的 `boundingClientRect` 在页面滚动到 0 / 600 / 1200 时
恒为 `top: 701, bottom: 753`，说明 `position: fixed` 在模拟器是生效的；
真机跑的是用户微信自带的基础库，自定义 tabBar 组件里的 fixed 定位没有生效，
组件被当成页面内容的一部分排在了文档流末尾。

**改成原生 tabBar**：`app.json` 里去掉 `"custom": true`，给 `list` 配上
`iconPath` / `selectedIconPath`（用 `assets/icons/` 里现成的两态 PNG）。
原生 tabBar 由框架渲染、在自己的原生层里，永远吸底，所有设备所有基础库行为一致。

连带的两处调整：

- 页面根节点的底部留白从 `calc(132rpx + env(safe-area-inset-bottom))` 改成 `40rpx`。
  原生 tabBar 会把 webview 整体上移（模拟器里截图高度从 753 变成 671），
  页面内容不再延伸到 tabBar 下面，不用再给它留位置。
- 页面里去掉 `this.getTabBar().setData()`，原生 tabBar 自己管选中态。

代价：原生 tabBar 是框架层，`App.captureScreenshot` 截不到它，
自动截图里看不到底部导航条（真机上是正常的）。

## 已知的环境限制

- **预览二维码需要正式 AppID**。测试号（`touristappid`）能跑模拟器，但上传预览包会被平台拒绝：
  `AppID 不合法,invalid appid`
- **云开发需要正式 AppID**。测试号下 `wx.cloud.init` 报
  `operateWXData:fail`，代码里已经兜住，回落到本地演示数据
- **订阅消息需要正式 AppID + 模板 ID**。测试号申请不到模板

## 出预览二维码时踩到的三件事

1. **测试号不能上传预览包**。模拟器跑得好好的，`cli.bat preview` 直接报
   `AppID 不合法,invalid appid`。必须换正式 AppID。
2. **主包有 2MB 上限**。仓库里的 `.tooling/node_modules`、`docs`、`design`
   这些都会被打进包里，光 `.tooling` 就 16MB。`.gitignore` 管不了这个，
   要在 `project.config.json` 的 `packOptions.ignore` 里排除。
   排除后主包 186.6KB。
3. **`--qr-output` 写的是终端字符二维码，不是图片**。内容是带 ANSI 颜色码的文本
   （`\x1b[47m  \x1b[0m` 白、`\x1b[40m  \x1b[0m` 黑），
   文件名叫 `.png` 但 PIL 认不出来。`scripts/qr-text-to-png.py` 负责把它
   解析成模块矩阵再画成 PNG。
   另外 `--qr-output` 要的是**文件路径**，传目录会报 `EISDIR`。

## 采集器验证（2026-11-12）

`node scripts/verify-collector.js`：39 个 fixture/构造用例，云函数与自建后端
两份 `sources.js` 跑同一套，输出必须一致。fixture 是当天真实抓取的
北京/陕西/云南省页快照（`scripts/fixtures/`），解析价与
`data/reference-prices.js`（独立来源）124 个值逐值一致。
`--live` 追加真实抓取 + pg-mem 入库链路：单地区采集 → 新鲜期跳过 →
force 重抓去重 → 全量 run 31 省 124 条 → 第二次 run 全跳过。

这次抓到的坑：

1. **页尾有一段被注释掉的 2017 年预测 div，同样带 `#EA5146` 边框** ——
   不先剥 HTML 注释会把它当成现行预测。解析器第一步就去注释。
2. **山西是 `shanxi`、陕西是 `shanxi-3`** —— 拼音撞名， slug 不能按拼音猜，
   已写进 `data/regions.js` 并有用例钉住。
3. **60s 的吨幅正则认不出「上调油价90元/吨」**（`上调` 与数字之间隔着「油价」），
   我们的写法两种都认。
4. **云函数跑在 UTC**，`todayStr()` 用本地时区会在早上 8 点前差一天，
   两端采集器都改成显式 UTC+8。

## 采集器复查（2026-11-12 晚）

接入汽油价格网之后复查采集链路，抓到三个问题，都已修：

### 1. 定时任务从未触发（严重）

`server/src/scheduler.js` 的 cron 解析只认纯数字，默认配置是
带星号步长的表达式（每 30 分钟 / 每 10 分钟），`Number('*')` 是 `NaN`，
`nextRun()` 直接返回 `null`，`register()` 打一行警告就退出。

而 `collector.run()` **只**从调度器调用，没有手动触发入口 ——
所以线上采集器一次都没跑过。证据：盘点时 `collector_runs` 是空表。

修法：字段解析支持 星号 / 步长 / 区间 / 逗号列表，并加 `server/scripts/scheduler-test.js`
（14 个用例）钉住「默认配置必须能解析出下次时间」。

### 2. 预测幅度缺失被当成「持平」

来源只说方向、没给幅度时，`saveWindow` 写 `forecast: {}`，
首页 `changeMeta(undefined)` 里 `Number(undefined) || 0` 把未知变成 0，
界面显示「与上次持平」—— 来源明说上调，却在替它猜幅度。

修法：`oil_windows` 加 `forecast_direction` 列（老库靠 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 补），
前端在幅度缺失时显示「预计上调 / 幅度待公布 · 非官方」。

### 3. 采集器回归没进 CI

`scripts/verify-collector.js` 写好了但没人跑。现在并进 `server` 的 `npm test`，
部署流水线每次都会跑 fixture 回归（不联网，纯确定性）。

### 复查时确认没问题的部分

- 31 个地区 slug 逐个真实抓取验证有效（含 山西 `shanxi` / 陕西 `shanxi-3` 撞名）
- 解析值与页面原文逐字一致（抽查河南、海南原始 `#youjia` 区块）
- 边界用例齐全：剥 HTML 注释、`90#` 不干扰 `0#`、`92号` 写法、全角括号、跨年推断
- 两份 `sources.js` 配置 deepEqual、解析输出一致

### 一个数据事实（不是 bug）

现抓的 98# 与 `data/reference-prices.js` 在个别省份对不上，
例如 河南 10.75 vs 10.16、海南 12.05 vs 11.63。核对页面原文后确认解析正确，
差异来自不同来源的 98# 口径不同（98# 铺货少，各站数据源不一致）。
**别把 live 值与 reference 的全量差异当成解析 bug。**
