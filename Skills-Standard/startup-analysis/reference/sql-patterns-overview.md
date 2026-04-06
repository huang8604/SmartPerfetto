<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 启动分析 SQL 模板参考

> 本文档汇编了 SmartPerfetto 启动性能分析中使用的全部 SQL 查询模板。所有 SQL 均针对 Perfetto trace_processor 执行，依赖 Perfetto stdlib 的 `android.startup.*`、`android.binder`、`sched`、`linux.cpu.frequency` 等模块。

## 使用说明

- SQL 模板中使用 `<parameter>` 或 `<parameter>` 表示需要替换的参数。
- `<parameter>` 中 `|` 后为默认值（例如 `<top_k>` 默认取 15）。
- 时间戳参数统一使用纳秒（ns），耗时输出默认转换为毫秒（ms）。
- 部分参数支持空值传入（`<startup_id> IS NULL` 模式），表示不按该维度过滤。
- `<package>` 支持 GLOB 前缀匹配（`GLOB '<package>*'`），空字符串表示不过滤。

### Perfetto stdlib 依赖表

| 表/视图 | 所属模块 | 用途 |
|---------|---------|------|
| `android_startups` | `android.startup.startups` | 启动事件基础信息 |
| `android_startup_processes` | `android.startup.startups` | 启动进程映射 |
| `android_startup_threads` | `android.startup.startups` | 启动线程映射（含 `is_main_thread`） |
| `android_thread_slices_for_all_startups` | `android.startup.startups` | 启动期间所有线程的 slice |
| `android_startup_opinionated_breakdown` | `android.startup.startup_breakdowns` | 启动延迟归因分类 |
| `android_startup_time_to_display` | `android.startup.time_to_display` | TTID/TTFD 指标 |
| `android_class_loading_for_startup` | `android.startup.startups` | 启动期间类加载 |
| `android_binder_txns` | `android.binder` | Binder 事务 |
| `android_binder_client_server_breakdown` | `android.binder_breakdown` | Binder 阻塞归因 |
| `thread_state` | `sched` | 线程状态（Running/R/S/D） |
| `sched_slice` | `sched` | 调度切片 |
| `cpu_frequency_counters` | `linux.cpu.frequency` | CPU 频率计数器 |
| `_cpu_topology` | 内置 | CPU 拓扑（`cpu_id`, `core_type`） |

---

## 内置 Metric 快捷方式

以下手写 SQL 有等效的 Perfetto 内置 metric。Metric 输出为 proto 格式，手写 SQL 更灵活，但 metric 更简洁。

| 分析维度 | 手写 SQL | 等效内置 Metric |
|---------|---------|---------------|
| 启动事件概览 | startup_events_in_range SQL | `RUN_METRIC('android_startup')` |
| 帧时间线统计 | scrolling performance_summary SQL | `RUN_METRIC('android_frame_timeline_metric')` |
| Jank 统计 | consumer_jank_detection SQL | `RUN_METRIC('android_jank')` |
| Binder 事务 | startup_binder SQL | `RUN_METRIC('android_binder')` |

**使用方法**：
```sql
-- 运行内置 metric
SELECT RUN_METRIC('android_startup');
-- 结果在 android_startup_output 表中（proto 格式）
SELECT * FROM android_startup_output;
```

> **何时用 metric vs 手写 SQL**：
> - metric 适合快速概览（一行调用得到全部结果）
> - 手写 SQL 适合自定义分析（按需过滤、关联其他表、计算自定义指标）
> - 本文档中的 SQL 模板提供了比 metric 更细粒度的控制

---

## 1. 启动事件检测

### 1.1 startup_events_in_range — 启动事件列表 (区间)

**描述：** 查询启动事件及 TTID/TTFD 指标。包含多信号启动类型校验（bindApplication/performCreate/handleRelaunchActivity/进程创建时间），可修正平台分类错误。

**依赖模块：** `android.startup.startups`, `android.startup.time_to_display`

**输入参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `package` | string | 否 | 应用包名（GLOB 前缀匹配） |
| `startup_id` | integer | 否 | 指定启动事件 ID |
| `startup_type` | string | 否 | 启动类型过滤（cold/warm/hot） |
| `start_ts` | timestamp | 否 | 区间开始时间（ns） |
| `end_ts` | timestamp | 否 | 区间结束时间（ns） |

**输出列：**

| 列名 | 类型 | 说明 |
|------|------|------|
| `startup_id` | number | 启动事件 ID |
| `package` | string | 包名 |
| `startup_type` | string | 校验后的启动类型 |
| `original_type` | string | 平台原始分类 |
| `dur_ms` | duration | 启动耗时 (ms) |
| `start_ts` | timestamp | 开始时间 (ns) |
| `end_ts` | timestamp | 结束时间 (ns) |
| `dur_ns` | duration | 启动耗时 (ns) |
| `ttid_ms` | duration | Time to Initial Display (ms) |
| `ttfd_ms` | duration | Time to Full Display (ms) |
| `type_display` | string | 类型中文展示（冷启动/温启动/热启动） |
| `rating` | string | 评级（优秀/良好/需优化/严重） |
| `type_reclassified` | number | 是否修正了类型 (0/1) |
| `type_confidence` | string | 分类置信度 (high/medium/low) |

**SQL：**

```sql
-- Multi-signal startup type validation:
--   bindApplication exists           → cold  (process created from zygote)
--   performCreate:* without above    → warm  (activity recreated, process alive)
--   handleRelaunchActivity           → warm  (config change rebuild)
--   performRestart:* exists           → collected as signal but NOT used for reclassification
--   none of above                    → keep original platform classification (Rule 5)
-- Also checks process creation time as fallback cold signal.
--
-- Uses android_startup_threads (stdlib, correct process resolution via
-- android_process_metadata) + direct slice JOIN with OVERLAP time filter.
-- Key: bindApplication can start BEFORE the launchingActivity event
-- (process fork precedes framework launch record by ~100ms), so we use
-- overlap (sl.ts + sl.dur > st.ts AND sl.ts < st.ts + st.dur) instead of
-- the strict "starts within" filter that android_thread_slices_for_all_startups uses.
WITH startup_type_signals AS (
  SELECT
    st.startup_id,
    -- Cold signals
    MAX(CASE WHEN sl.name = 'bindApplication' THEN 1 ELSE 0 END) as has_bind_app,
    MAX(CASE WHEN sl.name GLOB 'OpenDexFilesFromOat*' THEN 1 ELSE 0 END) as has_dex_load,
    MAX(CASE WHEN sl.name = 'PostFork' THEN 1 ELSE 0 END) as has_post_fork,
    -- Warm signals
    MAX(CASE WHEN sl.name GLOB 'performCreate:*' THEN 1 ELSE 0 END) as has_perform_create,
    MAX(CASE WHEN sl.name GLOB 'handleRelaunchActivity*'
             OR sl.name GLOB 'relaunchActivity*' THEN 1 ELSE 0 END) as has_relaunch,
    -- Hot signals (positive)
    MAX(CASE WHEN sl.name GLOB 'performRestart*' THEN 1 ELSE 0 END) as has_perform_restart,
    -- Signal count (trace completeness)
    COUNT(DISTINCT sl.name) as signal_count
  FROM android_startup_threads st
  JOIN thread_track tt ON tt.utid = st.utid
  JOIN slice sl ON sl.track_id = tt.id
  WHERE st.is_main_thread = 1
    -- Overlap: slice overlaps with startup window (not just starts within)
    AND sl.ts + sl.dur > st.ts AND sl.ts < st.ts + st.dur
    AND (sl.name IN ('bindApplication', 'PostFork', 'activityStart', 'activityResume')
         OR sl.name GLOB 'performCreate:*'
         OR sl.name GLOB 'performRestart*'
         OR sl.name GLOB 'handleRelaunchActivity*'
         OR sl.name GLOB 'relaunchActivity*'
         OR sl.name GLOB 'OpenDexFilesFromOat*')
  GROUP BY st.startup_id
),
-- Check process creation time (fallback cold signal)
process_age AS (
  SELECT
    s.startup_id,
    MAX(CASE
      WHEN p.start_ts IS NOT NULL
        AND p.start_ts >= s.ts - 5000000000  -- 5s tolerance before startup
        AND p.start_ts <= s.ts + s.dur
      THEN 1 ELSE 0
    END) as process_created_during_startup
  FROM android_startups s
  LEFT JOIN android_startup_processes asp ON asp.startup_id = s.startup_id
  LEFT JOIN process p ON p.upid = asp.upid
  GROUP BY s.startup_id
),
validated AS (
  SELECT
    s.startup_id,
    s.package,
    s.startup_type as original_type,
    CASE
      -- Rule 1: bindApplication → cold (strongest signal)
      WHEN COALESCE(sts.has_bind_app, 0) = 1 THEN 'cold'
      -- Rule 2: performCreate without bindApplication → warm
      WHEN COALESCE(sts.has_perform_create, 0) = 1 AND COALESCE(sts.has_bind_app, 0) = 0 THEN 'warm'
      -- Rule 3: handleRelaunchActivity → warm (config change rebuild)
      WHEN COALESCE(sts.has_relaunch, 0) = 1 THEN 'warm'
      -- Rule 4: process created during startup → cold (fallback)
      WHEN COALESCE(pa.process_created_during_startup, 0) = 1 THEN 'cold'
      -- Rule 5: keep platform classification
      ELSE s.startup_type
    END as startup_type,
    s.ts,
    s.dur,
    ttd.time_to_initial_display,
    ttd.time_to_full_display,
    CASE
      WHEN COALESCE(sts.has_bind_app, 0) = 1 AND s.startup_type != 'cold' THEN 1
      WHEN COALESCE(sts.has_perform_create, 0) = 1 AND COALESCE(sts.has_bind_app, 0) = 0 AND s.startup_type != 'warm' THEN 1
      WHEN COALESCE(sts.has_relaunch, 0) = 1 AND s.startup_type != 'warm' THEN 1
      WHEN COALESCE(pa.process_created_during_startup, 0) = 1 AND s.startup_type != 'cold' THEN 1
      ELSE 0
    END as type_reclassified,
    -- Classification confidence
    CASE
      WHEN COALESCE(sts.has_bind_app, 0) = 1 AND (COALESCE(sts.has_dex_load, 0) = 1 OR COALESCE(sts.has_post_fork, 0) = 1) THEN 'high'
      WHEN COALESCE(sts.has_bind_app, 0) = 1 THEN 'high'
      WHEN COALESCE(sts.has_perform_create, 0) = 1 AND COALESCE(sts.has_bind_app, 0) = 0 THEN 'high'
      WHEN COALESCE(sts.has_relaunch, 0) = 1 THEN 'medium'
      WHEN COALESCE(pa.process_created_during_startup, 0) = 1 THEN 'medium'
      WHEN COALESCE(sts.signal_count, 0) < 2 THEN 'low'
      ELSE 'medium'
    END as type_confidence
  FROM android_startups s
  LEFT JOIN android_startup_time_to_display ttd USING (startup_id)
  LEFT JOIN startup_type_signals sts USING (startup_id)
  LEFT JOIN process_age pa USING (startup_id)
  WHERE (s.package GLOB '<package>*' OR '<package>' = '')
    AND (<startup_id> IS NULL OR s.startup_id = <startup_id>)
    AND (<start_ts> IS NULL OR s.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR s.ts + s.dur <= <end_ts>)
)
SELECT
  startup_id,
  package,
  startup_type,
  original_type,
  dur / 1e6 as dur_ms,
  printf('%d', ts) as start_ts,
  printf('%d', ts + dur) as end_ts,
  printf('%d', dur) as dur_ns,
  time_to_initial_display / 1e6 as ttid_ms,
  time_to_full_display / 1e6 as ttfd_ms,
  CASE startup_type
    WHEN 'cold' THEN '冷启动'
    WHEN 'warm' THEN '温启动'
    WHEN 'hot' THEN '热启动'
    ELSE startup_type
  END as type_display,
  CASE
    WHEN startup_type = 'cold' AND dur / 1e6 < 500 THEN '优秀'
    WHEN startup_type = 'cold' AND dur / 1e6 < 1000 THEN '良好'
    WHEN startup_type = 'cold' AND dur / 1e6 < 2000 THEN '需优化'
    WHEN startup_type = 'cold' THEN '严重'
    WHEN startup_type = 'warm' AND dur / 1e6 < 200 THEN '优秀'
    WHEN startup_type = 'warm' AND dur / 1e6 < 500 THEN '良好'
    WHEN startup_type = 'warm' AND dur / 1e6 < 1000 THEN '需优化'
    WHEN startup_type = 'warm' THEN '严重'
    WHEN startup_type = 'hot' AND dur / 1e6 < 100 THEN '优秀'
    WHEN startup_type = 'hot' AND dur / 1e6 < 200 THEN '良好'
    WHEN startup_type = 'hot' AND dur / 1e6 < 500 THEN '需优化'
    WHEN startup_type = 'hot' THEN '严重'
    ELSE '需优化'
  END as rating,
  type_reclassified,
  type_confidence,
  printf('%d', CAST(ts - dur * 0.1 AS INTEGER)) as perfetto_start,
  printf('%d', CAST(ts + dur * 1.1 AS INTEGER)) as perfetto_end
FROM validated
WHERE ('<startup_type>' = '' OR startup_type = '<startup_type>')
ORDER BY dur DESC, ts ASC
```

**使用注意：**
- 启动类型校验的 5 条规则有明确优先级：bindApplication > performCreate > handleRelaunchActivity > 进程创建时间 > 平台分类
- `perfetto_start`/`perfetto_end` 用于 Perfetto UI 跳转，在启动窗口前后各扩展 10%

---

## 2. 延迟归因分析

### 2.1 startup_breakdown_in_range — 启动归因分解 (区间)

**描述：** 统计启动阶段各归因原因耗时占比，基于 Perfetto stdlib 的 `android_startup_opinionated_breakdown` 表。

**依赖模块：** `android.startup.startups`, `android.startup.startup_breakdowns`

**输入参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `package` | string | 否 | | 应用包名 |
| `startup_id` | integer | 否 | | 启动事件 ID |
| `startup_type` | string | 否 | | 启动类型 |
| `start_ts` | timestamp | 否 | | 区间开始时间 |
| `end_ts` | timestamp | 否 | | 区间结束时间 |
| `top_k` | integer | 否 | 15 | 返回 Top N |

**输出列：**

| 列名 | 类型 | 说明 |
|------|------|------|
| `reason` | string | 延迟原因 |
| `count` | number | 出现次数 |
| `total_dur_ms` | duration | 总耗时 (ms) |
| `avg_dur_ms` | duration | 平均耗时 (ms) |
| `max_dur_ms` | duration | 最大耗时 (ms) |
| `percent` | percentage | 占总延迟百分比 |
| `category` | string | 归类（IPC/IO/Memory/Lock/Layout/ClassLoading/Other） |

**SQL：**

