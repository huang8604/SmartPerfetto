<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Flutter 滑动分析 (flutter_scrolling_analysis) - Composite Skill v1.0

Flutter 应用帧渲染分析：UI 线程 + Raster 线程 + 帧时序。处理 Flutter 应用中标准 Android 帧检测 (Choreographer#doFrame, DrawFrame) 不适用的场景。

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| package | string | 否 | - | Flutter 应用包名 |
| start_ts | timestamp | 否 | - | 分析起始时间戳(ns) |
| end_ts | timestamp | 否 | - | 分析结束时间戳(ns) |
| vsync_period_ns | number | 否 | 16666667 | VSync 周期(ns)，默认 60Hz |

## 前置条件

- 必需表: `actual_frame_timeline_slice`
- 必需模块: `android.frames.timeline`
- 上下文变量: `package`, `vsync_period_ns`, `refresh_rate_hz`

## 架构模式检测

本 skill 自动检测 Flutter 的两种渲染模式:

**TextureView 模式（双出图）**:
- 管线: 1.ui -> texture -> RenderThread updateTexImage -> composite
- 特征: 存在 `1.ui` 线程 + `updateTexImage`/`SurfaceTexture` slice > 5 个
- 额外分析: RenderThread 上的 updateTexImage/DrawFrame/queueBuffer

**SurfaceView 模式（单出图）**:
- 管线: 1.ui -> 1.raster -> BufferQueue -> SurfaceFlinger
- 特征: 仅 `1.ui`/`1.raster` 线程，无 RenderThread 参与
- 分析重点: 1.ui 和 1.raster 线程耗时

## 步骤编排

### Step 1: flutter_frame_overview - 帧概览

统计所有 Flutter 帧: 总帧数、平均/最大/最小帧耗时、掉帧数(dur > 1.5x VSync)、框架报告掉帧数(jank_type != 'None')、掉帧率、估算 FPS。

### Step 2: flutter_thread_analysis - 线程耗时分布

分析 Flutter 三线程 + TextureView 模式下的 RenderThread:
- UI (Dart): `1.ui` 线程 - Dart/Framework 执行
- Raster (GPU): `1.raster` 线程 - Impeller/Skia 渲染
- IO (Decode): `1.io` 线程 - 图片解码等 IO
- RenderThread (TextureView): 仅 TextureView 模式 - 纹理合成

每个角色输出: slice 数、平均/最大耗时、总耗时、超预算次数。

### Step 2.5: flutter_consumer_jank - 消费端掉帧检测

从 SurfaceFlinger 消费端验证真实掉帧。使用 VSYNC-sf 周期计算，区分:
- real_jank_count: 实际用户感知掉帧（呈现间隔 > 1.5x VSync）
- hidden_jank_count: 隐藏掉帧（jank_type=None 但消费端实际掉帧）
- false_positive: 假阳性（jank_type 报告掉帧但消费端未跳帧）

按 jank_type 分组，标记责任归属: App / SurfaceFlinger / Buffer Stuffing / None。

### Step 3: flutter_jank_frames - 掉帧帧列表

列出所有 dur > 1.5x VSync 的帧，按严重程度排序。包含时间戳、耗时、卡顿等级(severe/bad/jank)、丢帧数、jank_tag。最多 30 帧。

### Step 4: flutter_ui_thread_long_slices - UI 线程长耗时

找出 `1.ui` 线程上 dur > VSync 周期的 depth=0 slice。分类:
- frame_build: BeginFrame
- widget_build: Build
- layout: Layout
- paint: Paint
- semantics: Semantics

最多 20 条，按耗时降序。

### Step 5: flutter_raster_thread_long_slices - Raster 线程长耗时

找出 `1.raster` 线程上 dur > VSync 周期的 depth=0 slice。分类:
- draw_to_surface: DrawToSurface
- impeller_render: EntityPass (Impeller)
- skia_render: SkGpu (Skia)
- compositor: Compositor

最多 20 条，按耗时降序。

## 参数流

```
inputs -> flutter_frame_overview
       -> flutter_thread_analysis (auto-detect TextureView/SurfaceView)
       -> flutter_consumer_jank
       -> flutter_jank_frames
       -> flutter_ui_thread_long_slices
       -> flutter_raster_thread_long_slices
```

## 使用说明

- Agent 应调用 `flutter_scrolling_analysis` 而非标准 `scrolling_analysis`（当检测到 Flutter 架构时）
- TextureView 模式: 关注 1.ui 线程 + RenderThread updateTexImage 双管线
- SurfaceView 模式: 关注 1.ui/1.raster 线程（非 RenderThread）
- consumer_jank 步骤用于校验框架标记的准确性，识别漏检和误报