# AGENTS.md

Wake油价势助手 · 微信小程序 —— 本地油价、调价通知、降价提醒、国内走势、国际原油行情。
原生小程序工程（无前端构建、无 npm 依赖），一级页面五个：油价 / 走势 / 调价 / 国际 / 提醒。

## 工具链

- 微信开发者工具（IDE 2.02.2609250），直接打开仓库根目录编译；基础库 3.8.10
- Node.js ≥ 18（脚本用），Python 3（只用于把终端字符二维码转成 PNG）
- 根目录**没有** package.json。`server/` 自带一份（依赖在服务器上 `npm install`），`ci/` 自带一份（`miniprogram-ci`，本机与 CI 共用同一份上传脚本）

## 常用命令

```bash
node scripts/lint-wxml.js          # 静态检查（有错误时 exit 1），改完必跑
node scripts/check-modules.js      # 运行时模块 + 服务端模块加载冒烟测试，挡住「删了函数体留着引用」这类 ReferenceError
node scripts/verify-data.js        # 数据层自检，打印算出的价格/走势/通知/行情
node scripts/verify-contract.js    # 端到端契约自检：后端真实响应 → 前端页面渲染结果
node scripts/verify-collector.js   # 采集器解析回归（--live 追加真实抓取 + pg-mem 入库链路）
node scripts/verify-chart.js        # 走势图自检：绘图几何、选点算法、组件触摸链路（假的 Canvas 上下文）
node scripts/gen-province-geo.js  # 重新生成服务端省界数据（server/src/data/provinces.json）
node scripts/sync-shared.js        # 由 data/ 生成服务端共享模块并做一致性断言，部署前必跑
node scripts/build-icons.js        # 重生成 assets/icons/*.png（SVG 精灵内联在脚本里，需本机 Chrome）
node scripts/preview-qr.js <appid> # 上传预览包并出扫码图（必须正式 AppID）
node ci/upload.js              # 上传小程序包到微信公众平台（开发版本），需上传密钥
node ci/upload.js --dry-run    # 只检查 AppID / 密钥 / 版本号能不能用，不上传
node scripts/release-desc.js   # 生成「提交开发版本」用的版本描述草稿（发版后改成人话再交）
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
- `ci/` — 小程序包上传工具（`miniprogram-ci`）：`upload.js` 是上传逻辑的唯一真源，本地与 CI 共用
- `design/` — 产品设计稿与高保真原型
- `docs/` — 截图在 `docs/screenshots/`，项目主页在 `docs/index.html`（GitHub Pages 从 `/docs` 发布）；部署与数据源说明直接看 `server/` 与 `README.md`

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
- **调价窗口的推算值**：来源没公布下一轮时，用「最近一次实际调价日 + 10 个工作日」推算（`data/adjust-cycle.js`，含法定节假日表；遇节假日顺延、调休上班日算工作日）。
  单一真源在小程序端 `data/`，服务端副本由 `scripts/sync-shared.js` 生成 —— 节假日表一旦分叉，推出来的日期就对不上。
  推算值**必须标「推算 · 非官方」**（项目铁律：绝不把猜测值发布成正式结果）
- **真源在 `data/`，`server/src/shared/shared.js` 是生成产物**（`scripts/sync-shared.js` 生成 + 一致性断言）。改完 `data/` 必须重跑同步脚本；**手改生成文件会被下次覆盖**
- **后端地址不对外公开**：仓库是 public，README、GitHub Pages 主页等对外文档只写「部署在自己的服务器上」，**不要出现真实后端域名**（配置里必须写的 `apiBaseUrl` 除外）

## 微信小程序特有坑（都踩过，改代码前先看）

| 坑 | 正确做法 |
| --- | --- |
| `require('../config')` 报 `module 'config.js' is not defined` | 运行时不做目录 index 解析，写 `require('../config/index')` |
| `<br>` / `<hr>` 不是 WXML 内置标签 | 会报 `unexpected end tag` 导致整页编译失败；用 `<view>` 或 `<text>` 代替 |
| `ctx.scale(dpr, dpr)` 重复触发会累乘 | 缩放变成 dpr 的 n 次方，图形画到画布外；改用 `ctx.setTransform(dpr,0,0,dpr,0,0)` |
| `wx:for` 里写 `{{path}}` | 应为 `{{item.path}}`，否则 `switchTab` 拿到 undefined |
| 动态 `src` 漏 `.png` 后缀 | 图标显示成白方块 |
| 国际行情日期是 `MM-DD HH:mm:ss` | 时间轴正则要的是 `YYYY-MM-DD`，解析全返回 0 会把曲线叠成一根竖线 |
| `App.captureScreenshot` 只截 DOM 层 | **仅 2.01.x 如此**；2.02 已会合成 canvas 图层，截图里没曲线才是真没画出来 |
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
| 订阅消息字段名对不上模板 | 平台只认模板里的占位符名（当前模板：`thing5`/`amount2`/`amount6`/`phrase1`/`date3`），自己起名一律 `errcode 47003`，日志里只看到「参数无效」 | 字段名与取值格式的唯一真源是 `server/src/services/subscribe-templates.js`（平台模板的镜像）；换模板只改那里，再同步 `config/index.js` 与服务端 `.env` |
| 业务代码里写死占位符名 → 换个模板必错位 | 老代码的 `buildData` 直接写 `thing5: …, amount2: …`，而注释却声称「契约表是唯一真源」。换个模板占位符名就变了（`thing5` → `thing1` 之类），字段全对不上，平台一律 47003 | 契约表里每个字段声明 **role**（fuel/amount/direction/date/price/tip），业务代码只给语义值，由 `dataByRole()` 按角色填字段（`server/src/services/subscribe-templates.js`）；换模板只改契约表 |
| 每升幅度拿不到时，官方降价提醒一条都发不出去 | 发改委公告只给吨价；白天发公告时新挂牌价还没采到 → 没有每升幅度。主模板的「调整价格」是 amount 类型，只能放「数字+元」：填 `0` 是**冒充「持平」**，填吨价是**把两个口径混在一起**，留空平台直接拒收 | 用**方向模板**：它的「调整幅度」是**文本类型**，能原样写「幅度待公布」。契约表里给该字段加 role=`amount` 且 type≠amount，`alert.js` 的 `canCarryText()` 就能识别；主模板自己带文本字段时直接用主模板 |
| 模板没有「温馨提示」字段 → 地区与口径挤进「油品种类」 | 当前模板把第 6 个关键词换成了「实时油价」，**「温馨提示」没有了**：地区（广东）与口径（实测/测算/非官方）只能并进「油品种类」那一行（≤20 字符），塞不下时先丢地区、再丢额外说明 | 契约表加 role=`price` 后现价有了自己的字段；没有 tip 字段时由 `carrierOf()` 挑「油品种类」承载（`compose()` 的 rank：现价 → 地区 → 额外说明 → 幅度整句），**口径说明必留** —— 测算值不标口径就是误导；被丢弃的内容要 `console.warn` 留痕，别闷声丢掉 |
| 一次性订阅额度是**按模板**给的 | 两个模板同时在用时，用户只授权了主模板 → 服务器拿方向模板下发吃 43101（用户没有该模板的额度），一次性额度白废 | 小程序端 `utils/subscribe.js` 把两个模板 ID 一起请求（`templateIds()`）；自检钉死「服务端配了方向模板 → 小程序端也要配上」 |
| `amount` 字段不能带「元/升」 | 微信的 amount 类型只认「数字+元」，`"0.13 元/升"` 格式非法（47002） | 一律走契约表的 `formatAmount()`，别在业务代码里手拼 |
| `date` 字段不吃 ISO 短日期 | `"2026-11-24"` 解析失败，要 `"2026年11月24日"` | 走契约表的 `formatDate()`；服务端取「今天」自己按 UTC+8 日历日算，**不能**用 `shared.clock.today()`（那是演示数据的平移日期）。⚠️ 服务端三个地方各算各的会差一天：`collector.js` / `alert.js` 已经是 UTC+8，`query.js` 的 `todayStr()` 原来按本地时区 —— 服务器跑 UTC 时凌晨 8 点前差一天，窗口卡上的日期整张错 |
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
| 弹层底部留一条死白带 | 原生 tabBar 页面上，webview 的底边**就是 tabBar 的顶边** —— home indicator 那条安全区已经被 tabBar 占住了，面板再叠一次 `env(safe-area-inset-bottom)` 就凭空多出 ~31px 空白（实测底部空白带 53px，列表被截断后下面空一大块） | 弹层底部只留 24rpx，别再叠 `env()`（`styles/components.wxss` 的 `.sheet-panel`）；原生 tabBar 页面**没有**安全区要避 |
| `<button>` 在 flex 容器里被撑成宽条 / 停在行中间 | 小程序 button 的 UA 默认样式带 `margin-left/right: auto`，放进 flex 行后自动外边距会**吸收剩余空间**（`space-between` 的自由空间被它平分吃掉）—— 作者写 `margin: 0` **压不住**。实测弹层关闭按钮停在屏幕 62% 处，不贴右 | `margin: 0 !important` 钉死外边距 + `flex: 0 0 <宽>`；再让同行的标题 `flex: 1` 把剩余空间吃掉，`space-between` 才有意义（见 `styles/components.wxss` 的 `.sheet-head-title`）。**别只写 `width`** |
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
| 微信订阅消息的 `data` 每字段必须是 `{"value":"…"}` 对象 | 扁平字符串被平台以 47003 拒收，日志只写「参数无效」，看不出是哪一项 | 传输层统一包装（`subscribe-templates.js` 的 `toWeChatData`），校验时解包；**格式与校验必须一起改** —— 只改一边会立刻报 `TOO_LONG/[object Object]` |
| 后端在 nginx 后面不开 `trust proxy` | `req.ip` 恒为 127.0.0.1，限流退化成**全站共用一个桶**：一个人打满全站 429 | `app.set('trust proxy', 1)`（nginx → node 正好一跳，XFF 最右一项才是真实客户端 IP） |
| `/api/*` 的错误一律 200 返回 | 监控与 CI 按状态码看不出服务端挂了，报警与重试策略失效 | 业务错误 4xx、内部错误 5xx（`errors.statusOf(err)`）；**外壳 `{ok,message,code}` 不变**，前端行为不受影响 |
| 公告正文「92号汽油、95号汽油每升下调0.10元」是几个油品**共用**一个幅度 | 按「标号 + 每升X元」配对，正则一匹配就吃掉整段，只认得下最后一个油品，却仍判「逐项解析成功」 | 按位置抓标号，再看每个金额短语**前面那一串**标号（中间只隔着分隔符才算一组） |
| 方向词「调整」看不出上调还是下调 | 旧解析非「下调」一律取正 —— 「调整0.10元」被当成**上涨**发布 | 只认「上调/下调」；「调整」判存疑，进人工核对队列 |
| 执行日期要认「…24时起」的生效语义 | 不限语境直接取第一个匹配，「上次调价自11月1日24时起」会被当成本轮生效日 | 日期必须带「24时/24:00」，并剔除被「上次/上轮/此前/前次」修饰的那一个 |
| 机器判定 `approved` 的门槛定太低 = 人工关卡被取消 | 只解析出 1~2 个油品也判 approved，等于替公告补了缺失的幅度 | 门槛：**四油品齐全 + 方向明确 + 执行日期明确 + 无自相矛盾**；否则 pending 进 `needsReview` 队列，`listPublic` 只发 approved |
| 发送失败永久占住 `dedupKey` | 占位行插了不删，下一轮 `reserve()` 唯一键冲突恒失败 —— 网络抖动这类**可重试**失败被永久跳过 | 可重试失败**释放占位行**（不消费用户额度），不可重试失败保留记录并消费额度；`listByUser` 过滤「sent=FALSE 且 fail_reason IS NULL」的僵尸行 |
| 契约测试 stub `utils/api.js` 的 `module.exports` = 没测传输层 | `fetchWithFallback` / `hasExpected` / `stampSource` 一次都没跑，页面吃的是后端原始响应 —— 字段漂了也照样全绿 | 在 **`wx.request` 层**打本地测试服务，让 `utils/cloud.js` 与 `utils/api.js` 一行不改地真跑；通知用夹具正文驱动 `collectFromSource` 产出，**禁止手插 approved 夹具** |
| 「合法为空」与「后端没给成」要分开 | 回落演示源会让用户看到假价格，还以为服务挂了 | 后端在合法为空时返回顶层 `empty:true`，前端 `hasExpected` 见到它就不回落演示源 |
| `scroll-view` 光有 `max-height` 滚不动 | 项目自己的 AGENTS.md 就记着这条，但代码里只给了 `max-height` + `flex:1 1 auto` | 父容器给**确定高度**，滚动区 `flex: 1 1 0; min-height: 0`（basis 0 + min-height 0 才有确定高度） |
| 发改委公告只给吨价，不给每升四油品幅度 | 正文写「国内汽、柴油（标准品）价格每吨分别下调645元、625元」—— 只有吨价、只分汽/柴油两类，附表还是 JPG 图片 | 每升四油品幅度靠各地挂牌价的**前后快照差值**测算（`server/src/services/measure.js`），界面必须写清口径（`utils/format.js` 的 `MEASURED_NOTE`），不能让人把测算值当官方公布值；测算值不能写进官方字段 |
| 调控类公告同段有两个数 | 「每吨分别应上调440元、420元，……调控后实际上调345元、335元」—— 前者是机制理论值，后者才是实际执行值 | 只认「实际上调/下调」；只解析到「应上调」时方向明确但幅度存疑，判 pending 不发布 |
| 发改委公告是「列表页 → 详情页」两步 | 列表页 `https://www.ndrc.gov.cn/xwdt/xwfb/` 里每条只是一个链接，正文在详情页的 `div.TRS_Editor` 里 | 采集器对 kind=notice 走 `listUrl` + `listParser` + `itemTitleKeywords` 两步；已入库的公告不再重复抓详情页 |
| 列表页 href 是相对链接 | 形如 `./202611/t20261112_1408795.html`，手工拼会变成 `www.ndrc.gov.cn.` 带尾点的域名，证书 altnames 直接不匹配 | 必须 `new URL(href, base).href` |
| 按生效日直接取历史价行算成 0 | 来源站可能提前几天挂出新价，生效日当天的行已经是新价 → 前后差 0，误判成「持平」 | 找**生效日附近最后一次价格变化**（变化点前一条 = 调价前、后一条 = 调价后），不要按日期取行 |
| 存疑通知每轮插一条重复行 | 去重键里带执行日期，解析结果一变键就变 → 老逻辑只在「存疑→可信」时覆盖，存疑→仍存疑会一直插新行 | 存疑通知按 (来源, 标题) **原地覆盖**，不能每次 insert |
| 测算方向与公告方向矛盾 | 用错了快照时算出来的方向跟公告反着来 | `measure.agreesWithDirection()` 不通过就不返回测算值 —— 摆出来比不摆更糟 |
| 测算阈值写死 0.5 元/升 = 大轮调价整轮被剔光 | 官方 645 元/吨 ≈ 0.47 元/升，真实挂牌价降幅 0.52~0.56 元/升，全被判成异常值 → 四个油品都算不出，界面一个每升幅度都没有 | 阈值跟着官方吨价走：`measure.boundOf()` 用标准品密度（89 号汽油 0.725、0 号柴油 0.835 kg/L）折出理论值，容差 ±max(35%, 0.15)；没有官方吨价才用绝对兜底 1.0 |
| 官方吨价与每升挂牌价不是同一口径 | 发改委附表是「各省汽、柴油**最高零售价格**（元/吨）」，标准品是 **89 号汽油 + 0 号车用柴油**，各标号另有质量差额 → 官方 645 元/吨 ≈ 0.47 元/升，实测 92# 0.52、95# 0.55、98# 0.56、0# 0.54 | 两者并列显示必须写口径说明（单一真源：`utils/format.js` 的 `MEASURED_NOTE`），否则用户会以为官方值和测算值对不上 |
| 吨价→每升的密度换算方向搞反 | `元/升 = 元/吨 ÷ 1000 × 密度`，写成 ÷ 密度 会把 645 元/吨算成 0.87 元/升，误判成「差 4 倍」的矛盾 | 记住是**乘**密度；标准品密度：89 号汽油 0.725、0 号车用柴油 0.835 kg/L |
| 源站某些省的某个油品会「漏更」 | 2026-11-12 那轮，河南、海南的 98# 挂牌价在 10-29 之后一直没更新（12.05 vs 基准 11.63），到 11-13 一次性补上 → 测出来的降幅虚高到 -0.97 | 三道闸：区间定界（`boundOf`）剔掉超出官方吨价能解释范围的值 → 同油品取各省中位数 → 跨省一致性闸门（MAD 过大就不给结论）。92#/95#/0# 当轮 31 省精确对上基准价，只有 98# 有这毛病 |
| 幅度缺失被当成 0 显示 | `Number(null)` 是 0 → 「幅度待公布」渲染成「持平 0.00」，用户以为这轮没调价 | 前后端都先判 `null/undefined`；服务端把算不出幅度的油品照样列出来（`delta: null`），前端显示 `--` |
| 模板 ID 手抄错一个字符，平台拒收但看不出原因 | 小写 `l` 与大写 `I` 长得一模一样，微信只回「参数无效」(47003)，日志里看不出是 ID 错了 | 三处同步：`config/index.js` / `server/src/services/subscribe-templates.js` / 服务端 `.env`。.env 的值**没登记在契约表就回退**契约表默认模板（`config.validate()` 会给警告）；selftest 钉死前两处必须一致 |
| IDE 2.02 的 `--qr-output` 直接写**图片文件** | 脚本按终端字符二维码去解析，报「没有解析出二维码模块，文件格式不对」，看起来像上传失败 | `scripts/preview-qr.js` 先看文件头：JPEG/PNG 直接转 PNG 交付（`preview-qr.js` 里已处理） |
| 首页小卡和通知卡的每升幅度不是一个口径 | 首页 95#/98#/0# 小卡用 `p.changeAmount`（**本地区**挂牌价前后差），通知卡用各省**中位数**，同一轮能差 0.01（广东 98# -0.56 vs 中位数 -0.55） | 别拿小卡数字去对中位数；看到不一致先查取的是哪个字段（`pages/index/index.js` 的 `changeMeta(p.changeAmount, ...)`） |
| 画布上的读数**不能**用 WXML 浮层 | canvas 是独立原生渲染层，z-index 压不住它 —— 浮层会被画布盖住（跟弹层被走势图盖住是同一个原因） | 十字光标与读数气泡直接画在画布上（`utils/chart.js` 的 `drawCrosshair`）；DOM 浮层只适合放在画布**外面**的地方 |
| 变化点窗口越过下一轮执行日 → 每升幅度整轮错位 | 发改委提前约 10 天公布下一轮，那条公告的生效日在**未来**；只把「视图内的轮次」传进测算，窗口边界就丢了，窗口放开到 +12 天后，本轮变化点找不到时会拿下一轮的价差当本轮幅度 | 下一轮执行日单独传进 `measureMany`（`nextExecDate`）：它不参与测算，但要当 `changePointAt` 的 `nextDate` 边界 |
| 发送超时后把占位还回去 → 可能重复投递 | 超时是「结果未知」：微信可能已经收下并投递了这条消息。占位一还，下一轮就会再发一次 | 超时类失败不释放占位；只有平台明确拒收（限流等）才 `markNotSending` 后释放。DAO 的 `release` 也收紧成只回收 `send_started_at IS NULL` 的行 |
| 选点与画图必须用**同一套**几何 | 两边各算一次横坐标的话，边距或像素密度改一处就对不上，表现是「点哪儿高亮的不是哪儿」 | 几何统一由 `chart.computeLayout()` 算：绘制（`drawSeries`）与触摸选点都调它 |
| 上传小程序包在 CI 上用开发者工具 CLI | `cli.bat` 要求 IDE 开着、已登录，CI 上根本跑不起来 | 用 `miniprogram-ci`（`ci/upload.js`）：不依赖 IDE，用「上传密钥」直接传 |
| 以为 `miniprogram-ci` 能「自动提交审核 / 自动发布」 | 它只有 `upload` 与 `preview`，没有提交审核接口 | 微信的 `wxa/commit`（提交审核）与 `wxa/release`（发布）只对**第三方平台**开放；个人主体小程序只能人工去公众平台后台点 |
| 打包排除清单写两处 | 上传脚本里再写一份 ignores，迟早和 `project.config.json` 的 `packOptions.ignore` 对不上 | 排除清单只有一处真源：`project.config.json` 的 `packOptions.ignore`（`ci/`、`server/`、`scripts/`、`docs/`、`project.private.config.json` 都在里面） |
| 公众平台「小程序代码上传」开了 IP 白名单 | GitHub runner 的出口 IP 不固定，开了就永远传不上去（平台回 `errCode -10008 invalid ip: <runner 出口 IP>`） | 白名单留空，靠上传密钥本身鉴权；真要限 IP 就得用固定出口 IP 的自建 runner |
| 真实 AppID 写进 `project.config.json` | GitHub 密钥扫描会把 `wx` + 16 位十六进制误报成密钥 | 仓库里存占位 `touristappid`，真实 AppID 放 `project.private.config.json`（不入库）；CI 从仓库 secret `WX_APP_ID` 取 |
| 画布上用 `bindtouchmove` 而不是 `catchtouchmove` | catch 会把页面滚动吞掉 —— 手指落在图上就滚不动 | 画布用 `bind*`，页面照常滚；图表自己的拖动在 `onTouchMove` 里处理 |
| 自检脚本里直接 require 组件会炸 | node 里没有 `Component` 也没有 `wx`；而且 `wx` 是 **render 时**才读的，require 完就删会 ReferenceError | 先补 `global.Component` / `global.wx`，`wx` 留到组件跑完再删（`scripts/verify-chart.js`） |
| 自动化协议点不了按钮 → 交互只能假跑 | `Element.tap` / `Element.query` 在 IDE 2.02 未实现，想验证点选只能靠肉眼 | 用假的 Canvas 上下文直接调组件的 `onTouchStart`；要截图就临时注入固定选中点，截完必须还原（`.tooling/shot-crosshair.js`） |
| 读数只按 `YYYY-MM-DD` 匹配 → 国际行情丢掉时刻 | 国际行情的点日期是 `YYYY-MM-DD HH:mm:ss`，油品历史是 `YYYY-MM-DD` —— 两者都带 `YYYY-MM-DD` 开头，只按日期匹配的话国际行情只剩 `11/17`，日内 15 分钟一个点根本分不清是几点 | 先看有没有空格再判带时刻：`components/trend-chart/index.js` 的 `_dateText`，带时刻走 `fmt.dateTime`（到分钟），纯日期走 `fmt.shortDate`；`scripts/verify-contract.js` 里有对应用例 |
| 来源还没公布下一轮时，窗口卡只能写「上一轮调价窗口」 | 预测源在两轮之间会把区块改成公布**上一轮结果**（实测 2026-11-17 三省页面给的都是 11-12 那轮的下调结果，`isForecast=false`），库里留的窗口就过期了 | 用「最近一次实际调价日 + 10 个工作日」推算下一轮（`data/adjust-cycle.js`，带法定节假日表），主日期换成推算值并标「推算 · 非官方」；来源一旦公布真实窗口就用真实值 —— 规则统一在 `utils/format.js` 的 `windowMeta` |
| 推导节点的日期是**生效日**，不是执行日 | 官方公告的 `executeAt` 是执行日，`oil_adjust_events` 的 date 是挂牌价生效日（新价从执行日次日 00:00 才开始挂） | 推算基准要把推导节点**减一天**（`server/src/services/query.js` 的 `latestAdjustDate`）；不减的话下一轮整体多推一天（11-26 变 11-27） |
| 公告发布日 ≠ 采集入库时刻 | `publishedAt` 是采集入库时间，列表里 4 条公告全显示成入库那天的日期，看着像刚发的 | 展示层读 `announcedAt`（发改委公告的 PubDate）；实测 35 条公告的**发布日与调价执行日全部同一天**（提前天数分布：提前 0 天 35 条），发布时刻 09:15~16:59 |
| 「下次通知时间」跟「下次调价日」是同一天 | 发改委公告在**调价执行当天**发布，不是提前几天 —— 写成「提前 N 天收到通知」就是错的 | 下次通知日 = 下次调价日（同一天），差别只在时刻：公告上午发，24:00 才调价。口径写进 `data/adjust-cycle.js` 的 `NOTICE_TIME_NOTE` |

## 数据源现状（2026-11-16 起）

多源协作，详见 `server/docs/data-source-design.md`：

| 源 | 协议 | 职责 | 抓取量 |
| --- | --- | --- | --- |
| `xmgcn.com` 油价网 | HTTPS | **现价 + 历史**（主源）。每省一次请求同时给当前价与最近 30 期历史（2025-09-10 → 2026-11-13） | 31 省 × 1 次 |
| `qiyoujiage.com` 汽油价格网 | HTTP | **下次调价预测**（全网唯一）+ 主源失败时兜底 + **交叉校核**（抽广东/山东/新疆 3 省，偏差 > 0.02 告警） | 平时 3 省 |
| `ndrc.gov.cn` 公告里的吨价 | — | **口径互校主路径**：公告已入库的每吨涨跌换算成每升，比各省实测中位数（零额外请求、不依赖任何第三方页面） | 0 次 |
| `xmgcn.com/tiaozheng/` | HTTPS | 官方调价时间表，**补充**互校（覆盖的历史轮次更多）。2026-11-24 起该页回「HTTP 200 + nginx 403 错误页」，被拒时只记内部告警 | 1 次 |
| `ndrc.gov.cn` 发改委 | HTTPS | 正式调价公告 | 不变 |

- 地区路径名**每源一套**（`data/regions.js` 的 `slugs`）：陕西 qiyoujiage=`shanxi-3` / xmgcn=`shanxi2`，内蒙古 `neimenggu`/`namenggu`，西藏 `xizang`/`xicang`
- 历史价入库有**五道闸门**（区间 / 时序去重 / 首尾自洽 / 跨省一致性 / 幂等）；跨省离群**保留源站原值只告警**，不擅自改写
- 调价节点从历史**实测推导**（`oil_adjust_events`），官方公告按日期合并进去
- 主源被拒时，调价节点改用**库内累积历史**推导（`collector.js` 的 `buildSeries`）—— 不回落的话节点会静默停更，而且没有任何报错
- **内部源**（只做口径互校、数据不展示给用户）的失败只进 `advisories`，不进 `needsReview`：它挂了不该点亮用户看到的「等待人工核对」

### 换源时踩的坑

| 坑 | 正确做法 |
| --- | --- |
| 站点对密集请求返回**残页** | 抓 31 个省页时油价网会返回**表格 tbody 为空**的页面（首测 7/31 省拿到空表），看起来像「那个省没有历史」 | 限速（3 并发 + 每请求间隔）+ **行数校验**（< 20 行判失败）+ **解析失败重试 1 次**；半张表比没有表危险，写进库会画出一条假台阶线 |
| 历史表的行序是**降序**（最新在前） | 页面第一行是 2026-11-13，最后一行是 2025-09-10。直接按页面顺序算「相邻期变化」，**全部反号**（涨变跌），测出来的涨跌额跟着反 | 解析后按日期升序重排（`sources.js` 的 `xmgcnRegion` 末尾）；`stripTags` 会把整行文字连成一串，排序前别用它取数 |
| 价格为整数时「价格+涨跌」会被粘连 | 去空白后「价格 10」+「涨跌 0」粘成 **100**。内蒙古 98# 在 2026-09-25 / 2026-10-16 正好是整数 10 → 粘成 100 后那两期涨跌变成 +90 / -89.68，整条序列全乱，跨省闸门还误报「偏离 89.98」 | 价格必须从**原始 HTML** 取（`<div>数字</div>`），涨跌的**符号从 class 取**（`change-up` / `change-down` / `change-unchanged`）；文本里的持平值是「0」，没有符号 |
| 站点回 **HTTP 200 + 一张 403 错误页**（软 403） | 2026-11-24 实测 xmgcn.com：请求任何路径都回 **200**，正文却是 nginx 的 403 静态页（138 字节，`last-modified: 2025-06-05`）。抓取层只看状态码就会当成「抓取成功」，再报「解析不出字段」—— 排查方向被引到解析器上，而真正的原因是**站点在拒绝我们** | 抓取层要**看正文**：`http-client.js` 的 `detectBlockPage`（只在 ≤ 4KB 的短页面上判定，避免文章里写「安全验证」就误伤）→ 归类 `SOURCE_BLOCKED`；连续被拒 3 次**熔断 6 小时**（31 省 × 2 次重试 = 62 个请求，别往拒绝我们的站点脸上打）；**内部源失败只进 advisories**，不能点亮用户的「等待人工核对」 |
| 98# 的**跨省绝对价差**天然就有 1.4 元/升 | 各省 98# 相对 92# 的溢价差 1.3（甘肃 −0.73 vs 西藏 +0.81），甘肃 98# 比中位数低 1.39 属正常。拿绝对价判离群会误伤一大片 | 跨省一致性只能用「**变化幅度**」（全国统一调价下各省一致），不能用绝对价；`measure.js` 的 MAD 闸门同理 |
| 真实单轮调价最大 1.13 元/升 | 2026-03-24 那轮全国普涨：92# +0.93、95# +1.01、**98# +1.13**。跳变阈值卡在 1.0 会把这种大轮调价整个挡掉 —— 挡掉的是真数据 | `collector.js` 的 `JUMP_LIMIT` 提到 **1.5**（留 30% 余量）；判定跳变前先问「这一轮官方吨价是多少」，别一刀切 |
| 闸门代码的循环条件写反 → 整道闸门静默失效 | `forEach` 里写成 `if (selfOk) return;`（应为 `if (!selfOk) return;`），条件永远成立 → 检查一次都不跑，G3 首尾自洽形同虚设 | 这种闸门**必须有对应的自检用例**（`server/scripts/selftest.js` 的「历史价入库的五道闸门」），光看代码看不出来 |
| 站点轮次一过就把预测区块改写成「结果」 | 轮次前是「下次油价11月12日24时调整 … 目前预计上调油价90元/吨(0.07元/升-0.08元/升)」，轮次后变成「油价11月12日24时调整 … 下跌0.51元/升-0.63元/升」 | 「下次」「预计」只在预测写法里出现，是区分二者的唯一依据（`qyjTrend` 的 `isForecast`）；**日期已过的结果不能当「下次窗口」写进去**，否则页面显示过期预测 |
| 官方公告只覆盖最近几轮 → 走势页节点恒为空 | `actionTrend` 原来是二选一（有公告用公告，没公告用推导表），公告只有最近几轮，一年视图只有几个节点 | 改成按日期**合并**：官方优先，官方测不出幅度时用实测推导值兜底；推导值是各省挂牌价实测差值，界面要标「据各地挂牌价测算」 |
| 换源那一轮把「上次调价」清空 → 首页全变「暂无调价对比」 | 价格行的 changeAt/changeAmount 只在「同源且价格变了」时才写。换源时同源基线取不到 → 被清空；采集又有 6 小时新鲜期，最长要等下一轮真抓才补回来，用户看到的是「价格正常、但没有调价对比」 | 价格没动时**保留原基线**；库里没基线就从**本源自己的历史表**重建最近一次调价（`collector.js` 的 `lastAdjustmentFromHistory`）；读侧再兜一层（`query.js` 的 `lastAdjustmentOf`）。口径都是**本地区**前后差值，别拿各省中位数来充 |
| 官方公告与挂牌价生效日**差一天** → 同一次调价被数成两次 | 公告写「11月12日24时起」，即次日 00:00 生效 —— 官方节点是 11-12，按挂牌价前后差推出来的节点是 11-13。只按精确日期合并的话，同一次调价两边都留着：节点列表里挨着出现两条，调价次数也多算一次（线上实测 26 个节点实际只有 23 次调价） | 官方节点落地时**收编前后一天内的推导节点**（`query.js` 的 `mergeAdjustNodes`）：保留官方日期与标题，官方测不出幅度时用被收编节点的实测值兜底；官方日期不许收编别的官方节点 |

## 验证要求

- 改完页面/WXML/组件，**必须**跑 `node scripts/lint-wxml.js`（0 错误 0 警告才算过）和 `node scripts/check-modules.js`（模块加载期异常静态检查查不出来）
- 改数据层或算法，跑 `node scripts/verify-data.js` 对照输出值
- **改了前后端之间的字段**，跑 `node scripts/verify-contract.js` —— 它在 `wx.request` 层打本地测试服务，让前端**真走** `fetchWithFallback`（不是 stub api 层），字段漂移、空值冒充 0.00、来源标错、回落与竞态都靠它挡
- **改了服务端的解析器或可信度判定**，跑 `node scripts/verify-collector.js`（解析回归）与 `verify-contract.js`（采集链路 → 入库 `review_status` → 对外可见性）
- **改了公告解析或测算**，拿 `scripts/fixtures/ndrc-*.html`（发改委真实公告原文）做回归；
  改动公告解析器时必须覆盖三类：普通调价、调控类（取「实际上调」）、搁浅（不作调整）
- **改了挂牌价测算**，必须覆盖：站点提前挂价、样本太少不给结论、测算方向与公告方向矛盾
  改了阈值或定界还要覆盖：大轮调价（官方 645 元/吨 + 实测 0.52 元/升）要算得出来、超出官方吨价能解释范围的脏数据不采信、明显偏小的降幅不采信、各省数据离散时不给结论、有多数支撑的中位数不能被误伤；
  改完做一次**反向验证** —— 把保护拆掉确认对应用例变红，再还原复跑
- **改了订阅消息模板**（ID 或字段），同步三处：`config/index.js`、`server/src/services/subscribe-templates.js`、服务端 `.env`；跑 selftest 的「小程序端与服务端契约表用的是同一个模板 ID」用例
- 改渲染结果，在开发者工具模拟器里逐页核对，别只信静态检查 —— 上面那批 bug 静态检查查不出来
- 截图类产物落在 `docs/screenshots/`，临时导出的 canvas 代码不要留在仓库里

## 提交约定

- 个人单维护项目，**直接在 `main` 上提交**，不开特性分支再合并；确需分支先问
- 提交信息用中文，描述改了什么（`fix: 修复 X` / `feat: 新增 X` / `docs: 补充 X`）
- 远端 `origin` = `https://github.com/uwakeme/oil-trend.git`；若 443 不通可临时改用 SSH：`git@github.com:uwakeme/oil-trend.git`
- 远端 `origin` 已有提交，用 `git push git@github.com:uwakeme/oil-trend.git main:main` 推送（443 不通时走 SSH）
- 用 `git push <url>` 形式推送**不会更新** `origin/main` 远程跟踪引用，`git log origin/main..main` 会误报「没推上去」，以 `git ls-remote` 的实际结果为准
- 改动前先看 `git status`，工作区经常有未提交的 WIP，**不要替用户丢弃或覆盖**
- **每次发完新版，只回给用户一段「版本描述」** —— 公众平台「提交开发版本」表单里
  唯一每次都要写的那项。别的表单项（图片预览、视频预览、测试账号、订单中心 path、
  审核加急、隐私指引……）**用户没要求就不要罗列**，他自己填。
  草稿由 `node scripts/release-desc.js` 生成，流水线也会自动写进运行 summary；
  交出去前要改成**用户视角的一句话** —— 审核员与用户看的是这句，不是 commit 标题
- **共享服务器上有别人的线上服务**（`lyric-lab.uwakeme.top`、`jiuguan.uwakeme.top`、openmaic）。
  涉及停服务、改 nginx、写 `/etc`、装证书这类操作，**只给命令让用户自己跑**；
  流水线只允许「上传代码 + 重启 Wake油价势助手 自己的 pm2 进程」，不许碰 nginx 与其他服务

## 安全

- **AppSecret 绝不能进代码或小程序包**。只在服务器的 `server/.env` 里，前端只认 `apiBaseUrl`
- **上传密钥（`private.key`）绝不能入库**：只放 GitHub 仓库 secret（`WX_UPLOAD_PRIVATE_KEY`）与本地磁盘
- 预览包、订阅消息模板都要求**正式 AppID**，测试号拿不到
- 主包体积上限 2MB，新增目录要在 `project.config.json` 的 `packOptions.ignore` 里排除
- `docs/`、`design/`、`scripts/`、`server/`、`.tooling/`、`.workbuddy/` 都已排除在打包外

## 项目现状（2026-11）

五个页面已写完并逐页验证过。**后端已上线**：`server/`（Node + Express + PostgreSQL）
部署在自己的服务器上，采集器每 30 分钟从**油价网**（xmgcn，HTTPS）抓
31 省挂牌价 + 最近 30 期历史（走势图能铺满近一年），**下次调价预测**另由**汽油价格网**
（qiyoujiage）提供并兼作兜底与交叉校核，页面显示的是真实挂牌价
（解析规则见 `server/src/services/sources.js`，分工见上文「数据源现状」）。

**发改委调价公告源已启用**（2026-11-16）：列表页 → 详情页两步抓取，拿到的是
「方向 + 执行日期 + 汽/柴油吨价」。公告**不给**四油品每升幅度，
那部分由 `server/src/services/measure.js` 拿各地挂牌价的前后快照差值测算，
界面标注为「据各地挂牌价测算，非官方公布」。
国际行情源仍未启用。

订阅消息链路还没走通到底（需正式 AppID + 模板 ID），未配置时「提醒」页要明说未配置，不假装授权成功。

小程序端已接 `wx.getLocation`：首页启动时读一次位置，反查省份后自动切到当地油价；
用户手动选过地区就不再自动覆盖，只提示「检测到你在 XX，点此切换」。
接口权限需在公众平台「开发管理 → 接口设置」申请 `wx.getLocation`，未开通时静默降级到默认地区。

微信云开发那套已下线（云函数目录已删，见 git 历史）；`config/index.js` 的
`apiBaseUrl` 留空则一律使用演示数据。
小程序图标已定为 **8-bit 像素风**：`assets/app-icon/app-icon.png`（512×512，公众平台后台上传用）。tabBar 导航图标仍是细描边 SVG 风格，与像素风**尚未统一**。

`docs/assets/og.png` 是 1200×630 **位图**，品牌名烧在像素里 —— 改名字时 grep 搜不到它，得单独重绘。
字体在 Windows 上现成可用：中文名用 `NotoSerifSC-VF.ttf`（思源宋体等价，`set_variation_by_axes([750])` 调字重），
英文行用 `DINNextLTPro-Light.ttf`（设计令牌的 `--font-num` 用的 DIN）。重绘只需换标题区：
按行二次拟合重建渐变背景 → 擦掉旧标题区 → 重画中文名与英文行，图表与数据行原样保留。

项目仍在开发阶段：**历史/存量数据引发的问题不修**，只登记一行；影响当前行为的代码缺陷照修。