```sql
SELECT
  b.reason,
  COUNT(*) as count,
  SUM(b.dur) / 1e6 as total_dur_ms,
  ROUND(AVG(b.dur) / 1e6, 2) as avg_dur_ms,
  ROUND(MAX(b.dur) / 1e6, 2) as max_dur_ms,
  ROUND(100.0 * SUM(b.dur) / (
    SELECT SUM(dur) FROM android_startup_opinionated_breakdown
    WHERE startup_id IN (
      SELECT startup_id FROM android_startups
      WHERE (package GLOB '<package>*' OR '<package>' = '')
        AND (<startup_id> IS NULL OR startup_id = <startup_id>)
        AND (<start_ts> IS NULL OR ts >= <start_ts>)
        AND (<end_ts> IS NULL OR ts + dur <= <end_ts>)
    )
  ), 1) as percent,
  CASE
    WHEN b.reason GLOB '*binder*' THEN 'IPC'
    WHEN b.reason GLOB '*io*' OR b.reason GLOB '*dlopen*' THEN 'IO'
    WHEN b.reason GLOB '*gc*' OR b.reason GLOB '*memory*' THEN 'Memory'
    WHEN b.reason GLOB '*lock*' OR b.reason GLOB '*contention*' THEN 'Lock'
    WHEN b.reason GLOB '*inflate*' THEN 'Layout'
    WHEN b.reason GLOB '*verify*' OR b.reason GLOB '*dex*' THEN 'ClassLoading'
    ELSE 'Other'
  END as category
FROM android_startup_opinionated_breakdown b
JOIN android_startups s ON b.startup_id = s.startup_id
WHERE (s.package GLOB '<package>*' OR '<package>' = '')
  AND (<startup_id> IS NULL OR s.startup_id = <startup_id>)
  AND (<start_ts> IS NULL OR s.ts >= <start_ts>)
  AND (<end_ts> IS NULL OR s.ts + s.dur <= <end_ts>)
GROUP BY b.reason
ORDER BY total_dur_ms DESC
LIMIT <top_k>
```

---

## 3. 主线程分析

### 3.1 startup_main_thread_slices_in_range — 启动主线程切片热点 (区间)

**描述：** 统计启动阶段主线程切片热点，包含 wall time 和 self time（去除子 slice 时间）。

**依赖模块：** `android.startup.startups`

**输入参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `package` | string | 否 | | 应用包名 |
| `startup_id` | integer | 否 | | 启动事件 ID |
| `startup_type` | string | 否 | | 启动类型 |
| `start_ts` | timestamp | 否 | | 区间开始时间 |
| `end_ts` | timestamp | 否 | | 区间结束时间 |
| `min_dur_ns` | integer | 否 | 1000000 | 最小切片时长 (ns, 默认 1ms) |
| `top_k` | integer | 否 | 15 | 返回 Top N |

**输出列：**

| 列名 | 类型 | 说明 |
|------|------|------|
| `slice_name` | string | 操作名称 |
| `thread_name` | string | 线程名 |
| `count` | number | 出现次数 |
| `total_dur_ms` | duration | 总耗时 wall time (ms) |
| `self_dur_ms` | duration | 自身耗时 (ms, 去除子 slice) |
| `avg_dur_ms` | duration | 平均耗时 (ms) |
| `max_dur_ms` | duration | 最大耗时 (ms) |
| `percent_of_startup` | percentage | wall time 占启动百分比 |
| `self_percent` | percentage | self time 占启动百分比 |

**SQL：**

```sql
WITH raw AS (
  SELECT
    ts.slice_name,
    ts.thread_name,
    ts.slice_dur,
    ts.slice_id,
    s.dur as startup_dur,
    '<startup_type>' as startup_type,
    s.package
  FROM android_thread_slices_for_all_startups ts
  JOIN android_startups s ON ts.startup_id = s.startup_id
  WHERE ts.is_main_thread = 1
    AND (s.package GLOB '<package>*' OR '<package>' = '')
    AND (<startup_id> IS NULL OR s.startup_id = <startup_id>)
    AND (<start_ts> IS NULL OR s.ts >= <start_ts>)
    AND (<end_ts> IS NULL OR s.ts + s.dur <= <end_ts>)
    AND ts.slice_dur > <min_dur_ns>
),
with_self AS (
  SELECT
    r.*,
    r.slice_dur - COALESCE((
      SELECT SUM(c.dur)
      FROM slice c
      WHERE c.parent_id = r.slice_id
    ), 0) as self_dur
  FROM raw r
)
SELECT
  slice_name,
  thread_name,
  COUNT(*) as count,
  SUM(slice_dur) / 1e6 as total_dur_ms,
  ROUND(SUM(self_dur) / 1e6, 2) as self_dur_ms,
  ROUND(AVG(slice_dur) / 1e6, 2) as avg_dur_ms,
  ROUND(MAX(slice_dur) / 1e6, 2) as max_dur_ms,
  ROUND(100.0 * SUM(slice_dur) / startup_dur, 1) as percent_of_startup,
  ROUND(100.0 * SUM(self_dur) / startup_dur, 1) as self_percent,
  startup_type,
  package
FROM with_self
GROUP BY slice_name
ORDER BY total_dur_ms DESC
LIMIT <top_k>
```

### 3.2 startup_main_thread_states_in_range — 启动主线程状态分布 (区间)

**描述：** 统计启动阶段主线程 Running/Runnable/Blocked 状态占比及阻塞函数。

**依赖模块：** `android.startup.startups`, `sched`

**输入参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `package` | string | 否 | 应用包名 |
| `startup_id` | integer | 否 | 启动事件 ID |
| `startup_type` | string | 否 | 启动类型 |
| `start_ts` | timestamp | 否 | 区间开始时间 |
| `end_ts` | timestamp | 否 | 区间结束时间 |

**输出列：**

| 列名 | 类型 | 说明 |
|------|------|------|
| `state` | string | 线程状态码 (Running/R/R+/S/D) |
| `state_desc` | string | 状态中文说明 |
| `total_dur_ms` | duration | 总耗时 (ms) |
| `percent` | percentage | 占启动百分比 |
| `count` | number | 状态切换次数 |
| `blocked_functions` | string | 阻塞函数列表 |

**SQL：**

```sql
SELECT
  ts.state,
  CASE ts.state
    WHEN 'Running' THEN 'Running (CPU执行)'
    WHEN 'R' THEN 'Runnable (等待调度)'
    WHEN 'R+' THEN 'Runnable+ (抢占等待)'
    WHEN 'S' THEN 'Sleeping (主动睡眠)'
    WHEN 'D' THEN 'Disk Sleep (IO等待)'
    ELSE ts.state
  END as state_desc,
  SUM(ts.dur) / 1e6 as total_dur_ms,
  ROUND(100.0 * SUM(ts.dur) / s.dur, 1) as percent,
  COUNT(*) as count,
  GROUP_CONCAT(DISTINCT ts.blocked_function) as blocked_functions
FROM thread_state ts
JOIN android_startup_threads st ON ts.utid = st.utid
JOIN android_startups s ON st.startup_id = s.startup_id
WHERE st.is_main_thread = 1
  AND (s.package GLOB '<package>*' OR '<package>' = '')
  AND (<startup_id> IS NULL OR s.startup_id = <startup_id>)
  AND (<start_ts> IS NULL OR s.ts >= <start_ts>)
  AND (<end_ts> IS NULL OR s.ts + s.dur <= <end_ts>)
  AND ts.ts >= s.ts
  AND ts.ts <= s.ts + s.dur
GROUP BY ts.state, s.startup_id
ORDER BY total_dur_ms DESC
```

### 3.3 startup_main_thread_file_io_in_range — 启动主线程文件 IO (区间)

**描述：** 统计启动阶段主线程文件 IO 相关切片（open/read/write/fsync/sqlite/database/file/disk）。

**依赖模块：** `android.startup.startups`

**输入参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `package` | string | 否 | | 应用包名 |
| `startup_id` | integer | 否 | | 启动事件 ID |
| `start_ts` | timestamp | 否 | | 区间开始时间 |
| `end_ts` | timestamp | 否 | | 区间结束时间 |
| `min_dur_ns` | integer | 否 | 500000 | 最小切片时长 (ns, 默认 0.5ms) |
| `top_k` | integer | 否 | 15 | 返回 Top N |

**SQL：**

```sql
SELECT
  ts.slice_name as io_slice,
  ts.thread_name,
  COUNT(*) as count,
  SUM(ts.slice_dur) / 1e6 as total_dur_ms,
  ROUND(AVG(ts.slice_dur) / 1e6, 2) as avg_dur_ms,
  ROUND(MAX(ts.slice_dur) / 1e6, 2) as max_dur_ms,
  '<startup_type>' as startup_type,
  ROUND(100.0 * SUM(ts.slice_dur) / s.dur, 1) as percent_of_startup
FROM android_thread_slices_for_all_startups ts
JOIN android_startups s ON ts.startup_id = s.startup_id
WHERE ts.is_main_thread = 1
  AND (s.package GLOB '<package>*' OR '<package>' = '')
  AND (<startup_id> IS NULL OR s.startup_id = <startup_id>)
  AND (<start_ts> IS NULL OR s.ts >= <start_ts>)
  AND (<end_ts> IS NULL OR s.ts + s.dur <= <end_ts>)
  AND ts.slice_dur > <min_dur_ns>
  AND (
    lower(ts.slice_name) GLOB '*open*'
    OR lower(ts.slice_name) GLOB '*read*'
    OR lower(ts.slice_name) GLOB '*write*'
    OR lower(ts.slice_name) GLOB '*fsync*'
    OR lower(ts.slice_name) GLOB '*fdatasync*'
    OR lower(ts.slice_name) GLOB '*sqlite*'
    OR lower(ts.slice_name) GLOB '*database*'
    OR lower(ts.slice_name) GLOB '*file*'
    OR lower(ts.slice_name) GLOB '*disk*'
  )
GROUP BY ts.slice_name, s.startup_id
ORDER BY total_dur_ms DESC
LIMIT <top_k>
```

### 3.4 startup_main_thread_sync_binder_in_range — 启动主线程同步 Binder (区间)

**描述：** 统计启动阶段主线程同步 Binder 调用耗时，按服务进程和 AIDL 方法聚合。

**依赖模块：** `android.startup.startups`, `android.binder`

**输入参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `package` | string | 否 | | 应用包名 |
| `startup_id` | integer | 否 | | 启动事件 ID |
| `start_ts` | timestamp | 否 | | 区间开始时间 |
| `end_ts` | timestamp | 否 | | 区间结束时间 |
| `top_k` | integer | 否 | 15 | 返回 Top N |

**SQL：**

```sql
SELECT
  bt.server_process,
  bt.aidl_name,
  COUNT(*) as call_count,
  SUM(bt.client_dur) / 1e6 as total_dur_ms,
  ROUND(AVG(bt.client_dur) / 1e6, 2) as avg_dur_ms,
  ROUND(MAX(bt.client_dur) / 1e6, 2) as max_dur_ms,
  ROUND(100.0 * SUM(bt.client_dur) / s.dur, 1) as percent_of_startup
FROM android_binder_txns bt
JOIN android_startups s ON (
  bt.client_ts >= s.ts AND bt.client_ts <= s.ts + s.dur
  AND bt.client_process GLOB s.package || '*'
)
    -- 注意：Perfetto stdlib android_binder_txns 可能无 is_main_thread 列，需改为 JOIN thread ON client_utid = utid WHERE thread.is_main_thread = 1
WHERE bt.is_main_thread = 1
  AND bt.is_sync = 1
  AND (s.package GLOB '<package>*' OR '<package>' = '')
  AND (<startup_id> IS NULL OR s.startup_id = <startup_id>)
  AND (<start_ts> IS NULL OR s.ts >= <start_ts>)
  AND (<end_ts> IS NULL OR s.ts + s.dur <= <end_ts>)
GROUP BY bt.server_process, bt.aidl_name, s.startup_id
ORDER BY total_dur_ms DESC
LIMIT <top_k>
```

### 3.5 startup_main_thread_binder_blocking_in_range — 启动主线程 Binder 阻塞明细

**描述：** 分析启动阶段主线程同步 Binder 阻塞明细，包含阻塞状态和阻塞函数。

**依赖模块：** `android.startup.startups`, `android.binder`

**输入参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `package` | string | 否 | | 应用包名 |
| `startup_id` | integer | 否 | | 启动事件 ID |
| `start_ts` | timestamp | 否 | | 区间开始时间 |
| `end_ts` | timestamp | 否 | | 区间结束时间 |
| `min_dur_ns` | integer | 否 | 5000000 | 最小 Binder 时长 (ns, 默认 5ms) |
| `top_k` | integer | 否 | 20 | 返回 Top N |

**SQL：**

```sql
SELECT DISTINCT
  bt.server_process,
  bt.aidl_name,
  bt.client_dur / 1e6 as dur_ms,
  ts.state,
  ts.blocked_function,
  printf('%d', bt.client_ts) as ts_str,
  printf('%d', bt.client_dur) as dur_str,
  CASE
    WHEN bt.client_dur / 1e6 > 50 THEN 'critical'
    WHEN bt.client_dur / 1e6 > 16 THEN 'warning'
    ELSE 'normal'
  END as severity
FROM android_binder_txns bt
JOIN android_startups s ON (
  bt.client_ts >= s.ts AND bt.client_ts <= s.ts + s.dur
  AND bt.client_process GLOB s.package || '*'
)
LEFT JOIN thread_state ts ON (
  ts.utid = bt.client_utid
  AND ts.ts >= bt.client_ts
  AND ts.ts < bt.client_ts + bt.client_dur
)
    -- 注意：Perfetto stdlib android_binder_txns 可能无 is_main_thread 列，需改为 JOIN thread ON client_utid = utid WHERE thread.is_main_thread = 1
WHERE bt.is_main_thread = 1
  AND bt.is_sync = 1
  AND (s.package GLOB '<package>*' OR '<package>' = '')
  AND (<startup_id> IS NULL OR s.startup_id = <startup_id>)
  AND (<start_ts> IS NULL OR s.ts >= <start_ts>)
  AND (<end_ts> IS NULL OR s.ts + s.dur <= <end_ts>)
  AND bt.client_dur > <min_dur_ns>
ORDER BY bt.client_dur DESC
LIMIT <top_k>
```

### 3.6 startup_binder_in_range — 启动 Binder 总览 (区间)

**描述：** 统计启动阶段全部 Binder 调用分布（包含非主线程），按服务进程和 AIDL 方法聚合。

**依赖模块：** `android.startup.startups`, `android.binder`

**输入参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `package` | string | 否 | | 应用包名 |
| `startup_id` | integer | 否 | | 启动事件 ID |
| `start_ts` | timestamp | 否 | | 区间开始时间 |
| `end_ts` | timestamp | 否 | | 区间结束时间 |
| `top_k` | integer | 否 | 15 | 返回 Top N |

**SQL：**

```sql
SELECT
  bt.server_process,
  bt.aidl_name,
  COUNT(*) as call_count,
  SUM(bt.client_dur) / 1e6 as total_dur_ms,
  ROUND(AVG(bt.client_dur) / 1e6, 2) as avg_dur_ms,
  ROUND(MAX(bt.client_dur) / 1e6, 2) as max_dur_ms,
  SUM(CASE WHEN bt.is_main_thread THEN 1 ELSE 0 END) as main_thread_calls,
  '<startup_type>' as startup_type,
  ROUND(100.0 * SUM(bt.client_dur) / s.dur, 1) as percent_of_startup
FROM android_binder_txns bt
JOIN android_startups s ON (
  bt.client_ts >= s.ts AND bt.client_ts <= s.ts + s.dur
  AND bt.client_process GLOB s.package || '*'
)
WHERE (s.package GLOB '<package>*' OR '<package>' = '')
  AND (<startup_id> IS NULL OR s.startup_id = <startup_id>)
  AND (<start_ts> IS NULL OR s.ts >= <start_ts>)
  AND (<end_ts> IS NULL OR s.ts + s.dur <= <end_ts>)
GROUP BY bt.server_process, bt.aidl_name, s.startup_id
ORDER BY total_dur_ms DESC
LIMIT <top_k>
```

