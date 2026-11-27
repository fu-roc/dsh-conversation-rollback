# dsh-conversation-rollback 设计文档

> 目标：给 DeepSeek Harness 加一个「回退对话」插件——在任意一条用户消息上点一下，把该消息及其之后的全部内容从这个会话里抹掉，聊天界面看起来像从没发生过，模型上下文里也确实不存在了。
>
> 状态：设计已定稿，待 review。本文档只描述设计，不含完整实现代码。

---

## 1. 产品定义

### 1.1 一句话

用户消息悬停时出现一个「回退到这里」图标按钮，点击 → 确认 → 当前会话被就地截断到该消息之前，该消息的文字回填到输入框等待编辑重发。

### 1.2 与「分叉（fork）」的区别

DSH 已经内置 Fork（`session.fork`，sidebar 右键 / 快捷键），但 Fork 的语义是**开一个新会话**、旧会话完整保留。本插件要的是**同一个会话 ID 就地回退**，不产生新会话、不留分支。这是本插件存在的全部理由。

### 1.3 核心使用场景

- 高频：说错话了、跑歪了，想撤掉最后 1–2 轮重来。
- 低频：回退到很早的一条消息，重开一条思路。
- 极端：回退到第一条消息 → 整个会话清空，会话 ID、标题保留，聊天区回到官方空状态页。

---

## 2. 决策清单（已定，不再讨论）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 回退语义 | **就地回退当前会话**，session id 不变，不 fork |
| D2 | 回退后动作 | 被点消息**纯文字**回填输入框 + 自动聚焦，**不自动发送** |
| D3 | 图片/附件 | 不回填，只带纯文字 |
| D4 | 按钮位置 | 用户消息的**复制按钮旁边**（图标行内，同款样式） |
| D5 | 按钮可见性 | **任意用户消息**都显示（不只最后一条） |
| D6 | 挂载对象 | 只挂用户消息（含 steering 插话），不挂助手回复 |
| D7 | 回退边界 | **被点的那条消息本身也删掉**（编辑重发语义） |
| D8 | 删除范围 | 该消息**及其之后的所有内容** |
| D9 | 确认 | 点击后**原生 Modal 确认框**，显示「将删除 N 条消息」+ 不可恢复警告 |
| D10 | 确认框附加信息 | 不显示首尾消息摘要，不提示覆盖草稿 |
| D11 | 可恢复性 | **不提供任何恢复入口**（无快照、无历史面板、无 undo） |
| D12 | 删除彻底程度 | **逻辑删除**：界面不渲染 / 模型看不到 / 搜索不到 / 刷新重开保持；磁盘日志保留原始记录 |
| D13 | 持久化 | 写日志事件，刷新 / 重开 / 重启后状态保持 |
| D14 | 界面表现 | 被回退轮次**从聊天界面直接消失**（不做灰条折叠，不做半透明） |
| D15 | 轨迹视图 | trajectory 视图同样隐藏 |
| D16 | 搜索 | 会话内 / 跨会话搜索都搜不到被回退内容 |
| D17 | 模型感知 | **完全无缝**：不在系统提示留备注，不让模型知道发生过回退 |
| D18 | 工具副作用 | 不管文件改动，不回滚工作区；只回退对话与内容类状态 |
| D19 | 运行中点击 | 自动 cancel 当前轮，然后执行回退 |
| D20 | 非对话状态 | 一并回退 **todo / 计划模式**（`goal` 不回退，见 §8 与 README「已知限制」）；模型选择、权限、沙箱、审批策略、工作目录、agent 预设**保持不动** |
| D21 | 后台任务 | 被回退轮次里启动且仍在跑的子代理 / 后台作业**一并取消** |
| D22 | 排队消息 | 待发送的排队消息（pending steering）**一并丢弃** |
| D23 | 多次回退 | **支持连续多次**，每次叠加新的遮蔽记录 |
| D24 | 首条消息 | **允许**回退，即清空整个对话，确认框警告更重 |
| D25 | 空会话形态 | 同一 session id、标题保留、历史日志保留；聊天区显示**官方空状态页** |
| D26 | 标题 | **仅当回退到第一条**时清空标题让它重新自动命名；中间回退不动标题（⚠️ 官方 `rename()` 拒绝空串且会 pin 标题，需绕过它自己 append `session/title title:''`，见 U2） |
| D27 | 多窗口 | **实时同步**到所有窗口 / 标签页 |
| D28 | 交互反馈 | 点击后短暂 loading；期间输入框、发送按钮、其它回退按钮**全部禁用** |
| D29 | 失败处理 | 用 DSH 自带 workspace toast 报错，历史保持不变 |
| D30 | 成功反馈 | **静默**，不弹 toast |
| D31 | 快捷键 | **不做**（按钮唯一入口）；无斜杠命令；无遥测 |
| D32 | 设置项 | 插件设置页卡片，**一个开关**：「回退后自动回填输入框」，默认开 |
| D33 | i18n | en + zh-CN 双语，跟随系统语言 |
| D34 | 交付 | 先本地装到 profile 验证 → 验证通过后包成 npm 包 `dsh-conversation-rollback` |
| D35 | 发布元信息 | MIT 许可证 + 完整 README（安装/使用/限制/已知问题） |
| D36 | 版本兼容 | 宽松声明（如 `engines.dsh: ">=0.2.0"`），不锁死 `^0.2.2-rc.5` |

