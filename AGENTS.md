# AGENTS.md

油势 · 微信小程序 —— 本地油价、调价通知、降价提醒、国内走势、国际原油行情。
原生小程序工程（无前端构建、无 npm 依赖），一级页面五个：油价 / 走势 / 调价 / 国际 / 提醒。

## 工具链

- 微信开发者工具（IDE 2.01.2510290），直接打开仓库根目录编译；基础库 3.8.10
- Node.js ≥ 18（脚本用），Python 3（截图合成用）
- 根目录**没有** package.json。云函数各自带 `package.json`，依赖在开发者工具里「云端安装依赖」

## 常用命令

```bash
node scripts/lint-wxml.js          # 静态检查（有错误时 exit 1），改完必跑
node scripts/check-modules.js      # 运行时模块加载冒烟测试，挡住「删了函数体留着引用」这类 ReferenceError
node scripts/verify-data.js        # 数据层自检，打印算出的价格/走势/通知/行情
node scripts/sync-cloud-shared.js  # 把 _shared/shared.js 同步到三个云函数，部署前必跑
node scripts/build-icons.js        # 由 design/ 的 SVG 精灵重生成 assets/icons/*.png（需本机 Chrome）
node scripts/preview-qr.js <appid> # 上传预览包并出扫码图（必须正式 AppID）
```

端到端验证（需先起 IDE 自动化服务，端口 9425）：

```bash
npm i --prefix .tooling miniprogram-automator ws
node scripts/verify-in-devtools.js   # 逐页截图 + 运行时异常捕获
node scripts/export-canvas.js       # 导出画布 PNG（截图流程用，脚本结束自动还原组件源码）
```

## 目录结构

- `pages/` — 五个一级页面，每页四件套 `.js/.json/.wxml/.wxss`
- `components/` — `trend-chart`（Canvas 2D 阶梯线）、`bottom-sheet`（底部弹层）
- 底部 tabBar 用**原生 tabBar**（`app.json` 里配 `iconPath`），别用自定义组件 —— 见下方「微信小程序特有坑」
- `utils/` — `api`（**唯一取数入口**）/ `chart` / `store` / `format` / `cloud` / `subscribe` / `demo-clock`
- `data/` — 演示数据集、调价时间线、地区价差
- `styles/` — `tokens.wxss`（设计令牌）+ `components.wxss`（通用类）
- `cloudfunctions/` — `oilApi` / `oilCollector` / `oilAlert`，共享规则在 `_shared/`
- `scripts/` — 检查与构建脚本
- `design/` — 产品设计稿与高保真原型
- `docs/` — 部署指南、数据源说明、验证记录、截图

## 代码风格

- 2 空格缩进，单引号，分号结尾
- **运行时代码**（`pages/` `utils/` `data/` `components/` `cloudfunctions/`）用 ES6 写法：
  `const/let`、箭头函数、模板字符串都可以。
  但**不要用可选链 `?.`、空值合并 `??`** —— 小程序运行时对高版本语法支持不稳
- **脚本代码**（`scripts/`）可用现代语法（`const/let`、箭头函数）
- 注释用中文，文件头用 `/** */` 说明该文件的职责与关键约定
- 视觉一律走 `styles/tokens.wxss` 的 CSS 变量，页面根节点加 `class="tk"` 继承

## 架构约定

- **数据层与数据来源分离**：`utils/api.js` 是唯一对外取数入口，云函数失败自动回落本地演示源。
  页面只认数据结构，不认来源；但**必须如实展示当前来源**，不允许把演示数据包装成实时行情
- **价格模型分两层**：`某地某油品价格 = 全国价（累加所有调价幅度）+ 地区价差`。调价幅度全国统一，零售价按地区定价
- **走势图画阶梯线**，不画折线 —— 国内油价只在调价日变化，横段按真实日期比例分配，不伪造连续成交价
- **调价预测与正式结果分开呈现**，预测必须标注「非官方」
- **采集侧解析不出结构化字段时进人工核对队列**，绝不把猜测值发布成正式结果
- **演示数据日期整体平移**（`utils/demo-clock.js`，锚点 `config.demoAnchorDate`），保证长期打开数据仍然新鲜
- 云函数之间不能跨目录 `require`，共享代码靠 `scripts/sync-cloud-shared.js` 复制 —— **改 `_shared/` 后必须同步**

## 微信小程序特有坑（都踩过，改代码前先看）

