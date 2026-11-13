# AGENTS.md

油价势 · 微信小程序 —— 本地油价、调价通知、降价提醒、国内走势、国际原油行情。
原生小程序工程（无前端构建、无 npm 依赖），一级页面五个：油价 / 走势 / 调价 / 国际 / 提醒。

## 工具链

- 微信开发者工具（IDE 2.02.2609250），直接打开仓库根目录编译；基础库 3.8.10
- Node.js ≥ 18（脚本用），Python 3（只用于把终端字符二维码转成 PNG）
- 根目录**没有** package.json。`server/` 自带一份，依赖在服务器上 `npm install`

## 常用命令

```bash
node scripts/lint-wxml.js          # 静态检查（有错误时 exit 1），改完必跑
node scripts/check-modules.js      # 运行时模块 + 服务端模块加载冒烟测试，挡住「删了函数体留着引用」这类 ReferenceError
node scripts/verify-data.js        # 数据层自检，打印算出的价格/走势/通知/行情
node scripts/verify-contract.js    # 端到端契约自检：后端真实响应 → 前端页面渲染结果
node scripts/verify-collector.js   # 采集器解析回归（--live 追加真实抓取 + pg-mem 入库链路）
node scripts/gen-province-geo.js  # 重新生成服务端省界数据（server/src/data/provinces.json）
node scripts/sync-shared.js        # 由 data/ 生成服务端共享模块并做一致性断言，部署前必跑
node scripts/build-icons.js        # 重生成 assets/icons/*.png（SVG 精灵内联在脚本里，需本机 Chrome）
node scripts/preview-qr.js <appid> # 上传预览包并出扫码图（必须正式 AppID）
```

端到端验证（需先起 IDE 自动化服务，默认端口 9421，用 `AUTO_WS` 覆盖）：

```bash
npm i --prefix .tooling ws
node scripts/verify-in-devtools.js   # 逐页截图 + 运行时异常捕获（2.02 的截图已含 canvas 图层）
```

## 目录结构

- `pages/` — 五个一级页面，每页四件套 `.js/.json/.wxml/.wxss`
- `components/` — `trend-chart`（Canvas 2D 阶梯线）、`bottom-sheet`（底部弹层）
- 底部 tabBar 用**原生 tabBar**（`app.json` 里配 `iconPath`），别用自定义组件 —— 见下方「微信小程序特有坑」
- `utils/` — `api`（**唯一取数入口**）/ `chart` / `store` / `format` / `cloud` / `subscribe` / `demo-clock`
- `data/` — 演示数据集、调价时间线、地区价差
- `styles/` — `tokens.wxss`（设计令牌）+ `components.wxss`（通用类）
- `server/` — **后端**（Node + Express + PostgreSQL），填 `config.apiBaseUrl` 才启用；留空则只用演示数据
  - `server/src/data/provinces.json` 是**生成产物**（省界数据，脚本产出），手改会被覆盖
- `scripts/` — 检查与构建脚本
- `design/` — 产品设计稿与高保真原型
- `docs/` — 部署指南、数据源说明、验证记录、截图

## 代码风格

- 2 空格缩进，单引号，分号结尾
- **运行时代码**（`pages/` `utils/` `data/` `components/`）用 ES6 写法：
  `const/let`、箭头函数、模板字符串都可以。
  但**不要用可选链 `?.`、空值合并 `??`** —— 小程序运行时对高版本语法支持不稳
- **脚本代码**（`scripts/`）可用现代语法（`const/let`、箭头函数）
- 注释用中文，文件头用 `/** */` 说明该文件的职责与关键约定
- 视觉一律走 `styles/tokens.wxss` 的 CSS 变量，页面根节点加 `class="tk"` 继承
- **后端只有 `utils/cloud.js` 一个出口**：小程序只认 `utils/api.js` → `utils/cloud.js` → 后端。
  换后端只改 `utils/cloud.js`，页面与 `utils/api.js` 不动。

## 架构约定

- **数据层与数据来源分离**：`utils/api.js` 是唯一对外取数入口，后端失败自动回落本地演示源。
  页面只认数据结构，不认来源；但**必须如实展示当前来源**，不允许把演示数据包装成实时行情
