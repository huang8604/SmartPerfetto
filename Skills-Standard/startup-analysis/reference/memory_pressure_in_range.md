<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 内存压力分析 (memory_pressure_in_range)

分析指定时间范围内的内存压力指标。检测 PSI 指标、kswapd 活动、直接回收（direct reclaim）、内存碎片整理（compaction）、LMK 事件和分配阻塞，用于判断内存压力是否对性能产生影响。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| start_ts | number | 是 | - | 起始时间戳(ns) |
| end_ts | number | 是 | - | 结束时间戳(ns) |
| package | string | 否 | - | 包名过滤（可选） |

## SQL 查询

```sql
WITH params AS (
  SELECT <start_ts> AS start_ts, <end_ts> AS end_ts, '<package>' AS package_filter
),

-- 1. PSI Memory Pressure（如 trace 中有）
psi_memory AS (
  SELECT 'psi_memory' AS source, c.ts, c.value, t.name AS metric_name
  FROM counter c JOIN counter_track t ON c.track_id = t.id
  WHERE (t.name LIKE 'mem.%psi%' OR t.name LIKE '%memory_pressure%')
    AND c.ts BETWEEN start_ts AND end_ts
),

-- 2. kswapd 活动（页面回收守护进程）
-- > **kswapd 检测注意**：kswapd 是内核线程，不产生 atrace slice。如果 SQL 使用 `slice` 表检测 kswapd 活动返回 0，
-- > 应改用 `sched_slice JOIN thread WHERE thread.name LIKE 'kswapd%'` 或检测 `mm_vmscan_kswapd_wake` ftrace 事件。
kswapd_slices AS (
  SELECT s.ts, s.dur, s.name FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN thread t ON tt.utid = t.utid
  WHERE t.name LIKE 'kswapd%' AND s.ts BETWEEN start_ts AND end_ts AND s.dur > 0
),

-- 3. 直接回收事件（同步内存分配阻塞）
direct_reclaim AS (
  SELECT s.ts, s.dur, s.name, t.name AS thread_name FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id JOIN thread t ON tt.utid = t.utid
  WHERE (s.name LIKE '%direct_reclaim%' OR s.name LIKE '%reclaim%alloc%')
    AND s.ts BETWEEN start_ts AND end_ts
),

-- 4. 内存碎片整理事件
compaction_events AS (...),

-- 5. LMK（Low Memory Killer）事件
lmk_events AS (...),

-- 6. 分配阻塞（> 1ms 的页面分配停顿）
alloc_stalls AS (...),

-- 7. Page cache 活动
-- mm_filemap_add_to_page_cache = cache miss → 磁盘读取
-- mm_filemap_delete_from_page_cache = 页面被驱逐 → 内存压力信号

-- 综合压力评分（加权 0-100）
pressure_score AS (
  -- kswapd: >10次=30分, >3次=15分, >0次=5分
  -- direct_reclaim: >5次=40分, >1次=20分, >0次=10分
  -- LMK: >0次=30分
  -- alloc_stall: >3次=20分, >0次=10分
  -- page_cache_delete: >100次=15分, >10次=5分
)

SELECT
  kswapd_events, kswapd_total_ms, kswapd_max_ms,
  direct_reclaim_events, direct_reclaim_total_ms, direct_reclaim_max_ms,
  compaction_events, compaction_total_ms,
  lmk_events,
  alloc_stall_events, alloc_stall_max_ms,
  page_cache_add_events, page_cache_delete_events,
  psi_max, psi_avg,
  pressure_score, pressure_level,
  range_duration_ms
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| kswapd_events | number | kswapd 活动次数 |
| kswapd_total_ms | duration | kswapd 总活动时间(ms) |
| kswapd_max_ms | duration | kswapd 单次最大时间(ms) |
| direct_reclaim_events | number | 直接回收事件次数 |
| direct_reclaim_total_ms | duration | 直接回收总时间(ms) |
| direct_reclaim_max_ms | duration | 直接回收单次最大时间(ms) |
| compaction_events | number | 碎片整理事件次数 |
| compaction_total_ms | duration | 碎片整理总时间(ms) |
| lmk_events | number | LMK 事件次数 |
| alloc_stall_events | number | 分配阻塞次数 |
| alloc_stall_max_ms | duration | 分配阻塞最大时间(ms) |
| page_cache_add_events | number | Page cache 添加次数（cache miss -> 磁盘读） |
| page_cache_delete_events | number | Page cache 驱逐次数（内存压力信号） |
| psi_max | number | PSI 内存压力最大值 |
| psi_avg | number | PSI 内存压力平均值 |
| pressure_score | number | 综合压力评分（0-100） |
| pressure_level | string | 压力等级（none/low/moderate/high/critical） |
| range_duration_ms | number | 分析时间范围长度(ms) |

## 诊断规则

| 条件 | 严重度 | 说明 |
|------|--------|------|
| pressure_score >= 70 或 lmk_events > 0 | critical | 严重内存压力，系统可能因内存不足而终止进程 |
| pressure_score >= 40 | warning | 检测到内存压力，可能影响性能 |
| direct_reclaim_max_ms > 5 | warning | 直接回收导致阻塞，可能导致帧超时或 ANR |

## 使用说明

- 综合压力评分基于 5 个维度加权：kswapd、direct reclaim、LMK、alloc stall、page cache eviction
- `pressure_level` 阈值：>= 70 critical, >= 40 high, >= 15 moderate, > 0 low, 0 none
- page_cache_add_events 高值表示频繁 cache miss（大量磁盘读取）
- page_cache_delete_events 高值表示系统正在驱逐 page cache（内存不够用）
- 在启动分析中用于检测 Phase 2.56 memory pressure 是否影响启动性能

> **kswapd 检测注意**：kswapd 是内核线程，不产生 atrace slice。如果 SQL 使用 `slice` 表检测 kswapd 活动返回 0，应改用 `sched_slice JOIN thread WHERE thread.name LIKE 'kswapd%'` 或检测 `mm_vmscan_kswapd_wake` ftrace 事件。