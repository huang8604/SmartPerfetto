<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 启动事件列表 (startup_events_in_range)

查询启动事件及 TTID/TTFD 指标，支持多信号启动类型校验（bindApplication/performCreate/handleRelaunchActivity/进程创建时间）。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | 应用包名（支持 GLOB 前缀匹配） |
| startup_id | integer | 否 | - | 指定启动事件 ID |
| startup_type | string | 否 | - | 启动类型过滤（cold/warm/hot） |
| start_ts | timestamp | 否 | - | 起始时间戳(ns) |
| end_ts | timestamp | 否 | - | 结束时间戳(ns) |

## SQL 查询

```sql
-- Multi-signal startup type validation:
--   bindApplication exists           -> cold  (process created from zygote)
--   performCreate:* without above    -> warm  (activity recreated, process alive)
--   handleRelaunchActivity           -> warm  (config change rebuild)
--   none of above                    -> keep original platform classification (Rule 5)
-- Also checks process creation time as fallback cold signal.
WITH startup_type_signals AS (
  SELECT
    st.startup_id,
    MAX(CASE WHEN sl.name = 'bindApplication' THEN 1 ELSE 0 END) as has_bind_app,
    MAX(CASE WHEN sl.name GLOB 'OpenDexFilesFromOat*' THEN 1 ELSE 0 END) as has_dex_load,
    MAX(CASE WHEN sl.name = 'PostFork' THEN 1 ELSE 0 END) as has_post_fork,
    MAX(CASE WHEN sl.name GLOB 'performCreate:*' THEN 1 ELSE 0 END) as has_perform_create,
    MAX(CASE WHEN sl.name GLOB 'handleRelaunchActivity*'
             OR sl.name GLOB 'relaunchActivity*' THEN 1 ELSE 0 END) as has_relaunch,
    MAX(CASE WHEN sl.name GLOB 'performRestart*' THEN 1 ELSE 0 END) as has_perform_restart,
    COUNT(DISTINCT sl.name) as signal_count
  FROM android_startup_threads st
  JOIN thread_track tt ON tt.utid = st.utid
  JOIN slice sl ON sl.track_id = tt.id
  WHERE st.is_main_thread = 1
    AND sl.ts + sl.dur > st.ts AND sl.ts < st.ts + st.dur
    AND (sl.name IN ('bindApplication', 'PostFork', 'activityStart', 'activityResume')
         OR sl.name GLOB 'performCreate:*'
         OR sl.name GLOB 'performRestart*'
         OR sl.name GLOB 'handleRelaunchActivity*'
         OR sl.name GLOB 'relaunchActivity*'
         OR sl.name GLOB 'OpenDexFilesFromOat*')
  GROUP BY st.startup_id
),
process_age AS (
  SELECT
    s.startup_id,
    MAX(CASE
      WHEN p.start_ts IS NOT NULL
        AND p.start_ts >= s.ts - 5000000000
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
    s.startup_id, s.package, s.startup_type as original_type,
    CASE
      WHEN COALESCE(sts.has_bind_app, 0) = 1 THEN 'cold'
      WHEN COALESCE(sts.has_perform_create, 0) = 1 AND COALESCE(sts.has_bind_app, 0) = 0 THEN 'warm'
      WHEN COALESCE(sts.has_relaunch, 0) = 1 THEN 'warm'
      WHEN COALESCE(pa.process_created_during_startup, 0) = 1 THEN 'cold'
      ELSE s.startup_type
    END as startup_type,
    s.ts, s.dur,
    ttd.time_to_initial_display, ttd.time_to_full_display,
    -- type_reclassified, type_confidence (omitted for brevity)
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
  startup_id, package, startup_type, original_type,
  dur / 1e6 as dur_ms,
  printf('%d', ts) as start_ts,
  printf('%d', ts + dur) as end_ts,
  printf('%d', dur) as dur_ns,
  time_to_initial_display / 1e6 as ttid_ms,
  time_to_full_display / 1e6 as ttfd_ms,
  -- type_display, rating, type_reclassified, type_confidence
FROM validated
WHERE ('<startup_type>' = '' OR startup_type = '<startup_type>')
ORDER BY dur DESC, ts ASC
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| startup_id | number | 启动事件 ID |
| package | string | 应用包名 |
| startup_type | string | 校验后的启动类型（cold/warm/hot） |
| original_type | string | Perfetto 原始分类的启动类型 |
| dur_ms | duration | 启动总耗时（毫秒） |
| start_ts | timestamp | 启动开始时间戳（ns，支持导航） |
| end_ts | timestamp | 启动结束时间戳（ns，支持导航） |
| dur_ns | duration | 启动总耗时（纳秒，隐藏列） |
| ttid_ms | duration | Time to Initial Display（毫秒） |
| ttfd_ms | duration | Time to Full Display（毫秒） |
| type_display | string | 启动类型中文显示（冷启动/温启动/热启动） |
| rating | string | 评级（优秀/良好/需优化/严重） |
| type_reclassified | number | 是否重新分类（0/1） |
| type_confidence | string | 分类置信度（high/medium/low） |

## 使用说明

- **前置模块**: `android.startup.startups`, `android.startup.time_to_display`
- 该 Skill 实现了 5 条启动类型校验规则，比 Perfetto 原始分类更准确
- 评级标准：冷启动 <500ms 优秀 / <1000ms 良好 / <2000ms 需优化 / >2000ms 严重；温启动和热启动阈值更低
- 使用 OVERLAP 时间过滤（`sl.ts + sl.dur > st.ts AND sl.ts < st.ts + st.dur`）而非严格 "starts within"，因为 bindApplication 可能在 launchingActivity 事件之前开始
- 是 `startup_analysis` 组合 Skill 的第一个步骤，用于定位启动事件和确定分析范围