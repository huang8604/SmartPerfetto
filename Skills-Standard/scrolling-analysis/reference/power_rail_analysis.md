<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Power Rail / Battery Counter 分析

## Battery Counter Tracks

```sql
-- 电池相关 counter tracks
SELECT ct.name, COUNT(*) as samples
FROM counter c
JOIN counter_track ct ON c.track_id = ct.id
WHERE ct.name GLOB 'batt.*'
GROUP BY ct.name
```

常见 track:
- `batt.charge_uah`: 电池充电量
- `batt.current_ua`: 瞬时电流（正=充电，负=放电）
- `batt.capacity_pct`: 电池百分比
- `batt.voltage_uv`: 电池电压

## 功耗 vs 频率关联

```sql
-- 高功耗但频率低 = thermal 限频证据
SELECT
  printf('%d', c_batt.ts) as ts,
  CAST(c_batt.value AS INTEGER) as current_ua,
  (SELECT CAST(c2.value AS INTEGER) FROM counter c2
   JOIN cpu_counter_track cct ON c2.track_id = cct.id
   WHERE cct.name GLOB 'cpu*freq*' AND cct.cpu IN (<big_core_ids>)
     AND c2.ts <= c_batt.ts ORDER BY c2.ts DESC LIMIT 1) as big_freq_khz
FROM counter c_batt
JOIN counter_track ct ON c_batt.track_id = ct.id
WHERE ct.name = 'batt.current_ua'
  AND c_batt.ts BETWEEN <start_ts> AND <end_ts>
ORDER BY c_batt.ts
```

## Trace 配置

```protobuf
data_sources {
  config {
    name: "android.power"
    android_power_config {
      battery_poll_ms: 1000
      collect_power_rails: true  # ODPM 子系统功耗（如有）
    }
  }
}
```