### 3.7 startup_binder_pool_analysis — Binder 线程池分析

**描述：** 分析启动期间 Binder 线程池的利用率和饱和度。检测线程池大小、忙碌/空闲比、阻塞情况。

**依赖模块：** `sched`

**输入参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `package` | string | 是 | 应用包名 |
| `start_ts` | timestamp | 是 | 区间开始时间 |
| `end_ts` | timestamp | 是 | 区间结束时间 |

**SQL：**

```sql
WITH binder_threads AS (
  SELECT t.utid, t.name as thread_name
  FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<package>*'
    AND t.name GLOB 'Binder:*'
),
pool_stats AS (
  SELECT
    COUNT(DISTINCT bt.utid) as pool_size,
    ROUND(SUM(CASE WHEN ts.state = 'Running' THEN
      (MIN(ts.ts + ts.dur, <end_ts>) - MAX(ts.ts, <start_ts>))
    ELSE 0 END) / 1e6, 2) as total_running_ms,
    ROUND(SUM(CASE WHEN ts.state = 'S'
      AND (ts.blocked_function GLOB '*binder_wait_for_work*'
           OR ts.blocked_function GLOB '*binder_thread_read*') THEN
      (MIN(ts.ts + ts.dur, <end_ts>) - MAX(ts.ts, <start_ts>))
    ELSE 0 END) / 1e6, 2) as total_idle_ms,
    ROUND(SUM(CASE WHEN ts.state = 'S'
      AND ts.blocked_function IS NOT NULL
      AND ts.blocked_function NOT GLOB '*binder_wait_for_work*'
      AND ts.blocked_function NOT GLOB '*binder_thread_read*' THEN
      (MIN(ts.ts + ts.dur, <end_ts>) - MAX(ts.ts, <start_ts>))
    ELSE 0 END) / 1e6, 2) as total_blocked_ms
  FROM binder_threads bt
  JOIN thread_state ts ON ts.utid = bt.utid
  WHERE ts.ts < <end_ts> AND ts.ts + ts.dur > <start_ts>
)
SELECT '线程池大小' as metric,
  pool_size || ' 个 Binder 线程' as value,
  CASE WHEN pool_size = 0 THEN '未检测到 Binder 线程'
       WHEN pool_size < 3 THEN '线程池较小'
       ELSE '正常' END as assessment
FROM pool_stats
UNION ALL
SELECT '线程池利用率' as metric,
  ROUND(100.0 * total_running_ms / NULLIF(total_running_ms + total_idle_ms, 0), 1) || '%' ||
  ' (Running ' || total_running_ms || 'ms / Idle ' || total_idle_ms || 'ms)' as value,
  CASE
    WHEN total_running_ms / NULLIF(total_running_ms + total_idle_ms, 0) > 0.8 THEN '利用率过高，可能存在排队'
    WHEN total_running_ms / NULLIF(total_running_ms + total_idle_ms, 0) > 0.5 THEN '中等利用率'
    ELSE '利用率正常'
  END as assessment
FROM pool_stats
UNION ALL
SELECT 'Binder 线程被阻塞' as metric,
  total_blocked_ms || ' ms (非 binder_wait 的 S 状态)' as value,
  CASE
    WHEN total_blocked_ms > 50 THEN 'Binder 线程自身被阻塞（锁竞争/IO），影响服务响应'
    WHEN total_blocked_ms > 10 THEN '有一定阻塞'
    ELSE '正常'
  END as assessment
FROM pool_stats
```

---

## 4. CPU/调度分析

### 4.1 startup_sched_latency_in_range — 启动调度延迟 (区间)

**描述：** 统计启动阶段主线程 Runnable (R/R+) 等待时延，检测调度瓶颈。

**依赖模块：** `android.startup.startups`, `sched`

**输入参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `package` | string | 否 | 应用包名 |
| `startup_id` | integer | 否 | 启动事件 ID |
| `start_ts` | timestamp | 否 | 区间开始时间 |
| `end_ts` | timestamp | 否 | 区间结束时间 |

**输出列：**

| 列名 | 类型 | 说明 |
|------|------|------|
| `state` | string | 状态 (R 或 R+) |
| `count` | number | 等待次数 |
| `total_wait_ms` | duration | 总等待时间 (ms) |
| `avg_wait_ms` | duration | 平均等待时间 (ms) |
| `max_wait_ms` | duration | 最大等待时间 (ms) |
| `severe_delays` | number | 严重延迟次数 (>8ms) |

**SQL：**

```sql
SELECT
  ts.state,
  COUNT(*) as count,
  SUM(ts.dur) / 1e6 as total_wait_ms,
  ROUND(AVG(ts.dur) / 1e6, 2) as avg_wait_ms,
  ROUND(MAX(ts.dur) / 1e6, 2) as max_wait_ms,
  SUM(CASE WHEN ts.dur / 1e6 > 8 THEN 1 ELSE 0 END) as severe_delays
FROM thread_state ts
JOIN android_startup_threads st ON ts.utid = st.utid
JOIN android_startups s ON st.startup_id = s.startup_id
WHERE st.is_main_thread = 1
  AND (s.package GLOB '<package>*' OR '<package>' = '')
  AND (<startup_id> IS NULL OR s.startup_id = <startup_id>)
  AND (<start_ts> IS NULL OR s.ts >= <start_ts>)
  AND (<end_ts> IS NULL OR s.ts + s.dur <= <end_ts>)
  AND ts.state IN ('R', 'R+')
  AND ts.ts >= s.ts
  AND ts.ts <= s.ts + s.dur
GROUP BY ts.state
```

### 4.2 startup_critical_tasks — 启动关键任务发现

**描述：** 自动识别启动区间内所有活跃线程，按 CPU 时间排序。为每个线程提供四象限分析 (Q1 大核运行 / Q2 小核运行 / Q3 等待调度 / Q4a IO 阻塞 / Q4b 睡眠等待) + 核迁移统计。自动识别线程角色 (main/render/gc/jit/binder/worker/flutter_ui/flutter_raster/webview/other)。

**依赖模块：** `sched`, `linux.cpu.frequency`

**输入参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `package` | string | 是 | | 应用包名 |
| `start_ts` | timestamp | 是 | | 区间开始时间 |
| `end_ts` | timestamp | 是 | | 区间结束时间 |
| `top_k` | number | 否 | 15 | 返回 Top N |

**输出列：**

| 列名 | 类型 | 说明 |
|------|------|------|
| `thread_name` | string | 线程名 |
| `tid` | number | 线程 ID |
| `role` | string | 自动识别的角色 |
| `total_cpu_ms` | duration | CPU 时间 (ms) |
| `q1_big_running_ms` | duration | Q1 大核运行 (ms) |
| `q2_little_running_ms` | duration | Q2 小核运行 (ms) |
| `q3_runnable_ms` | duration | Q3 等待调度 (ms) |
| `q4a_io_blocked_ms` | duration | Q4a IO 阻塞 (ms) |
| `q4b_sleeping_ms` | duration | Q4b 睡眠等待 (ms) |
| `running_pct` | percentage | 运行时间占比 |
| `big_core_pct` | percentage | 大核时间占 CPU 时间比 |
| `migrations` | number | 核迁移次数 |
| `cross_cluster_migrations` | number | 跨 cluster 迁移次数 |

**SQL：**

```sql
-- Step 1: 识别目标进程的所有线程并自动分配角色
WITH process_threads AS (
  SELECT
    t.utid,
    t.tid,
    t.name as thread_name,
    p.pid,
    CASE
      WHEN t.tid = p.pid THEN 'main'
      WHEN t.name = 'RenderThread' THEN 'render'
      WHEN t.name GLOB '*HeapTaskDaemon*' THEN 'gc'
      WHEN t.name GLOB '*FinalizerDaemon*' THEN 'gc'
      WHEN t.name GLOB '*ReferenceQueueDaemon*' THEN 'gc'
      WHEN t.name GLOB 'Jit thread pool*' THEN 'jit'
      WHEN t.name GLOB '*Profile Saver*' THEN 'jit'
      WHEN t.name GLOB 'Binder:*' THEN 'binder'
      WHEN t.name GLOB '*AsyncTask*' OR t.name GLOB 'pool-*-thread-*' THEN 'worker'
      WHEN t.name GLOB '*DefaultDispatcher*' OR t.name GLOB '*Dispatchers.Default*' THEN 'worker'
      WHEN t.name GLOB '*Executor*' OR t.name GLOB '*Worker*' THEN 'worker'
      WHEN t.name GLOB 'OkHttp*' THEN 'worker'
      WHEN t.name GLOB 'arch_disk_io*' THEN 'worker'
      WHEN t.name = '1.ui' THEN 'flutter_ui'
      WHEN t.name = '1.raster' THEN 'flutter_raster'
      WHEN t.name = 'CrRendererMain' THEN 'webview'
      WHEN t.name GLOB '*Signal Catcher*' THEN 'system'
      ELSE 'other'
    END as role
  FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<package>*'
),
-- Step 2: 计算每个线程的四象限分布
thread_quadrant_raw AS (
  SELECT
    pt.utid,
    pt.tid,
    pt.thread_name,
    pt.role,
    ts.state,
    ts.cpu,
    COALESCE(ct.core_type, 'unknown') as core_type,
    SUM(
      MIN(ts.ts + ts.dur, <end_ts>) - MAX(ts.ts, <start_ts>)
    ) / 1e6 as dur_ms
  FROM thread_state ts
  JOIN process_threads pt ON ts.utid = pt.utid
  LEFT JOIN _cpu_topology ct ON ts.cpu = ct.cpu_id
  WHERE ts.ts < <end_ts>
    AND ts.ts + ts.dur > <start_ts>
  GROUP BY pt.utid, ts.state, ts.cpu
),
thread_quadrants AS (
  SELECT
    utid, tid, thread_name, role,
    -- CPU 时间 = 所有 Running 时间
    ROUND(SUM(CASE WHEN state = 'Running' THEN dur_ms ELSE 0 END), 2) as total_cpu_ms,
    -- Q1: 大核运行（prime/big/medium 归入性能核侧）
    ROUND(SUM(CASE WHEN state = 'Running' AND core_type IN ('prime', 'big', 'medium')
      THEN dur_ms ELSE 0 END), 2) as q1_big_running_ms,
    -- Q2: 小核运行
    ROUND(SUM(CASE WHEN state = 'Running' AND core_type = 'little'
      THEN dur_ms ELSE 0 END), 2) as q2_little_running_ms,
    -- Q3: Runnable 等待（含 R 和 R+）
    ROUND(SUM(CASE WHEN state IN ('R', 'R+')
      THEN dur_ms ELSE 0 END), 2) as q3_runnable_ms,
    -- Q4a: IO 阻塞（D/DK）
    ROUND(SUM(CASE WHEN state IN ('D', 'DK')
      THEN dur_ms ELSE 0 END), 2) as q4a_io_blocked_ms,
    -- Q4b: 睡眠等待（S/I）
    ROUND(SUM(CASE WHEN state IN ('S', 'I')
      THEN dur_ms ELSE 0 END), 2) as q4b_sleeping_ms,
    -- 总状态时间（该线程的分母）
    ROUND(SUM(dur_ms), 2) as total_ms
  FROM thread_quadrant_raw
  GROUP BY utid
  HAVING total_cpu_ms > 0.5  -- 过滤 CPU 时间 < 0.5ms 的噪声线程
),
-- Step 3: 计算核迁移
sched_events AS (
  SELECT
    pt.utid,
    ss.cpu,
    COALESCE(ct.core_type, 'unknown') as core_type,
    LAG(ss.cpu) OVER (PARTITION BY pt.utid ORDER BY ss.ts) as prev_cpu,
    LAG(COALESCE(ct.core_type, 'unknown')) OVER (PARTITION BY pt.utid ORDER BY ss.ts) as prev_core_type
  FROM sched_slice ss
  JOIN process_threads pt ON ss.utid = pt.utid
  LEFT JOIN _cpu_topology ct ON ss.cpu = ct.cpu_id
  WHERE ss.ts >= <start_ts> AND ss.ts < <end_ts>
),
thread_migrations AS (
  SELECT
    utid,
    SUM(CASE WHEN prev_cpu IS NOT NULL AND cpu != prev_cpu THEN 1 ELSE 0 END) as migrations,
    SUM(CASE WHEN prev_cpu IS NOT NULL AND cpu != prev_cpu
              AND core_type != prev_core_type THEN 1 ELSE 0 END) as cross_cluster_migrations
  FROM sched_events
  GROUP BY utid
)
-- Final: 合并四象限 + 摆核数据
SELECT
  tq.thread_name,
  tq.tid,
  tq.role,
  tq.total_cpu_ms,
  tq.q1_big_running_ms,
  tq.q2_little_running_ms,
  tq.q3_runnable_ms,
  tq.q4a_io_blocked_ms,
  tq.q4b_sleeping_ms,
  tq.total_ms,
  -- 百分比
  ROUND(100.0 * tq.total_cpu_ms / NULLIF(tq.total_ms, 0), 1) as running_pct,
  ROUND(100.0 * tq.q1_big_running_ms / NULLIF(tq.total_cpu_ms, 0), 1) as big_core_pct,
  -- 摆核
  COALESCE(tm.migrations, 0) as migrations,
  COALESCE(tm.cross_cluster_migrations, 0) as cross_cluster_migrations
FROM thread_quadrants tq
LEFT JOIN thread_migrations tm ON tq.utid = tm.utid
ORDER BY
  CASE tq.role WHEN 'main' THEN 0 ELSE 1 END,
  tq.total_cpu_ms DESC
LIMIT <top_k>
```

### 4.3 startup_freq_rampup — 启动 CPU 频率爬升

**描述：** 分析冷启动初期 CPU 频率从低到高的爬升过程。冷启动前 50ms CPU 可能还在低频（idle 被唤醒），影响前期性能。比较 early phase（前 100ms）和 steady phase（100ms 后）的频率。

**依赖模块：** `linux.cpu.frequency`

**输入参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `start_ts` | timestamp | 是 | 启动开始时间 |
| `end_ts` | timestamp | 是 | 启动结束时间 |

**输出列：**

| 列名 | 类型 | 说明 |
|------|------|------|
| `core_type` | string | 核类型 (prime/big/medium/little) |
| `early_avg_freq_mhz` | number | 初期均频 (MHz) |
| `steady_avg_freq_mhz` | number | 稳态均频 (MHz) |
| `max_freq_mhz` | number | 最高频率 (MHz) |
| `rampup_pct` | percentage | 爬升幅度 (%) |
| `assessment` | string | 评估 |

**SQL：**

