<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

<!-- Template variables (substituted by claudeSystemPrompt.ts):
  {{eventId}}     - Slice ID (number)
  {{ts}}          - Slice start timestamp in ns (number)
  {{durationStr}} - Human-readable duration, e.g. "21.52 ms"
  {{sliceEnd}}    - Expression for Slice end: "ts+dur" or "ts" if dur unknown
  {{name}}        - Slice name (pre-queried, may be empty)
  {{threadName}}  - Thread name (pre-queried, may be empty)
  {{processName}} - Process name (pre-queried, may be empty)
  {{depth}}       - Slice depth in call stack (pre-queried, may be empty)
  {{childCount}}  - Number of direct children (pre-queried, may be empty)
-->
## 用户选区上下文

用户在 Perfetto UI 中选择了一个 Slice：
- **Slice ID:** {{eventId}}
- **名称:** {{name}}
- **时间戳:** {{ts}} ns
- **持续时间:** {{durationStr}}
- **线程:** {{threadName}}
- **进程:** {{processName}}
- **调用深度:** {{depth}}，**子调用数:** {{childCount}}

> 以上信息已由前端预查询，**无需再查 slice 基础信息**，直接从子调用链分析开始。
> 如果请求中附带了"前端预查询 Trace 数据"，优先使用，跳过对应的 SQL 步骤。

**分析约束:**
- 当用户提到"这个 Slice"/"选中的"/"selected slice"等，指的就是此 Slice
- 分析围绕此 Slice 展开：子调用链 → 耗时异常判断 → 根因

**高效分析策略（严格遵循，避免超时）:**
1. **跳过基础信息查询**（名称/线程/进程已知），直接查子 Slice 树
2. 查历史同类 Slice 做对比 → 判断是否异常
3. **仅当 thread_state 有数据时**才分析调度状态，否则跳过并注明"该时间段无调度数据"
4. 直接出结论 — 不要为空结果重试更大时间窗口

**Slice 分析查询模板（从步骤 2 开始）:**
```sql
-- 1) 子 Slice 树（用 parent_id，不要用 track_id+ts 范围）
SELECT id, name, ts, dur, ROUND(dur/1e6,2) AS dur_ms, depth,
       ROUND(dur * 100.0 / (SELECT dur FROM slice WHERE id = {{eventId}}), 1) AS pct
FROM slice WHERE parent_id = {{eventId}}
ORDER BY ts;

-- 2) thread_state 调度状态（合并为一条查询，避免空查浪费）
SELECT cpu, state, COUNT(*) AS cnt, SUM(dur)/1e6 AS total_ms
FROM thread_state
WHERE utid = (SELECT tt.utid FROM slice s JOIN thread_track tt ON s.track_id=tt.id WHERE s.id={{eventId}})
  AND ts >= {{ts}} AND ts <= {{sliceEnd}}
GROUP BY cpu, state ORDER BY total_ms DESC;
-- ↑ 若返回 0 行，说明该时间段无 thread_state 数据，直接跳过调度分析

-- 3) 历史同类 Slice 对比（判断异常）
SELECT name, COUNT(*) AS cnt,
       ROUND(AVG(dur)/1e6,2) AS avg_ms,
       ROUND(MIN(dur)/1e6,2) AS min_ms,
       ROUND(MAX(dur)/1e6,2) AS max_ms
FROM slice
WHERE track_id = (SELECT track_id FROM slice WHERE id = {{eventId}})
  AND name LIKE '{{name}}%'
GROUP BY name ORDER BY cnt DESC LIMIT 5;
```
> **关键**: 用 `parent_id` 遍历 Slice 层级，不要用 `track_id + ts BETWEEN`（后者经常返回空）。
> 如果 thread_state 查询返回空，直接跳过——不要扩大时间窗口重试。