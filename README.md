# dsh-channel-memory

DeepSeek Harness 插件：**手机通道专属工作区** + **跨会话互通记忆**。

零运行时依赖（只用 node 内置模块 + 宿主自带的 `@deepseek-ai/dsh-tools`），
兼容 DSH `0.2.1-rc.5` / cordis `4.0.5`。

## 解决什么

用 wxbridge 这类手机通道时，实测到两个问题：

1. **会话散落**：每从微信发一句话，桥就可能新起一条 DSH 会话，全落在默认工作区里。
   桌面侧栏被"手机会话"淹没，也没有一个地方能把它们归档、回看。
2. **记忆不通**：换一条会话（或桥重启）就不知道之前交代过什么。用户只能反复重述
   身份资料、求职口径、偏好——而这些本该是一次交代、长期复用。

## 做法

- **专属工作区**：`~/.dsh/channel-workspace`（可配）。用宿主的
  `workspaceRegistry.resolveByPath()` 先查，缺失才 `create()`。
- **归属判定不自己猜**：不同宿主版本暴露会话 cwd 的方式不一样，猜错就会静默跳过一切。
  这里改用宿主自己的不变量 —— `Workspace.attachSession()` 会校验会话 header 的 cwd
  是否等于工作区路径，不等就抛。所以「挂载成功」本身就是权威的归属证据，
  普通桌面会话会在 `catch` 里被安静跳过，插件绝不强行挂载绕过校验。
- **共享记忆**：`~/.dsh/channel-memory/memory.json`，原子 rename + sha256 校验和。
  校验和不符（文件被截断/外部改坏）时退回空库，而不是拿脏数据当记忆用。
- **自动流水**：监听 `session/event` 的 `turn/end`，只给已确认归属的通道会话记一条，
  用于「手机侧这段时间聊过什么」的回溯。
- **提示词注入**：`systemPrompt.section({ name, order, text })`，`text` 传**函数**
  （宿主按 `typeof section.text === 'function' ? section.text(context)` 求值），
  所以写入记忆后下一轮组装自动生效，不需要手动 refresh。只追加、不替换人格。

## 模型工具

| 工具 | 用途 |
|---|---|
| `memory_write` | 记一条跨会话共享记忆（`kind`/`tags`/`pinned`） |
| `memory_search` | 子串检索正文/标签/类别 |
| `memory_list` | 列出最近 20 条，带 id 便于删除 |
| `memory_forget` | 按 id 删除 |
| `channel_workspace_info` | 工作区路径/id/已归属会话数/记忆与流水条数 |

`pinned: true` 的记忆常驻提示词索引，其余按 `indexLimit`（默认 12）取最近若干条。

## 安装

> ⚠️ npm 上 `dsh-channel-memory` 目前只有 `0.0.0-stage` 占位版（`latest` 指向它），
> 真实版本要等 staging approve 完成。**在此之前请用下面的 git 或本地目录方式安装**，
> 不要直接 `pnpm add dsh-channel-memory`。

在 DSH 的应用 profile 目录里执行（Windows 桌面形态是
`%USERPROFILE%\.dsh\profiles\desktop`）：

```bash
cd %USERPROFILE%\.dsh\profiles\desktop
pnpm add github:Yuncan050115/dsh-channel-memory
```

或从本地目录安装：

```bash
pnpm add file:C:\path\to\dsh-channel-memory
```

然后把 bundle 名加进同目录 `package.json` 的 `dsh.profile.bundles`
（DSH 插件管理器会自动做这一步，手工加也可以）：

```json
"dsh": { "profile": { "bundles": [ ..., "dsh-channel-memory" ] } }
```

重启 DSH 生效。不想重启也可以先校验组合结果——用 DSH 自带运行时做一次干跑
（`--dump-config` 只组合配置、不启动 GUI）。`<APP>` 是 DSH 的安装目录，
Windows 桌面形态默认是 `C:\Program Files\DeepSeek Harness` 或
`D:\DeepSeek Harness`：

```bat
set ELECTRON_RUN_AS_NODE=1
set DSH_HOME=%USERPROFILE%\.dsh
"<APP>\DeepSeek Harness.exe" --expose-internals ^
  "<APP>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" ^
  --profile desktop --dump-config
```

输出里应能看到 `# == dsh-channel-memory` 这一层；若出现 `skipped bundles` 或
`did not activate`，说明 bundle 没挂上。

## 配置

`cordis.patch.yml` 里 `channel-memory` 行的 `config` 全部可选，注释掉了默认值：

```yaml
- insert:
    - id: channel-memory
      name: 'dsh-channel-memory'
      config:
        workspacePath: 'C:/Users/you/.dsh/channel-workspace'
        workspaceTitle: '手机通道'
        dataDir: 'C:/Users/you/.dsh/channel-memory'
        injectIndex: true
        indexLimit: 12
        autoDigest: true
```

## 与手机通道配合

要让微信发起的会话真的落进这个工作区，需要**桥侧的会话 cwd 指向通道工作区**。
wxbridge 支持在 `~/.dsh/wxbridge/config.json` 里配 `cwd`（宿主半 `pick('cwd')` →
keeper → 桥的 `--cwd`），例如：

```json
{ "cwd": "C:/Users/wujid/.dsh/channel-workspace" }
```

配完重启桥即可。不配也不会出错——插件只是没有会话可归属，记忆与工具照常工作。

## 验证

`plugin/contract_test.mjs` 用**宿主自己的 `defineTool`** 跑契约测试（不是 stub）：
value-schema DSL 违规会当场抛。夹具强制宿主不变量（cwd 不符则 `attachSession` 抛），
因此「外来会话被拒绝挂载」是被真实验证的，而不是被假 object 允许的。

```
RESULT: PASS   （5 个工具注册、1 个提示词分节、外来会话未被挂载、post-apply 写入反映进索引）
```

权限面见 `PERMISSIONS.md`。

## License

MIT
