/**
 * dsh-channel-memory — 手机通道专属工作区 + 跨会话互通记忆
 *
 * 解决两个实测到的问题：
 *  1. 每次从微信发起对话都会新起一条 DSH 会话，散落在默认工作区里，桌面侧栏
 *     被"手机会话"淹没，也无处归档。
 *  2. 手机侧会话之间没有共享记忆：换会话或桥重启后不知道之前交代过什么。
 *
 * 形态说明（都按宿主 0.2.1-rc.5 的实际契约来，不凭直觉）：
 *  - 服务依赖用 ctx.inject([...names], cb) 声明；根 ctx 上直接取不到
 *    workspaceRegistry / systemPrompt，所以全部在注入回调里完成。
 *  - 专属工作区：workspaceRegistry.resolveByPath() 先查，缺失才 create()。
 *    create 对同一 realpath 幂等，但显式先查可保证"绝不改动既有 title"。
 *  - 会话归属：attachSession() 由宿主校验 header.cwd 是否等于工作区路径，
 *    不匹配会抛；因此只在确实属于通道时才挂，失败静默跳过，绝不伪造归属。
 *  - 提示词注入：systemPrompt.section({ name, order, text })，text 传函数
 *    （宿主按 `typeof section.text === 'function' ? section.text(context)` 求值），
 *    所以记忆变化会随下次组装自动生效，不需要手动 refresh。
 *  - 自动流水：监听 session/event 的 turn/end（payload 明确为 (session, event)），
 *    不用 agent/turn-stopping —— 后者是 scope-filtered serial 事件，回调里
 *    拿不到稳定的 agent 标识。
 *  - 存储：~/.dsh/channel-memory/*.json，原子 rename + sha256 校验和；校验和
 *    不符时退回空库而不是把脏数据当记忆用。
 *
 * 零运行时依赖：node 内置模块 + 宿主提供的 @deepseek-ai/dsh-tools。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'channel-memory'
// `tools` 是每 agent 的调度服务，根 ctx 上直接读取会抛
// "cannot get property tools without inject"。声明式 inject 才能拿到可用的
// 服务句柄，且注册落在本插件的 fiber 上（与 modlens 等可用插件同一形态）。
export const inject = ['tools']

const NL = String.fromCharCode(10)
const MAX_MEMORIES = 400
const MAX_DIGESTS = 300
const MAX_TEXT = 4000
const SECTION_ORDER = 3200

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const clamp = (s, n) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim().slice(0, n)

/** 原子写 + 校验和：坏文件绝不覆盖好文件。 */
function writeJson(file, value) {
  const { checksum, ...rest } = value
  const body = JSON.stringify(rest, null, 1)
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify({ ...rest, checksum: createHash('sha256').update(body).digest('hex') }, null, 1) + NL, 'utf8')
  renameSync(tmp, file)
}

function readJson(file, initial) {
  if (!existsSync(file)) return structuredClone(initial)
  let doc
  try { doc = JSON.parse(readFileSync(file, 'utf8')) } catch { return structuredClone(initial) }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return structuredClone(initial)
  const { checksum, ...rest } = doc
  if (checksum) {
    const expect = createHash('sha256').update(JSON.stringify(rest, null, 1)).digest('hex')
    if (expect !== checksum) return structuredClone(initial)   // 截断/外部改坏：退回空库
  }
  return { ...structuredClone(initial), ...rest }
}

const MEM0 = { version: 1, items: [] }
const DIG0 = { version: 1, items: [] }

