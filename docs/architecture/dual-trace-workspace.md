# 双 Trace 工作区操作模型

[English](dual-trace-workspace.en.md) | [中文](dual-trace-workspace.md)

本文定义 Web UI Raw Trace Compare 的双窗操作模型。它补充
[架构总览](overview.md)中的对比模式说明，重点覆盖用户操作、AI Panel
上下文、前后端协同和边界条件。Analysis Result Compare 仍走
workspace comparison API，不属于本文范围。

## 产品原则

- 默认仍是单窗。用户打开普通 Trace 后只看到一个 Perfetto timeline 和 AI Panel。
- AI Panel header 提供一个直达的“打开双窗”按钮。点击后立即打开双窗壳：一个窗口显示 `current` Trace，另一个窗口为空，等待用户选择历史 Trace；不需要先进入 trace picker。
- 两个物理窗口都有 Trace selector。用户可以决定哪个窗口显示 `current`，哪个窗口显示历史 `reference`；在当前窗口选择历史 Trace 时，`current` 会原子移动到另一个窗口，不会出现重复 Trace 或中间无主 Trace 状态。
- 历史 Trace 的可见名称以 `filename` 为主，上传时间和大小只作为次要信息；Trace id 只用于身份识别，不作为用户需要理解的主标签。
- 产品语义始终是“当前页面的 `current` parent + 一个 workspace 历史 `reference`”。窗口位置可以互换，但不支持任意选择两个历史 Trace。
- 布局切换、最大化、最小化以及 AI Panel 的隐藏/再次显示只改变展示状态，不销毁或重新加载已经存在的 iframe。
- 双窗 header 常驻明确的“AI 助手”按钮，作为工作区内收起/恢复对话面板的入口；它不会改变 workspace controller、iframe 身份、当前 run 或 SSE owner。
- 分析运行中或正在等待停止确认时，`current + reference + agent session/run`
  组成同一个运行身份。此时 selector、新建 pair、退出对比、切换会话、New Chat、
  Provider、workspace、backend URL 和 backend access token 都不能改变该身份；
  左右/上下、拖拽、最大化、最小化、AI Panel 隐藏/恢复，以及为相同 pair 重新打开
  视觉双窗仍然可用。只有显式 Stop 进入后端取消协议。
- AI Panel 收起采用视觉折叠并保留同一个 Panel 与 SSE owner；即使 `/analyze` 尚未返回
  session id，展开后也仍能停止同一个请求。分析期间会改变 Panel 挂载点的 Pop Out/Dock
  操作延后到终态，避免把请求所有权留在已卸载实例中。
- 显式退出双窗、当前 Trace unload 或 workspace 切换才销毁双窗 iframe。退出双窗只关闭视觉工作区；已有 reference 和 AI 对比上下文仍可保留。退出对比则进一步清掉 reference、对比上下文和对比 agent session。
- 双窗 iframe 不拥有新的 AI session，也不重复上传 Trace。它们只作为完整 Perfetto timeline 视图使用。

## 状态机

| 状态 | UI 表现 | 后端对比能力 | 进入条件 | 退出条件 |
| --- | --- | --- | --- | --- |
| Single trace | 单 timeline + AI Panel | 单 Trace 工具 | 打开普通 Trace、退出对比、切换 workspace、新 Trace reset | 点击“打开双窗” |
| Dual workspace draft | `current` timeline + 一个空 reference 窗口 | 仍是单 Trace 工具 | 点击“打开双窗” | 选择历史 Trace、显式退出、切换 Trace/workspace |
| Dual workspace paired | 同页两个完整 timeline，每个窗口都有 selector | `referenceTraceId` 生效，comparison tools 可用，并带视觉布局状态 | 任一 selector 选择历史 Trace | 显式退出双窗、退出对比、切换 Trace/workspace |
| Comparison context | 单 timeline + 对比栏 | `referenceTraceId` 和 comparison tools 仍可用 | 已配对时显式退出双窗 | 再次打开双窗、退出对比、切换 Trace/workspace |
| Pane minimized | 一个 live iframe + 一个最小化 rail | 两侧仍可分析，最小化侧标记为 `context_only` | 点击 pane 最小化 | 点击 rail 还原、重置、最大化另一侧、退出 |
| Pane maximized | 一个 iframe 占满工作区 | 最大化侧 `live`，另一侧 `context_only` | 点击 pane 最大化 | 再点恢复、重置、退出 |

## 加载与打开流程

### 1. 普通 Trace 加载

