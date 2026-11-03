# PERMISSIONS — dsh-channel-memory

本文件声明插件运行时实际使用的权限面。

## 总览（运行时行为）

- **文件系统**：只在两个目录下读写，路径由配置决定，默认都在 DSH home 内：
  - `~/.dsh/channel-memory/`：`memory.json`（共享记忆）、`digest.json`（自动流水）。
    写入一律「临时文件 + `rename` 原子替换」，并带 sha256 校验和。
  - `~/.dsh/channel-workspace/`：专属工作区目录，仅在不存在时 `mkdir`。
    插件**不读写**该目录内的任何业务文件，它只是宿主用来归属会话的工作根。
- **宿主服务（只读调用 + 显式挂载）**：通过 `ctx.inject(['workspaceRegistry','sessions'])`
  与 `ctx.inject(['systemPrompt'])` 获取，不使用未声明的服务。
  - `workspaceRegistry.resolveByPath / create / get`
  - `Workspace.attachSession(sessionId)` —— 只在宿主校验通过时成功；
    插件不绕过、不重试、不强改归属关系。
  - `systemPrompt.section(...)` —— 追加一个自有分节，不替换他人分节、不使用
    `complete: true`。
- **事件监听**：`session/created`、`session/event`（只取 `turn/end` 一类记录）。
  回调全程 `try/catch`，任何异常都不影响会话本身。
- **网络**：❌ 不发起任何网络请求。
- **进程/子进程**：❌ 不 spawn 任何子进程。
- **凭据**：❌ 不读取 `.credentials.yaml`、不读取任何 `*_API_KEY` / `*_ACCOUNT_*`，
  不接触 DSH 凭据服务。

## 明确不做

- ❌ 不读取用户业务文件、项目文件、会话正文（只记 `turn/end` 的元信息与条数）。
- ❌ 不写入工作区以外的路径；配置里给了越界路径时由操作者自己负责，插件不做二次扩散。
- ❌ 不修改其它插件的配置或提示词分节。
- ❌ 无 npm 生命周期脚本（`install` / `postinstall` 等一律没有）。
- ❌ 不上传、不同步、不外发任何记忆内容；共享仅发生在同一台机器的同一份 JSON 上。

## 数据可见性提示

`memory.json` 是**明文**存放在用户目录下的。任何能读该目录的进程都能读到其中的内容，
因此不要把密码、令牌、私钥等写进记忆——工具描述里也明确只用于事实/偏好/任务口径。

## 依赖

| 依赖 | 用途 |
|---|---|
| `@deepseek-ai/dsh-tools`（宿主提供） | `defineTool` 注册模型工具 |
| `@deepseek-ai/cordis`（peer） | 插件框架类型 |

无第三方运行时依赖，仅使用 `node:fs` / `node:os` / `node:path` / `node:crypto`。