export function apply(ctx, config) {
  const cfg = {
    workspacePath: config.workspacePath || join(dshHome(), 'channel-workspace'),
    dataDir: config.dataDir || join(dshHome(), 'channel-memory'),
    workspaceTitle: config.workspaceTitle || '手机通道',
    injectIndex: config.injectIndex !== false,
    indexLimit: Number.isInteger(config.indexLimit) && config.indexLimit > 0 ? config.indexLimit : 12,
    autoDigest: config.autoDigest !== false,
  }

  try { mkdirSync(cfg.dataDir, { recursive: true }) } catch { /* 只读环境下仍可运行 */ }
  const MEM_FILE = join(cfg.dataDir, 'memory.json')
  const DIG_FILE = join(cfg.dataDir, 'digest.json')
  const mem = readJson(MEM_FILE, MEM0)
  const dig = readJson(DIG_FILE, DIG0)
  if (!Array.isArray(mem.items)) mem.items = []
  if (!Array.isArray(dig.items)) dig.items = []

  const saveMem = () => { try { writeJson(MEM_FILE, { version: 1, items: mem.items.slice(-MAX_MEMORIES) }) } catch (e) { ctx.logger?.warn?.('channel-memory: save failed ' + String(e?.message).slice(0, 80)) } }
  const saveDig = () => { try { writeJson(DIG_FILE, { version: 1, items: dig.items.slice(-MAX_DIGESTS) }) } catch { } }

  const addMemory = (input) => {
    const text = clamp(input.text, MAX_TEXT)
    if (!text) return { ok: false, reason: 'text 为空' }
    const item = {
      id: randomUUID().slice(0, 8),
      text,
      kind: clamp(input.kind, 24) || 'note',
      tags: (Array.isArray(input.tags) ? input.tags : []).map((t) => clamp(t, 40)).filter(Boolean).slice(0, 8),
      pinned: input.pinned === true,
      source: clamp(input.source, 40) || 'agent',
      at: new Date().toISOString(),
    }
    mem.items.push(item)
    saveMem()
    return { ok: true, item, total: mem.items.length }
  }

  const search = (q, limit) => {
    const needle = clamp(q, 200).toLowerCase()
    const pool = mem.items.slice().reverse()
    const hit = needle
      ? pool.filter((m) => (m.text + ' ' + (m.tags || []).join(' ') + ' ' + m.kind).toLowerCase().includes(needle))
      : pool
    return hit.slice(0, Math.max(1, Math.min(Number(limit) || cfg.indexLimit, 100)))
  }

  const buildIndex = () => {
    const pinned = mem.items.filter((m) => m.pinned)
    const recent = mem.items.slice(-cfg.indexLimit)
    const seen = new Set()
    const lines = [...pinned, ...recent].filter((m) => !seen.has(m.id) && (seen.add(m.id), true))
    if (!lines.length) return ''
    return [
      '<channel_memory scope="shared-across-sessions">',
      '「手机通道」共享记忆，所有会话可读（memory_write 记录 / memory_search 检索 / memory_forget 删除）：',
      ...lines.map((m) => `- [${m.id}]${m.pinned ? '[置顶]' : ''} (${m.kind}) ${m.text.slice(0, 220)}`),
      '</channel_memory>',
    ].join(NL)
  }

  // ---- 宿主服务：workspaceRegistry / sessions ----------------------------
  // 归属判定不自己猜会话的 cwd 字段形状（不同宿主版本暴露方式不同，猜错就会
  // 静默跳过一切）。改用宿主自己的不变量：attachSession() 会校验会话 header 的
  // cwd 是否等于工作区路径，不等就抛。所以"尝试挂载成功"本身就是权威的归属证据。
  const state = { workspaceId: '', workspacePath: '', reg: null }
  const channelSessions = new Set()

  ctx.inject(['workspaceRegistry', 'sessions'], (host) => {
    const reg = host.workspaceRegistry
    if (!reg) { ctx.logger?.warn?.('channel-memory: workspaceRegistry 不可用'); return }
    state.reg = reg

    const ensureWorkspace = async () => {
      try {
        if (!existsSync(cfg.workspacePath)) mkdirSync(cfg.workspacePath, { recursive: true })
        const found = await reg.resolveByPath(cfg.workspacePath)
        const ws = found || await reg.create(cfg.workspacePath, cfg.workspaceTitle)
        state.workspaceId = ws.id; state.workspacePath = ws.path
        for (const id of ws.sessionIds || []) channelSessions.add(id)   // 重启后续用
        if (!found) ctx.logger?.info?.(`channel-memory: workspace ${ws.id} -> ${ws.path}`)
        return ws
      } catch (e) {
        ctx.logger?.warn?.('channel-memory: workspace ensure failed: ' + String(e?.message ?? e).slice(0, 160))
        return undefined
      }
    }

    const attach = async (session) => {
      const id = session?.id
      if (!state.workspaceId || !id || channelSessions.has(id)) return
      let ws
      try { ws = reg.get(state.workspaceId) } catch { return }
      if (!ws) return
      try {
        await ws.attachSession(id)          // host validates cwd === workspace path
        channelSessions.add(id)
        ctx.logger?.info?.(`channel-memory: attached ${String(id).slice(0, 12)}`)
      } catch {
        // 普通桌面会话会在这里被宿主拒绝——这是预期路径，不是错误，
        // 所以保持静默，绝不强行挂载绕过宿主校验。
      }
    }

    ctx.effect(async () => { await ensureWorkspace() })

    ctx.on('session/created', (session) => { Promise.resolve(attach(session)).catch(() => { }) })

    // 自动流水：只记已确认归属的通道会话的 turn/end。
    if (cfg.autoDigest) {
      ctx.on('session/event', (session, event) => {
        try {
          if (!event || event.type !== 'turn/end') return
          if (!channelSessions.has(session?.id)) return
          dig.items.push({
            id: randomUUID().slice(0, 8),
            session: clamp(session?.id, 60),
            reason: clamp(event?.data?.reason?.kind ?? event?.data?.reason, 24),
            at: new Date().toISOString(),
          })
          saveDig()
        } catch { /* 流水失败绝不影响会话本身 */ }
      })
    }
  })

  // ---- 提示词注入 --------------------------------------------------------
  if (cfg.injectIndex) {
    ctx.inject(['systemPrompt'], (host) => {
      const sp = host.systemPrompt
      if (!sp || typeof sp.section !== 'function') { ctx.logger?.warn?.('channel-memory: systemPrompt 不可用'); return }
      try {
        sp.section({ name: 'channel-memory:index', order: SECTION_ORDER, text: buildIndex })
      } catch (e) {
        ctx.logger?.warn?.('channel-memory: section failed: ' + String(e?.message ?? e).slice(0, 140))
      }
    })
  }

  // ---- 模型工具 ----------------------------------------------------------
  // output.schema 是"值节点"：只写 type/properties/additionalProperties，
  // 不写 required（该 DSL 里 required 只在参数槽位合法，写进 output.schema 会被拒）。
  const OUT = (extra = {}) => ({
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { ok: { type: 'boolean' }, result: { type: 'string' }, ...extra },
    },
    render: (_args, value) => [{ type: 'text', text: String(value?.result ?? '') }],
  })

  const tools = [
    {
      name: 'memory_write',
      description:
        '写入一条跨会话共享记忆（手机通道与桌面端都能读到）。用于用户明确交代、以后还要用的事实：' +
        '身份资料、求职口径、偏好、正在推进的事项与结论。不要记一次性闲聊或能从文件读到的内容。' +
        'pinned=true 会常驻提示词索引。',
      parameters: {
        text: { type: 'string', required: true, description: '记忆正文，一条只说一件事，≤4000 字。' },
        kind: { type: 'string', description: '类别：fact / pref / task / decision / contact。默认 note。' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签，最多 8 个。' },
        pinned: { type: 'boolean', description: '是否置顶进提示词索引。' },
      },
      execute: async (args) => {
        const r = addMemory({ ...args, source: 'tool' })
        return { ok: r.ok, result: r.ok ? `已记录 [${r.item.id}]（共 ${r.total} 条）` : `✗ ${r.reason}` }
      },
    },
    {
      name: 'memory_search',
      description: '在共享记忆里检索（子串匹配正文/标签/类别）。不传 query 返回最近若干条。',
      parameters: {
        query: { type: 'string', description: '检索词，中文可用。' },
        limit: { type: 'integer', description: '最多返回几条，默认 12。' },
      },
      execute: async (args) => {
        const hits = search(args.query, args.limit)
        if (!hits.length) return { ok: true, result: '（无匹配记忆）' }
        return { ok: true, result: hits.map((m) => `[${m.id}] (${m.kind})${m.pinned ? '[置顶]' : ''} ${m.text}`).join(NL) }
      },
    },
    {
      name: 'memory_list',
      description: '列出共享记忆（最近 20 条，带 id 便于删除）。',
      parameters: {
        include_digests: { type: 'boolean', description: '是否一并给出自动流水条数（默认否）。' },
      },
      execute: async (args) => {
        const lines = mem.items.slice(-20).map((m) => `[${m.id}] (${m.kind})${m.pinned ? '[置顶]' : ''} ${m.text.slice(0, 160)}`)
        let out = `共享记忆 ${mem.items.length} 条（显示最近 ${lines.length}）：` + NL + (lines.join(NL) || '（空）')
        if (args.include_digests) out += NL + `自动流水 ${dig.items.length} 条。`
        return { ok: true, result: out }
      },
    },
    {
      name: 'memory_forget',
      description: '按 id 删除一条共享记忆。id 来自 memory_search / memory_list。',
      parameters: { id: { type: 'string', required: true, description: '记忆 id，如 a1b2c3d4。' } },
      execute: async (args) => {
        const id = clamp(args.id, 20)
        const before = mem.items.length
        mem.items = mem.items.filter((m) => m.id !== id)
        if (mem.items.length === before) return { ok: false, result: `✗ 未找到 [${id}]` }
        saveMem()
        return { ok: true, result: `已删除 [${id}]，剩余 ${mem.items.length} 条` }
      },
    },
    {
      name: 'channel_workspace_info',
      description: '查看「手机通道」专属工作区状态：路径、id、已归属会话数、记忆与流水条数。',
      parameters: {},
      execute: async () => {
        let count = 0
        try {
          const ws = state.reg?.get?.(state.workspaceId)
          count = (ws?.sessionIds || []).length
        } catch { }
        return {
          ok: Boolean(state.workspaceId),
          result: [
            `工作区 id : ${state.workspaceId || '(未就绪)'}`,
            `路径      : ${state.workspacePath || cfg.workspacePath}`,
            `已归属会话: ${count}`,
            `共享记忆  : ${mem.items.length} 条（置顶 ${mem.items.filter((m) => m.pinned).length}）`,
            `自动流水  : ${dig.items.length} 条`,
            `数据目录  : ${cfg.dataDir}`,
          ].join(NL),
        }
      },
    },
  ]

  const diag = { toolsService: 'absent', defineTool: typeof defineTool, errors: [], registered: [] }

  // Written before it is called: registration can land either synchronously (hosts
  // that resolve `tools` eagerly) or from the inject callback, and both paths report
  // through here. A single early snapshot would always show registered:0 on profiles
  // where inject defers, which previously read as "plugin not installed".
  const writeStatus = () => {
    try {
      writeJson(join(cfg.dataDir, 'status.json'), {
        version: 1, at: new Date().toISOString(), registered: diag.registered.length, total: tools.length,
        diag, workspace: state.workspaceId || null, memories: mem.items.length,
      })
    } catch { }
  }

  const registerAll = (toolsSvc) => {
    if (diag.registered.length) return                       // exactly once
    if (!toolsSvc || typeof toolsSvc.register !== 'function') { diag.toolsService = 'unavailable'; return }
    diag.toolsService = 'ok'
    for (const t of tools) {
      try {
        toolsSvc.register(defineTool({ ...t, output: OUT() }))
        diag.registered.push(t.name)
      } catch (e) {
        const msg = `${t.name}: ` + String(e?.message ?? e).slice(0, 160)
        diag.errors.push(msg)
        ctx.logger?.warn?.(`channel-memory: tool ${msg}`)
      }
    }
    writeStatus()
  }

  // `tools` is requested through inject rather than read off the root context:
  // on some profiles (observed under `--profile acp`, the path phone turns take)
  // touching ctx.tools without declaring it throws
  // `cannot get property "tools" without inject`, which would abort apply() and
  // leave the plugin mounted but tool-less.
  ctx.inject(['tools'], (host) => registerAll(host.tools))

  // Hosts that already resolved the service call the callback synchronously; where
  // they do not, keep the direct handle as a guarded fallback so registration can
  // never silently no-op. registerAll ignores the second attempt.
  if (!diag.registered.length) {
    try { registerAll(ctx.tools) } catch (e) { diag.errors.push('direct: ' + String(e?.message ?? e).slice(0, 120)) }
  }
  writeStatus()
  setTimeout(writeStatus, 2000)      // after the workspace effect has had time to land
  setTimeout(writeStatus, 10000)

  ctx.logger?.info?.(`channel-memory ready: tools=${diag.registered.length}/${tools.length} memories=${mem.items.length} ws=${cfg.workspacePath}`)
}