---

## 3. 技术方案

### 3.1 为什么不能「物理删除」日志

这是整个方案的根基，必须说清楚：

1. **会话日志严格 append-only**。`seq` 就是日志行号，事件从 seq 0 连续排列，JSONL 后端永不重写（`docs/subsystems/persistence.md:342,377`）。
2. **seq 被到处引用**。`sourceEventSeqs`、节点的 `anchorSeq`、turn/step 编号、fork 边界、`request/header` 关联……删掉中间一条事件，后面所有引用全部错位。
3. **DSH 没有提供任何「重写日志」的 API**。唯一的物理截断是持久化后端在**尾帧损坏**时的崩溃修复（`truncateTornTail`），不是可编程接口；崩溃恢复也不会截断日志，只补 `interruptedTurnClosers`。
4. **强行改文件 = 会话损坏**。下次加载时序列连续性校验会直接失败。

所以「删除」在 DSH 里只有两层含义，本插件两层都做：

- **模型层**：用 surface `replace` 把事件从派生历史里遮蔽 → `deriveMessages()` 不再产出它们。
- **界面层**：前端 conversation Definition 认领这些事件并返回 `visibility: 'hidden'` → chat 与 trajectory 都不渲染。

「保留原始日志」不是偷懒，是唯一安全的做法；而且它顺带满足了 D12「刷新后状态保持」——重放日志时遮蔽关系还在，模型历史和界面隐藏都能复现。

### 3.2 核心机制：surface replace

`SurfaceOp`（`docs/subsystems/session.md:320-351`）的契约：

```ts
type SurfaceEventType = 'system/message' | 'developer/message' | 'user/message'
                       | 'assistant/message' | 'tool/result'
type SurfaceOp = 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }
```

- `replace` 把**当前 surface 上**从 `startSeq` 到 `endSeq`（含端点）的节点整体替换成新节点。
- 两端必都存在于当前 surface；端点顺序按 **surface 顺序**而非 seq 大小。
- `sourceEventSeqs` **必须覆盖全部被遮蔽的节点**，否则 append 时直接抛错：
  `surface replace: sourceEventSeqs must include every shadowed surface node; missing …`
- 官方注释明确：`Used by compaction; any surface-replacing producer may use it.` → 第三方插件写 replace 完全合法。

`deriveMessages()` 是模型可见历史的唯一来源，`replace` 会把被遮蔽节点从派生历史里删掉（`session.md:697-710`）。

**关键约束（必须遵守）**：

1. **不能遮蔽 surface node 0 的 `system/message`**。V3 规则：首个 system head 只能被另一个 system message 恰好覆盖着替换，普通 replace 与 compaction 都无法消费它（asar 111036359）。→ 回退到第一条时，遮蔽范围从**第一条 `user/message`** 开始，系统提示留在 surface 上。
2. **`assistant/message` 不能带 `sourceEventSeqs`**（它自带 stream）。→ 替换用的新节点选 `user/message` 最方便。
3. **replace 端点必须早于新事件**：`startSeq < event.seq && endSeq < event.seq`。
4. **替换节点本身会成为 surface 节点**：它必须是一条「语法上合法、内容上无害」的消息。方案是写一条 `user/message`，`source` 为内部标记，`content` 为空——`deriveEventMessage` 对 `user/message` 直接返回 `event.data`，空 content 也是合法消息（区别于 assistant 空 content 被跳过）。它会在模型历史里占一个空用户消息位；**这一点在 §5 风险 R2 里给出消除办法**。

