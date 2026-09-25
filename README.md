# dsh-approval-policy — 无人值守审批门控

> dsh 插件：给声明为无人值守的审批请求（subagent / 定时 / cron）加一道**有界应答窗口**——
> 先把请求交给下游交互面，**窗口内有人答就用人的答案**，窗口耗尽则按 fail-closed 默认裁决落定，
> **turn 立即落地，不再无限挂起**。交互会话默认零改动。

**要求 dsh >= 0.1.7-rc.1**（`package.json` 以 `peerDependencies` 声明该地板——dsh 0.1.7 起官方安装预检读取插件 peerDependencies 做兼容性检查）。

> **简体中文** · [English](README.en.md)

## 为什么要做

rc.3 起的 dsh 有一个空档：**approval 可能永不落地**。没人盯着的时候（无浏览器、或浏览器
闲置），交互 answerer 注册着却永不应答；cordis waterfall 的 veto 语义下，链首 answerer 也
救不了一个「没有超时的等待」——`next()` 不被调用、裁决不返回，这个 approval 就一直挂着，
turn 也就永远停在原地。

dsh 0.1.7 已经把「**一个 answerer 都没有**」这一档做成 fail-closed（回 `'unavailable'`）。
本插件补的是剩下那一档：**answerer 注册着，但不答**。

真正无人值守的来源天然如此：subagent 会话、定时任务、cron 任务发起时，人根本不在电脑前。
等一个永远不会到来的答案没有意义。但也不能一律 auto-reject：共用会话里人可能恰好顺手在
（或者人刚插过一句），**窗口内的人工应答仍然算数**。

诉求出处：Nemuritor01 在 deepseek-ai/deepseek-harness discussion #2544 提出的
**unattended policy, per session or per origin, interactive default unchanged**——
本插件就是这三句话的落地形态。

## 机制

本插件挂在宿主的 `'approval/request'` cordis waterfall 上，以
`ctx.on('approval/request', …, { prepend: true })` **prepend 注册**，因此无论插件加载顺序如何，
门控器都排在交互 answerer（web 远程应答、dsh-feishu 卡片……）**之前**。无人值守的请求在被人
的界面认领之前就被圈进窗口；被门控的请求在窗口内**仍然通过 `next()` 到达那些界面**。

```
approval/request（宿主 waterfall）
  │
  └─ dsh-approval-policy（prepend 注册，链首）
       │
       ├─ shouldGate(request)？
       │    ├─ 否（交互会话）→ next() 立即透传 ──► 交互默认不变
       │    │
       │    └─ 是（无人值守）
       │         │
       │         └─ raceGate：Promise.race( next() , 窗口计时器 )
       │              ├─ 下游在窗口内答了 ──► 用下游的答案
       │              │     （空链瞬间 fail-closed 'unavailable' 原样透传，
       │              │       没有东西可等，不必吃掉窗口）
       │              ├─ 窗口耗尽 ────────► defaultOutcome 落定
       │              │     （turn 立即落地：被拒或 unavailable，绝不挂起）
       │              │
       │              └─ turn 中止 ───────► 宿主信号竞速收 'cancelled'
       │                    （迟到的窗口到期被直接忽略）
       │
       └─ 交互 answerer（web 远程应答 / dsh-feishu 卡片 / …）仍在链上，
          只是排在门控之后：先 next() 才轮得到它们
```

### 判定粒度（v1）

| 来源 | 粒度 | 判定依据 |
|---|---|---|
| `sessions` 名单命中 | 会话级 | agent id 命中 glob → 该会话**所有** turn 都门控（与 `origins` 取并集） |
| `all` | 全局 | 所有审批请求都门控（opt-in 的全门控逃生舱） |
| `subagent` | 会话级 | `session.header.origin === 'subagent'`（子代理会话是专用于委派的） |
| `scheduled` | turn 级 | 会话**最后一条溯源 user 消息**的 `source.kind === 'schedule'`（宿主 dsh-schedule） |
| `cron` | turn 级 | 最后一条溯源 user 消息 `source.kind === 'cron'`（dsh-cron ≥ 本次补丁版） |

`scheduled` / `cron` 取的是**最后一条溯源** user 消息（`user` / `schedule` / `cron`），
**跳过合成注入**：宿主在 turn 启动后会往 user 消息流里注 `runtime-context` 快照、
`skill-catalog` 提醒这类 `role='user'` 的合成消息，它们永远压在触发消息后面——不跳过的话
每条 cron turn 都会被误判成交互（真机测试抓到的坑，回归单测钉死）。也不取「任一条」或
「首条」：这些会话和人是共用的，**人插过话就不门控**——「有没有人在看」正是无人值守判定的
语义。cron 任务跑完后人 steer 了一句澄清，最后一条溯源就是人的 → 交互默认保留。
`sessions` 名单里的非法 glob 按不命中处理（编译失败不抛），保证名单写错也不会打断审批。