- **价格模型分两层**：`某地某油品价格 = 全国价（累加所有调价幅度）+ 地区价差（该地区、该油品）`。调价幅度全国统一，零售价按地区定价
  —— 地区价差**必须按油品分别存**：各省标号结构不同（98# 相对 92# 的地区差跨度 1.57 元/升），共用一套价差误差最大到 0.89 元/升
  —— `data/reference-prices.js` 存各省真实挂牌价作校验基准，自检逐省比对（124 个值）
- **走势图画阶梯线**，不画折线 —— 国内油价只在调价日变化，横段按真实日期比例分配，不伪造连续成交价
- **调价预测与正式结果分开呈现**，预测必须标注「非官方」
- **采集侧解析不出结构化字段时进人工核对队列**，绝不把猜测值发布成正式结果
- **地区定位在服务端做**：经纬度 → 省份靠 `server/src/data/provinces.json` 的省界多边形判断
  （由 `scripts/gen-province-geo.js` 从 DataV 生成），前端只负责拿经纬度，不往小程序包里塞地理数据
  —— 坐标系全程 **GCJ-02**，与 `wx.getLocation` 的 `type:'gcj02'` 对齐
- **演示数据日期整体平移**（`utils/demo-clock.js`，锚点 `config.demoAnchorDate`），保证长期打开数据仍然新鲜
- **真源在 `data/`，`server/src/shared/shared.js` 是生成产物**（`scripts/sync-shared.js` 生成 + 一致性断言）。改完 `data/` 必须重跑同步脚本；**手改生成文件会被下次覆盖**

## 微信小程序特有坑（都踩过，改代码前先看）

