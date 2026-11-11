# 验证记录

小程序不能只靠肉眼看。这次用了开发者工具的自动化接口做逐页验证，
踩到的坑和结论都记在这里，免得下次再踩一遍。

## 怎么跑

### 1. 开服务端口

开发者工具 → 设置 → 安全设置 → 服务端口 打开。
命令行第一次跑会问一次「是否开启工具服务」，输 y 即可。

### 2. 起自动化服务

```bash
"<微信开发者工具目录>/cli.bat" auto --project "<项目目录>" --auto-port 9425 --lang zh
```

端口会监听一个 WebSocket。`scripts/verify-in-devtools.js` 连上去之后：
逐页 switchTab → 读页面数据 → 截图 → 收集运行时日志。

### 3. 跑验证

```bash
npm i --prefix .tooling miniprogram-automator ws
node scripts/verify-in-devtools.js
```

## 为什么要自己写协议客户端

本机 IDE 是 2.01.2510290，它的 `Tool.getInfo` 返回 `{ version }`，
而 miniprogram-automator 0.13 读的是 `SDKVersion`，握手阶段直接抛
「Cannot read properties of undefined (reading 'split')」。

协议本身很简单（`{id, method, params}` → `{id, result}`），
`scripts/verify-in-devtools.js` 里几十行就实现了，比等 automator 适配快。

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
`cli.bat auto --project <path> --auto-port <port>`（端口用 `AUTO_WS` 环境变量覆盖）。

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
| 云端也是同一个坑 | 部署后才炸 | 云函数原先没有加载期门禁，`scripts/check-modules.js` 现在会 stub 掉 `wx-server-sdk` 再加载三个云函数入口 |

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
