# dsh-approval-policy

The unattended approval gate for dsh: a bounded wait plus a fail-closed default settlement for approval requests raised by machine-driven sources. This file is the shared vocabulary for the plugin's docs, config and code.

## Language

**Unattended Policy（无人值守策略）**:
The plugin's policy for requests from unattended sources: hand the request down the chain, wait a bounded Window, then settle with a fail-closed Default Outcome. Applies per session or per Origin; interactive sessions are exempt by default.
_Avoid_: approval policy (the host's same-named concept — a session-level ask|never policy that decides immediately, no window), timeout

**Origin（来源）**:
The unattended classification of whoever raised an approval request: `subagent`, `scheduled`, `cron`, or the opt-in catch-all `all`. Some are decided per session, others per turn.
_Avoid_: trigger, provider

**Window（应答窗口）**:
The longest the gate waits after handing a request to the downstream chain before the Default Outcome settles it. Measured in seconds; zero means denying without ever asking downstream.
_Avoid_: timeout, TTL

**Default Outcome（超时默认裁决）**:
The fail-closed verdict that settles a request when the Window expires: `rejected` or `unavailable`. There is no granting outcome — an unattended default must never allow.
_Avoid_: fallback, deny (both are semantically wider)

**Gate（门控器）**:
The racing answerer at the head of the `approval/request` waterfall. It delegates first, then races the downstream chain against the Window; it never claims a request outright.
_Avoid_: router (an ask-side concept; this plugin does no routing), proxy

**Sessions List（会话点名名单）**:
The configuration dimension that names sessions by agent id glob. A hit gates every turn of that session, unioned with the configured Origins.
_Avoid_: whitelist (the semantics blur), origin
