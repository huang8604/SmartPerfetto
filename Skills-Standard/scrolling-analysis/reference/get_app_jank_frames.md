<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# 获取应用掉帧帧列表 (get_app_jank_frames)

此技能不作为独立的 atomic skill 存在，而是内嵌在 `scrolling_analysis` composite skill 的 Step `get_app_jank_frames` 中。

它使用双信号混合检测策略获取所有真正掉帧的帧列表，并进行 guilty frame 溯源。

## 核心逻辑

### 双信号混合策略

- **非 BS 帧**：`present_type IN ('Late Present', 'Dropped Frame')` 为权威信号
- **BS 帧**：`present_type` 始终为 Late Present，需用 `present_ts` 间隔二次验证
  - 间隔 > 1.5x VSync = 真实掉帧（被 BS 掩盖的卡顿）
  - 间隔 <= 1.5x VSync = 管线背压（非感知掉帧）

### 责任归属

```
Self Jank / App Deadline Missed → APP
*SurfaceFlinger* → SF
Buffer Stuffing → BUFFER_STUFFING
None / NULL → HIDDEN
其他 → UNKNOWN
```

### Guilty Frame 溯源

BlastBufferQueue 三缓冲下，可见卡顿发生在慢帧 2-3 帧之后。通过回溯前 5 帧内超预算的帧，找到导致缓冲区枯竭的"罪魁帧"。

## 输出列

| 列名 | 类型 | 说明 |
|------|------|------|
| frame_id | string | 帧 token |
| ts | timestamp | 帧起始时间 |
| end_ts | timestamp | 帧结束时间 |
| dur_ms | number | 帧耗时(ms) |
| jank_type | string | 框架报告的 jank 类型 |
| layer_name | string | 图层名 |
| session_id | number | 滑动区间 ID |
| token_gap | number | Token 跳跃值 |
| vsync_missed | number | 估算跳过的 VSync 数 |
| jank_responsibility | string | 责任归属 (APP/SF/BUFFER_STUFFING/HIDDEN/UNKNOWN) |
| present_interval_ms | number | 消费端呈现间隔(ms) |
| is_hidden_jank | number | 是否为隐形掉帧 (1/0) |
| guilty_frame_id | string | 罪魁帧 ID |
| guilty_over_budget_ms | number | 罪魁帧超预算时间(ms) |

## 使用说明

- 此步骤的数据通过 `save_as: app_jank_frames` 供下游 `batch_frame_root_cause` 引用
- display 设为 false（隐藏独立显示），由批量根因分类统一展示
- 最多返回 `max_frames_per_session` 帧（默认 200），配合批量分类使用