```sql
-- Early phase: first 100ms of startup
WITH early_freq AS (
  SELECT
    COALESCE(ct.core_type, 'unknown') as core_type,
    ROUND(SUM(c.value * cf.dur) / NULLIF(SUM(cf.dur), 0) / 1000, 0) as avg_freq_mhz,
    ROUND(MAX(c.value) / 1000, 0) as max_freq_mhz
  FROM cpu_frequency_counters cf
  JOIN counter c ON cf.id = c.id
  LEFT JOIN _cpu_topology ct ON cf.cpu = ct.cpu_id
  WHERE cf.ts >= <start_ts>
    AND cf.ts < <start_ts> + 100000000  -- first 100ms
  GROUP BY core_type
),
-- Steady phase: 100ms to end
steady_freq AS (
  SELECT
    COALESCE(ct.core_type, 'unknown') as core_type,
    ROUND(SUM(c.value * cf.dur) / NULLIF(SUM(cf.dur), 0) / 1000, 0) as avg_freq_mhz,
    ROUND(MAX(c.value) / 1000, 0) as max_freq_mhz
  FROM cpu_frequency_counters cf
  JOIN counter c ON cf.id = c.id
  LEFT JOIN _cpu_topology ct ON cf.cpu = ct.cpu_id
  WHERE cf.ts >= <start_ts> + 100000000  -- after first 100ms
    AND cf.ts < <end_ts>
  GROUP BY core_type
)
SELECT
  COALESCE(ef.core_type, sf.core_type) as core_type,
  COALESCE(ef.avg_freq_mhz, 0) as early_avg_freq_mhz,
  COALESCE(sf.avg_freq_mhz, 0) as steady_avg_freq_mhz,
  COALESCE(sf.max_freq_mhz, ef.max_freq_mhz, 0) as max_freq_mhz,
  ROUND((COALESCE(sf.avg_freq_mhz, 0) - COALESCE(ef.avg_freq_mhz, 0))
    / NULLIF(COALESCE(ef.avg_freq_mhz, 1), 0) * 100, 1) as rampup_pct,
  CASE
    WHEN COALESCE(ef.avg_freq_mhz, 0) < COALESCE(sf.avg_freq_mhz, 0) * 0.5
      THEN '启动初期频率显著偏低，升频延迟明显'
    WHEN COALESCE(ef.avg_freq_mhz, 0) < COALESCE(sf.avg_freq_mhz, 0) * 0.8
      THEN '启动初期频率偏低，有一定升频延迟'
    ELSE '频率爬升正常'
  END as assessment
FROM early_freq ef
FULL OUTER JOIN steady_freq sf ON ef.core_type = sf.core_type
ORDER BY
  CASE COALESCE(ef.core_type, sf.core_type)
    WHEN 'prime' THEN 0 WHEN 'big' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
```

### 4.4 startup_cpu_placement_timeline — 启动摆核时序分析

**描述：** 按时间桶分析主线程的核类型变化，检测"启动初期被困小核"的问题。典型场景：冷启动 fork 后继承 Zygote 的 CPU affinity、cgroup 设置延迟、uclamp_min 生效延迟。

**依赖模块：** `sched`

**输入参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `package` | string | 是 | | 应用包名 |
| `start_ts` | timestamp | 是 | | 区间开始时间 |
| `end_ts` | timestamp | 是 | | 区间结束时间 |
| `bucket_ms` | number | 否 | 50 | 时间桶大小 (ms) |

**输出列：**

| 列名 | 类型 | 说明 |
|------|------|------|
| `bucket_idx` | number | 时间桶索引 |
| `bucket_offset_ms` | number | 距启动开始偏移 (ms) |
| `big_core_ms` | duration | 大核运行时间 (ms) |
| `little_core_ms` | duration | 小核运行时间 (ms) |
| `big_core_pct` | percentage | 大核占比 (%) |
| `used_cpus` | string | 使用的 CPU 编号 |
| `core_types` | string | 使用的核类型 |

**SQL：**

```sql
WITH main_thread AS (
  SELECT t.utid
  FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<package>*' AND t.tid = p.pid
  LIMIT 1
),
-- Generate time buckets (max 30 buckets)
bucket_size AS (
  SELECT MAX(<bucket_ms> * 1000000, (<end_ts> - <start_ts>) / 30) as bucket_ns
),
buckets AS (
  SELECT
    0 as bucket_idx,
    <start_ts> as bucket_start,
    MIN(<start_ts> + (SELECT bucket_ns FROM bucket_size), <end_ts>) as bucket_end
  UNION ALL
  SELECT
    bucket_idx + 1,
    bucket_end,
    MIN(bucket_end + (SELECT bucket_ns FROM bucket_size), <end_ts>)
  FROM buckets
  WHERE bucket_end < <end_ts> AND bucket_idx < 29
),
-- Main thread sched data
main_sched AS (
  SELECT ss.ts, ss.dur, ss.cpu,
    COALESCE(ct.core_type, 'unknown') as core_type
  FROM sched_slice ss
  CROSS JOIN main_thread mt
  LEFT JOIN _cpu_topology ct ON ss.cpu = ct.cpu_id
  WHERE ss.utid = mt.utid
    AND ss.ts < <end_ts> AND ss.ts + ss.dur > <start_ts>
)
SELECT
  b.bucket_idx,
  ROUND((b.bucket_start - <start_ts>) / 1e6, 0) as bucket_offset_ms,
  ROUND(COALESCE(SUM(CASE WHEN ms.core_type IN ('prime', 'big', 'medium')
    THEN (MIN(ms.ts + ms.dur, b.bucket_end) - MAX(ms.ts, b.bucket_start)) ELSE 0 END) / 1e6, 0), 2) as big_core_ms,
  ROUND(COALESCE(SUM(CASE WHEN ms.core_type = 'little'
    THEN (MIN(ms.ts + ms.dur, b.bucket_end) - MAX(ms.ts, b.bucket_start)) ELSE 0 END) / 1e6, 0), 2) as little_core_ms,
  ROUND(100.0 *
    COALESCE(SUM(CASE WHEN ms.core_type IN ('prime', 'big', 'medium')
      THEN (MIN(ms.ts + ms.dur, b.bucket_end) - MAX(ms.ts, b.bucket_start)) ELSE 0 END), 0) /
    NULLIF(
      COALESCE(SUM(MIN(ms.ts + ms.dur, b.bucket_end) - MAX(ms.ts, b.bucket_start)), 0), 0
    ), 1) as big_core_pct,
  GROUP_CONCAT(DISTINCT ms.cpu) as used_cpus,
  GROUP_CONCAT(DISTINCT ms.core_type) as core_types
FROM buckets b
LEFT JOIN main_sched ms ON ms.ts < b.bucket_end AND ms.ts + ms.dur > b.bucket_start
GROUP BY b.bucket_idx
ORDER BY b.bucket_idx
```

---

## 5. 深钻工具

### 5.1 startup_hot_slice_states — 热点 Slice 线程状态分布

**描述：** 分析启动区间内 Top N 热点 Slice 各自的线程状态分布（Running/S/D/R）及 blocked_functions。回答"这个慢 slice 到底是 CPU 密集还是被阻塞了？"

**依赖模块：** `sched`

**输入参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `package` | string | 是 | | 应用包名 |
| `start_ts` | timestamp | 是 | | 区间开始时间 |
| `end_ts` | timestamp | 是 | | 区间结束时间 |
| `top_n` | number | 否 | 10 | 分析 Top N 热点 slice |

**输出列：**

| 列名 | 类型 | 说明 |
|------|------|------|
| `slice_name` | string | 切片名 |
| `slice_dur_ms` | duration | 切片耗时 (ms) |
| `slice_ts` | timestamp | 开始时间 |
| `state` | string | 线程状态 |
| `state_dur_ms` | duration | 该状态耗时 (ms) |
| `state_pct` | percentage | 状态占 slice 百分比 |
| `blocked_functions` | string | 阻塞函数 |

**SQL：**

```sql
WITH main_thread AS (
  SELECT t.utid, p.pid
  FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<package>*'
    AND t.tid = p.pid
),
hot_slices AS (
  SELECT
    s.name as slice_name,
    s.ts as slice_ts,
    s.ts + s.dur as slice_end,
    s.dur / 1e6 as slice_dur_ms
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN main_thread mt ON tt.utid = mt.utid
  WHERE s.ts >= <start_ts>
    AND s.ts + s.dur <= <end_ts>
    AND s.dur >= 5000000
  ORDER BY s.dur DESC
  LIMIT <top_n>
)
SELECT
  hs.slice_name,
  ROUND(hs.slice_dur_ms, 1) as slice_dur_ms,
  printf('%d', hs.slice_ts) as slice_ts,
  tstate.state,
  ROUND(SUM(
    MIN(tstate.ts + tstate.dur, hs.slice_end) - MAX(tstate.ts, hs.slice_ts)
  ) / 1e6, 2) as state_dur_ms,
  ROUND(100.0 * SUM(
    MIN(tstate.ts + tstate.dur, hs.slice_end) - MAX(tstate.ts, hs.slice_ts)
  ) / (hs.slice_dur_ms * 1e6), 1) as state_pct,
  GROUP_CONCAT(DISTINCT tstate.blocked_function) as blocked_functions
FROM hot_slices hs
JOIN main_thread mt
JOIN thread_state tstate ON tstate.utid = mt.utid
  AND tstate.ts < hs.slice_end
  AND tstate.ts + tstate.dur > hs.slice_ts
GROUP BY hs.slice_name, hs.slice_ts, tstate.state
ORDER BY hs.slice_dur_ms DESC, state_dur_ms DESC
```

### 5.2 startup_thread_blocking_graph — 启动线程阻塞关系图

**描述：** 利用 `thread_state.waker_utid` 构建线程间的 block/wakeup 关系图。回答"主线程被谁阻塞？唤醒者当时在做什么？"构建因果链如：`MainThread[S: binder_wait] <- Binder:1234_5 <- system_server/PackageManager`。

**依赖模块：** `sched`

**输入参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `package` | string | 是 | | 应用包名 |
| `start_ts` | timestamp | 是 | | 区间开始时间 |
| `end_ts` | timestamp | 是 | | 区间结束时间 |
| `min_block_ms` | number | 否 | 1 | 最小阻塞时长 (ms) |
| `top_k` | number | 否 | 20 | 返回 Top N |

**输出列：**

| 列名 | 类型 | 说明 |
|------|------|------|
| `blocked_thread` | string | 被阻塞线程名 |
| `blocked_role` | string | 被阻塞线程角色 |
| `blocked_state` | string | 阻塞状态 (S/D) |
| `blocked_function` | string | 阻塞函数 |
| `waker_thread` | string | 唤醒者线程名 |
| `waker_process` | string | 唤醒者进程名 |
| `waker_current_slice` | string | 唤醒者当时在执行的操作 |
| `block_count` | number | 阻塞次数 |
| `total_block_ms` | duration | 总阻塞时间 (ms) |
| `max_block_ms` | duration | 最大阻塞时间 (ms) |
| `avg_block_ms` | duration | 平均阻塞时间 (ms) |

**SQL：**

```sql
WITH process_threads AS (
  SELECT
    t.utid,
    t.tid,
    t.name as thread_name,
    p.pid,
    CASE
      WHEN t.tid = p.pid THEN 'main'
      WHEN t.name = 'RenderThread' THEN 'render'
      WHEN t.name GLOB '*HeapTaskDaemon*' OR t.name GLOB '*FinalizerDaemon*' THEN 'gc'
      WHEN t.name GLOB 'Jit thread pool*' THEN 'jit'
      WHEN t.name GLOB 'Binder:*' THEN 'binder'
      ELSE 'other'
    END as role
  FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<package>*'
),
-- 查找所有阻塞事件（S/D 状态 > min_block_ms）及其唤醒者
blocking_events AS (
  SELECT
    pt.thread_name as blocked_thread,
    pt.role as blocked_role,
    ts.state as blocked_state,
    ts.blocked_function,
    ts.waker_utid,
    ts.ts as block_ts,
    ts.dur as block_dur
  FROM thread_state ts
  JOIN process_threads pt ON ts.utid = pt.utid
  WHERE ts.state IN ('S', 'D')
    AND ts.waker_utid IS NOT NULL
    AND ts.ts >= <start_ts> AND ts.ts < <end_ts>
    AND ts.dur > <min_block_ms> * 1000000
),
-- 关联唤醒者的线程信息和进程信息
with_waker_info AS (
  SELECT
    be.*,
    COALESCE(wt.name, 'unknown') as waker_thread,
    COALESCE(wp.name, 'unknown') as waker_process,
    wt.utid as waker_utid_resolved
  FROM blocking_events be
  LEFT JOIN thread wt ON be.waker_utid = wt.utid
  LEFT JOIN process wp ON wt.upid = wp.upid
),
-- 查找唤醒者在唤醒时刻正在执行的最内层 slice
with_waker_slice AS (
  SELECT
    wi.*,
    (SELECT s.name FROM slice s
     JOIN thread_track tt ON s.track_id = tt.id
     WHERE tt.utid = wi.waker_utid_resolved
       AND s.ts <= wi.block_ts + wi.block_dur
       AND s.ts + s.dur >= wi.block_ts + wi.block_dur
     ORDER BY s.dur ASC
     LIMIT 1) as waker_current_slice
  FROM with_waker_info wi
)
-- 聚合：按阻塞线程 x 唤醒者 x 阻塞函数分组
SELECT
  blocked_thread,
  blocked_role,
  blocked_state,
  COALESCE(blocked_function, '-') as blocked_function,
  waker_thread,
  waker_process,
  COALESCE(waker_current_slice, '-') as waker_current_slice,
  COUNT(*) as block_count,
  ROUND(SUM(block_dur) / 1e6, 2) as total_block_ms,
  ROUND(MAX(block_dur) / 1e6, 2) as max_block_ms,
  ROUND(AVG(block_dur) / 1e6, 2) as avg_block_ms
FROM with_waker_slice
GROUP BY blocked_thread, blocked_role, blocked_state, blocked_function,
         waker_thread, waker_process
ORDER BY
  CASE blocked_role WHEN 'main' THEN 0 WHEN 'render' THEN 1 ELSE 2 END,
  total_block_ms DESC
LIMIT <top_k>
```

### 5.3 blocking_chain_analysis — 阻塞链分析（通用版）

**描述：** 分析指定时间范围内主线程的阻塞链：线程状态分布、唤醒链、阻塞函数分布。与 startup_thread_blocking_graph 不同，此技能不依赖 android_startups 表，可用于任意时间范围。包含 3 个步骤。

**输入参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `process_name` | string | 是 | 目标进程名 |
| `start_ts` | timestamp | 是 | 分析起始时间戳 (ns) |
| `end_ts` | timestamp | 是 | 分析结束时间戳 (ns) |

#### Step 1: 主线程状态分布

