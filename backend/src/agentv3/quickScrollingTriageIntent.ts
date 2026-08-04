// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export const SCROLLING_TRIAGE_LOOKUP_REASON = 'scrolling triage lookup';

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim().toLowerCase();
}

function asksForJankPresenceFact(query: string): boolean {
  return (
    /\bany\s+jank\s*[?？.。!]*$/.test(query) ||
    /\b(?:is|was|are|were)\s+there\s+(?:any\s+)?jank(?:\s+in\s+(?:this\s+|the\s+)?(?:trace|recording|capture))?\s*[?？.。!]*$/.test(query) ||
    /\bjank\s+(?:present|detected)\s*[?？.。!]*$/.test(query) ||
    /\b(?:does|did)\s+(?:it|this|this\s+trace|the\s+trace|the\s+recording|the\s+capture)\s+(?:have|contain)\s+(?:any\s+)?jank\s*[?？.。!]*$/.test(query)
  );
}

export function shouldUseQuickScrollingTriageIntent(input: {
  query: string;
  requireExplicitOverview?: boolean;
}): boolean {
  const query = normalizeQuery(input.query);
  if (!query) return false;

  const mentionsScrolling = /滑动|卡顿|掉帧|丢帧|帧率|流畅|顺滑|跟手|输入延迟|触摸延迟|列表滑|fps|\bscroll(?:ing)?\b|\bjank\b|stutter|smoothness|fling|frame rate|input latency|touch latency/.test(query);
  if (!mentionsScrolling) return false;

  const asksForScrollGestureFact =
    /(?:滑动|滚动|\bscroll(?:ing)?\b|\bscroll\s*gestures?\b|\bswipes?\b).{0,16}(?:次数|多少|几个|几次|手势|gestures?|表|行|rows?|tables?|count|有没有|有吗|吗|么|are\s+there|how\s+many)/.test(query) ||
    /(?:有没有|有吗|多少|几个|几次|rows?|tables?|count|are\s+there|how\s+many).{0,16}(?:滑动|滚动|\bscroll(?:ing)?\b|\bscroll\s*gestures?\b|\bswipes?\b)/.test(query);
  const asksForSingleMetric =
    asksForScrollGestureFact ||
    asksForJankPresenceFact(query) ||
    /(?:fps|帧率|总帧数|掉帧率|掉帧|丢帧|卡顿).{0,12}(?:是多少|多少|几个|几帧|有吗|有没有|吗|么|what|how many|how much)|(?:是多少|多少|几个|几帧|有吗|有没有).{0,12}(?:fps|帧率|总帧数|掉帧率|掉帧|丢帧|卡顿)|\b(?:what|which)\s+(?:is|was)\s+(?:the\s+)?(?:fps|frame\s*rate|jank\s*rate|janky\s*frame\s*rate|janky?\s*frames?(?:\s*(?:count|number))?|jank\s*count|dropped\s*frames?\s*rate|dropped\s*frame\s*percentage|frame\s*count|total\s*frames?)\b|\b(?:how\s+many|how\s+much)\b.{0,24}\b(?:janky?\s*frames?|jank\s*frames?|jank\s*count|dropped\s*frames?|frames?|fps)\b|\bjank\s*frames?\s*(?:count|number)?\b|\bjank\s*count\b/.test(query);

  const asksForExplicitOverview = /概览|整体|总体|总览|快速看|看一下|看看|triage|overview|summary|\bquick\s+(?:scroll(?:ing)?|jank)\b|scroll(?:ing)?\s+(?:triage|overview|summary)|smoothness\s+summary/.test(query);
  const asksForMetricOnly =
    asksForSingleMetric &&
    !/概览|整体|总体|总览|triage|overview|summary|评估|分析|卡不卡|怎么样|如何|流畅|\bsmooth(?:ness)?\b/.test(query);
  const asksForBroadOverview = asksForExplicitOverview || /评估|分析|卡不卡|怎么样|如何|流畅|\bsmooth(?:ness)?\b/.test(query);
  const asksForOverview = input.requireExplicitOverview ? asksForExplicitOverview : asksForBroadOverview;
  if (!asksForOverview) return false;
  if (asksForMetricOnly) return false;

  const asksForCausalDiagnostic = /为什么|原因|根因|导致|造成|怎么修|如何修|修复|诊断|优化|建议|why|caus(?:e|es|ed|ing)|reasons?|root\s*cause|diagnos(?:e|is)|optimi[sz]e|recommend|fix|repair/.test(query);
  if (asksForCausalDiagnostic) return false;

  const asksForDeepDrilldown = /逐帧|每一帧|哪一帧|具体.*帧|代表帧|详情|详细|深钻|调用栈|内核栈|binder server|锁等待|线程状态|代码|函数|sql|display_frame_token|surface_frame_token|frame[_\s-]?id|root cause deep|call\s*stack|callstack|sched_blocked_reason|thread_state/.test(query);
  if (asksForDeepDrilldown) return false;

  const asksForComparison = /对比|比较|reference trace|baseline|compare|diff/.test(query);
  if (asksForComparison) return false;

  return true;
}
