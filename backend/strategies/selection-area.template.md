<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

<!-- Template variables (substituted by claudeSystemPrompt.ts):
  {{startNs}}     - Area start timestamp in ns (number)
  {{endNs}}       - Area end timestamp in ns (number)
  {{durationMs}}  - Duration in ms, e.g. "19.30"
  {{trackCount}}  - Number of selected tracks (number or "未知")
  {{trackSummary}} - Pre-formatted track list grouped by process (string, may be empty)
-->
## 用户选区上下文

用户在 Perfetto UI 中选择了一段时间区间（按 M 键标记）：
- **起始时间:** {{startNs}} ns
- **结束时间:** {{endNs}} ns
- **持续时间:** {{durationMs}} ms
- **选中 Track 数:** {{trackCount}}{{trackSummary}}

**分析约束:**
- 你的 SQL 查询必须使用 `WHERE ts >= {{startNs}} AND ts <= {{endNs}}` 来限制时间范围
- 上述时间戳是 trace_processor 原始时间戳（ns），可直接用于 slice/thread_state/sched 等所有表的 ts 列
- 分析结论应聚焦于用户选择的这段区间
- 如果需要全局上下文（如整体 VSync 周期）来做对比，可以额外查询，但核心分析范围是选区内
- 当用户提到"选中的区间"/"这一段"/"选择的范围"/"marked area"等，指的就是上述时间窗口

**选区内常用 SQL 查询模板:**
```sql
-- 1) 选区内某线程的调度状态分布（大小核、Running/Sleeping/Runnable）
SELECT cpu, state, SUM(dur)/1e6 AS total_ms, COUNT(*) AS count
FROM thread_state
WHERE utid = <UTID> AND ts >= {{startNs}} AND ts <= {{endNs}}
GROUP BY cpu, state ORDER BY total_ms DESC;

-- 2) 选区内 CPU 频率变化（使用 counter + cpu_counter_track，不要用 cpu_frequency_counters）
SELECT ct.cpu, c.ts, c.value AS freq_khz
FROM counter c JOIN cpu_counter_track ct ON c.track_id = ct.id
WHERE ct.name = 'cpufreq' AND c.ts >= {{startNs}} AND c.ts <= {{endNs}}
ORDER BY ct.cpu, c.ts;

-- 3) 选区内某线程的 Slice 热点（通过 thread_track 关联）
SELECT s.name, s.dur/1e6 AS dur_ms, s.ts, s.depth
FROM slice s JOIN thread_track tt ON s.track_id = tt.id
WHERE tt.utid = <UTID> AND s.ts >= {{startNs}} AND s.ts <= {{endNs}}
ORDER BY s.dur DESC LIMIT 20;
```
> 注意: 不要猜测表名。如果不确定表是否存在，先用 `lookup_sql_schema` 工具查询。