```sql
WITH main_thread AS (
  SELECT t.utid
  FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<process_name>*'
    AND (t.is_main_thread = 1 OR t.tid = p.pid)
  LIMIT 1
),
state_dist AS (
  SELECT
    ts_tbl.state,
    COUNT(*) as count,
    SUM(
      MIN(ts_tbl.ts + ts_tbl.dur, <end_ts>)
      - MAX(ts_tbl.ts, <start_ts>)
    ) as total_dur_ns,
    (SELECT bf.blocked_function
     FROM thread_state bf
     CROSS JOIN main_thread mt2
     WHERE bf.utid = mt2.utid
       AND bf.state = ts_tbl.state
       AND bf.blocked_function IS NOT NULL
       AND bf.blocked_function != ''
       AND bf.ts + bf.dur > <start_ts>
       AND bf.ts < <end_ts>
     GROUP BY bf.blocked_function
     ORDER BY SUM(bf.dur) DESC
     LIMIT 1
    ) as top_blocked_function
  FROM thread_state ts_tbl
  CROSS JOIN main_thread mt
  WHERE ts_tbl.utid = mt.utid
    AND ts_tbl.ts + ts_tbl.dur > <start_ts>
    AND ts_tbl.ts < <end_ts>
  GROUP BY ts_tbl.state
),
total AS (
  SELECT SUM(total_dur_ns) as total_ns FROM state_dist
)
SELECT
  sd.state,
  CASE sd.state
    WHEN 'Running' THEN 'Running (运行中)'
    WHEN 'R' THEN 'Runnable (可运行)'
    WHEN 'R+' THEN 'Runnable (Preempted)'
    WHEN 'S' THEN 'Sleeping (睡眠/等待)'
    WHEN 'D' THEN 'Uninterruptible Sleep (不可中断睡眠/IO)'
    WHEN 'T' THEN 'Stopped (已停止)'
    WHEN 'X' THEN 'Dead (已退出)'
    ELSE sd.state
  END as state_display,
  ROUND(sd.total_dur_ns / 1e6, 2) as total_dur_ms,
  sd.count,
  ROUND(100.0 * sd.total_dur_ns / NULLIF((SELECT total_ns FROM total), 0), 1) as pct,
  sd.top_blocked_function as blocked_function
FROM state_dist sd
ORDER BY total_dur_ns DESC
```

#### Step 2: 唤醒链分析

```sql
WITH main_thread AS (
  SELECT t.utid
  FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<process_name>*'
    AND (t.is_main_thread = 1 OR t.tid = p.pid)
  LIMIT 1
),
wakeups AS (
  SELECT
    ts_tbl.ts + ts_tbl.dur as wakeup_ts,
    ts_tbl.dur as sleep_dur,
    ts_tbl.blocked_function,
    wt.name as waker_thread_name,
    wp.name as waker_process_name
  FROM thread_state ts_tbl
  CROSS JOIN main_thread mt
  LEFT JOIN thread wt ON ts_tbl.waker_utid = wt.utid
  LEFT JOIN process wp ON wt.upid = wp.upid
  WHERE ts_tbl.utid = mt.utid
    AND ts_tbl.state IN ('S', 'D')
    AND ts_tbl.waker_utid IS NOT NULL
    AND ts_tbl.ts + ts_tbl.dur > <start_ts>
    AND ts_tbl.ts < <end_ts>
)
SELECT
  printf('%d', MIN(wakeup_ts)) as ts,
  waker_thread_name,
  waker_process_name,
  blocked_function,
  ROUND(SUM(sleep_dur) / 1e6, 2) as total_sleep_dur_ms,
  ROUND(MAX(sleep_dur) / 1e6, 2) as max_sleep_dur_ms,
  COUNT(*) as wakeup_count
FROM wakeups
WHERE waker_thread_name IS NOT NULL
GROUP BY waker_thread_name, waker_process_name, blocked_function
ORDER BY SUM(sleep_dur) DESC
LIMIT 15
```

#### Step 3: 阻塞函数汇总

```sql
WITH main_thread AS (
  SELECT t.utid
  FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<process_name>*'
    AND (t.is_main_thread = 1 OR t.tid = p.pid)
  LIMIT 1
),
blocked AS (
  SELECT
    ts_tbl.blocked_function,
    ts_tbl.dur
  FROM thread_state ts_tbl
  CROSS JOIN main_thread mt
  WHERE ts_tbl.utid = mt.utid
    AND ts_tbl.state IN ('S', 'D')
    AND ts_tbl.blocked_function IS NOT NULL
    AND ts_tbl.blocked_function != ''
    AND ts_tbl.ts + ts_tbl.dur > <start_ts>
    AND ts_tbl.ts < <end_ts>
),
total AS (
  SELECT SUM(dur) as total_ns FROM blocked
)
SELECT
  blocked_function,
  ROUND(SUM(dur) / 1e6, 2) as total_dur_ms,
  COUNT(*) as count,
  ROUND(100.0 * SUM(dur) / NULLIF((SELECT total_ns FROM total), 0), 1) as pct
FROM blocked
GROUP BY blocked_function
ORDER BY SUM(dur) DESC
LIMIT 10
```

### 5.4 binder_root_cause — Binder 根因归因

**描述：** 使用 Perfetto stdlib 的 `android_binder_client_server_breakdown` 表对慢 Binder 事务进行服务端/客户端阻塞原因归因。Breakdown 原因类型包括：GC、lock_contention、binder（嵌套）、monitor_contention、IO、CPU scheduling 等。

**依赖模块：** `android.binder_breakdown`

**输入参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `process_name` | string | 是 | | 目标进程名 |
| `start_ts` | timestamp | 是 | | 分析起始时间 |
| `end_ts` | timestamp | 是 | | 分析结束时间 |
| `min_dur_ms` | number | 否 | 1 | 最小 Binder 事务时长阈值 (ms) |

#### Step 1: 慢 Binder 事务阻塞归因

```sql
WITH slow_txns AS (
  SELECT binder_txn_id, binder_reply_id, client_ts, client_dur, server_dur,
         aidl_name, client_process, server_process
  FROM android_binder_txns
  WHERE is_sync = 1
    AND (client_process GLOB '<process_name>*' OR '<process_name>' = '')
    AND client_dur > <min_dur_ms> * 1000000
    AND (<start_ts> IS NULL OR client_ts >= <start_ts>)
    AND (<end_ts> IS NULL OR client_ts < <end_ts>)
  ORDER BY client_dur DESC
  LIMIT 20
)
SELECT
  COALESCE(st.aidl_name, 'unknown') as interface,
  st.server_process,
  ROUND(st.client_dur / 1e6, 2) as client_dur_ms,
  ROUND(st.server_dur / 1e6, 2) as server_dur_ms,
  bd.reason,
  bd.reason_type,
  ROUND(SUM(bd.dur) / 1e6, 2) as reason_dur_ms,
  ROUND(100.0 * SUM(bd.dur) / st.client_dur, 1) as reason_pct
FROM slow_txns st
JOIN android_binder_client_server_breakdown bd
  ON st.binder_txn_id = bd.binder_txn_id
  AND st.binder_reply_id = bd.binder_reply_id
GROUP BY st.binder_txn_id, bd.reason, bd.reason_type
ORDER BY st.client_dur DESC, reason_dur_ms DESC
```

#### Step 2: 阻塞原因汇总

```sql
SELECT
  bd.reason,
  bd.reason_type,
  COUNT(DISTINCT bd.binder_txn_id) as txn_count,
  ROUND(SUM(bd.dur) / 1e6, 2) as total_dur_ms
FROM android_binder_client_server_breakdown bd
JOIN android_binder_txns bt ON bd.binder_txn_id = bt.binder_txn_id
  AND bd.binder_reply_id = bt.binder_reply_id
WHERE bt.is_sync = 1
  AND (bt.client_process GLOB '<process_name>*' OR '<process_name>' = '')
  AND bt.client_dur > <min_dur_ms> * 1000000
  AND (<start_ts> IS NULL OR bt.client_ts >= <start_ts>)
  AND (<end_ts> IS NULL OR bt.client_ts < <end_ts>)
GROUP BY bd.reason, bd.reason_type
ORDER BY total_dur_ms DESC
```

---

## 6. 补充检测

### 6.1 startup_slow_reasons — 启动慢原因（Google 官方分类 + 自检）v3.0

**描述：** 基于 Perfetto stdlib 的 android.startup 模块，检测 20+ 种已知启动慢原因（SR01-SR20），覆盖 JIT/DEX2OAT/GC/锁竞争/主线程IO/Binder 阻塞/Broadcast 延迟/类验证/ContentProvider/SharedPreferences/sleep/SDK初始化/Native库/WebView/inflate/热节流/后台干扰/system_server锁/并发启动/数据库IO。

**依赖模块：** `android.startup.startups`, `android.startup.time_to_display`

**输入参数：** 无（自动检测最慢的启动事件）

**输出列：**

| 列名 | 类型 | 说明 |
|------|------|------|
| `reason_id` | string | 原因编号 (SR01-SR20) |
| `reason` | string | 慢启动原因描述 |
| `severity` | string | 严重程度 (critical/warning/info) |
| `evidence` | string | 证据 |
| `suggestion` | string | 优化建议 |

**SQL（完整版，包含 SR01-SR20）：**

