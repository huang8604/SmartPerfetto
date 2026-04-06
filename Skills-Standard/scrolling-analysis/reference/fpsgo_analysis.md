<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# FPSGO 子模块分析 (MTK)

## FPSGO 架构

FPSGO (FPS Go) 是 MTK 的帧感知调度框架，包含以下子模块：

| 模块 | 功能 | Trace 标记模式 |
|------|------|-------------|
| **FSTB** (Frame Stabilizer) | 帧稳定：根据目标帧率和当前帧耗时计算需要的 CPU 频率 | `*fpsgo*fstb*`, `*FSTB*` |
| **FBT** (Frame Boost Technology) | 急拉：预测掉帧风险时主动提频 | `*fpsgo*fbt*`, `*boost*`, `*rescue*` |
| **GBE** (Game Boost Enhancement) | 游戏场景增强 | `*gbe*` |
| **XGFF** | 跨进程帧感知调度 | `*xgff*` |

## FSTB 状态检测

```sql
-- FSTB 活跃状态和目标帧率
SELECT name, COUNT(*) as cnt,
  ROUND(SUM(dur)/1e6, 1) as total_ms
FROM slice
WHERE name GLOB '*fstb*' OR name GLOB '*FSTB*'
  OR name GLOB '*fpsgo*target*'
GROUP BY name ORDER BY cnt DESC
```

## FBT 急拉事件追踪

```sql
-- FBT 急拉触发事件
SELECT name, ts, dur,
  ROUND(dur/1e6, 2) as dur_ms
FROM slice
WHERE name GLOB '*fbt*boost*'
  OR name GLOB '*fbt*rescue*'
  OR name GLOB '*fpsgo*boost*'
ORDER BY ts
LIMIT 30
```

## per-task Boost 值查询

```sql
-- 如有 sched_util 相关 ftrace event
SELECT name, COUNT(*) as cnt
FROM slice
WHERE name GLOB '*uclamp*' OR name GLOB '*util*boost*'
GROUP BY name
```

## FPSGO 版本差异

| Kernel 版本 | FPSGO 版本 | 关键差异 |
|------------|-----------|---------|
| 4.x | FPSGO v1 | 全局 boost 为主 |
| 5.10+ | FPSGO v2 | per-task boost + bhr (base highest ratio) |
| 5.15+ | FPSGO v3 | 增强的跨进程帧感知 |
| 6.x | FPSGO v4 | 与 EAS 深度整合 |

不同版本的 trace tag 名称可能不同。搜索时使用宽泛模式 `*fpsgo*` 确保覆盖。