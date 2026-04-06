<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

<!-- Template variables (substituted by claudeSystemPrompt.ts):
  {{eventId}}     - Slice ID (number)
  {{ts}}          - Slice start timestamp in ns (number)
  {{durationStr}} - Human-readable duration, e.g. "21.52 ms"
  {{sliceEnd}}    - Expression for Slice end: "ts+dur" or "ts" if dur unknown
-->
## 用户选区上下文

用户在 Perfetto UI 中选择了一个 Slice：
- **Slice ID:** {{eventId}}
- **时间戳:** {{ts}} ns
- **持续时间:** {{durationStr}}

**分析约束:**
- 当用户提到"这个 Slice"/"选中的"/"selected slice"等，指的就是此 Slice
- 分析围绕此 Slice 展开：身份 → 子调用链 → 耗时异常判断 → 根因

**高效分析策略（严格遵循，避免超时）:**
1. 查询 Slice 详情 + 子 Slice（步骤 1+2 可并行）
2. 查历史同类 Slice 做对比 → 判断是否异常
3. **仅当步骤 3 thread_state 有数据时**才分析调度状态，否则跳过并注明"该时间段无调度数据"
4. 直接出结论 — 不要为空结果重试更大时间窗口

**Slice 分析查询模板:**
```sql
-- 1) Slice 详情 + 所属线程/进程
SELECT s.id, s.name, s.ts, s.dur, s.depth, s.parent_id, s.track_id,
       t.name AS thread_name, t.tid, t.utid,
       p.name AS process_name, p.pid
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t ON tt.utid = t.id
LEFT JOIN process p USING(upid)
WHERE s.id = {{eventId}};

-- 2) 子 Slice 树（用 parent_id，不要用 track_id+ts 范围）
--    先查直接子 Slice，再按需递归深层
SELECT id, name, ts, dur, ROUND(dur/1e6,2) AS dur_ms, depth,
       ROUND(dur * 100.0 / (SELECT dur FROM slice WHERE id = {{eventId}}), 1) AS pct
FROM slice WHERE parent_id = {{eventId}}
ORDER BY ts;

-- 3) thread_state 可用性检查 + 调度状态（合并为一条查询，避免空查浪费）
SELECT cpu, state, COUNT(*) AS cnt, SUM(dur)/1e6 AS total_ms
FROM thread_state
WHERE utid = <UTID_from_step1>
  AND ts >= {{ts}} AND ts <= {{sliceEnd}}
GROUP BY cpu, state ORDER BY total_ms DESC;
-- ↑ 若返回 0 行，说明该时间段无 thread_state 数据，直接跳过调度分析

-- 4) 历史同类 Slice 对比（判断异常）
SELECT name, COUNT(*) AS cnt,
       ROUND(AVG(dur)/1e6,2) AS avg_ms,
       ROUND(MIN(dur)/1e6,2) AS min_ms,
       ROUND(MAX(dur)/1e6,2) AS max_ms
FROM slice
WHERE track_id = <track_id_from_step1>
  AND name LIKE '<slice_name_prefix>%'
GROUP BY name ORDER BY cnt DESC LIMIT 5;
```
> **关键**: 用 `parent_id` 遍历 Slice 层级，不要用 `track_id + ts BETWEEN`（后者经常返回空）。
> 如果 thread_state 查询返回空，直接跳过——不要扩大时间窗口重试。