1. 用户通过 Perfetto UI 打开 trace。
2. 前端后台上传 trace 到 `/api/traces/upload` 或使用已有 HTTP RPC target。
3. `backendTraceId` ready 后，AI Panel 显示可分析状态。
4. 此时 `referenceTraceId = null`，双窗工作区尚未打开。

如果后台 trace 尚未 ready，对比入口不展示或不可用；双窗不能在缺少 current
backend trace id 的状态打开。

### 2. 直达打开双窗

1. 用户点击 AI Panel header 的“打开双窗”按钮。
2. 前端只要求 current `backendTraceId` 已 ready，不要求预先存在 `referenceTraceId`。
3. Trace 作用域的 workspace controller 立即打开 `ai-trace-pair-workspace`：默认第一个窗口显示 `current`，第二个窗口显示“请选择历史 Trace”的空态。
4. 前端同时读取当前 workspace 的历史 Trace 列表，并按 id 排除 current Trace。
5. 每条历史记录以 `filename` 为主标签；只有同名记录需要区分时才追加本地化上传时间和文件大小。相同 filename 的不同记录仍分别保留，由 id 区分。

此时用户已经进入可操作的双窗壳，但在选择历史 Trace 之前仍是单 Trace AI
上下文，不发送 `referenceTraceId`，也不启用 comparison tools。

### 3. 在任一窗口选择 Trace

1. 两个窗口的 selector 都列出 current Trace 和所有可用历史 Trace。
2. 用户把 current 选到另一个窗口时，只改变 current 的物理位置。
3. 用户在任一窗口选择历史 Trace 时，该历史 Trace 成为唯一的 `reference`，`current` 同时原子移动到另一个窗口。
4. 第一次选择 reference 后，前端保存 `referenceTraceId/referenceTraceName` 并启用 raw trace comparison；更换历史 Trace 时只更新 reference 身份。
5. selector 不允许形成“历史 A + 历史 B”。current parent 始终留在 pair 中。

选择 current 的位置或交换两侧不会重建 iframe。选择新的历史 reference 会更新
reference iframe 的 URL，因此只允许该 reference iframe 加载新 Trace，current iframe
保持不变。

### 4. iframe 加载

双窗打开后，已有 Trace 的 pane 创建 same-origin iframe：

- `hideSidebar=true`
- `mode=embedded`
- `smartperfettoDualTrace=true`
- `smartperfettoPane=current|reference`
- `url=/api/workspaces/:workspaceId/traces/:traceId/file`

`load_trace.ts` 看到 `smartperfettoDualTrace=true` 后跳过 AI backend upload。每个
iframe 使用 Perfetto UI 自己的 WASM engine 加载完整 timeline。空 reference 窗口不
创建 iframe，直到用户选择历史 Trace。

双窗 iframe 是完整 Perfetto timeline，用户可以在每一侧独立搜索、缩放、
选择、展开 track 和查询。主 AI Panel 仍然是唯一对话入口。

## 双窗内操作

| 操作 | 用户入口 | 状态变化 | AI 上下文影响 |
| --- | --- | --- | --- |
| 为窗口选择 Trace | 两个 pane 的 selector | 选择 current 只移动位置；选择历史 Trace 时把它设为 reference，并把 current 原子移动到另一 pane | `primarySide/referenceSide` 按实际物理位置更新；更换 reference 会重置不兼容的 comparison session |
| 左右/上下切换 | 工作区右上工具按钮 | `tracePairLayout = horizontal|vertical`，取消最大化；保留两个 iframe 节点 | `primarySide/referenceSide` 从 left/right 切到 top/bottom |
| 拖拽 splitter | 中间分割线 | `tracePairSplitPercent` 更新，限制在 18 到 82 | `splitPercent` 进入 `tracePairContext` |
| 最大化一侧 | pane toolbar | `tracePairMaximizedTraceSide = current|reference`，清空 minimized；iframe 仍挂载 | 最大化侧 `live`，另一侧 `context_only` |
| 最小化一侧 | pane toolbar | `tracePairMinimizedTraceSides = {side}`，取消最大化；iframe 仍挂载 | 最小化侧 `context_only`，另一侧 `live` |
| 还原最小化 | minimized rail | 从 minimized set 删除该侧；复用原 iframe | 该侧恢复 `live` |
| 在新标签页打开 | pane toolbar | 不改变当前对比状态 | 只是辅助查看；新标签页仍是 embedded trace URL |
| 隐藏/再次显示 AI Panel | AI Panel 入口 | 只切换对话面板；双窗 host、controller 和 iframe 保持 | 无变化 |
| 退出双窗 | 工作区 header | 关闭视觉工作区并销毁其 iframe，清掉 max/min | 已有对比上下文保留，workspaceOpen 变 false |
| 退出对比 | 对比栏退出按钮 | 无 active run 时清掉 reference、agent session、双窗状态；运行中禁用 | 后续请求回到单 Trace |