### 3.3 事件设计

插件声明一个自有 log-only 事件（declaration-merge `SessionEventMap`），形状照抄 `compaction/prune`：

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'rollback/prune': {
      /** 被遮蔽的 seq 区间（含端点） */
      readonly shadowedRange: { readonly start: SessionSeq; readonly end: SessionSeq }
      /** 全部被遮蔽的 seq（与 shadowedRange 一致，但保留显式列表便于校验） */
      readonly shadowedSeqs: readonly SessionSeq[]
      /** 用户可感知的「消息条数」，用于确认框与审计 */
      readonly messageCount: number
      /** 被回退掉的 turn 数 */
      readonly turnCount: number
      /** 被点的那条用户消息 seq（回填来源） */
      readonly originSeq: SessionSeq
      /** 回退时的 ISO 时间戳，仅用于调试 */
      readonly at: string
    }
  }
}
```

log-only 事件：不带 `surfaceOp`、不产生派生历史、不属于任何 SurfaceEventType（`session.md:781` 已确认允许插件如此声明）。

**写入顺序**（与 `compaction/prune` 的契约同构：pricer 事件必须紧贴 replace 之前）：

```
1. rollback/prune            ← log-only，记录遮蔽范围
2. user/message + replace    ← 同一批 append，紧随其后
3. todo/write                ← 回退后的 todo 快照（若需要）
4. plan/mode                 ← 回退后的计划模式状态（若需要）
5. session/title (title:'')  ← 仅回退到第一条时
```

1 和 2 必须**同一次 `session.append([...])`** 提交，保证「有 replace 必有 pricer 事件」的原子性；3–5 可以在同一批里，也可以分后续批次（都不影响正确性，因为它们都是 last-write-wins）。

**为什么状态类事件可以「重放回退」**：`todo/write`、`plan/mode`（不含 `goal/change`，理由见 §8）全是 log-only + last-write-wins（`persistence-catalog.md:1080-1084 / 728-736 / 556-562`）。要回到某个时间点的状态，只需按**回退点当时的投影值**再追加一条同样的快照事件，重放自然收敛到那个状态——不需要改写历史，也不需要「反向 diff」。

### 3.4 回退点的精确定位

前端只传「被点的用户消息 seq」（`originSeq`），host 端负责把它翻译成遮蔽区间：

1. `startSeq` = 当前 surface 中 **seq ≥ `originSeq` 的第一个节点**。正常情况就是 `originSeq` 本身（被点的那条用户消息是 append-origin surface 节点）；若命中不到（已回退过，或前端传来的是非 surface 锚点如被折叠的节点），直接报错 `that message is no longer in the visible conversation`，**不允许顺延到下一个节点**（顺延会在多窗口/未刷新场景下静默多删一轮，见 §8）。**D7 要求被点的消息本身也被删掉，所以 `startSeq` 就是它，而不是它的前一条。**
2. `endSeq` = 当前 surface 的**最后一个节点**（D8：其后全部内容一并回退）。
3. **越界校验**：若 `startSeq` 或 `endSeq` 命中的是 node 0 的 `system/message` → 直接拒绝（见 §3.2 约束 1）；若 `originSeq` 已在 `shadowed` 集合里（重复回退同一条）→ 拒绝并提示。
4. 从日志里遍历 `[startSeq, endSeq]`，收集：
   - `job/registered` 的 jobId → 取消后台任务（D21）
   - `assistant/message` / `user/message` 的条数 → 确认框的 N 与 `messageCount`
   - `turn/start` 数 → `turnCount`
   - 最后一次 `todo/write` / `plan/mode` **在 `startSeq` 之前**的值 → D20 的恢复目标（`goal/change` 不重放，见 §8）

**首条消息的特判**：若 `startSeq` 恰好是第一条用户消息，遮蔽后 surface 只剩 `[system head, 替换节点]` → 会话等效为空，前端自然走官方空态页（D24/D25）。

### 3.5 前端隐藏（「澈无痕迹」的实现）

问题：聊天渲染只读 **append-origin** 事件（`isAppendSurfaceEvent`），被 replace 遮蔽的事件**仍然是 append-origin**，所以 UI 照样渲染——这是有意的设计（压缩后旧消息仍可见就靠它）。

官方隐藏机制：节点 `visibility: 'hidden'`。`legacyContribution` 里
`if (raw.visibility !== 'visible' && node.kind !== 'assistant-step') return EMPTY_CONTRIBUTION`——hidden 节点不贡献任何渲染内容。`conversation.md:255` 明确要求：已发布节点要离开可见流时，返回**同一个 key** 并改 `visibility`，而不是返回 `null` 撤回。

方案：插件注册自己的 conversation Definition，**在官方 Definition 之前 exclusive 认领**被遮蔽的事件：

- chat target：认领 `user/message` / `assistant/message` / `tool/result` 中 `surface === 'shadowed'` 的那些，`buildViewNode` 返回 `visibility: 'hidden'`、固定 key（同一个 key 稳定复现）。
- trajectory target：**必须单独注册**一份（chat 与 trajectory 是两套 target，各自 dispatch，互不影响）；trajectory 的 `trajectory-input-message` 定义不看 surface，所以它一定会认领被遮蔽的 user/message——插件要用 exclusive 抢在它前面。

`exclusive` 的语义（官方 JSDoc）：认领后**同一 target 的其它 Definition 都收不到这条事件**，且该 target 的 unmatched fallback 不执行；同一 target 上两条 exclusive 认领会抛错。因为官方 Definition 对已认领的事件不再建 Context，所以整行（含轮尾动作栏）都不会渲染。

#### 3.5.1 必须一起处理的「残留行」

只隐藏消息事件是不够的，这几种节点不挂在被遮蔽的消息上，需要显式处理：

| 残留 | 为什么不会自动消失 | 处理 |
|---|---|---|
| **轮尾行（turn-tail）** | `turnTailDefinition` 由 `turn/start` 起 Context、`turn/end` 产出节点（`groupTree:'turn'`），而 `turn/start` / `turn/end` 是 log-only 事件、**永远不会被 shadow**。所以被回退轮次的尾部行（含 fork 按钮、token 用量）仍会渲染 | 对**整轮都在回退区间内**的 turn，插件在 chat target 上 exclusive 认领它的 `turn/start`，使官方 `turn-tail`（以及其它以 turn/start 起头的 Definition）不为该轮建 Context。这是唯一不接管官方渲染器的干净做法 |
| **process 分组 / 空白组** | 隐藏节点的 `legacyContribution` 返回空，但分组容器本身仍可能留白 | 验收时专门看「连续回退多轮」的场景；必要时对 `assistant-step` 也用同 key + hidden（`legacyContribution` 对 `assistant-step` 有例外分支，需实测） |
| **trajectory 的 requests 面板** | 按 seq 的请求视图，不读节点 `visibility`（R3） | 已知限制，写进 README |

> 验收标准（M2）：回退后**滚动到底、键盘上下翻页、切到 trajectory 再切回**，都看不到任何被回退轮次的行。这是「澈无痕迹」的实测定义。

### 3.6 按钮

挂载点：`conversation.chat.user.before`（chain slot，scope session，owner props `{source, kind}`）。

- 这是官方在 `user` 节点注册时声明、并在气泡上方 `renderSlotChain` 渲染的插槽。
- 用 `select(owner)` 只认 `source === null`（真人输入）与 steering 行，系统注入的消息（AGENTS.md、skill 内容、goal 续轮等）不显示按钮。
- 样式复用图标行的契约：28px 方形、`--dsw-radius-sm`、`--dsw-alias-label-tertiary`、hover 时 `--dsw-alias-interactive-bg-hover`、`15px` 图标；`@media (hover:hover)` 下默认 `opacity: 0`，hover/focus-within 变 1（与非末轮动作栏现有行为一致）。
- 点击 → 弹 `Modal`（`@deepseek-ai/dsh-client-ui-primitives`）→ 确认 → 调 Remote。

> 注：`MessageIconActions` 有一个 `extraActions` 插位（注释写明是给插件用的），但用户消息那条路径没有把 `extraActions` 传下去（只有助手轮尾传了 `assistantActions`）。所以真正能用的只有 `conversation.chat.user.before`，不能塞进复制按钮那一行内部——这是插件 API 的现状限制，视觉上做成「紧贴气泡上方的一行同款图标」是能做到的最接近形态。

### 3.7 Host 端 Remote

`sessionController` 没有任何 rollback / truncate / delete 方法（已核对完整 `@Remote` 清单），所以插件自带一个服务，挂两个方法：

```ts
@Remote('rollback') async rollback(request: RollbackRequest): Promise<RollbackValue>
// RollbackRequest { sessionId, originSeq, refillText? }
// RollbackValue   { removedMessages, removedTurns, sessionEmptied }

