<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# CPU Profiling 深钻指南（可选）

## 适用场景

当 Q1 (Running on big core) > 70% 且 top_slice self_ms > 帧预算 2x 时，热点 slice 是 CPU-bound，需要 callstack 定位具体热点函数。

**注意**：CPU profiling 只能帮助 CPU-bound 问题（Q1 高）。对 Q4 高（阻塞）的问题，应使用 blocked_functions 和阻塞链分析。

## linux.perf 数据源配置

```protobuf
data_sources {
  config {
    name: "linux.perf"
    perf_event_config {
      timebase {
        counter: SW_CPU_CLOCK
        frequency: 100  # 100 Hz sampling
        timestamp_clock: PERF_CLOCK_MONOTONIC
      }
      callstack_sampling {
        kernel_frames: true
      }
    }
  }
}
```

## 查询 SQL

```sql
-- 热点函数 Top 20（需要 linux.perf 数据）
SELECT
  symbol_name,
  COUNT(*) as sample_count,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) as pct
FROM perf_sample ps
JOIN stack_profile_callsite spc ON ps.callsite_id = spc.id
JOIN stack_profile_frame spf ON spc.frame_id = spf.id
WHERE ps.ts BETWEEN <start_ts> AND <end_ts>
  AND spf.symbol_name IS NOT NULL
  AND spf.symbol_name != '[unknown]'
GROUP BY symbol_name
ORDER BY sample_count DESC
LIMIT 20
```

## 注意事项

- 需要 symbolization（release 包可能无符号，需要 mapping file）
- sampling 有统计误差，sample_count < 10 的结果不可靠
- 对帧级分析，需要将 sample 与帧时间窗口对齐