| 坑 | 正确做法 |
| --- | --- |
| `require('../config')` 报 `module 'config.js' is not defined` | 运行时不做目录 index 解析，写 `require('../config/index')` |
| `<br>` / `<hr>` 不是 WXML 内置标签 | 会报 `unexpected end tag` 导致整页编译失败；用 `<view>` 或 `<text>` 代替 |
| `ctx.scale(dpr, dpr)` 重复触发会累乘 | 缩放变成 dpr 的 n 次方，图形画到画布外；改用 `ctx.setTransform(dpr,0,0,dpr,0,0)` |
| `wx:for` 里写 `{{path}}` | 应为 `{{item.path}}`，否则 `switchTab` 拿到 undefined |
| 动态 `src` 漏 `.png` 后缀 | 图标显示成白方块 |
| 国际行情日期是 `MM-DD HH:mm:ss` | 时间轴正则要的是 `YYYY-MM-DD`，解析全返回 0 会把曲线叠成一根竖线 |
| `App.captureScreenshot` 只截 DOM 层 | **仅 2.01.x 如此**；2.02 已会合成 canvas 图层，截图里没曲线才是真没画出来。判定见 `docs/verification.md` |
| `miniprogram-automator` 0.13 与本机 IDE 不兼容 | 2.01.x 的 `Tool.getInfo` 只返回 `{ version }`，automator 读 `SDKVersion` 直接崩；`scripts/verify-in-devtools.js` 自己实现了协议，只依赖 `ws` |
| 自定义 tabBar 的 `position: fixed` 真机不生效 | 组件被排进文档流末尾，要滚到底才看得到；改用**原生 tabBar**：`app.json` 去掉 `"custom": true`，`list` 里配 `iconPath` / `selectedIconPath` |
| 主包超 2MB，上传预览包被拒 | `.gitignore` 管不了上传包，要在 `project.config.json` 的 `packOptions.ignore` 里排除 `.tooling` / `docs` / `design` / `scripts` / `server` |
| GitHub 密钥扫描误报小程序 AppID | AppID 是标识符不是凭据，扫的是 `wx` + 16 位十六进制；真实 AppID 放本地 `project.private.config.json`（不入库），AppSecret 永远不进代码 |
| 开发者工具 CLI 上传失败时**退出码仍是 0** | `preview-qr.js` 报「成功」但二维码是旧 AppID 的 | 上传前先删掉旧的二维码文本，跑完没有新文件就当失败；端口不对时 CLI 会回「IDE 已启动并在监听 http://127.0.0.1:XXXXX」，按它说的端口重试 |
| canvas 是**独立原生渲染层**，z-index 压不住 | 走势图浮在底部弹层上面，把弹层内容盖住 | 把弹层 z-index 提到 99999 也没用。唯一可靠的办法是弹层打开时把画布从 DOM 里摘掉（`trend-chart` 的 `visible` 属性用 `wx:if` 控制） |
| 换 AppID 后预览二维码要重新出 | 预览包按 AppID 上传，旧码指向已注销的账号 | 换完 AppID 跑 `node scripts/preview-qr.js`；AppID 只写 `project.private.config.json` |
| pg 的 LIMIT/OFFSET 用占位符 | `LIMIT $1` 传过来是 `'20'`。⚠️ 更正：pg 实际会按 bigint 推断，`LIMIT $2` **通常能正常执行**（原记录的说法不准确，别再拿它当线上故障的依据）；但参数化 LIMIT 的类型推断依赖服务端推断，换驱动/换版本容易出幺蛾子 | 一律内联整数（先 `Number()` + 取整净化），`server/src/dao/index.js` 里五处写法一致 |
| JSONB / NUMERIC 读出来是字符串 | pg 不自动解析，`deltas` 是对象、`price` 是字符串 | `server/src/dao/index.js` 的 `toCamel` 里用列名白名单转数字 —— **不能见数字就转**，`fuelId` 是 `'92'`，转成数字前端判断全失效 |
| 自建后端没有 `cloud.getWXContext()` | 拿不到 openid | 走 `wx.login()` → code → `code2session` 换 openid，服务端自签 token；`utils/cloud.js` 的 `loginReady()` 保证用户类接口等 token 到位 |
| cron 解析不支持星号步长 | `nextRun('0 */30 * * * *')` 返回 `null`，`register()` 打一行警告就退出 —— **采集器与提醒器在线上一次都没跑过**，`collector_runs` 一直是空表 | 字段解析要支持 星号 / 步长 / 区间 `a-b` / `a-b/N` / 逗号列表；`server/scripts/scheduler-test.js` 钉住「默认配置必须能解析出下次时间」 |
| 预测幅度解析不出来被当成 0 | `forecast` 是空对象时前端 `changeMeta(undefined)` → `Number(undefined) \|\| 0` → 显示「与上次持平」，来源明说上调却显示持平，等于替来源猜了幅度 | 方向单独存 `oil_windows.forecast_direction`；前端幅度缺失时显示「预计上调 / 幅度待公布 · 非官方」，不写「元/升」 |
| 订阅消息字段名对不上模板 | 平台只认模板里的占位符名（`thing5`/`amount2`/`phrase1`/`date3`/`thing4`），自己起名一律 `errcode 47003`，日志里只看到「参数无效」 | 字段名与取值格式的唯一真源是 `server/src/services/subscribe-templates.js`（平台模板的镜像）；换模板只改那里，再同步 `config/index.js` 与服务端 `.env` |
| `amount` 字段不能带「元/升」 | 微信的 amount 类型只认「数字+元」，`"0.13 元/升"` 格式非法（47002） | 一律走契约表的 `formatAmount()`，别在业务代码里手拼 |
| `date` 字段不吃 ISO 短日期 | `"2026-11-24"` 解析失败，要 `"2026年11月24日"` | 走契约表的 `formatDate()`；服务端取「今天」自己按 UTC+8 日历日算，**不能**用 `shared.clock.today()`（那是演示数据的平移日期） |
| 一次性订阅授权用完即失效 | 用户每次同意只够发一条。写成永久布尔标记后，界面一直显示「微信提醒已开启」，微信那边其实已经拒收（43101） | 服务端发成功后把 `subscribe_granted` 置回 false 并记 `subscribe_used_at`；前端只在「刚拿到授权」的那一次保存里带 `subscribeGranted`，其它保存一律不带 |
| 命中多条提醒不能连发 | 一次性授权额度只有 1 条，连发第二条必被拒 | `alert.js` 命中多条只发第一条（按 official → target → forecast 的顺序） |
| 公告里的油品泛称会串号 | 正文写「98号汽油每升下调0.10元」，按「汽油」泛称匹配会把 98# 的幅度记到 92# 头上（后一段覆盖前一段），而 `perFuel` 还判定成「解析成功」 | 标号必须从正文**明确抓到数字**（92号/95#/98号/0号）；泛称猜不出标号就不填，`changes` 宁可留空也不复制总幅度 |
| 公告执行日期写的是「24时」 | 只认 `24:00` 会把执行日期整个丢掉，而没有日期的通知既没法倒计时也没法触发提醒 | 正则认 `24时` 和 `24:00` 两种写法 |
| `review_status` 是机器判定的可信度标记 | 把它当「人工审核结论」就会以为必须有人点通过；把它当「解析成功标志」就会把猜的值发出去 | `approved` = 逐项幅度明确**且**执行日期明确，可对外；`pending` = 存疑不发布。存疑的遇到更可信的解析要**覆盖更新**，否则解析器修好了重跑也进不来（去重键一样） |
| 汽油价格网对密集请求回 HTTP 567 | 连发 28 个地区页后开始限流（不是 404，slug 没错） | 采集走 3 并发 + 6 小时新鲜期；`verify-collector.js --live` 加 1.5s 间隔，CI 只跑 fixture 模式 |
| certbot `--standalone` 在这台机器上校验失败 | 报 `404` + `Invalid response`；日志里是 `Certbot wasn't able to bind to :80 using IPv4` —— certbot 的临时服务器只绑了 IPv6 的 80，Let's Encrypt 走 IPv4 就打不到 | 用 `certbot --nginx`（走 nginx 自己的 80，IPv4/IPv6 都监听）；这台机器是双栈，别用 standalone |
| `wx.getLocation` 没开通接口权限 | 微信后台「开发管理 → 接口设置」里没申请就直接 fail，参数传得再对也没用 | 静默降级到默认地区，不弹错误提示；权限批下来后自动生效，不用改代码 |
| `app.json` 少写 `requiredPrivateInfos` | 位置类接口被平台直接拦掉，报错跟权限没关系 | 必须声明 `["getLocation"]`，同时在 `permission` 里写清用途文案 |
| 位置隐私协议没弹 | `wx.getLocation` 报隐私未授权 | 先调 `wx.requirePrivacyAuthorize()`，用户同意后再取位置 |
| `wx.getLocation` 拿 wgs84 坐标 | 与省界数据差 300~600 米，江苏/河北这种贴着的省会判错 | 固定传 `type: 'gcj02'`，服务端省界数据也是 GCJ-02，两边不换算 |
| 定位失败弹错误提示 | 用户被反复打扰，而且定位本来就是可选增强 | 失败一律静默返回 null，只在用户明确拒绝过权限时给一个「开启定位」入口 |
| `<button>` 在 flex 容器里被撑成宽条 | 小程序 button 的 UA 默认样式带 `margin: auto`，放进 flex 行里就被自动外边距顶开 | 钉死 `flex: 0 0 <宽>` 和 `margin: 0`，别只写 `width` |
| 前端读 `latestNotice`、后端只给 `notice` | 字段契约漂一个名字，首页通知在真实后端下整块失真（标题空白、金额 0.00、日期 `--`），而 `expectKeys` 不含通知字段所以照样判 live | 两个名字都给（`notice` 与 `latestNotice` 同源），前端读 `payload.latestNotice \|\| payload.notice`；`scripts/verify-contract.js` 把后端真实响应喂给页面的 `applyXxx()` 钉住 |
| `Number(null) === 0`，空价格会显示成 `0.00` | 后端没给价格时，前端渲染「92# 0.00 元/升」—— 0.00 是真实价格，`--` 才是没有数据 | `fmt.price(null/undefined/'')` 统一返回 `'--'`；要继续算数的用 `fmt.priceValue()`（返回 null，区别于 0） |
| 「空数据」不能整包回落演示源 | 通知列表为空是合法的（后端确实还没有正式公告），回落演示会凭空造出假通知；而行情曲线为空是真的没数据 | `utils/api.js` 分开「字段存在」与「字段有值」两套校验：通知只查存在，行情/价格要查非空 |
| 去重发生在副作用之后就晚了 | 「查有没有发过 → 发消息 → 落库」两个实例同时跑会各发一遍，用户收到两条 | 先占位再发送：`dao.logs.reserve()` 插入占位行（唯一键冲突就说明别人抢到了），拿到行的人才有资格发 |
| pg-mem 的 `ON CONFLICT DO NOTHING RETURNING` 会把冲突行也返回 | 真库冲突时返回 0 行，pg-mem 却返回已有行 —— 自检分不清「抢到了」还是「撞上了」 | 用「直接插入 + 捕获 23505 唯一键冲突」，两种引擎行为一致（`dao.logs.reserve`） |
| 部署时 `pm2 delete` 之后失败 = 线上直接没了 | `delete → npm install → apply-schema → start` 是串行的，中间任一步失败就留下「旧进程已删、新进程没起」 | 结构与配置检查放在**动进程之前**（`apply-schema` + `config.validate()`），失败时旧进程还活着；健康检查探 `/ready`（真连库），不探只查进程存活的 `/health` |
| 服务端空密钥 = 谁能自签任意 openid | 签名算法开源，空串作 HMAC key 不报错，`issueToken` 照常签发 | 启动前强校验 `OIL_TOKEN_SECRET`（≥32 位）与 `DATABASE_URL`，缺一即 `exit 1`；CI 在 `.env` 缺这个键时自动补一个（只追加，不覆盖用户维护的值） |
| 汽油价格网没有 HTTPS | 证书是腾讯 CDN 的通用证书，altnames 里没有该域名，https 握手直接失败（2026-11-13 实测） | 只能走 HTTP → 抓取层必须加固：重定向只跟白名单主机、总时限（`req.setTimeout` 只是空闲超时）、入库前与上次真实价比（落差 >1 元不入门）与各省基准价比（偏差 >1.5 元只告警） |
| `setTimeout` 上限 2^31-1 ms | 月/年级 cron 一次要等那么久，超了溢出成 1ms —— 任务立刻触发又立刻排下一次，进程变忙循环 | `scheduler.js` 里把等待截到上限，到点重新算下一次（**没到点不能执行任务**） |
| 弹层里的长列表用 `overflow-y:auto` 滚不动 | 普通 `<view>` + `catchtouchmove` 会吞掉滚动，31 个省的地区列表远超 84vh | 内容改用 `<scroll-view scroll-y>`（**必须给高度约束**，`max-height` 对 scroll-view 不生效），`catchtouchmove` 只留遮罩；弹层样式单一真源在 `styles/components.wxss` |
| 切 tab 后弹层状态残留 | 五个 tab 页 `switchTab` 只触发 `onHide` 不触发 `onUnload`，`data` 常驻；弹层还开着，迷你走势 canvas 也一直被摘掉 | 各页 `onHide()` 复位弹层状态，但**不要**清 `_reqSeq` / `_loadedAt` / 用户已选的地区油品 |
| 四页 `load()` 没有并发竞态保护 | 快速连切周期/筛选，慢请求后到会盖掉新数据，页面停在旧周期 | 照首页的 `_reqSeq` 模式：请求开头取序号，`.then/.catch` 开头判 `if (seq !== self._reqSeq) return;`；`wx.stopPullDownRefresh()` 要无条件执行 |
| 涨跌额 0 分不清「持平」和「不知道」 | 首次真实采集没有基线，后端把 `changeAmount` 记 0、`changeAt` 留空 —— 这时 0 是「还不知道」不是「持平」，写成「与上次持平」等于替来源猜了结论 | 前端按 `changeAt` 判断有没有基线：没有就显示「暂无调价对比」；有基线且幅度为 0 才是真的持平 |
| 历史价只在价格变化时写，走势图只剩一个点 | 国内油价 30 天不调价，`oil_price_history` 就只剩起点的 1 行，canvas 单点只画出一个圆点，没有横线 | 每轮采集都写当天生效的挂牌价，按 `(地区, 油品, 日期)` 唯一索引幂等覆盖 —— 阶梯线的横段本来就该是平的 |
| 调价窗口过期还写「下一次…距窗口 -1 天」 | 来源还没公布下一轮时，库里留的是上一轮的窗口，`daysLeft` 是负数，挂在下面的预测早就失效了 | 首页按 `daysLeft < 0` 判过期：标题改「上一轮调价窗口」、倒计时写「已过 N 天 · 等待下一轮公布」，并且不展示失效的预测 |

