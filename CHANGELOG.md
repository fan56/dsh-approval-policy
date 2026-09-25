# @aiwayds/dsh-approval-policy

## 0.1.0

首个版本：无人值守审批门控（unattended approval gate）。

### Added

- **门控机制**：作为竞速应答者挂在宿主 `'approval/request'` cordis waterfall 上，
  `ctx.on('approval/request', …, { prepend: true })` 永远排在交互 answerer 之前。判定为无人值守
  的请求先 `next()` 交给下游链，同时用有界窗口竞速：下游在窗口内答了就用下游的答案（空链瞬间
  fail-closed `'unavailable'` 原样透传）；窗口耗尽则按 fail-closed 默认裁决落定，turn 立即落地不再
  挂起；turn 中止由宿主信号竞速收 `'cancelled'`，迟到的窗口到期被忽略。交互会话（未命中任何来源）
  立即 `next()` 透传，交互默认不变。
- **四个配置键**（`cordis.patch.yml` 挂载块 `config:` 段，id = `dsh-approval-policy`，全部 volatile
  可热改）：
  - `origins`（`(subagent|scheduled|cron|all)[]`，默认 `[subagent, scheduled]`）——判定为无人值守的
    来源，`all` 是 opt-in 的全门控；
  - `sessions`（`string[]` glob，默认 `[]`）——按 agent id glob 点名会话，命中即门控该会话**所有**
    turn（与 `origins` 取并集），非法 glob 按不命中处理；
  - `windowSeconds`（`number` 0..86400，默认 `60`）——应答窗口（秒），`0` = 立即拒绝且不问下游；
  - `defaultOutcome`（`rejected | unavailable`，默认 `rejected`）——窗口耗尽时落定的 fail-closed 裁决。
    **配置层没有放行档**（fail-closed 红线，schema 枚举就不含）。
- **判定粒度（v1）**：`sessions` glob 命中为会话级（命中即门控）；`all` 全局；`subagent` 会话级
  （`session.header.origin === 'subagent'`）；`scheduled` 与 `cron` 为 turn 级——取会话**最后一条**
  user 消息的 `source.kind`（分别是 `schedule` / `cron`），而不是「任一」或「首条」：这些会话和人是
  共用的，人插过话就不门控（cron 任务后人 steer 澄清 → 最后一条是人的 → 交互默认保留）。
- **审计由宿主落**：宿主自己写 `approval/asked` + `approval/decided` 到会话日志，本插件不写日志；
  无论哪个 answerer 做的裁决（含超时拒绝）都在 transcript 里可追溯。宿主会话级
  `approval/policy`（ask|never）短路在 waterfall 之前，与本插件零冲突。
- 16 个纯逻辑单测（`npm test`，`node --test`）覆盖 glob 编译、事实读取、判定粒度、竞速语义与
  `apply()` 的 prepend 注册/释放；boot smoke（`npm run smoke`，`scripts/smoke-boot.mjs`）走真宿主
  dump-config + boot + 卸载腿。
- dsh 地板 `>= 0.1.7-rc.1`，以 `package.json` 的 `peerDependencies` 声明。
