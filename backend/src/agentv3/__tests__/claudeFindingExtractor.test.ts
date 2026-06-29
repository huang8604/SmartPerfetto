// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * claudeFindingExtractor unit tests
 *
 * Tests finding extraction from free-text, including:
 * - Basic [SEVERITY] pattern matching
 * - Code block stripping (Mermaid, SQL, etc.)
 * - Evidence extraction (根因推理链 format)
 */

import { describe, it, expect } from '@jest/globals';
import { extractFindingsFromText } from '../claudeFindingExtractor';

describe('extractFindingsFromText', () => {
  it('should extract basic findings with severity markers', () => {
    const text = `
**[HIGH] 主线程 CPU 负载过高**
描述：主线程 Running 占 63%
证据：Q1=62.8%

**[MEDIUM] GC 压力**
描述：后台 GC 影响轻微
`;
    const findings = extractFindingsFromText(text);
    expect(findings).toHaveLength(2);
    expect(findings[0].severity).toBe('high');
    expect(findings[0].title).toContain('CPU 负载');
    expect(findings[1].severity).toBe('medium');
  });

  it('should NOT extract findings from Mermaid code blocks', () => {
    const text = `
**[HIGH] 真实发现 — CPU 瓶颈**
描述：主线程超时

\`\`\`mermaid
graph TD
    A["启动"] --> B["[HIGH] 超时 15ms\\nfreq_ramp_slow 47%"]
    B --> C["[MEDIUM] 短帧超时\\nlock_binder_wait"]
    style B fill:#ff6b6b,color:#fff
\`\`\`

**[LOW] GC 压力较小**
描述：GC 影响可忽略
`;
    const findings = extractFindingsFromText(text);
    // Should only find 2 real findings, not the [HIGH] and [MEDIUM] inside Mermaid
    expect(findings).toHaveLength(2);
    expect(findings[0].severity).toBe('high');
    expect(findings[0].title).toContain('CPU 瓶颈');
    expect(findings[1].severity).toBe('low');
    expect(findings[1].title).toContain('GC');
  });

  it('should NOT extract findings from SQL code blocks', () => {
    const text = `
**[CRITICAL] 阻塞严重**
描述：主线程被 Binder 阻塞

\`\`\`sql
SELECT '[HIGH] this is not a finding' FROM slice WHERE dur > 100000
\`\`\`
`;
    const findings = extractFindingsFromText(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
  });

  it('should extract evidence from 根因推理链 format', () => {
    const text = `
**[HIGH] freq_ramp_slow — 代表帧 Frame 38**
根因推理链：
  ① 症状：帧耗时 18.57ms
  ② 机制：CPU 大核从 787MHz 爬升
  ③ 根源：CustomScroll_doFrameLoad
建议：设置 uclamp.min
`;
    const findings = extractFindingsFromText(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence).toBeDefined();
    expect(findings[0].evidence?.length).toBeGreaterThan(0);
  });

  it('should extract evidence from final-report evidence type and bold root-cause labels', () => {
    const text = `
#### [CRITICAL] Frames 59665234-59669978 — CustomScroll_longFrameLoad 合成负载
**证据类型/置信度**：trace_direct（main_slices + 四象限 + blocking_chain 三重确认）/ 高
**根因推理链**：
\`\`\`
① 症状：连续 6 帧耗时 59-63ms
② 位置：ANIMATION 回调 → CustomScroll_longFrameLoad
\`\`\`

#### [HIGH] Frame 59665037 — shader compile
**Evidence Type/Confidence**: trace_direct / high
`;
    const findings = extractFindingsFromText(text);
    expect(findings).toHaveLength(2);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].evidence?.[0]?.text).toContain('trace_direct');
    expect(findings[0].evidence?.[0]?.text).toContain('blocking_chain');
    expect(findings[1].evidence?.[0]?.text).toContain('trace_direct');
  });

  it('should use a representative-frame metric code block as evidence after a real severity heading', () => {
    const text = `
### [CRITICAL] workload_heavy 代表帧：Frame 59665234（Session 1，62.73ms，7 VSync）
\`\`\`
帧耗时：62.73ms（帧预算 8.33ms，超 7.5×），呈现间隔 65.03ms
MainThread：Q1=0% Q2=0% Q3=0.3% Q4a=0% Q4b=3.7%
RenderThread：Q1=0% Q2=0% Q3=0.3% Q4a=0% Q4b=98.3%
关键操作：animation → CustomScroll_longFrameLoad_1 (self_ms ≈ 59ms)
CPU频率：均频 2157MHz / 设备峰值 3533MHz（61%）
Binder: 0ms / GC: 0ms / IO: 0ms
\`\`\`

### [HIGH] shader compile 代表帧
证据：RenderThread makePipeline 12.89ms
`;
    const findings = extractFindingsFromText(text);
    expect(findings).toHaveLength(2);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].evidence?.[0]?.text).toContain('帧耗时：62.73ms');
    expect(findings[0].evidence?.[0]?.text).toContain('CPU频率');
  });

  it('should ignore severity markers that only appear inside markdown table cells', () => {
    const text = `
| 类型 | 帧数 | 占比 | 根因 | 严重度 |
|------|------|------|------|--------|
| \`CustomScroll_longFrameLoad\` | 6 | 85.7% | ANIMATION 回调同步重载 | [CRITICAL] |

### [HIGH] 真实发现：RenderThread 合成负载
证据：Frame 59665234 RenderThread Q4b=98.3%
`;

    const findings = extractFindingsFromText(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain('RenderThread 合成负载');
    expect(findings.map(finding => finding.title)).not.toContain('|');
  });

  it('should use a markdown metrics table as evidence after a real severity heading', () => {
    const text = `
### 代表帧分析

**[CRITICAL] Frame 2 — 主线程 ANIMATION 同步重载**

| 属性 | 数值 |
|---|---|
| 帧耗时 | **62.73ms（7.5x 预算）** |
| vsync_missed | 7 帧 |
| \`Choreographer#doFrame\` | 60.85ms |
| \`animation\` → \`CustomScroll_longFrameLoad_1\` | **59.02ms** |
| 主线程 Running 占比 | **95.9%**（无锁/IO/GC） |
| RenderThread | 仅 1.88ms，98.3% 等待主线程 |

**因果链**：\`Choreographer#doFrame\` → ANIMATION 回调 → \`CustomScroll_longFrameLoad_1\`
`;

    const findings = extractFindingsFromText(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].title).toBe('Frame 2 — 主线程 ANIMATION 同步重载');
    expect(findings[0].evidence?.[0]?.text).toContain('帧耗时');
    expect(findings[0].evidence?.[0]?.text).toContain('62.73ms');
    expect(findings[0].evidence?.[0]?.text).toContain('CustomScroll_longFrameLoad_1');
  });

  it('should use inline metric text as evidence for severity-tagged recommendations', () => {
    const text = `
### 优化建议

1. **[CRITICAL] \`CustomScroll_longFrameLoad\` 移出 ANIMATION 回调** — 当前 6/7 帧在 \`Choreographer#doFrame\` 的 ANIMATION 阶段同步执行 47-59ms。建议异步执行或预计算，预估消除 86% 掉帧，FPS 升至约 120。
`;

    const findings = extractFindingsFromText(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].description).toContain('47-59ms');
    expect(findings[0].evidence?.[0]?.text).toContain('47-59ms');
    expect(findings[0].evidence?.[0]?.text).toContain('86%');
  });

  it('should still extract severity headings whose title contains pipe characters', () => {
    const text = `
### [HIGH] UI | Render | CPU stall
证据：Frame 42 RenderThread 18ms
`;

    const findings = extractFindingsFromText(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe('UI | Render | CPU stall');
  });

  it('should handle empty text', () => {
    expect(extractFindingsFromText('')).toHaveLength(0);
    expect(extractFindingsFromText(undefined as any)).toHaveLength(0);
  });
});
