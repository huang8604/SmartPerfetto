<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 启动 CPU 频率爬升 (startup_freq_rampup)

分析冷启动初期 CPU 频率从低到高的爬升过程。冷启动前 50ms CPU 可能还在低频（idle 被唤醒），影响前期性能。输出每个核类型在启动初期 vs 稳态的频率对比。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| start_ts | timestamp | 是 | - | 启动区间开始时间戳(ns) |
| end_ts | timestamp | 是 | - | 启动区间结束时间戳(ns) |

## SQL 查询

```sql
-- Early phase: 启动后前 100ms
WITH early_freq AS (
  SELECT
    COALESCE(ct.core_type, 'unknown') as core_type,
    ROUND(SUM(c.value * cf.dur) / NULLIF(SUM(cf.dur), 0) / 1000, 0) as avg_freq_mhz,
    ROUND(MAX(c.value) / 1000, 0) as max_freq_mhz
  FROM cpu_frequency_counters cf
  JOIN counter c ON cf.id = c.id
  LEFT JOIN _cpu_topology ct ON cf.cpu = ct.cpu_id
  WHERE cf.ts >= <start_ts> AND cf.ts < <start_ts> + 100000000
  GROUP BY core_type
),
-- Steady phase: 100ms 到启动结束
steady_freq AS (
  SELECT
    COALESCE(ct.core_type, 'unknown') as core_type,
    ROUND(SUM(c.value * cf.dur) / NULLIF(SUM(cf.dur), 0) / 1000, 0) as avg_freq_mhz,
    ROUND(MAX(c.value) / 1000, 0) as max_freq_mhz
  FROM cpu_frequency_counters cf
  JOIN counter c ON cf.id = c.id
  LEFT JOIN _cpu_topology ct ON cf.cpu = ct.cpu_id
  WHERE cf.ts >= <start_ts> + 100000000 AND cf.ts < <end_ts>
  GROUP BY core_type
)
SELECT
  COALESCE(ef.core_type, sf.core_type) as core_type,
  COALESCE(ef.avg_freq_mhz, 0) as early_avg_freq_mhz,
  COALESCE(sf.avg_freq_mhz, 0) as steady_avg_freq_mhz,
  COALESCE(sf.max_freq_mhz, ef.max_freq_mhz, 0) as max_freq_mhz,
  ROUND((sf.avg_freq_mhz - ef.avg_freq_mhz) / NULLIF(ef.avg_freq_mhz, 0) * 100, 1) as rampup_pct,
  CASE
    WHEN ef.avg_freq_mhz < sf.avg_freq_mhz * 0.5 THEN '启动初期频率显著偏低，升频延迟明显'
    WHEN ef.avg_freq_mhz < sf.avg_freq_mhz * 0.8 THEN '启动初期频率偏低，有一定升频延迟'
    ELSE '频率爬升正常'
  END as assessment
FROM early_freq ef
FULL OUTER JOIN steady_freq sf ON ef.core_type = sf.core_type
ORDER BY CASE core_type WHEN 'prime' THEN 0 WHEN 'big' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
```

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| core_type | string | 核类型（prime/big/medium/little） |
| early_avg_freq_mhz | number | 启动初期（前 100ms）加权平均频率（MHz） |
| steady_avg_freq_mhz | number | 稳态（100ms 后）加权平均频率（MHz） |
| max_freq_mhz | number | 区间内最高频率（MHz） |
| rampup_pct | percentage | 爬升幅度（稳态 vs 初期的频率增长百分比） |
| assessment | string | 评估结论（频率爬升正常/偏低/显著偏低） |

## 使用说明

- **前置模块**: `linux.cpu.frequency`
- 以 100ms 为分界点将启动区间切分为初期和稳态两个阶段
- 如果初期均频 < 稳态均频的 50%，判定为"升频延迟明显"
- 典型场景：冷启动 fork 后 CPU 从 idle 唤醒，governor 需要几十毫秒才把频率拉上来
- 在 `startup_detail` 组合 Skill 中用于检测 CPU 频率爬升延迟