```sql
WITH startup_info AS (
  SELECT s.startup_id, s.package, s.ts, s.dur, s.startup_type,
         p.upid
  FROM android_startups s
  JOIN process p ON p.name GLOB s.package || '*'
  ORDER BY s.dur DESC LIMIT 1
),
main_thread AS (
  SELECT t.utid, t.tid FROM thread t
  JOIN startup_info si ON t.upid = si.upid
  WHERE (t.is_main_thread = 1 OR t.tid = (SELECT pid FROM process WHERE upid = si.upid))
  LIMIT 1
),
-- Check: JIT activity (indicator of missing baseline profile)
jit_check AS (
  SELECT COUNT(*) as jit_compile_count,
    ROUND(COALESCE(SUM(s.dur), 0) / 1e6, 1) as jit_compile_ms
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN thread t ON tt.utid = t.utid
  JOIN startup_info si ON t.upid = si.upid
  WHERE s.name GLOB 'JIT compiling*'
    AND s.ts >= si.ts AND s.ts < si.ts + si.dur
),
-- Check: DEX2OAT running concurrently
dex2oat_check AS (
  SELECT COUNT(*) as dex2oat_running
  FROM process p
  WHERE (p.name GLOB '*dex2oat*' OR p.name GLOB '*dex2oatd*')
    AND p.start_ts IS NOT NULL
    AND p.start_ts < (SELECT ts + dur FROM startup_info)
),
-- Check: GC during startup
gc_check AS (
  SELECT
    COUNT(*) as gc_count,
    ROUND(COALESCE(SUM(s.dur), 0) / 1e6, 1) as gc_total_ms,
    SUM(CASE WHEN tt.utid = (SELECT utid FROM main_thread) THEN 1 ELSE 0 END) as main_thread_gc_count
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN thread t ON tt.utid = t.utid
  JOIN startup_info si ON t.upid = si.upid
  WHERE (s.name GLOB '*GC*' OR s.name GLOB '*gc*')
    AND s.ts >= si.ts AND s.ts < si.ts + si.dur
    AND s.dur > 100000  -- > 0.1ms
),
-- Check: Lock contention
lock_check AS (
  SELECT
    COUNT(*) as lock_count,
    ROUND(COALESCE(SUM(s.dur), 0) / 1e6, 1) as lock_total_ms
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN main_thread mt ON tt.utid = mt.utid
  JOIN startup_info si
  WHERE (s.name GLOB '*Lock contention*'
         OR s.name GLOB '*monitor contention*'
         OR s.name GLOB '*art::Monitor*')
    AND s.ts >= si.ts AND s.ts < si.ts + si.dur
),
-- Check: Main thread IO (D state)
io_check AS (
  SELECT
    ROUND(COALESCE(SUM(
      MIN(ts.ts + ts.dur, (SELECT ts + dur FROM startup_info))
      - MAX(ts.ts, (SELECT ts FROM startup_info))
    ), 0) / 1e6, 1) as main_thread_d_state_ms
  FROM thread_state ts
  JOIN main_thread mt ON ts.utid = mt.utid
  WHERE ts.state IN ('D', 'DK')
    AND ts.ts < (SELECT ts + dur FROM startup_info)
    AND ts.ts + ts.dur > (SELECT ts FROM startup_info)
),
-- Check: Binder blocking on main thread
binder_check AS (
  SELECT
    COUNT(*) as binder_block_count,
    ROUND(COALESCE(SUM(ts.dur), 0) / 1e6, 1) as binder_block_ms
  FROM thread_state ts
  JOIN main_thread mt ON ts.utid = mt.utid
  WHERE ts.state = 'S'
    AND (ts.blocked_function GLOB '*binder*')
    AND ts.ts >= (SELECT ts FROM startup_info)
    AND ts.ts < (SELECT ts + dur FROM startup_info)
    AND ts.dur > 1000000  -- > 1ms
),
-- Check: Broadcast delays during startup
broadcast_check AS (
  SELECT COUNT(*) as broadcast_count
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN main_thread mt ON tt.utid = mt.utid
  JOIN startup_info si
  WHERE s.name GLOB '*broadcastReceiveReg*'
    AND s.ts >= si.ts AND s.ts < si.ts + si.dur
),
-- Check: Class verification
class_verify_check AS (
  SELECT
    COUNT(*) as verify_count,
    ROUND(COALESCE(SUM(s.dur), 0) / 1e6, 1) as verify_ms
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN thread t ON tt.utid = t.utid
  JOIN startup_info si ON t.upid = si.upid
  WHERE (s.name GLOB 'VerifyClass*' OR s.name GLOB 'verifyClass*')
    AND s.ts >= si.ts AND s.ts < si.ts + si.dur
)
-- Emit detected slow reasons
SELECT 'SR01' as reason_id,
  'JIT 编译活跃（疑似缺少 Baseline Profile）' as reason,
  CASE WHEN jit_compile_count > 50 THEN 'critical'
       WHEN jit_compile_count > 20 THEN 'warning' ELSE 'info' END as severity,
  jit_compile_count || ' 次编译, ' || jit_compile_ms || ' ms' as evidence,
  '使用 Baseline Profile 预编译热点方法，减少冷启动 JIT 需求' as suggestion
FROM jit_check WHERE jit_compile_count > 5

UNION ALL
SELECT 'SR02', 'DEX2OAT 并发运行',
  'warning',
  'dex2oat 进程在启动期间运行', '等待 DEX 优化完成后再测试启动性能'
FROM dex2oat_check WHERE dex2oat_running > 0

UNION ALL
SELECT 'SR03',
  CASE WHEN main_thread_gc_count > 0 THEN '主线程 GC（直接阻塞）'
       ELSE 'GC 活动（间接影响）' END,
  CASE WHEN main_thread_gc_count > 0 THEN 'warning' ELSE 'info' END,
  gc_count || ' 次 GC, 总耗时 ' || gc_total_ms || ' ms, 主线程 ' || main_thread_gc_count || ' 次',
  '减少启动期间的对象分配，避免触发 GC'
FROM gc_check WHERE gc_count > 0

UNION ALL
SELECT 'SR04', '主线程锁竞争',
  CASE WHEN lock_total_ms > 50 THEN 'critical'
       WHEN lock_total_ms > 10 THEN 'warning' ELSE 'info' END,
  lock_count || ' 次, 总耗时 ' || lock_total_ms || ' ms',
  '检查 synchronized/ReentrantLock 使用，减少启动期间的线程同步'
FROM lock_check WHERE lock_count > 0

UNION ALL
SELECT 'SR05', '主线程 IO 阻塞',
  CASE WHEN main_thread_d_state_ms > 100 THEN 'critical'
       WHEN main_thread_d_state_ms > 30 THEN 'warning' ELSE 'info' END,
  '主线程 D(Disk Sleep) 状态 ' || main_thread_d_state_ms || ' ms',
  '将文件/数据库操作移至后台线程'
FROM io_check WHERE main_thread_d_state_ms > 5

UNION ALL
SELECT 'SR06', '主线程 Binder 阻塞',
  CASE WHEN binder_block_ms > 100 THEN 'critical'
       WHEN binder_block_ms > 30 THEN 'warning' ELSE 'info' END,
  binder_block_count || ' 次, 总阻塞 ' || binder_block_ms || ' ms',
  '减少启动期间的同步 Binder 调用，或改为异步'
FROM binder_check WHERE binder_block_count > 0

UNION ALL
SELECT 'SR07', 'Broadcast 接收延迟', 'info',
  broadcast_count || ' 次 broadcast 在启动期间',
  '考虑延迟注册非关键 BroadcastReceiver'
FROM broadcast_check WHERE broadcast_count > 3

UNION ALL
SELECT 'SR08', '大量类验证',
  CASE WHEN verify_ms > 100 THEN 'warning' ELSE 'info' END,
  verify_count || ' 个类验证, 耗时 ' || verify_ms || ' ms',
  '使用 speed-profile 编译模式减少运行时类验证'
FROM class_verify_check WHERE verify_count > 10

-- ================================================================
-- SR09-SR20: 扩展检测 (v3.0)
-- ================================================================

-- SR09: ContentProvider 初始化过多 (仅冷启动)
UNION ALL
SELECT 'SR09',
  'ContentProvider 初始化过多（' || cp_count || ' 个）',
  CASE WHEN cp_count > 8 THEN 'critical'
       WHEN cp_count > 3 THEN 'warning' ELSE 'info' END,
  cp_count || ' 个 ContentProvider, 最慢 ' || max_cp_ms || ' ms',
  '使用 Jetpack App Startup 合并 ContentProvider; 审计每个 CP 的必要性'
FROM (
  SELECT COUNT(*) as cp_count,
    ROUND(MAX(s.dur) / 1e6, 1) as max_cp_ms
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN main_thread mt ON tt.utid = mt.utid
  JOIN startup_info si
  WHERE s.name GLOB '*contentProviderCreate*'
    AND s.ts >= si.ts AND s.ts < si.ts + si.dur
    AND EXISTS (
      SELECT 1 FROM slice ba
      JOIN thread_track tt2 ON ba.track_id = tt2.id
      JOIN main_thread mt2 ON tt2.utid = mt2.utid
      WHERE ba.name = 'bindApplication'
        AND ba.ts >= si.ts AND ba.ts < si.ts + si.dur
    )
) WHERE cp_count > 3

-- SR10: 主线程 futex 等待
UNION ALL
SELECT 'SR10',
  CASE WHEN in_bind_app = 1 AND no_lock_slice = 1
       THEN '主线程 futex 等待（疑似 SharedPreferences 阻塞，发生在 bindApplication 阶段且无 Lock contention slice）'
       ELSE '主线程 futex 等待（通用锁/同步阻塞，非 SP 特征）'
  END,
  CASE WHEN futex_ms > 50 THEN 'critical'
       WHEN futex_ms > 10 THEN 'warning' ELSE 'info' END,
  '主线程 futex_wait 总耗时 ' || futex_ms || ' ms (' || futex_count || ' 次)'
    || CASE WHEN in_bind_app = 1 THEN ', 在 bindApplication 阶段' ELSE '' END,
  CASE WHEN in_bind_app = 1 AND no_lock_slice = 1
       THEN '迁移到 Jetpack DataStore; 拆分大 SP 文件; 避免启动时同步读取 SP'
       ELSE '检查 blocked_functions 和 Lock contention slice 定位具体锁; 参考 SR04'
  END
FROM (
  SELECT
    COUNT(*) as futex_count,
    ROUND(SUM(ts_inner.dur) / 1e6, 1) as futex_ms,
    CASE WHEN SUM(CASE WHEN EXISTS (
      SELECT 1 FROM slice ba
      JOIN thread_track tt2 ON ba.track_id = tt2.id
      JOIN main_thread mt2 ON tt2.utid = mt2.utid
      WHERE ba.name = 'bindApplication'
        AND ba.ts >= si.ts AND ba.ts < si.ts + si.dur
        AND ts_inner.ts >= ba.ts AND ts_inner.ts < ba.ts + ba.dur
    ) THEN ts_inner.dur ELSE 0 END) > SUM(ts_inner.dur) / 2 THEN 1 ELSE 0 END as in_bind_app,
    CASE WHEN SUM(CASE WHEN EXISTS (
      SELECT 1 FROM slice lc
      JOIN thread_track tt3 ON lc.track_id = tt3.id
      JOIN main_thread mt3 ON tt3.utid = mt3.utid
      WHERE (lc.name GLOB '*Lock contention*' OR lc.name GLOB '*monitor contention*')
        AND lc.ts < ts_inner.ts + ts_inner.dur
        AND lc.ts + lc.dur > ts_inner.ts
    ) THEN ts_inner.dur ELSE 0 END) < SUM(ts_inner.dur) / 2 THEN 1 ELSE 0 END as no_lock_slice
  FROM thread_state ts_inner
  JOIN main_thread mt ON ts_inner.utid = mt.utid
  JOIN startup_info si
  WHERE ts_inner.state = 'S'
    AND ts_inner.blocked_function GLOB '*futex_wait*'
    AND ts_inner.ts >= si.ts AND ts_inner.ts < si.ts + si.dur
    AND ts_inner.dur > 1000000
) WHERE futex_ms > 5

-- SR11: 主线程显式 sleep/delay
UNION ALL
SELECT 'SR11', '主线程存在显式 sleep/delay',
  CASE WHEN sleep_ms > 100 THEN 'critical'
       WHEN sleep_ms > 10 THEN 'warning' ELSE 'info' END,
  '主线程 nanosleep 总耗时 ' || sleep_ms || ' ms (' || sleep_count || ' 次)',
  '删除 Thread.sleep(); 替换为事件驱动等待'
FROM (
  SELECT
    COUNT(*) as sleep_count,
    ROUND(SUM(ts_inner.dur) / 1e6, 1) as sleep_ms
  FROM thread_state ts_inner
  JOIN main_thread mt ON ts_inner.utid = mt.utid
  JOIN startup_info si
  WHERE ts_inner.state = 'S'
    AND ts_inner.blocked_function GLOB '*nanosleep*'
    AND ts_inner.ts >= si.ts AND ts_inner.ts < si.ts + si.dur
) WHERE sleep_ms > 1

-- SR12: 三方 SDK 初始化开销 (仅冷启动)
UNION ALL
SELECT 'SR12', 'bindApplication 阶段非框架 slice 占比高（疑似三方 SDK 初始化过重）',
  CASE WHEN non_fw_percent > 60 THEN 'critical'
       WHEN non_fw_percent > 30 THEN 'warning' ELSE 'info' END,
  '非框架 slice 占 bindApplication ' || non_fw_percent || '%, 总耗时 ' || non_fw_ms || ' ms',
  '延迟非关键 SDK 初始化至首帧后; 使用 App Startup 库管理初始化顺序'
FROM (
  SELECT
    ROUND(SUM(CASE WHEN s.name NOT GLOB 'bindApplication*'
                   AND s.name NOT GLOB 'contentProviderCreate*'
                   AND s.name NOT GLOB 'Application.onCreate*'
                   AND s.name NOT GLOB 'OpenDexFilesFromOat*'
                   AND s.name NOT GLOB 'VerifyClass*'
                   AND s.name NOT GLOB 'JIT compiling*'
              THEN s.dur ELSE 0 END) / 1e6, 1) as non_fw_ms,
    ROUND(100.0 * SUM(CASE WHEN s.name NOT GLOB 'bindApplication*'
                   AND s.name NOT GLOB 'contentProviderCreate*'
                   AND s.name NOT GLOB 'Application.onCreate*'
                   AND s.name NOT GLOB 'OpenDexFilesFromOat*'
                   AND s.name NOT GLOB 'VerifyClass*'
                   AND s.name NOT GLOB 'JIT compiling*'
              THEN s.dur ELSE 0 END)
      / MAX(1, ba.dur), 1) as non_fw_percent
  FROM slice ba
  JOIN thread_track tt_ba ON ba.track_id = tt_ba.id
  JOIN main_thread mt_ba ON tt_ba.utid = mt_ba.utid
  JOIN startup_info si ON ba.ts >= si.ts AND ba.ts < si.ts + si.dur
  JOIN slice s ON s.track_id = ba.track_id
    AND s.ts >= ba.ts AND s.ts < ba.ts + ba.dur
    AND s.dur > 5000000
    AND s.depth = ba.depth + 1  -- 仅直接子 slice，避免嵌套双算
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN main_thread mt ON tt.utid = mt.utid
  WHERE ba.name = 'bindApplication'
) WHERE non_fw_percent > 30

-- SR13: Native 库加载开销
UNION ALL
SELECT 'SR13', 'Native 库加载耗时显著',
  CASE WHEN dlopen_ms > 200 THEN 'critical'
       WHEN dlopen_ms > 50 THEN 'warning' ELSE 'info' END,
  dlopen_count || ' 个 .so 加载, 总耗时 ' || dlopen_ms || ' ms, 最大单个 ' || max_dlopen_ms || ' ms',
  '延迟加载非关键 native 库; 减小 .so 体积; 使用 linker namespace 优化'
FROM (
  SELECT
    COUNT(*) as dlopen_count,
    ROUND(SUM(s.dur) / 1e6, 1) as dlopen_ms,
    ROUND(MAX(s.dur) / 1e6, 1) as max_dlopen_ms
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN thread t ON tt.utid = t.utid
  JOIN startup_info si ON t.upid = si.upid
  WHERE s.name GLOB 'dlopen:*'
    AND s.ts >= si.ts AND s.ts < si.ts + si.dur
) WHERE dlopen_ms > 30

-- SR14: WebView 初始化
UNION ALL
SELECT 'SR14', 'WebView 初始化在启动路径中',
  CASE WHEN wv_ms > 300 THEN 'critical'
       WHEN wv_ms > 100 THEN 'warning' ELSE 'info' END,
  'WebView 相关 slice 总耗时 ' || wv_ms || ' ms',
  '延迟 WebView 初始化到首次使用时; 使用 WebView 预热 (Android 12+)'
FROM (
  SELECT
    ROUND(SUM(s.dur) / 1e6, 1) as wv_ms
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN thread t ON tt.utid = t.utid
  JOIN startup_info si ON t.upid = si.upid
  WHERE (s.name GLOB '*WebView*' OR s.name GLOB '*webview*'
         OR s.name GLOB 'dlopen:*webview*' OR s.name GLOB 'dlopen:*chromium*')
    AND s.ts >= si.ts AND s.ts < si.ts + si.dur
) WHERE wv_ms > 50

-- SR15: Layout Inflation 过重
UNION ALL
SELECT 'SR15', '布局膨胀(inflate)耗时过长',
  CASE WHEN inflate_ms > 450 THEN 'critical'
       WHEN inflate_ms > 200 THEN 'warning' ELSE 'info' END,
  'inflate 总耗时 ' || inflate_ms || ' ms',
  '使用 ViewStub 延迟非首屏 View; 减少布局嵌套; 考虑 AsyncLayoutInflater'
FROM (
  SELECT
    ROUND(SUM(s.dur) / 1e6, 1) as inflate_ms
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN main_thread mt ON tt.utid = mt.utid
  JOIN startup_info si
  WHERE s.name GLOB 'inflate*'
    AND s.ts >= si.ts AND s.ts < si.ts + si.dur
) WHERE inflate_ms > 100

-- SR16: 热节流（按 CPU 分组比较同一 CPU 的 startup max vs global max）
UNION ALL
SELECT 'SR16', 'CPU 热节流（CPU' || throttled_cpu || ' 启动期间频率仅达峰值 ' || min_pct || '%）',
  CASE WHEN min_pct < 70 THEN 'critical'
       WHEN min_pct < 90 THEN 'warning' ELSE 'info' END,
  'CPU' || throttled_cpu || ': 启动期间最高 ' || startup_freq || ' KHz, 全局峰值 ' || global_freq || ' KHz (' || min_pct || '%)',
  '设备可能过热; 冷却后重测对比; 检查 thermal governor 参数'
FROM (
  SELECT
    per_cpu.cpu as throttled_cpu,
    per_cpu.startup_max as startup_freq,
    per_cpu.global_max as global_freq,
    CAST(ROUND(100.0 * per_cpu.startup_max / MAX(1, per_cpu.global_max)) AS INTEGER) as min_pct
  FROM (
    SELECT ct.cpu,
      MAX(CASE WHEN c.ts >= si.ts AND c.ts < si.ts + si.dur THEN c.value ELSE 0 END) as startup_max,
      MAX(c.value) as global_max
    FROM counter c
    JOIN cpu_counter_track ct ON c.track_id = ct.id
    CROSS JOIN startup_info si
    WHERE ct.name = 'cpufreq'
    GROUP BY ct.cpu
    HAVING global_max > 0 AND startup_max > 0
  ) per_cpu
  ORDER BY 100.0 * per_cpu.startup_max / MAX(1, per_cpu.global_max) ASC
  LIMIT 1
) WHERE min_pct < 90

-- SR17: 后台进程干扰（Runnable 占比过高）
UNION ALL
SELECT 'SR17', '主线程调度延迟过高（后台进程干扰）',
  CASE WHEN runnable_pct > 15 THEN 'critical'
       WHEN runnable_pct > 10 THEN 'warning' ELSE 'info' END,
  '主线程 Runnable 状态占比 ' || runnable_pct || '% (' || runnable_ms || ' ms)',
  '清理后台进程后重测; 检查同期运行的后台 job/service'
FROM (
  SELECT
    ROUND(SUM(
      MIN(ts_inner.ts + ts_inner.dur, si.ts + si.dur)
      - MAX(ts_inner.ts, si.ts)
    ) / 1e6, 1) as runnable_ms,
    CAST(ROUND(100.0 * SUM(
      MIN(ts_inner.ts + ts_inner.dur, si.ts + si.dur)
      - MAX(ts_inner.ts, si.ts)
    ) / (SELECT dur FROM startup_info)) AS INTEGER) as runnable_pct
  FROM thread_state ts_inner
  JOIN main_thread mt ON ts_inner.utid = mt.utid
  JOIN startup_info si
  WHERE ts_inner.state IN ('R', 'R+')
    AND ts_inner.ts < si.ts + si.dur
    AND ts_inner.ts + ts_inner.dur > si.ts
) WHERE runnable_pct > 10

-- SR18: system_server 锁竞争影响 app 启动
UNION ALL
SELECT 'SR18', 'system_server 锁竞争影响 app 的 Binder 调用',
  CASE WHEN ss_lock_ms > 100 THEN 'critical'
       WHEN ss_lock_ms > 20 THEN 'warning' ELSE 'info' END,
  ss_lock_count || ' 次锁竞争与 app Binder 调用重叠, 总耗时 ' || ss_lock_ms || ' ms, 最大 ' || ss_max_ms || ' ms',
  '检查 system_server WMS/AMS 锁竞争; 减少启动期间的同步系统调用'
FROM (
  SELECT
    COUNT(*) as ss_lock_count,
    ROUND(SUM(lc.dur) / 1e6, 1) as ss_lock_ms,
    ROUND(MAX(lc.dur) / 1e6, 1) as ss_max_ms
  FROM slice lc
  JOIN thread_track tt ON lc.track_id = tt.id
  JOIN thread t ON tt.utid = t.utid
  JOIN process p ON t.upid = p.upid
  JOIN startup_info si
  WHERE p.name = 'system_server'
    AND (lc.name GLOB 'Lock contention*' OR lc.name GLOB 'monitor contention*')
    AND lc.ts >= si.ts AND lc.ts < si.ts + si.dur
    AND lc.dur > 1000000
    -- 因果链：锁竞争必须与 app 主线程的 binder S 状态时间重叠
    AND EXISTS (
      SELECT 1 FROM thread_state binder_wait
      JOIN main_thread mt ON binder_wait.utid = mt.utid
      WHERE binder_wait.state = 'S'
        AND binder_wait.blocked_function GLOB '*binder*'
        AND binder_wait.ts < lc.ts + lc.dur
        AND binder_wait.ts + binder_wait.dur > lc.ts
    )
) WHERE ss_lock_ms > 10

-- SR19: 并发启动
UNION ALL
SELECT 'SR19', '并发应用启动干扰',
  CASE WHEN other_start_count > 3 THEN 'critical'
       WHEN other_start_count > 1 THEN 'warning' ELSE 'info' END,
  '启动窗口 ±5s 内有 ' || other_start_count || ' 个其他进程 fork',
  '检查是否为 boot storm 场景; 延迟非关键应用启动'
FROM (
  SELECT COUNT(DISTINCT p2.name) as other_start_count
  FROM process p2
  JOIN startup_info si
  WHERE p2.start_ts IS NOT NULL
    AND p2.start_ts >= si.ts - 5000000000
    AND p2.start_ts <= si.ts + si.dur + 5000000000
    AND p2.name NOT GLOB (si.package || '*')
    AND p2.name != 'system_server'
    AND p2.name != 'Zygote'
    AND p2.name NOT GLOB 'zygote*'
    AND p2.name NOT GLOB '*:*'
    AND p2.pid > 1000
) WHERE other_start_count > 1

-- SR20: 数据库 IO
UNION ALL
SELECT 'SR20', '主线程 fsync/数据库 IO 阻塞',
  CASE WHEN fsync_ms > 50 THEN 'critical'
       WHEN fsync_ms > 10 THEN 'warning' ELSE 'info' END,
  '主线程 fsync 相关 D 状态 ' || fsync_ms || ' ms (' || fsync_count || ' 次)',
  '数据库初始化必须异步; 检查 Room migration 或 SP commit 是否在主线程'
FROM (
  SELECT
    COUNT(*) as fsync_count,
    ROUND(SUM(ts_inner.dur) / 1e6, 1) as fsync_ms
  FROM thread_state ts_inner
  JOIN main_thread mt ON ts_inner.utid = mt.utid
  JOIN startup_info si
  WHERE ts_inner.state IN ('D', 'DK')
    AND (ts_inner.blocked_function GLOB '*fsync*'
         OR ts_inner.blocked_function GLOB '*sqlite*')
    AND ts_inner.ts >= si.ts AND ts_inner.ts < si.ts + si.dur
) WHERE fsync_ms > 5

ORDER BY
  CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END
```

