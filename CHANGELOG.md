# Changelog

本项目的所有显著变更都将记录在本文件。

格式基于 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]
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

[Unreleased]: https://github.com/uwakeme/oil-trend/compare/v1.0.4...HEAD
[1.0.4]: https://github.com/uwakeme/oil-trend/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/uwakeme/oil-trend/compare/v1.0.2...v1.0.3
