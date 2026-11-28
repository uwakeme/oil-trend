# Changelog

本项目的所有显著变更都将记录在本文件。

格式基于 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.0.6] - 2026-11-28
### Added
- 国际行情接入真实源：纽约原油走东方财富（快照 + 5 分钟线与日线历史），布伦特原油走新浪财经（场外差价合约 CFD 报价）；国际页写明品种口径，布伦特与 ICE 结算价的基差不再让人误以为「数和网上搜的对不上」
### Removed
- 国际行情的演示数据：以前服务端没采到行情时回落的是写死的 78.42 / 74.16 加伪随机曲线（时间戳却按「现在」打），看着像刚更新的实时行情。现在服务端查不到记录就返回空态，页面显示「还没有采集到行情」；后端连不上就是失败态加重试按钮
- 国内油价的本地兜底演示数据：后端不可用时不再回落内置演示数据，五个页面一律显示失败态与「重新加载」按钮 —— 宁可告诉用户读不到，也不给一份看着正常、其实是编出来的价格（内置演示数据集、演示调价时间线、演示时钟与 `dataSource` 配置项一并删除）
### Changed
- 来源提示条不再有「演示数据」这一档：演示数据已全部删除，页面上不该再出现这句话

## [1.0.5] - 2026-11-27
### Added
- 调价通知详情补上「每升调价幅度」与「调价前 → 调价后」价格表；官方公告只给吨价时按历史实测比值折算补出每升幅度与调价后价格，并标明「折算 · 非官方」，源站挂出新挂牌价后自动替换为实测值
### Fixed
- 调价通知详情里的执行时刻缺失（公告只给日期时显示成「2026 年 11 月 26 日  时执行」），改为「24 时起执行」

## [1.0.4] - 2026-11-26
### Added
- 「数据来源与说明」弹层新增隐私保护指引入口，点击可查看微信官方的隐私指引
### Fixed
- 补上剪贴板写入权限声明（scope.writeClipboard），真机复制不再报「scope is not declared」

## [1.0.3] - 2026-11-26
### Added
- 首页「数据来源与说明」底部展示小程序备案号与工信部查询地址，点一下即可复制到剪贴板

[Unreleased]: https://github.com/uwakeme/oil-trend/compare/v1.0.6...HEAD
[1.0.6]: https://github.com/uwakeme/oil-trend/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/uwakeme/oil-trend/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/uwakeme/oil-trend/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/uwakeme/oil-trend/compare/v1.0.2...v1.0.3
