<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 启动摆核时序分析 (startup_cpu_placement_timeline)

按时间桶分析主线程的核类型变化，检测"启动初期被困小核"的问题。典型场景包括：冷启动 fork 后继承 Zygote 的 CPU affinity 初期可能在小核、cgroup 设置延迟（AMS 还没把新进程加入 top-app cgroup）、uclamp_min 生效延迟等。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 是 | - | 应用包名（支持 GLOB 前缀匹配） |
| start_ts | timestamp | 是 | - | 启动区间开始时间戳(ns) |
| end_ts | timestamp | 是 | - | 启动区间结束时间戳(ns) |
| bucket_ms | number | 否 | 50 | 时间桶大小（ms） |

## SQL 查询

```sql
WITH main_thread AS (
  SELECT t.utid FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<package>*' AND t.tid = p.pid LIMIT 1
),
-- 生成时间桶（最多 30 个桶）
bucket_size AS (
  SELECT MAX(<bucket_ms|50> * 1000000, (<end_ts> - <start_ts>) / 30) as bucket_ns
),
buckets AS (
  -- 递归 CTE 生成桶序列
),
-- 主线程 sched 数据 + 核类型
main_sched AS (
  SELECT ss.ts, ss.dur, ss.cpu,
    COALESCE(ct.core_type, 'unknown') as core_type
  FROM sched_slice ss CROSS JOIN main_thread mt
  LEFT JOIN _cpu_topology ct ON ss.cpu = ct.cpu_id
  WHERE ss.utid = mt.utid AND ss.ts < <end_ts> AND ss.ts + ss.dur > <start_ts>
)
SELECT
  b.bucket_idx,
  ROUND((b.bucket_start - <start_ts>) / 1e6, 0) as bucket_offset_ms,
  ROUND(big_core_overlap / 1e6, 2) as big_core_ms,
  ROUND(little_core_overlap / 1e6, 2) as little_core_ms,
  ROUND(100.0 * big_core_overlap / NULLIF(total_overlap, 0), 1) as big_core_pct,
  GROUP_CONCAT(DISTINCT ms.cpu) as used_cpus,
  GROUP_CONCAT(DISTINCT ms.core_type) as core_types
FROM buckets b LEFT JOIN main_sched ms ON overlap
GROUP BY b.bucket_idx ORDER BY b.bucket_idx
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| bucket_idx | number | 时间桶编号（从 0 开始） |
| bucket_offset_ms | number | 相对于启动开始的偏移量（ms） |
| big_core_ms | duration | 大核运行时间（prime/big/medium，ms） |
| little_core_ms | duration | 小核运行时间（little，ms） |
| big_core_pct | percentage | 大核占比（%） |
| used_cpus | string | 该桶内使用过的 CPU 编号（逗号分隔） |
| core_types | string | 该桶内涉及的核类型（逗号分隔） |

## 使用说明

- **前置模块**: `sched`
- 默认 50ms 桶，最多生成 30 个桶
- 如果前几个桶的 `big_core_pct` 接近 0% 而后续桶升到较高比例，说明存在"启动初期被困小核"问题
- medium 核（如 Cortex-A78）归入性能核侧
- 在 `startup_detail` 组合 Skill 中用于观察主线程核类型随时间的变化趋势