双窗 host 属于当前 Trace 生命周期，与 AI Panel 的 Right/Bottom/浮窗/隐藏状态平级。
布局切换、最大化、最小化以及 AI Panel hide/show 都复用相同的语义 iframe 节点和
`src`。只有显式退出双窗、current Trace unload 或 workspace 切换会销毁这些 iframe；
再次打开时才重新创建。选择新的 reference 是身份变化，只重新加载 reference 侧。

## AI Panel 上下文契约

前端发送分析请求时，如果 `referenceTraceId` 存在：

```json
{
  "traceId": "current-trace-id",
  "referenceTraceId": "reference-trace-id",
  "options": {
    "tracePairContext": {
      "schemaVersion": 1,
      "layout": "horizontal",
      "primarySide": "right",
      "referenceSide": "left",
      "activeSide": "left",
      "workspaceOpen": true,
      "splitPercent": 50,
      "panes": [
        {
          "side": "right",
          "traceSide": "current",
          "traceId": "current-trace-id",
          "traceName": "current.perfetto-trace",
          "active": false,
          "visualState": "live"
        },
        {
          "side": "left",
          "traceSide": "reference",
          "traceId": "reference-trace-id",
          "traceName": "reference.perfetto-trace",
          "active": true,
          "visualState": "live"
        }
      ],
      "aliases": {
        "左侧": "reference",
        "右侧": "current",
        "上方": "reference",
        "下方": "current",
        "当前": "current",
        "参考": "reference"
      }
    }
  }
}
```

规则：

- 请求顶层 `traceId` 始终是用户最初打开的 current parent；`referenceTraceId` 始终是 selector 选择的唯一历史 reference。
- `current` 与 `reference` 是语义角色，不等于固定物理位置。current 可以位于左/右或上/下，`primarySide/referenceSide`、`panes[].side` 和位置 aliases 必须按 `currentPane` 动态映射。
- 在 current 所在窗口选择历史 Trace 时，前端必须原子更新 `currentPane` 和 reference，不能短暂构造两个 history 或丢失 current。
- 相同 pair 仅交换物理位置时，不改变 `traceId/referenceTraceId`，也不重置 comparison session；reference 身份变化时必须断开不兼容的旧 comparison session。
- `activeSide` 由用户最近 hover/focus 的 pane 决定；双窗未打开时默认 current。
- `visualState=live` 表示该 pane 当前可见；`context_only` 表示它仍可分析，但不是当前可见窗口。
- 后端 normalize 会丢弃非法 side、非法 layout、重复 minimized side，并把 split 限制在 18 到 82。
- System prompt 中只注入结构化映射，不把双窗 UI 文案当作 durable prompt 内容。

## 前后端协同

| 层 | 责任 |
| --- | --- |
| Perfetto UI 主页面 | 打开 current Trace；在 Trace 生命周期内持有 workspace controller 和双窗 host，使其不依赖 AI Panel 是否挂载 |
| AI Panel | 提供直达“打开双窗”入口、加载历史目录、构造 `tracePairContext`、发送 `referenceTraceId` |
| 双窗 selector | 以 filename 为主显示 current/历史 Trace，维护 current 的物理位置和唯一 reference 身份 |
| 双窗 iframe | 用 workspace trace file URL 加载完整 Perfetto timeline；展示状态变化时保持节点和 `src`，不创建新的对比 session |
| `load_trace.ts` | 识别 `smartperfettoDualTrace=true`，跳过后台 AI upload |
| Backend analyze route | 校验/normalize `tracePairContext`，把 `referenceTraceId` 传给 runtime |
| MCP registry | 只有存在 `referenceTraceId` 时暴露 comparison tools |
| Agent runtime | 使用 shared comparison methodology，按 current/reference 或 left/right/top/bottom 取证 |
| Report/snapshot | 保留 raw trace comparison 的 evidence/report/session snapshot 合约，和 CLI `smp compare` 对齐 |

## 边界条件

### 当前 trace 尚未 ready

对比入口依赖 `isInRpcMode && hasBackendTrace`。如果当前 trace 还没上传或注册成功，
用户不能选择 reference，也不能打开双窗。错误应停在 AI Panel 的 backend 状态上，
而不是创建半个双窗。

### 没有可用 reference trace

双窗仍会立即打开：current 窗口可用，另一个窗口显示“请选择历史 Trace”的空态，
并提示先上传另一个 Trace。目录按 id 过滤 current，防止自对比。

