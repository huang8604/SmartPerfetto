<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Android Rendering Pipeline

## Mechanism

Each frame flows through a multi-stage pipeline driven by VSync signals:

1. **VSync-app** fires, waking the app process
2. **Choreographer#doFrame** on the main thread: input handling, animation, measure, layout, draw (records display list)
3. **syncFrameState** transfers the display list to RenderThread
4. **RenderThread DrawFrame**: dequeueBuffer from BufferQueue, issues GPU commands (OpenGL/Vulkan), queueBuffer back
5. **SurfaceFlinger** receives the buffer at VSync-sf, composites all visible layers via HWC
6. **HWC** (Hardware Composer) sends the final frame to the display

The frame budget is one VSync period: 16.67ms at 60Hz, 11.11ms at 90Hz, 8.33ms at 120Hz. Any stage exceeding its share pushes the frame past deadline.

## Why Jank Appears 2-3 Frames Late

Android uses triple-buffering. When a frame takes too long to render, its buffer arrives late to SurfaceFlinger. SF has no new buffer to display, so it re-displays the stale buffer, causing visible stutter. Because of pipeline depth, the visual jank appears 2-3 VSync cycles after the actual slow frame. This is called **buffer stuffing** -- the pipeline backs up and the user sees the effect downstream.

## Frame Token 体系（actual_frame_timeline_slice）

`actual_frame_timeline_slice` 是 Perfetto 帧分析的核心表，每行代表一个帧事件。关键是理解 **双 token 架构**：

| Token | 含义 | 何时为 NULL |
|-------|------|------------|
| `display_frame_token` | SF 合成周期的 VSync ID（"这个帧被哪个 SF VSync 消费"） | 始终非 NULL |
| `surface_frame_token` | App 自己的 VSync ID（"触发 Choreographer#doFrame 的 VSync"） | SF display frame 行为 NULL |

### 帧类型判断

| 帧类型 | 过滤条件 | 含义 |
|--------|---------|------|
| App 帧 | `surface_frame_token IS NOT NULL` | 应用提交的 surface frame |
| SF 帧 | `surface_frame_token IS NULL` | SurfaceFlinger 的 display frame |

### JOIN 场景与正确用法

| 场景 | 正确做法 | 错误做法 |
|------|---------|---------|
| App 帧 ↔ SF 帧 关联 | `ON app.display_frame_token = sf.display_frame_token` | 用 `surface_frame_token` JOIN |
| expected ↔ actual 帧匹配 | `ON e.display_frame_token = a.display_frame_token` | — |
| 用 stdlib frame_id 查帧 | `ON stdlib_frame_id = a.surface_frame_token` | 用 `display_frame_token` |
| token_gap 缓冲区饥饿检测 | App 帧的 `display_frame_token` 差值 | 用 `surface_frame_token` 差值 |
| 通用 frame_id 输出 | `display_frame_token as frame_id`（一致性） | — |

### ⚠️ 常见陷阱

**`COALESCE(display_frame_token, surface_frame_token)` 的认知误导**：
由于 `display_frame_token` 始终非 NULL，COALESCE 实际上**始终返回 `display_frame_token`**。
代码中广泛使用这个模式作为通用 `frame_id`，这会造成一个认知陷阱：看到 `frame_id` 时**不确定它到底是哪个 token**。

**关键区分**：
- SmartPerfetto skill 输出的 `frame_id` = `display_frame_token`（SF VSync ID）
- Perfetto stdlib `android_input_events.frame_id` = `surface_frame_token`（App VSync ID）
- 两者语义不同，不能混用做 JOIN key

## Key Trace Signatures

| Slice / Counter | Where | Indicates |
|----------------|-------|-----------|
| `Choreographer#doFrame` | Main thread | App-side frame work (UI thread portion) |
| `DrawFrame` | RenderThread | GPU command recording + buffer submission |
| `dequeueBuffer` | RenderThread | Waiting for a free buffer from BufferQueue |
| `queueBuffer` | RenderThread | Submitting completed buffer to SurfaceFlinger |
| `onMessageInvalidate` | SurfaceFlinger | SF-side composition trigger |
| `HW_VSYNC` counter | Display | Hardware VSync pulse |

## Diagnosis Approach

- Compare `Choreographer#doFrame` duration to VSync period. If it exceeds budget, the bottleneck is on the main thread (measure/layout/draw).
- If main thread is fast but `DrawFrame` is slow, the bottleneck is GPU-side (complex shaders, overdraw, large textures).
- Long `dequeueBuffer` means all buffers are in use -- the pipeline is backed up, often from a previous slow frame.
- Check `FrameMissed` or `StalledByBackpressure` counters on SurfaceFlinger to confirm dropped frames.

## Typical Solutions

- Reduce view hierarchy depth (fewer measure/layout passes)
- Offload heavy work from main thread (use coroutines, HandlerThread)
- Reduce GPU overdraw (flatten layouts, avoid unnecessary backgrounds)
- Use `RenderThread` hints: avoid `canvas.saveLayer()`, minimize path clipping
- Enable hardware layers for complex, static views