## 验证要求

- 改完页面/WXML/组件，**必须**跑 `node scripts/lint-wxml.js`（0 错误 0 警告才算过）和 `node scripts/check-modules.js`（模块加载期异常静态检查查不出来）
- 改数据层或算法，跑 `node scripts/verify-data.js` 对照输出值
- **改了前后端之间的字段**，跑 `node scripts/verify-contract.js` —— 它把后端真实响应喂给五页的 `applyXxx()`，字段漂移、空值冒充 0.00、来源标错都靠它挡
- 改渲染结果，在开发者工具模拟器里逐页核对，别只信静态检查 —— 上面那批 bug 静态检查查不出来
- 截图类产物落在 `docs/screenshots/`，临时导出的 canvas 代码不要留在仓库里

## 提交约定

- 个人单维护项目，**直接在 `main` 上提交**，不开特性分支再合并；确需分支先问
- 提交信息用中文，描述改了什么（`fix: 修复 X` / `feat: 新增 X` / `docs: 补充 X`）
- 远端 `origin` = `https://github.com/uwakeme/oil-trend.git`；若 443 不通可临时改用 SSH：`git@github.com:uwakeme/oil-trend.git`
- 远端 `origin` 已有提交，用 `git push git@github.com:uwakeme/oil-trend.git main:main` 推送（443 不通时走 SSH）
- 用 `git push <url>` 形式推送**不会更新** `origin/main` 远程跟踪引用，`git log origin/main..main` 会误报「没推上去」，以 `git ls-remote` 的实际结果为准
- 改动前先看 `git status`，工作区经常有未提交的 WIP，**不要替用户丢弃或覆盖**
- **共享服务器上有别人的线上服务**（`lyric-lab.uwakeme.top`、`jiuguan.uwakeme.top`、openmaic）。
  涉及停服务、改 nginx、写 `/etc`、装证书这类操作，**只给命令让用户自己跑**；
  流水线只允许「上传代码 + 重启油价势自己的 pm2 进程」，不许碰 nginx 与其他服务