### Reference trace 文件不可读

双窗 iframe 会在对应 pane 内表现为 Perfetto 加载失败；AI 分析请求仍会由后端
trace service/SQL 工具报错。UI 不应静默把 reference 换成其他 trace。

### 用户切换新 Trace

新 Trace reset 必须回到 Single trace：

- 清空 `referenceTraceId/referenceTraceName`
- 关闭双窗并销毁已有 iframe
- 清空 max/min 状态
- 清空旧 comparison session bridge
- 创建或恢复新 Trace 自己的单 Trace session

这样避免旧 reference 被误套到新 current trace。

### 用户切换 workspace

workspace 切换会销毁双窗 iframe，并清掉历史 Trace 列表、reference、双窗状态和 agent session。
新的 trace file URL 必须使用新 workspace 的
`/api/workspaces/:workspaceId/traces/:traceId/file`。

### 用户退出双窗后继续对话

`referenceTraceId` 仍然存在，所以后续问题仍是双 Trace raw comparison。模型会看到
`workspaceOpen=false`，应理解为“视觉双窗已退出并释放 iframe，但 reference Trace 仍可分析”。
再次点击“打开双窗”会为相同 pair 重新创建 iframe。

### 用户退出对比后继续对话

退出会清掉 `referenceTraceId` 和对比 agent session。后续请求不注册 comparison tools，
也不携带 `tracePairContext`。

### 最小化/最大化后继续对话

AI 不应把隐藏侧当作不存在。隐藏侧仍可通过 SQL/Skill 分析，只是在回答中标注它是
context-only。最大化、最小化、还原和布局切换只使用 CSS/状态改变可见性，两个已加载
iframe 的 DOM 节点和 `src` 保持不变。只有 Trace 加载或 backend 查询失败，才算该侧不可用。

### AI Panel 隐藏或位置切换

AI Panel 的隐藏/再次显示以及 Right/Bottom/浮窗位置只影响对话面板，不卸载双窗，
不改变 current/reference 语义，也不重新加载 iframe。双窗 host 是 Trace 页面级视图。

### 用户通过 selector 调整窗口内容

把 current 选到另一窗口只交换物理位置，复用两个 iframe。选择新的历史 Trace 会改变
reference 身份并只加载 reference iframe。产品不允许把 current 替换掉后再选择第二条
历史 Trace，因此不会形成任意“历史 A vs 历史 B”的 pair。

### 多轮 session

进入对比会断开不兼容的单 Trace agent session。退出对比也会断开 comparison session。
Provider/runtime pinning 继续遵守普通 session 规则，不能因为对比模式静默切换 provider。

## 完成标准

双 Trace 工作区相关改动完成前，需要至少证明：

- 普通打开 Trace 时默认是单窗。
- 点击 AI Panel header 的“打开双窗”后，立即出现 current + 空 reference 的双窗壳，无需先选历史 Trace。
- 两个窗口的 selector 都可用；在 current 窗口选择历史 Trace 时，current 原子移动到另一窗口。
- 历史项以 filename 为主、时间和大小为辅，相同 filename 的不同 id 仍可分别选择。
- 选择 reference 后同页出现两个完整 Perfetto timeline，且 pair 始终是 current parent + 一个历史 reference。
- 左右/上下、拖拽、最小化、最大化和 AI Panel hide/show 不会替换或重新加载已有 iframe。
- 分析运行中 selector 和所有会话身份切换入口保持锁定，但布局操作、AI Panel
  hide/show 和相同 pair 的视觉重开不会停止或替换当前 run。
- 运行中 Settings、workspace、backend URL/access token 和 Provider 写操作保持锁定；
  pre-session hide/show 保留同一个 Stop owner，已建立的 SSE 也不会因折叠而重连。
- 显式退出双窗、Trace unload 和 workspace switch 会销毁 iframe；退出对比会额外清掉 reference 和 comparison session。
- 双窗 iframe 不会新增后台 trace 上传。
- 双窗 iframe 只保留时间线与父窗重绘桥，不注册 AI Panel、状态入口或独立 session owner。
- Stop 请求携带当前回执的精确 `runId`；同一 session 的新 run 要等旧 runtime 真正退出后才可启动，
  因而旧 run 的迟到清理不能中止或污染新 run。
- `tracePairContext` 在 current 位于任一物理窗口、双窗打开/退出、上下布局、max/min 状态下都符合契约。
- Backend normalize 和 system prompt 能稳定处理非法/缺失字段。
- `frontend/` 预构建已刷新，`./start.sh` 路径能拿到相同行为。