### 与宿主既有机制的关系

- **审计白送**：宿主自己落 `approval/asked` + `approval/decided` 到会话日志，**本插件不写日志**。
  无论哪个 answerer 做的裁决都在 transcript 里可追溯，**超时拒绝同样查得到**。
- **会话级 `approval/policy`（ask | never）短路在 waterfall 之前**：宿主自己的策略先生效，
  `never` 会直接 auto-reject，与本插件**零冲突**——那是宿主既有机制，本插件是
  「**先试 N 秒再拒**」的时间窗形态。
- **交互会话（未命中任何来源）立即 `next()` 透传**：交互默认一字不变。
- **零落盘状态**：没有数据文件，配置之外不额外占位（entry id 本身就是 settings 命名空间）。

## 配置

挂在 `cordis.patch.yml` 的 dsh-approval-policy 挂载块 `config:` 段（id = `dsh-approval-policy`，
entry id 同时就是 settings 命名空间）。四个键**全部 volatile，可在设置页热改**。

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `origins` | `(subagent\|scheduled\|cron\|all)[]` | `[subagent, scheduled]` | 判定为无人值守的来源；`all` 是 opt-in 的全门控 |
| `sessions` | `string[]`（glob） | `[]` | 按 agent id glob 点名会话，命中即门控该会话**所有** turn（与 `origins` 取并集） |
| `windowSeconds` | `number` 0..86400 | `60` | 应答窗口（秒）；`0` = 立即拒绝且**不**问下游 |
| `defaultOutcome` | `rejected \| unavailable` | `rejected` | 超时落定值；**配置层没有 allowed-once**（fail-closed 红线，schema 枚举就不含） |

```yaml
# ~/.dsh/cordis.patch.yml（或某个 profile 的 cordis.patch.yml）
- insert:
    - id: dsh-approval-policy
      name: '@aiwayds/dsh-approval-policy'
      config:
        origins: [subagent, scheduled, cron]   # cron 需 dsh-cron 的 source kind 补丁版
        windowSeconds: 60
        defaultOutcome: rejected
```

- `defaultOutcome` 只有 `rejected` 和 `unavailable` 两个值，**没有 `allowed-once`（本次放行）这一档**
  ——无人值守的默认裁决必须 fail-closed，超时就是拒。要「窗口内放行」请让窗口内真的有人答。
- 改完 `cordis.patch.yml` 后重启 dsh 生效；挂载块里的四键也可以在设置页直接热改。
- 调配置的完整向导见随包技能 `dsh-approval-policy-config`（`skills/dsh-approval-policy-config/SKILL.md`）。

## 安装

```bash
dsh plugin add @aiwayds/dsh-approval-policy   # 激活门控，bundle 自动挂载
```

profile 级操作用 `dsh plugin --profile <name> add @aiwayds/dsh-approval-policy`。
装好即按上表默认生效（`origins: [subagent, scheduled]`、窗口 60 秒、超时 `rejected`），
无需先写 patch——要把 `cron` 也纳入门控请按上面示例补 `config:` 段。

本地开发用 link 时，bundles 里把它放在交互 UI 之前或之后都可以（`prepend` 保证门控永远在
链首，不依赖加载顺序）：

```jsonc
{
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@aiwayds/dsh-approval-policy",
    "@aiwayds/dsh-tui-pi"
  ]}}
}
```

## 卸载

```bash
dsh plugin remove @aiwayds/dsh-approval-policy
```

宿主自动清掉 profile `bundles` 里对应的条目和插件的 patch 层。本插件**零落盘状态**——
没有数据文件，配置之外不额外占位——卸载后不留任何残留。

卸载后审批行为**回到宿主原生**（无窗口）：会话级 `approval/policy` 的 `ask` / `never` 照旧
生效，交互 answerer 照旧应答；而「无人值守且没人答」那一档重新变回**可能永不落地**。
想保留拒绝保障又不装本插件，可以把相关会话设成 `approval/policy: never`（立即拒，无窗口）。

## 测试

```bash
npm test    # 17 个纯逻辑单测（node --test）：
            #   glob 编译 / 事实读取（最后一条溯源 user 消息、合成注入跳过）/ 判定粒度（subagent、
            #   scheduled、cron、all、sessions 名单与并集）
            #   + 竞速语义（窗口 0 立即拒且不委托、瞬间 unavailable 原样透传、
            #   窗口内答案胜出、挂死 answerer 输给窗口）+ apply() 以 prepend 注册
            #   单个 listener 并在 dispose 时释放

npm run smoke   # scripts/smoke-boot.mjs：真宿主 dump-config + boot + 卸载腿
```

License: MIT. 作者 fan56。