## 安全

- **AppSecret 绝不能进代码或小程序包**。只在服务器的 `server/.env` 里，前端只认 `apiBaseUrl`
- 预览包、订阅消息模板都要求**正式 AppID**，测试号拿不到
- 主包体积上限 2MB，新增目录要在 `project.config.json` 的 `packOptions.ignore` 里排除
- `docs/`、`design/`、`scripts/`、`server/`、`.tooling/`、`.workbuddy/` 都已排除在打包外

## 项目现状（2026-11）

五个页面已写完并逐页验证过。**后端已上线**：`server/`（Node + Express + PostgreSQL）
部署在 `oil-trend.uwakeme.top`，采集器每 30 分钟从**汽油价格网**（qiyoujiage）抓
31 省挂牌价 + 下次调价预测，页面显示的是真实挂牌价（解析与验证见 `docs/data-sources.md`）。
ndrc 公告与国际行情两个来源仍未启用。

订阅消息链路还没走通到底（需正式 AppID + 模板 ID），未配置时「提醒」页要明说未配置，不假装授权成功。

小程序端已接 `wx.getLocation`：首页启动时读一次位置，反查省份后自动切到当地油价；
用户手动选过地区就不再自动覆盖，只提示「检测到你在 XX，点此切换」。
接口权限需在公众平台「开发管理 → 接口设置」申请 `wx.getLocation`，未开通时静默降级到默认地区。

微信云开发那套已下线（云函数目录已删，见 git 历史）；`config/index.js` 的
`apiBaseUrl` 留空则一律使用演示数据。
小程序图标已定为 **8-bit 像素风**：`assets/app-icon/app-icon.png`（512×512，公众平台后台上传用）。tabBar 导航图标仍是细描边 SVG 风格，与像素风**尚未统一**。

项目仍在开发阶段：**历史/存量数据引发的问题不修**，只登记一行；影响当前行为的代码缺陷照修。