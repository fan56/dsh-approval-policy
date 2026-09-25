---
name: dsh-approval-policy-config
description: "dsh 无人值守审批门控插件（@aiwayds/dsh-approval-policy）使用与配置指南。审批挂起、approval 挂死、无人值守、超时拒绝、subagent 审批、定时任务审批、审批门控等场景，或要配置 dsh-approval-policy 时先读本指南：四个键（origins/sessions/windowSeconds/defaultOutcome）的默认值、cordis.patch.yml 挂载块 config: 段示例、ask_user_question 配置向导、行为边界速查。触发词：approval-policy、windowSeconds、审批门控。"
---

# dsh-approval-policy 使用指南（无人值守审批门控）

> dsh 插件：挂在宿主 `'approval/request'` waterfall 链首（prepend 注册）的竞速门控器。
> 声明为无人值守的请求先 `next()` 交给下游交互面，**窗口内有人答就用人的答案**，
> 窗口耗尽按 fail-closed 默认裁决落定，**turn 立即落地不再挂起**；交互会话默认不变。

## 配置入口

持久化在 `cordis.patch.yml` 里 dsh-approval-policy 挂载块的 `config:` 段（id =
`dsh-approval-policy`，entry id 同时就是 settings 命名空间）。四个键**全部 volatile**，
也可以直接在 dsh 设置页热改；改 `cordis.patch.yml` 则需重启 dsh 生效。
bundle 方式（`dsh plugin add @aiwayds/dsh-approval-policy` 或列在 profile `bundles`）
自动挂载，无需手写 patch。

## 配置键

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `origins` | `(subagent\|scheduled\|cron\|all)[]` | `[subagent, scheduled]` | 判定为无人值守的来源；`all` 是 opt-in 的全门控 |
| `sessions` | `string[]`（glob） | `[]` | 按 agent id glob 点名会话，命中即门控该会话**所有** turn（与 `origins` 取并集） |
| `windowSeconds` | `number` 0..86400 | `60` | 应答窗口（秒）；`0` = 立即拒绝且**不**问下游 |
| `defaultOutcome` | `rejected \| unavailable` | `rejected` | 超时落定值；**配置层没有 allowed-once**（fail-closed 红线，schema 枚举就不含） |

判定粒度：`sessions` 命中与 `all` 是会话级/全局；`subagent` 看 `session.header.origin ===
'subagent'`（会话级）；`scheduled` / `cron` 看会话**最后一条溯源** user 消息的 `source.kind`
（`schedule` / `cron`，turn 级；`runtime-context` / `skill-catalog` 等合成注入会被跳过，
不污染判定）——人插过话就不门控（"有没有人在看"语义）。
`cron` 需要 dsh-cron 自带 `source.kind: 'cron'` 的补丁版。

挂载块形状（`~/.dsh/cordis.patch.yml` 或某个 profile 的 cordis.patch.yml）：

```yaml
- insert:
    - id: dsh-approval-policy
      name: '@aiwayds/dsh-approval-policy'
      config:
        origins: [subagent, scheduled, cron]   # cron 需 dsh-cron 的 source kind 补丁版
        windowSeconds: 60
        defaultOutcome: rejected
```

## 交互式配置向导（ask_user_question）

用户抱怨审批挂起时，不要甩配置表让对方自己读——先用 `ask_user_question` 问清期望，
再映射到键：

1. **要门控哪些来源** → `origins`：`subagent`（子代理会话专有）／`scheduled`（定时任务）／
   `cron`（cron 任务）／`all`（全部审批都门控）。多选；先问清是不是只想治某一类。
2. **有没有要整会话点名的** → `sessions`：有的话问 agent id 或前缀，按 glob 写（如 `ops-*`）；
   命中即门控该会话**所有** turn，与 `origins` 取并集。没有就留空数组。
3. **窗口多长** → `windowSeconds`：问能接受挂多久（默认 60 秒）；要"绝不等待、立刻拒"
   填 `0`（立即拒绝且**不**问下游）；想要"人还在就还能答"就给个几十秒到几分钟的数。
4. **超时落什么** → `defaultOutcome`：`rejected`（默认，拒）或 `unavailable`（下游不可用）。
   **必须强调：没有 `allowed-once`（本次放行）这一档**——无人值守的默认裁决必须 fail-closed，
   超时就是拒；想放行就让窗口内真的有人答。
5. **落盘** → 把结果写进 `cordis.patch.yml` 挂载块的 `config:` 段（只写用户实际确认过的键，
   其余留默认），并提醒**重启 dsh 生效**（设置页热改则即时生效）。

## 行为边界速查

- **交互会话不门控**：未命中 `sessions` 名单、也未命中任何 origin 的 turn 立即 `next()` 透传，
  交互默认一字不变。
- **宿主 policy 优先**：会话级 `approval/policy`（ask|never）短路在 waterfall 之前，
  `never` 直接 auto-reject，与本插件零冲突；本插件是"先试 N 秒再拒"的时间窗形态。
- **审计宿主落**：`approval/asked` + `approval/decided` 由宿主写进会话日志，本插件不写日志，
  超时拒绝同样在 transcript 里可追溯。
- **窗口内下游答了就用下游的答案**；空链瞬间 fail-closed `'unavailable'` 原样透传。
- **turn 中止**由宿主信号竞速收 `'cancelled'`，迟到的窗口到期被忽略。