@Remote('rollbackPreview') async rollbackPreview(request): Promise<RollbackPreview>
// 返回 { messageCount, turnCount, willEmptySession, jobCount }
// 供确认框显示「将删除 N 条消息」
```

**执行流程**（`rollback`）：

1. 取 `Session`；若当前有 open turn → 先 `sessionController.cancel({ sessionId })` 并等 turn 收尾（D19）。**更彻底的替代**：`ctx.agents.get(sessionId).cancel(cause)` + `await agent.whenIdle()`，它同时清 inbox 并等到真正静止。
   - 实现用 `waitForIdle(agent, IDLE_TIMEOUT_MS)`（`IDLE_TIMEOUT_MS = 15_000`）：`whenIdle()` 用 `Promise.race` 加超时，返回 `true`=已静止 / `false`=超时。超时不中止回退，只 `ctx.logger.warn`，避免一个卡死的工具把回退永久挂住。
2. 丢弃 pending inbox（D22）：`ctx.agents.get(sessionId)?.inbox.clear()`（durable cancel，写 `agent/inbox/spliced`）。若第 1 步用的是 `agent.cancel(...)` 而非 `sessionController.cancel`，注意它**默认已经清空 inbox**，别重复。
3. 算出遮蔽区间与各种计数（§3.4）。
4. 取消区间内的后台任务（`ctx.jobs.kill`，D21）。
5. 计算 todo / plan 的回退目标值（区间开始前的最后快照）。
6. `session.append([...])`：`rollback/prune` + `user/message{replace}` + 状态类事件 + 可能的 `session/title`。
7. 返回计数给前端；前端 `inputActions.setDraft(text)` 回填（若开关开启）+ 聚焦（总是执行）。

**并发**（D27 / 多窗口）：所有窗口订阅同一个 session 事件流，遮蔽事件一到，各窗口的 conversation 重建、按钮重新计算可用性。host 端对同一 session 的 rollback 加**单飞闩锁**：`singleFlight(session.id, () => rollback(...))` 用模块级 `ROLLBACKS_IN_FLIGHT: Map<string, symbol>` 记在飞的键，同键第二个请求立即 `reject` 一个 `RollbackBusyError`（`code: "busy"`），不排队、不等待；释放时先比对 identity 再 `delete`，确保迟到的释放不会摘掉新持有者的锁。HTTP 层把错误序列化成 `{ ok: false, error, code }`，client 读到 `code === "busy"` 时提示「另一个窗口正在回退这个会话」。

**边界**：闩锁是进程内的。两个 DSH 进程（两个桌面实例）指向同一份会话日志时彼此不可见，这一点写进 README「已知限制」。

**降级路径**：闩锁只管插件自己的入口；即使有并发，`planRollback` 也会因为 `nodes[index] !== originSeq` 拒绝第二次回退（§3.4 第 1 步），最坏结果是一次失败的 RPC，不会算错区间。

### 3.8 搜索

**天然满足**（D16）：`sessionController.search` 内部固定带 `{kind:'surface', values:['current']}` 过滤器，并二次校验 `hit.bestMatch.surface !== 'current'` 就丢弃。被遮蔽的内容是 `shadowed`，搜索根本查不到。插件不需要为此写任何代码。

### 3.9 设置

插件设置页卡片「对话回退」，一个 `Volatile<boolean>` 开关「回退后自动回填输入框」（默认 `true`），按 `cookbook/adding-a-settings-card.md` 的范式实现：Config 用 `z.boolean().default(true).volatile()`，读用 `.get()`，监听 `ctx.on('loader/volatile-update', …)`。

### 3.10 包结构

```
dsh-conversation-rollback/
├── package.json          # type:module, main:lib/index.js, dsh.bundle.patch, dsh.client
├── cordis.patch.yml      # insert 一个 plugin entry，带防重复挂载守卫
├── LICENSE               # MIT
├── README.md             # 安装/使用/限制/已知问题
├── icon.svg
├── locale/{en,zh}.json
├── src/
│   ├── index.ts          # host 侧 plugin 入口
│   ├── rollback-service.ts   # @Remote 服务
│   ├── plan.ts           # 遮蔽区间计算（纯函数，好测）
│   ├── events.ts         # rollback/prune 声明
│   └── client/
│       ├── index.tsx     # client 侧 plugin 入口
│       ├── RollbackButton.tsx
│       ├── RollbackConfirm.tsx
│       ├── hidden-definition.ts   # 隐藏被遮蔽事件的 Definition
│       └── *.module.css
└── lib/                  # 构建产物
```

`package.json` 的 `dsh.client.inject` 需要：`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/dsh-client-ui-chat`、`@deepseek-ai/dsh-client-ui-primitives`。

peer 依赖参照 `dsh-better-sidebar` 的实物清单，版本用宽松范围；`@deepseek-ai/schemastery` 进 dependencies；`@deepseek-ai/cordis` 同时进 peer 与 dev。

---

## 4. 实现里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | host 侧：事件声明 + 区间计算纯函数 + Remote | 单测覆盖区间计算；手动 `append` 后 `deriveMessages()` 确实变短 |
| M2 | 前端隐藏 Definition（chat + trajectory） | 刷新后聊天区与轨迹区都看不到被遮蔽消息 |
| M3 | 按钮 + 确认框 + loading/禁用态 | 真会话点击可用，多窗口同步 |
| M4 | 状态回退（todo/plan）+ 后台任务取消 + pending 丢弃 | 逐项手测 |
| M5 | 设置卡片 + i18n + README + 打包 | 装进 profile 后开关生效；`pnpm build` 通过 |

每个里程碑都在**新开的测试会话**里验证，绝不动用户正在用的工作会话。

---

## 5. 风险与降级路径

| # | 风险 | 影响 | 应对 |
|---|---|---|---|
| R1 | **替换节点占位**：replace 必须插入一个新节点，方案是空 content 的 `user/message`，它会在模型历史里留下一条空用户消息 | 模型可能对空消息感到困惑（实测影响很小） | 若真有问题，改用 `developer/message`（不参与人类 transcript，但会进模型历史）或给 content 一个零宽占位符；**兜底降级**：接受一条空消息 |
| R2 | **前端 exclusive 抢不过官方 Definition** | UI 仍显示被回退内容 | D 决策已授权降级：**先保证模型层正确**，前端隐藏做不到再商量。届时的说法是「刷新后看不到、当前窗口可能有残留」 |
| R2b | **轮尾行（turn-tail）不会随消息自动消失**：它由 `turn/start` 起 Context、`turn/end` 产出，两个都是 log-only 事件、永不被 shadow | 被回退轮次底部仍留一行（fork 按钮 / token 用量）| 对整轮落在回退区间内的 turn，exclusive 认领它的 `turn/start`（§3.5.1）；M2 验收必须覆盖这个场景 |
| R3 | **其它窗口/其它视图残留** | 小概率 | 已确认多窗口共享事件流；trajectory 的 `requests`（按 seq 的请求视图）不受节点 visibility 影响，可能露头——列入已知问题 |
| R4 | **首条消息回退不能动 system head** | 无影响（本来就不该动） | 遮蔽范围从第一条 `user/message` 开始；system 保留在 surface 上 |
| R5 | **清空标题注定要绕过官方 API**：`SessionTitleService.rename()` 对空标题直接抛 `SessionTitleInvalidError("session title must contain visible characters")`，且它写入的 `session/title` 带 `source:{kind:'user'}` 会**pin 住标题**（注释原文：in-flight automatic generation is superseded and later user messages schedule none）。`foldSessionTitle` 是纯「最后一条胜出」，没有 tombstone | D26 若坚持「清空后自动重新命名」，用 rename 必然做不到 | 只能自己 `session.append('session/title', { title:'', messageSeqs:[], source:{kind:'fallback'} })` 绕过校验（见 U2）；做不到就降级为「保留原标题」并写进已知限制 |
| R6 | **cancel 与 append 的时序**：cancel 后 turn 收尾是异步的，可能在收尾事件上撞 append | 回退失败 | host 端等 `turn/end` 后再 append；带超时；失败回滚为「未发生」并 toast |
| R7 | **两窗口并发回退** | 区间算错 | 已实现：`singleFlight` 单飞闩锁，第二个请求 `RollbackBusyError`（`code:'busy'`），client 出「另一个窗口正在回退」。**残留**：仅进程内有效，多进程（两个桌面实例）无互斥，写进 README 已知限制 |
| R8 | **pending inbox 清空**：~~没有公开 API~~ **已核实有**——`agent.inbox.clear()`（`docs/subsystems/core.md:285-345`，`Agent` 通过 `ctx.agents.get(id)` 拿到） | ~~D22 可能做不到~~ 无障碍 | `Agent.cancel(cause, {keepInbox})` 默认**会**清空排队工作；本插件希望「取消当前轮但稍后自己清 inbox」，可先 `agent.cancel({kind:'…'})`（默认清空）或 `cancel(..., {keepInbox:true})` 后再 `agent.inbox.clear()`。二者皆可，取默认（更简单） |
| R9 | **DSH 升级导致内部 API 变动** | 插件崩 | 只用文档化的公开 seam（surface / Definition / slot / Remote）；`engines.dsh` 写宽松范围但 README 注明「仅在 0.2.2-rc.5 实测」 |

---

## 6. 未决点（实现时验证，不阻塞设计）

- **U1 — pending inbox 清空：已解决**。`Agent.inbox`（`ctx.agents.get(sessionId).inbox`）暴露 `nextTurn` / `nextStep` / `clear()` / `append` / `prepend` / `replace` / `remove` / `splice`，全部是「durably cancel」语义并写 `agent/inbox/spliced` 事件（`docs/subsystems/core.md:283-345`）。回退时直接 `inbox.clear()` 即可满足 D22；**注意 `Agent.cancel()` 默认也会清 inbox**，但顺序上应先算区间再清，避免影响计数。
- **U2 — `session/title` 空串语义（已取证一半）**：`rename()` 明确拒绝空串并会 pin 标题，所以 D26 必须**绕过 `sessionTitle.rename`**，直接 `session.append('session/title', { title:'', messageSeqs:[], source:{kind:'fallback'} })`。仍需实现时验证两点：(a) `session/title` 的 schema 是否接受空串（`SessionTitleEventData.title` 注释写的是 “Normalized non-empty title text”，可能只是 rename 的输入约束而非 schema 约束）；(b) 自动命名调度读的 host-only projection `titleInput`（`{first,count,lastSeq}`，`init` 为空、`apply` 只累加）**不会因为回退而回退**——它的 `apply` 只看 `sessionTitleUserMessageOf(event)`，被遮蔽的消息仍是 append-origin，所以仍会被计入。若 provider 的 automatic 模式是 `first-prompt`，标题会一直沿用被回退消息生成的那个；只有 `all-prompts` 才会随新消息重算。**若验证失败，D26 降级为「保留原标题」。**
- **U3 — `rollbackPreview` 的性能**：确认框要在点击瞬间拿到 N，需要扫描日志区间。对超大区间（几万事件）可能慢；必要时改成前端按已加载窗口估算 + 二次精确校验。
- **U4 — 隐藏 Definition 与分页**：被遮蔽事件仍会随分页下发到客户端（`paginate` 只看 append-origin）。隐藏 Definition 拿得到它们，但这意味着网络流量没省。属于「可接受」，不优化。

---

## 7. 明确不做

- 不做 undo / 恢复面板 / 快照（D11）。
- 不做文件系统回滚（D18）。
- 不做分叉（已有内置 fork）。
- 不做快捷键 / 斜杠命令（D31）。
- 不做遥测（D31）。
- 不做「显示/隐藏回退按钮」总开关（只保留自动回填开关）。
- 不回填图片与附件（D3）。
- 不回退模型选择、权限模式、沙箱模式、审批策略、工作目录、agent 预设（D20）。

---

## 8. 实现修订（2026-11-26，以代码为准）

本节记录实现过程中被证伪或被降级的设计点，避免文档与代码不一致。**发生冲突时以代码与 README 为准。**

| 设计点 | 原设计 | 实际实现 | 原因 |
| --- | --- | --- | --- |
| §3.3 写入顺序 `1. rollback/prune` | 自定义 `rollback/prune` 事件记录遮蔽范围 | **不写自定义事件**，只写一条带 `surfaceOp: replace` 的空 `system/message` | DSH 禁止第三方插件 append 新事件类型（`plugin-practices` 明令）；且 live `Session.append()` 无法设置 `ignorable: true`，写进去会让会话无法重新打开。遮蔽范围可由 `surfaceOp.startSeq/endSeq` + `sourceEventSeqs` 反推 |
| §3.3 第 5 步 `goal/change` | 重放回退点前的 goal 快照 | **不回退 goal**（`STATE_EVENTS` 只有 `todo/write`、`plan/mode`） | `dsh-goal/src/fold.ts` 的 `requireNextRevision` 要求 `next.revision === current.revision + 1`，重放旧快照必然违反；`applyGoalProjection` 会把错误记进 `state.failure`，导致该会话 goal 服务**永久**报错（实测复现：`goal replay failed at session event 8464: goal complete must advance the current goal by one revision`） |
| §3.3 第 6 步 `session/title (title:'')` | 回退到第一条时清空标题 | **不做**，保留原标题 | U2 验证结果：写空串能过日志校验，但标题投影 schema 是 `z.string().min(1).nullable()`，会让投影状态非法。见 README「已知限制」 |
| §3.4 第 1 步「顺延到下一个 surface 节点」 | 允许 `startSeq` 吸附到下一个节点 | **禁止吸附**：`nodes[index] !== originSeq` 直接报错 `that message is no longer in the visible conversation` | 吸附会在多窗口/未刷新场景下静默多删一轮内容，比报错危险 |
| D9「原生 Modal」 | `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal` | **自绘 Overlay**，样式对齐官方 dialog：`--dsw-alias-bg-layer-2`、`--dsw-radius-panel`、`--dsw-elevation-prominent`、`--dsw-alias-bg-mask-1` + `--dsw-mask-blur` | 官方 `plugin-practices` 禁止第三方包 require `dsh-client-ui-primitives`。自绘不引入新依赖，亮/暗主题实测跟随 |
| §5 按钮样式 | `@media (hover:hover)` 下默认 `opacity: 0`，hover 变 1 | **常驻显示**，hover/focus 时加 `--dsw-alias-interactive-bg-hover` 背景 | 常驻更容易被发现；隐藏态会降低可发现性且在小屏/触摸设备上不可用 |
| D2 / §3.6「回填 + 自动聚焦」 | `InputActions.setDraft` + 聚焦 | `setDraft` + `ctx.conversation.input.for(ctx.sessions.scope(id)).focus()` | `InputActions` 没有 `focus()`；per-session 的 `SessionInput` facade 才有，且必须传 session-scope ctx。**注**：曾误写成 `ctx.uiConversation.input.for(binding.ctx)`，两处成员都不存在（`UiConversation` 无 `input`，`ConversationBinding` 无 `ctx`），该写法是死代码，见 REVIEW §9.2 |
| D20「todo/plan/goal 一并回退」 | 三类都重放 | `todo`/`plan` **仅当被删区间内确实出现过该事件时才重放** | 无条件重放会往日志里灌入与回退无关的空操作事件 |
| 依赖声明 | `dsh.client.inject` + `peerDependencies` | 只声明 `@deepseek-ai/cordis`（与官方包一致），client 依赖走 `dsh.client.inject`（`react`、`dsh-client-locale`、`dsh-client-ui-slots`） | 官方 `dsh-client-ui-goal/package.json` 同样只把 cordis 列进 peerDependencies |
| `locale/` 目录 | 随包发布 en/zh JSON | **删除该目录**，词条内嵌在 `lib/client.js` 并用 `ctx.locale.register` 批量注册 | 那两份 JSON 从未被任何代码引用，属于死资源 |
| 单次回退互斥 | 未涉及 | `singleFlight(sessionId, …)` + `RollbackBusyError(code: 'busy')`；HTTP 回 `{ ok:false, error, code }`，client 按 `code` 出提示 | 借鉴同类插件「同一目标串行」的做法；闩锁在 RPC 入口处，不排队而是立即拒绝，避免两个窗口各自 cancel/jobs.kill 后只成功一个 |
| 等待轮次收尾 | `await agent.whenIdle()` 无上限 | `waitForIdle(agent, 15_000)`：超时返回 `false` 并 `ctx.logger.warn`，继续回退 | 卡死的工具会让无上限等待把回退永久挂住；15 秒足够覆盖正常收尾，超时后区间仍按当前 surface 计算，结果正确 |

