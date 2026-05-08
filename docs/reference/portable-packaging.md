<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->

# 免安装包打包

[English](portable-packaging.en.md) | [中文](portable-packaging.md)

SmartPerfetto 的免安装包不是单文件二进制。启动器负责拉起包内 Node.js 24
runtime、后端、预构建 Perfetto UI 和固定版本 `trace_processor_shell`。

当前维护的 release asset：

- `smartperfetto-v<version>-windows-x64.zip`
- `smartperfetto-v<version>-macos-arm64.zip`
- `smartperfetto-v<version>-linux-x64.tar.gz`

## 打包

```bash
npm run package:portable
```

单平台：

```bash
npm run package:windows-exe
npm run package:macos-app
npm run package:linux
```

输出：

```text
dist/portable/smartperfetto-v<version>-windows-x64.zip
dist/portable/smartperfetto-v<version>-macos-arm64.zip
dist/portable/smartperfetto-v<version>-linux-x64.tar.gz
```

兼容 Windows 旧命令仍输出到：

```text
dist/windows-exe/smartperfetto-v<version>-windows-x64.zip
```

## 发布

正常公开发布：

```bash
npm run version:set -- 1.0.3
git add package.json package-lock.json backend/package.json backend/package-lock.json
git commit -m "chore: release v1.0.3"
git push origin main
npm run release:portable -- 1.0.3 --no-draft
```

`release:portable` 会重新打包、校验 manifest、上传所有目标平台 asset，并确认
GitHub Release 的 target commit 和 asset 名称。默认创建 draft release；加
`--no-draft` 才直接发布。

仅发布某个平台：

```bash
npm run release:portable -- 1.0.3 --targets macos-arm64
npm run release:windows-exe -- 1.0.3
```

公开发布不要使用 `--allow-dirty`。`--skip-build` 只适合已经为同一版本和同一
commit 刚刚打过包的情况。

## macOS 签名和公证

未设置签名变量时，脚本会生成 unsigned app，适合本地测试，不适合作为低摩擦公开
发布。正式 macOS 包建议设置：

```bash
export SMARTPERFETTO_MACOS_SIGN_IDENTITY="Developer ID Application: ..."
export SMARTPERFETTO_MACOS_NOTARY_PROFILE="notarytool-keychain-profile"
npm run release:portable -- 1.0.3 --targets macos-arm64
```

设置签名身份后脚本会 `codesign --options runtime` 并做 strict verify；设置 notary
profile 后会通过 `xcrun notarytool submit --wait` 提交，并对 `.app` staple 后重新
生成 zip。

## 用户数据目录

- Windows：包目录下 `data/` 和 `logs/`。
- macOS：`~/Library/Application Support/SmartPerfetto` 和 `~/Library/Logs/SmartPerfetto`。
- Linux：`${XDG_DATA_HOME:-~/.local/share}/smartperfetto` 和
  `${XDG_STATE_HOME:-~/.local/state}/smartperfetto/logs`。

AI 分析推荐在 UI 里配置 Provider profile。需要 env 凭证时，在对应用户数据目录
创建 `env` 文件后重启启动器。

## 验证

脚本会校验包结构、版本、manifest、Node runtime、目标平台 native 依赖和
`trace_processor_shell` pin。真实发布前仍需要在目标平台做最小 smoke：

1. 启动包内 launcher。
2. 打开 [http://localhost:10000](http://localhost:10000)。
3. 检查 [http://localhost:3000/health](http://localhost:3000/health)。
4. 上传一条小 trace，确认后端日志中启动了对应平台的 `trace_processor_shell`。