### 6.2 startup_gc_in_range — 启动 GC 分析 (区间)

**描述：** 统计启动阶段 GC 相关切片及主线程占比。

**依赖模块：** `android.startup.startups`

**输入参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `package` | string | 否 | | 应用包名 |
| `startup_id` | integer | 否 | | 启动事件 ID |
| `start_ts` | timestamp | 否 | | 区间开始时间 |
| `end_ts` | timestamp | 否 | | 区间结束时间 |
| `top_k` | integer | 否 | 10 | 返回 Top N |

**输出列：**

| 列名 | 类型 | 说明 |
|------|------|------|
| `gc_type` | string | GC 类型/slice 名 |
| `thread_name` | string | 线程名 |
| `is_main_thread` | boolean | 是否主线程 |
| `count` | number | 次数 |
| `total_dur_ms` | duration | 总耗时 (ms) |
| `avg_dur_ms` | duration | 平均耗时 (ms) |
| `percent_of_startup` | percentage | 启动占比 |

**SQL：**

```sql
SELECT
  ts.slice_name as gc_type,
  ts.thread_name,
  ts.is_main_thread,
  COUNT(*) as count,
  SUM(ts.slice_dur) / 1e6 as total_dur_ms,
  ROUND(AVG(ts.slice_dur) / 1e6, 2) as avg_dur_ms,
  ROUND(100.0 * SUM(ts.slice_dur) / s.dur, 1) as percent_of_startup
FROM android_thread_slices_for_all_startups ts
JOIN android_startups s ON ts.startup_id = s.startup_id
WHERE (s.package GLOB '<package>*' OR '<package>' = '')
  AND (<startup_id> IS NULL OR s.startup_id = <startup_id>)
  AND (<start_ts> IS NULL OR s.ts >= <start_ts>)
  AND (<end_ts> IS NULL OR s.ts + s.dur <= <end_ts>)
  AND (ts.slice_name GLOB '*GC*' OR ts.slice_name GLOB '*gc*')
GROUP BY ts.slice_name, ts.is_main_thread
ORDER BY total_dur_ms DESC
LIMIT <top_k>
```

### 6.3 startup_class_loading_in_range — 启动类加载分析 (区间)

**描述：** 统计启动阶段类加载切片耗时，基于 `android_class_loading_for_startup` 表。

**依赖模块：** `android.startup.startups`

**输入参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `package` | string | 否 | | 应用包名 |
| `startup_id` | integer | 否 | | 启动事件 ID |
| `start_ts` | timestamp | 否 | | 区间开始时间 |
| `end_ts` | timestamp | 否 | | 区间结束时间 |
| `top_k` | integer | 否 | 10 | 返回 Top N |

**SQL：**

```sql
SELECT
  cl.slice_name,
  cl.thread_name,
  COUNT(*) as count,
  SUM(cl.slice_dur) / 1e6 as total_dur_ms,
  ROUND(AVG(cl.slice_dur) / 1e6, 2) as avg_dur_ms,
  '<startup_type>' as startup_type,
  ROUND(100.0 * SUM(cl.slice_dur) / s.dur, 1) as percent_of_startup
FROM android_class_loading_for_startup cl
JOIN android_startups s ON cl.startup_id = s.startup_id
WHERE (s.package GLOB '<package>*' OR '<package>' = '')
  AND (<startup_id> IS NULL OR s.startup_id = <startup_id>)
  AND (<start_ts> IS NULL OR s.ts >= <start_ts>)
  AND (<end_ts> IS NULL OR s.ts + s.dur <= <end_ts>)
GROUP BY cl.slice_name
ORDER BY total_dur_ms DESC
LIMIT <top_k>
```

### 6.4 startup_jit_analysis — 启动 JIT 影响分析

**描述：** 分析 JIT 编译线程对启动速度的影响。JIT 影响启动的三个机制：(1) JIT 编译与主线程争抢 CPU（特别是大核）；(2) JIT Code Cache 接近上限时触发 GarbageCollectCache；(3) 缺少 Baseline Profile 时冷启动前期代码走解释器。

**依赖模块：** `sched`

**输入参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `package` | string | 是 | 应用包名 |
| `start_ts` | timestamp | 是 | 区间开始时间 |
| `end_ts` | timestamp | 是 | 区间结束时间 |

**SQL：**

```sql
WITH jit_threads AS (
  SELECT t.utid, t.name as thread_name
  FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<package>*'
    AND (t.name GLOB 'Jit thread pool*'
         OR t.name GLOB 'Profile Saver*')
),
main_thread AS (
  SELECT t.utid
  FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<package>*' AND t.tid = p.pid
  LIMIT 1
),
-- JIT 线程的 CPU 时间和核类型
jit_cpu AS (
  SELECT
    COALESCE(ct.core_type, 'unknown') as core_type,
    SUM(MIN(ss.ts + ss.dur, <end_ts>) - MAX(ss.ts, <start_ts>)) / 1e6 as running_ms
  FROM sched_slice ss
  JOIN jit_threads jt ON ss.utid = jt.utid
  LEFT JOIN _cpu_topology ct ON ss.cpu = ct.cpu_id
  WHERE ss.ts < <end_ts> AND ss.ts + ss.dur > <start_ts>
  GROUP BY core_type
),
-- JIT slice 分析
jit_slices AS (
  SELECT
    CASE
      WHEN s.name GLOB 'JIT compiling*' THEN 'jit_compile'
      WHEN s.name GLOB '*GarbageCollectCache*' THEN 'code_cache_gc'
      WHEN s.name GLOB '*ScopedCodeCacheWrite*' THEN 'code_cache_write'
      WHEN s.name GLOB 'JitProfileTask*' THEN 'profile_task'
      ELSE 'other_jit'
    END as jit_activity,
    COUNT(*) as event_count,
    SUM(s.dur) / 1e6 as total_ms,
    MAX(s.dur) / 1e6 as max_ms
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN jit_threads jt ON tt.utid = jt.utid
  WHERE s.ts >= <start_ts> AND s.ts < <end_ts>
    AND s.dur > 0
  GROUP BY jit_activity
),
summary AS (
  SELECT
    ROUND(COALESCE((SELECT SUM(running_ms) FROM jit_cpu), 0), 1) as jit_total_cpu_ms,
    ROUND(COALESCE((SELECT SUM(running_ms) FROM jit_cpu WHERE core_type IN ('prime', 'big', 'medium')), 0), 1) as jit_big_core_ms,
    ROUND(COALESCE((SELECT SUM(running_ms) FROM jit_cpu WHERE core_type = 'little'), 0), 1) as jit_little_core_ms,
    COALESCE((SELECT event_count FROM jit_slices WHERE jit_activity = 'jit_compile'), 0) as compile_count,
    ROUND(COALESCE((SELECT total_ms FROM jit_slices WHERE jit_activity = 'jit_compile'), 0), 1) as compile_total_ms,
    COALESCE((SELECT event_count FROM jit_slices WHERE jit_activity = 'code_cache_gc'), 0) as code_cache_gc_count,
    ROUND(COALESCE((SELECT total_ms FROM jit_slices WHERE jit_activity = 'code_cache_gc'), 0), 1) as code_cache_gc_ms
)
SELECT 'JIT 总 CPU 时间' as metric,
  ROUND(jit_total_cpu_ms, 1) || ' ms' as value,
  CASE
    WHEN jit_total_cpu_ms > 50 THEN '偏高：JIT 线程占用大量 CPU，建议使用 Baseline Profile'
    WHEN jit_total_cpu_ms > 20 THEN '中等：有一定 JIT 编译活动'
    WHEN jit_total_cpu_ms > 0 THEN '正常'
    ELSE '无 JIT 活动（可能已 AOT 编译）'
  END as assessment
FROM summary
UNION ALL
SELECT 'JIT 大核 CPU 时间' as metric,
  ROUND(jit_big_core_ms, 1) || ' ms (' ||
    ROUND(100.0 * jit_big_core_ms / NULLIF(jit_total_cpu_ms, 0), 0) || '%)' as value,
  CASE
    WHEN jit_big_core_ms > 30 THEN 'JIT 线程占用大量大核时间，可能与主线程争抢'
    WHEN jit_big_core_ms > 10 THEN '有一定大核竞争'
    ELSE '正常'
  END as assessment
FROM summary
UNION ALL
SELECT 'JIT 编译次数' as metric,
  compile_count || ' 次 (' || ROUND(compile_total_ms, 1) || ' ms)' as value,
  CASE
    WHEN compile_count > 50 THEN '大量 JIT 编译，Baseline Profile 覆盖不足'
    WHEN compile_count > 20 THEN '中等数量 JIT 编译'
    WHEN compile_count > 0 THEN '少量 JIT 编译'
    ELSE '无 JIT 编译'
  END as assessment
FROM summary
UNION ALL
SELECT 'Code Cache GC' as metric,
  code_cache_gc_count || ' 次 (' || ROUND(code_cache_gc_ms, 1) || ' ms)' as value,
  CASE
    WHEN code_cache_gc_count > 0 THEN '触发 Code Cache GC，可能影响启动性能'
    ELSE '未触发'
  END as assessment
FROM summary
```

### 6.5 memory_pressure_in_range — 内存压力分析

**描述：** 分析指定时间范围内的内存压力指标：PSI、kswapd 活动、直接回收、内存压缩、LMK 事件、分配阻塞、Page Cache 活动。计算综合压力分数 (0-100)。

**输入参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `start_ts` | number | 是 | 开始时间戳 (ns) |
| `end_ts` | number | 是 | 结束时间戳 (ns) |
| `package` | string | 否 | 包名过滤 |

**输出列：**

| 列名 | 类型 | 说明 |
|------|------|------|
| `pressure_level` | string | 综合压力等级 (none/low/moderate/high/critical) |
| `pressure_score` | number | 综合压力分数 (0-100) |
| `kswapd_events` | number | kswapd 活动次数 |
| `kswapd_total_ms` | duration | kswapd 总活动时间 (ms) |
| `kswapd_max_ms` | duration | kswapd 最大活动时间 (ms) |
| `direct_reclaim_events` | number | 直接回收次数 |
| `direct_reclaim_total_ms` | duration | 直接回收总时间 (ms) |
| `direct_reclaim_max_ms` | duration | 直接回收最大时间 (ms) |
| `compaction_events` | number | 内存压缩次数 |
| `lmk_events` | number | LMK (Low Memory Killer) 事件数 |
| `alloc_stall_events` | number | 分配阻塞次数 |
| `page_cache_add_events` | number | Page Cache 加入次数 (cache miss) |
| `page_cache_delete_events` | number | Page Cache 驱逐次数 (memory pressure) |

**SQL：**

