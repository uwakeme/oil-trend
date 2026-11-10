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

## 截图看不到 Canvas 内容

`App.captureScreenshot` 只截 DOM 层，**不合成 canvas 图层**。
所以自动截图里图表区域是空白的 —— 这是截图接口的限制，不是图表没画。

判断依据：把 canvas 元素的 CSS 背景染红，截图里能看到红色块（说明元素在、也在被截），
但 `ctx.fillRect` 画的内容拍不到。再从小程序内部读
`ctx.getImageData()` 统计非透明像素，能确认画布里确实有内容。

要拿到带图表的成品图，做法是：

1. 在 `components/trend-chart/index.js` 里临时加一段导出：
   `wx.canvasToTempFilePath({ canvas })` → base64 → 写进 storage
2. 从外部用 `App.callWxMethod` 调 `getStorageSync` 把 base64 取回来，存成 PNG
3. 用 `scripts/compose-screenshots.py` 把画布 PNG 贴回页面截图的对应位置

导出那几行是临时的，已从仓库里移除；需要重新抓画布时再临时加回来。

## 这次抓出来的真 bug

| 问题 | 表现 | 原因 |
| --- | --- | --- |
| WXML 编译失败 | `unexpected end tag: view` | `<br>` 不是 WXML 内置标签，被当成自定义组件 |
| 页面启动就抛异常 | `module 'config.js' is not defined` | 小程序 require 不做目录 index 解析，得写 `../config/index` |
| 图表空白 | 画布区域没内容 | `ctx.scale(dpr,dpr)` 是累乘，组件重复渲染时缩放变成 dpr 的 n 次方，图形画到画布外；改用 `ctx.setTransform` |
| 国际行情图是一根竖线 | 所有点叠在同一个 x | 行情的 date 是 `MM-DD HH:mm:ss`，时间轴正则要的是 `YYYY-MM-DD`，解析全返回 0 |
| 订阅卡图标不显示 | 白方块 | 动态 src 的值漏了 `.png` 后缀 |
| 自定义 tabBar 点不动 | switchTab 拿不到 url | `wx:for` 里写 `{{path}}`，应写 `{{item.path}}` |

前两个是模拟器才会暴露的问题，静态检查查不出来。
`scripts/lint-wxml.js` 后来补了「标签必须是 WXML 内置标签或已声明的自定义组件」这条规则，
`<br>` 就是在那一轮被改掉的。

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