| 坑 | 正确做法 |
| --- | --- |
| `require('../config')` 报 `module 'config.js' is not defined` | 运行时不做目录 index 解析，写 `require('../config/index')` |
| `<br>` / `<hr>` 不是 WXML 内置标签 | 会报 `unexpected end tag` 导致整页编译失败；用 `<view>` 或 `<text>` 代替 |
| `ctx.scale(dpr, dpr)` 重复触发会累乘 | 缩放变成 dpr 的 n 次方，图形画到画布外；改用 `ctx.setTransform(dpr,0,0,dpr,0,0)` |
| `wx:for` 里写 `{{path}}` | 应为 `{{item.path}}`，否则 `switchTab` 拿到 undefined |
| 动态 `src` 漏 `.png` 后缀 | 图标显示成白方块 |
| 国际行情日期是 `MM-DD HH:mm:ss` | 时间轴正则要的是 `YYYY-MM-DD`，解析全返回 0 会把曲线叠成一根竖线 |
| `App.captureScreenshot` 只截 DOM 层 | 不合成 canvas 图层，图表区空白是接口限制不是没画；判定见 `docs/verification.md` |
| `miniprogram-automator` 0.13 与本机 IDE 不兼容 | IDE `Tool.getInfo` 返回 `{ version }`，automator 读 `SDKVersion` 直接崩；`scripts/verify-in-devtools.js` 自己实现了协议 |
| 自定义 tabBar 的 `position: fixed` 真机不生效 | 组件被排进文档流末尾，要滚到底才看得到；改用**原生 tabBar**：`app.json` 去掉 `"custom": true`，`list` 里配 `iconPath` / `selectedIconPath` |
| 主包超 2MB，上传预览包被拒 | `.gitignore` 管不了上传包，要在 `project.config.json` 的 `packOptions.ignore` 里排除 `.tooling` / `docs` / `design` / `scripts` / `cloudfunctions` |
| GitHub 密钥扫描误报小程序 AppID | AppID 是标识符不是凭据，扫的是 `wx` + 16 位十六进制；真实 AppID 放本地 `project.private.config.json`（不入库），AppSecret 永远不进代码 |

## 验证要求

- 改完页面/WXML/组件，**必须**跑 `node scripts/lint-wxml.js`（0 错误 0 警告才算过）和 `node scripts/check-modules.js`（模块加载期异常静态检查查不出来）
- 改数据层或算法，跑 `node scripts/verify-data.js` 对照输出值
- 改渲染结果，在开发者工具模拟器里逐页核对，别只信静态检查 —— 上面那批 bug 静态检查查不出来
- 截图类产物落在 `docs/screenshots/`，临时导出的 canvas 代码不要留在仓库里

## 提交约定

- 个人单维护项目，**直接在 `main` 上提交**，不开特性分支再合并；确需分支先问
- 提交信息用中文，描述改了什么（`fix: 修复 X` / `feat: 新增 X` / `docs: 补充 X`）
- 远端 `origin` = `https://github.com/uwakeme/oil-trend.git`；若 443 不通可临时改用 SSH：`git@github.com:uwakeme/oil-trend.git`
- 远端仓库目前是空的，首次提交还没推上去
- 改动前先看 `git status`，工作区经常有未提交的 WIP，**不要替用户丢弃或覆盖**

## 安全

- **AppSecret 绝不能进代码或小程序包**。云函数走云开发凭据，前端不需要 AppSecret
- 预览包、云开发、订阅消息模板都要求**正式 AppID**，测试号拿不到
- 主包体积上限 2MB，新增目录要在 `project.config.json` 的 `packOptions.ignore` 里排除
- `docs/`、`design/`、`scripts/`、`.tooling/`、`.workbuddy/`、`cloudfunctions/` 都已排除在打包外

## 项目现状（2026-11）

五个页面与三个云函数已写完并逐页验证过，当前跑的是**内置演示数据集**，真实数据源尚未接入。
订阅消息链路还没走通到底（需正式 AppID + 模板 ID），未配置时「提醒」页要明说未配置，不假装授权成功。
小程序图标已定为 **8-bit 像素风**：`assets/app-icon/app-icon.png`（512×512，公众平台后台上传用），5 套备选方案与提示词留在 `design/app-icon-candidates/`。tabBar 导航图标仍是细描边 SVG 风格，与像素风**尚未统一**。

项目仍在开发阶段：**历史/存量数据引发的问题不修**，只登记一行；影响当前行为的代码缺陷照修。