```sql
WITH params AS (
  SELECT
    <start_ts> AS start_ts,
    <end_ts> AS end_ts,
    '<package>' AS package_filter
),
psi_memory AS (
  SELECT
    'psi_memory' AS source,
    c.ts, c.value, t.name AS metric_name
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  CROSS JOIN params p
  WHERE (t.name LIKE 'mem.%psi%' OR t.name LIKE '%memory_pressure%')
    AND c.ts >= p.start_ts AND c.ts <= p.end_ts
),
psi_summary AS (
  SELECT MAX(value) AS max_psi_value, AVG(value) AS avg_psi_value,
         COUNT(*) AS psi_sample_count
  FROM psi_memory
),
kswapd_slices AS (
  SELECT s.ts, s.dur, s.name
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN thread t ON tt.utid = t.utid
  CROSS JOIN params p
  WHERE t.name LIKE 'kswapd%'
    AND s.ts >= p.start_ts AND s.ts <= p.end_ts AND s.dur > 0
),
kswapd_summary AS (
  SELECT COUNT(*) AS kswapd_event_count,
    COALESCE(SUM(dur), 0) AS kswapd_total_dur_ns,
    COALESCE(MAX(dur), 0) AS kswapd_max_dur_ns
  FROM kswapd_slices
),
direct_reclaim AS (
  SELECT s.ts, s.dur, s.name, t.name AS thread_name
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN thread t ON tt.utid = t.utid
  CROSS JOIN params p
  WHERE (s.name LIKE '%direct_reclaim%' OR s.name LIKE '%reclaim%alloc%')
    AND s.ts >= p.start_ts AND s.ts <= p.end_ts
),
direct_reclaim_summary AS (
  SELECT COUNT(*) AS direct_reclaim_count,
    COALESCE(SUM(dur), 0) AS direct_reclaim_total_ns,
    COALESCE(MAX(dur), 0) AS direct_reclaim_max_ns
  FROM direct_reclaim
),
compaction_summary AS (
  SELECT COUNT(*) AS compaction_count,
    COALESCE(SUM(dur), 0) AS compaction_total_ns
  FROM slice s CROSS JOIN params p
  WHERE s.name LIKE '%compact%' AND s.ts >= p.start_ts AND s.ts <= p.end_ts
),
lmk_summary AS (
  SELECT COUNT(*) AS lmk_event_count
  FROM slice CROSS JOIN params p
  WHERE (name LIKE '%lowmemory%' OR name LIKE '%lmkd%' OR name LIKE '%oom_adj%')
    AND ts >= p.start_ts AND ts <= p.end_ts
),
alloc_stall_summary AS (
  SELECT COUNT(*) AS alloc_stall_count,
    COALESCE(MAX(dur), 0) AS alloc_stall_max_ns
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  CROSS JOIN params p
  WHERE (s.name LIKE '%alloc_pages%' OR s.name LIKE '%page_alloc%')
    AND s.dur > 1000000 AND s.ts >= p.start_ts AND s.ts <= p.end_ts
),
page_cache_adds AS (
  SELECT COUNT(*) AS add_count
  FROM raw r CROSS JOIN params p
  WHERE r.name = 'mm_filemap_add_to_page_cache'
    AND r.ts >= p.start_ts AND r.ts <= p.end_ts
),
page_cache_deletes AS (
  SELECT COUNT(*) AS delete_count
  FROM raw r CROSS JOIN params p
  WHERE r.name = 'mm_filemap_delete_from_page_cache'
    AND r.ts >= p.start_ts AND r.ts <= p.end_ts
),
pressure_score AS (
  SELECT
    CASE WHEN (SELECT kswapd_event_count FROM kswapd_summary) > 10 THEN 30
         WHEN (SELECT kswapd_event_count FROM kswapd_summary) > 3 THEN 15
         WHEN (SELECT kswapd_event_count FROM kswapd_summary) > 0 THEN 5
         ELSE 0 END +
    CASE WHEN (SELECT direct_reclaim_count FROM direct_reclaim_summary) > 5 THEN 40
         WHEN (SELECT direct_reclaim_count FROM direct_reclaim_summary) > 1 THEN 20
         WHEN (SELECT direct_reclaim_count FROM direct_reclaim_summary) > 0 THEN 10
         ELSE 0 END +
    CASE WHEN (SELECT lmk_event_count FROM lmk_summary) > 0 THEN 30 ELSE 0 END +
    CASE WHEN (SELECT alloc_stall_count FROM alloc_stall_summary) > 3 THEN 20
         WHEN (SELECT alloc_stall_count FROM alloc_stall_summary) > 0 THEN 10
         ELSE 0 END +
    CASE WHEN (SELECT delete_count FROM page_cache_deletes) > 100 THEN 15
         WHEN (SELECT delete_count FROM page_cache_deletes) > 10 THEN 5
         ELSE 0 END AS score
)
SELECT
  (SELECT kswapd_event_count FROM kswapd_summary) AS kswapd_events,
  ROUND((SELECT kswapd_total_dur_ns FROM kswapd_summary) / 1e6, 2) AS kswapd_total_ms,
  ROUND((SELECT kswapd_max_dur_ns FROM kswapd_summary) / 1e6, 2) AS kswapd_max_ms,
  (SELECT direct_reclaim_count FROM direct_reclaim_summary) AS direct_reclaim_events,
  ROUND((SELECT direct_reclaim_total_ns FROM direct_reclaim_summary) / 1e6, 2) AS direct_reclaim_total_ms,
  ROUND((SELECT direct_reclaim_max_ns FROM direct_reclaim_summary) / 1e6, 2) AS direct_reclaim_max_ms,
  (SELECT compaction_count FROM compaction_summary) AS compaction_events,
  ROUND((SELECT compaction_total_ns FROM compaction_summary) / 1e6, 2) AS compaction_total_ms,
  (SELECT lmk_event_count FROM lmk_summary) AS lmk_events,
  (SELECT alloc_stall_count FROM alloc_stall_summary) AS alloc_stall_events,
  ROUND((SELECT alloc_stall_max_ns FROM alloc_stall_summary) / 1e6, 2) AS alloc_stall_max_ms,
  (SELECT add_count FROM page_cache_adds) AS page_cache_add_events,
  (SELECT delete_count FROM page_cache_deletes) AS page_cache_delete_events,
  (SELECT max_psi_value FROM psi_summary) AS psi_max,
  (SELECT avg_psi_value FROM psi_summary) AS psi_avg,
  (SELECT score FROM pressure_score) AS pressure_score,
  CASE
    WHEN (SELECT score FROM pressure_score) >= 70 THEN 'critical'
    WHEN (SELECT score FROM pressure_score) >= 40 THEN 'high'
    WHEN (SELECT score FROM pressure_score) >= 15 THEN 'moderate'
    WHEN (SELECT score FROM pressure_score) > 0 THEN 'low'
    ELSE 'none'
  END AS pressure_level,
  (SELECT end_ts - start_ts FROM params) / 1e6 AS range_duration_ms
```

---

## 7. Composite Skill 内联 SQL（startup_detail 独有）

### 7.1 大小核占比分析

**描述：** 分析启动期间主线程在大核 (prime/big/medium) vs 小核 (little) 上的运行时间分布。

```sql
WITH main_thread AS (
  SELECT t.utid, t.tid, t.name as thread_name, p.pid, p.name as process_name
  FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<package>*'
    AND t.tid = p.pid
),
cpu_time AS (
  SELECT
    ss.utid, ss.cpu,
    SUM(MIN(ss.ts + ss.dur, <end_ts>) - MAX(ss.ts, <start_ts>)) / 1e6 as dur_ms,
    COALESCE(ct.core_type, 'unknown') as core_type
  FROM sched_slice ss
  JOIN main_thread mt ON ss.utid = mt.utid
  LEFT JOIN _cpu_topology ct ON ss.cpu = ct.cpu_id
  WHERE ss.ts < <end_ts> AND ss.ts + ss.dur > <start_ts>
  GROUP BY ss.utid, ss.cpu
)
SELECT
  'MainThread' as thread_type,
  ROUND(SUM(CASE WHEN core_type IN ('prime', 'big', 'medium') THEN dur_ms ELSE 0 END), 2) as big_core_ms,
  ROUND(SUM(CASE WHEN core_type IN ('little') THEN dur_ms ELSE 0 END), 2) as little_core_ms,
  ROUND(SUM(dur_ms), 2) as total_running_ms,
  ROUND(100.0 * SUM(CASE WHEN core_type IN ('prime', 'big', 'medium') THEN dur_ms ELSE 0 END) /
        NULLIF(SUM(dur_ms), 0), 1) as big_core_pct,
  ROUND(100.0 * SUM(CASE WHEN core_type IN ('little') THEN dur_ms ELSE 0 END) /
        NULLIF(SUM(dur_ms), 0), 1) as little_core_pct,
  GROUP_CONCAT(DISTINCT cpu) as used_cpus,
  'topology_view' as classify_method
FROM cpu_time
GROUP BY 1
```

### 7.2 四大象限分析

**描述：** 分析主线程在启动期间的四象限状态分布（Q1 大核运行 / Q2 小核运行 / Q3 可运行等待 / Q4a IO 阻塞 / Q4b 睡眠等待）。

```sql
WITH main_thread AS (
  SELECT t.utid, t.tid, t.name as thread_name, p.pid, p.name as process_name
  FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE p.name GLOB '<package>*'
    AND t.tid = p.pid
),
thread_states AS (
  SELECT
    ts.utid, ts.state, ts.cpu,
    COALESCE(ct.core_type, 'unknown') as core_type,
    SUM(MIN(ts.ts + ts.dur, <end_ts>) - MAX(ts.ts, <start_ts>)) / 1e6 as dur_ms
  FROM thread_state ts
  JOIN main_thread mt ON ts.utid = mt.utid
  LEFT JOIN _cpu_topology ct ON ts.cpu = ct.cpu_id
  WHERE ts.ts < <end_ts> AND ts.ts + ts.dur > <start_ts>
  GROUP BY ts.utid, ts.state, ts.cpu
),
quadrant_data AS (
  SELECT
    CASE
      WHEN state = 'Running' AND core_type IN ('prime', 'big', 'medium') THEN 'Q1_big_running'
      WHEN state = 'Running' AND core_type IN ('little') THEN 'Q2_little_running'
      WHEN state IN ('R', 'R+') THEN 'Q3_runnable'
      WHEN state IN ('D', 'DK') THEN 'Q4a_io_blocked'
      WHEN state IN ('S', 'I') THEN 'Q4b_sleeping'
      ELSE 'other'
    END as quadrant,
    dur_ms
  FROM thread_states
)
SELECT
  'MainThread' as thread_type,
  ROUND(SUM(CASE WHEN quadrant = 'Q1_big_running' THEN dur_ms ELSE 0 END), 2) as q1_big_running_ms,
  ROUND(SUM(CASE WHEN quadrant = 'Q2_little_running' THEN dur_ms ELSE 0 END), 2) as q2_little_running_ms,
  ROUND(SUM(CASE WHEN quadrant = 'Q3_runnable' THEN dur_ms ELSE 0 END), 2) as q3_runnable_ms,
  ROUND(SUM(CASE WHEN quadrant = 'Q4a_io_blocked' THEN dur_ms ELSE 0 END), 2) as q4a_io_blocked_ms,
  ROUND(SUM(CASE WHEN quadrant = 'Q4b_sleeping' THEN dur_ms ELSE 0 END), 2) as q4b_sleeping_ms,
  ROUND(SUM(dur_ms), 2) as total_ms,
  ROUND(100.0 * SUM(CASE WHEN quadrant = 'Q1_big_running' THEN dur_ms ELSE 0 END) /
        NULLIF(SUM(dur_ms), 0), 1) as q1_pct,
  ROUND(100.0 * SUM(CASE WHEN quadrant = 'Q2_little_running' THEN dur_ms ELSE 0 END) /
        NULLIF(SUM(dur_ms), 0), 1) as q2_pct,
  ROUND(100.0 * SUM(CASE WHEN quadrant = 'Q3_runnable' THEN dur_ms ELSE 0 END) /
        NULLIF(SUM(dur_ms), 0), 1) as q3_pct,
  ROUND(100.0 * SUM(CASE WHEN quadrant = 'Q4a_io_blocked' THEN dur_ms ELSE 0 END) /
        NULLIF(SUM(dur_ms), 0), 1) as q4a_pct,
  ROUND(100.0 * SUM(CASE WHEN quadrant = 'Q4b_sleeping' THEN dur_ms ELSE 0 END) /
        NULLIF(SUM(dur_ms), 0), 1) as q4b_pct,
  'topology_view' as classify_method
FROM quadrant_data
GROUP BY 1
```

### 7.3 主线程可操作热点（剔除框架包裹切片，含 exclusive time）

**描述：** 找出主线程上真正可操作的热点 slice（剔除如 `clientTransactionExecuted`、`activityStart`、`bindApplication` 等框架包裹切片），按 self time（exclusive time）排序。

```sql
WITH main_thread AS (
  SELECT t.utid
  FROM thread t
  JOIN process p ON t.upid = p.upid
  WHERE (p.name GLOB '<package>*' OR '<package>' = '')
    AND t.tid = p.pid
),
slice_with_self AS (
  SELECT
    s.id,
    s.name as slice_name,
    MIN(s.ts + s.dur, <end_ts>) - MAX(s.ts, <start_ts>) as clipped_dur,
    (MIN(s.ts + s.dur, <end_ts>) - MAX(s.ts, <start_ts>))
      - COALESCE((
          SELECT SUM(
            MIN(c.ts + c.dur, MIN(s.ts + s.dur, <end_ts>))
            - MAX(c.ts, MAX(s.ts, <start_ts>))
          )
          FROM slice c
          WHERE c.parent_id = s.id
            AND c.ts < <end_ts>
            AND c.ts + c.dur > <start_ts>
        ), 0) as self_dur
  FROM slice s
  JOIN thread_track tt ON s.track_id = tt.id
  JOIN main_thread mt ON tt.utid = mt.utid
  WHERE s.ts < <end_ts>
    AND s.ts + s.dur > <start_ts>
),
agg AS (
  SELECT
    slice_name,
    COUNT(*) as count,
    ROUND(SUM(clipped_dur) / 1e6, 2) as total_ms,
    ROUND(SUM(self_dur) / 1e6, 2) as self_ms,
    ROUND(AVG(clipped_dur) / 1e6, 2) as avg_ms,
    ROUND(MAX(clipped_dur) / 1e6, 2) as max_ms,
    ROUND(100.0 * SUM(clipped_dur) / NULLIF(<end_ts> - <start_ts>, 0), 1) as percent,
    ROUND(100.0 * SUM(self_dur) / NULLIF(<end_ts> - <start_ts>, 0), 1) as self_percent,
    CASE
      WHEN lower(slice_name) IN ('clienttransactionexecuted', 'activitystart', 'bindapplication') THEN 1
      WHEN lower(slice_name) GLOB 'performcreate:*' THEN 1
      WHEN lower(slice_name) GLOB 'performresume*' THEN 1
      WHEN lower(slice_name) GLOB 'activitythreadmain*' THEN 1
      ELSE 0
    END as is_framework_wrapper
  FROM slice_with_self
  WHERE clipped_dur >= 1000000
  GROUP BY slice_name
)
SELECT
  slice_name, count, total_ms, self_ms, avg_ms, max_ms,
  percent, self_percent, is_framework_wrapper
FROM agg
ORDER BY is_framework_wrapper ASC, self_ms DESC
LIMIT 5
```

---

## 附录: 分析阶段与 Skill 对应关系

| 分析阶段 | Skill | 适用场景 |
|---------|-------|---------|
| **1. 启动事件检测** | startup_events_in_range | 所有启动分析的入口 |
| **2. 延迟归因** | startup_breakdown_in_range | 快速定位耗时大类 |
| **3. 主线程分析** | startup_main_thread_slices_in_range | 定位主线程热点操作 |
| | startup_main_thread_states_in_range | 主线程状态分布 |
| | startup_main_thread_file_io_in_range | 主线程 IO 操作 |
| | startup_main_thread_sync_binder_in_range | 主线程同步 Binder |
| | startup_main_thread_binder_blocking_in_range | Binder 阻塞明细 |
| | startup_binder_in_range | 全部 Binder 总览 |
| | startup_binder_pool_analysis | Binder 线程池利用率 |
| **4. CPU/调度** | startup_sched_latency_in_range | 调度延迟 |
| | startup_critical_tasks | 全线程四象限 + 核迁移 |
| | startup_freq_rampup | CPU 频率爬升 |
| | startup_cpu_placement_timeline | 主线程摆核时序 |
| **5. 深钻** | startup_hot_slice_states | 热点 slice 状态分解 |
| | startup_thread_blocking_graph | 线程阻塞关系图 |
| | blocking_chain_analysis | 通用阻塞链（3 步） |
| | binder_root_cause | Binder 阻塞归因（2 步） |
| **6. 补充检测** | startup_slow_reasons (v3.0) | 20+ 已知慢原因自检 |
| | startup_gc_in_range | GC 影响分析 |
| | startup_class_loading_in_range | 类加载开销 |
| | startup_jit_analysis | JIT 影响分析 |
| | memory_pressure_in_range | 内存压力检测 |
| **组合编排** | startup_analysis (composite) | 启动分析主入口 |
| | startup_detail (composite) | 单事件深度分析 |