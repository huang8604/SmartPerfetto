<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 启动慢原因（官方分类） (startup_slow_reasons)

基于 Perfetto stdlib 的 android.startup 模块，检测 20+ 种已知的启动慢原因。v3.0 新增 SR09-SR20 扩展检测，覆盖 ContentProvider、SharedPreferences、sleep、SDK init、native lib、WebView、inflate、thermal、后台干扰、system_server 锁、并发启动、数据库 IO。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| （无输入参数） | - | - | - | 自动分析最慢的启动事件 |

## 步骤编排

这是一个 composite skill，包含 2 个步骤：

### Step 1: startup_overview — 启动事件汇总
查询所有启动事件的基本信息（startup_id、package、startup_type、dur_ms、ttid_ms、ttfd_ms），用于定位分析目标。

### Step 2: slow_reason_checks — 慢启动原因检测
对最慢的启动事件执行 20 项检测，每项对应一个 reason_id：

| reason_id | 检测项 | 严重度阈值 | 根因分类 |
|-----------|--------|-----------|----------|
| SR01 | JIT 编译活跃（缺少 Baseline Profile） | >50次=critical, >20次=warning | 应用层 A12 |
| SR02 | DEX2OAT 并发运行 | 存在即 warning | 应用层 A5 / 环境 |
| SR03 | GC 活动 | 主线程 GC=warning | 应用层 A6 |
| SR04 | 主线程锁竞争 | >50ms=critical, >10ms=warning | 应用层 A7 |
| SR05 | 主线程 IO 阻塞 | >100ms=critical, >30ms=warning | 应用层 A2 |
| SR06 | 主线程 Binder 阻塞 | >100ms=critical, >30ms=warning | 系统层 B6 / 应用层 |
| SR07 | Broadcast 接收延迟 | >3次=info | 应用层 A13 |
| SR08 | 大量类验证 | >100ms=warning | 应用层 A5 |
| SR09 | ContentProvider 初始化过多 | >8个=critical, >3个=warning | 应用层 A1（仅冷启动） |
| SR10 | 主线程 futex 等待 | >50ms=critical, >10ms=warning | 应用层 A9/A7 |
| SR11 | 主线程显式 sleep/delay | >100ms=critical, >10ms=warning | 应用层 A17 |
| SR12 | 三方 SDK 初始化过重 | >60%=critical, >30%=warning | 应用层 A11（仅冷启动） |
| SR13 | Native 库加载耗时 | >200ms=critical, >50ms=warning | 应用层 A14 |
| SR14 | WebView 初始化 | >300ms=critical, >100ms=warning | 应用层 A10 |
| SR15 | 布局膨胀(inflate)过长 | >450ms=critical, >200ms=warning | 应用层 A4 |
| SR16 | CPU 热节流 | <70%=critical, <90%=warning | 系统层 B4 |
| SR17 | 后台进程干扰（调度延迟） | >15%=critical, >10%=warning | 系统层 B9 |
| SR18 | system_server 锁竞争影响 | >100ms=critical, >20ms=warning | 系统层 B7 |
| SR19 | 并发应用启动干扰 | >3个=critical, >1个=warning | 系统层 B12 |
| SR20 | 主线程 fsync/数据库 IO | >50ms=critical, >10ms=warning | 应用层 A8 |

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| reason_id | string | 原因编号（SR01-SR20） |
| reason | string | 慢启动原因描述 |
| severity | string | 严重程度（critical/warning/info） |
| evidence | string | 证据（数值 + 描述） |
| suggestion | string | 优化建议 |

## 使用说明

- **前置模块**: `android.startup.startups`, `android.startup.time_to_display`
- 结果按 severity 排序：critical > warning > info
- SR09 和 SR12 有冷启动门控（检测 bindApplication slice 存在性），避免温/热启动误报
- SR10 实现了两级归因：在 bindApplication 阶段 + 无 Lock contention slice 覆盖 -> 疑似 SharedPreferences 阻塞；否则为通用 futex 阻塞
- SR16 按 CPU 分组比较同一 CPU 的 startup max vs global max，避免跨大小核比较导致假阳性
- SR18 要求因果链：锁竞争必须与 app 主线程的 binder S 状态时间重叠
- 与 `startup_analysis` 组合 Skill 的其他步骤交叉验证使用