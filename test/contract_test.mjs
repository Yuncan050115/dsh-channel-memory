// Contract test for dsh-channel-memory using the HOST's real defineTool.
//
// The plugin imports '@deepseek-ai/dsh-tools' as a bare specifier, which only
// resolves inside a profile/asar tree. Rather than stub defineTool (which would
// prove nothing), this harness rewrites that one specifier to the asar file URL
// and loads the result. Files inside the asar resolve their own bare specifiers
// (dsh-tools -> @deepseek-ai/cordis) exactly as the app does, so the real schema
// compiler runs: any DSL violation throws here instead of at boot.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TOOLS_URL = pathToFileURL(process.env.DSH_TOOLS_ENTRY
  || 'D:/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js').href;
const PLUGIN = process.env.DSH_PLUGIN_ENTRY
  || path.join(process.cwd(), 'lib', 'index.js');

const src = fs.readFileSync(PLUGIN, 'utf8');
if (!src.includes("'@deepseek-ai/dsh-tools'")) { console.error('import line not found — plugin changed shape'); process.exit(1); }
const patched = src.replace(/from '@deepseek-ai\/dsh-tools'/g, `from ${JSON.stringify(TOOLS_URL)}`);
const tmp = path.join(path.dirname(PLUGIN), '__contract_under_test.mjs');
fs.writeFileSync(tmp, patched, 'utf8');

let mod;
try {
  mod = await import(pathToFileURL(tmp).href);
} finally {
  fs.rmSync(tmp, { force: true });
}

const { defineTool } = await import(TOOLS_URL);
console.log('host defineTool:', typeof defineTool);
console.log('plugin exports:', Object.keys(mod), '| name =', mod.name);

const registered = [], injected = [], logged = [], sections = [], events = {};
// The host's real invariant: attachSession() validates that the session header's
// cwd equals the workspace path and throws otherwise. The fake enforces exactly
// that, so "attach succeeded" is the plugin's only evidence of channel ownership
// and a foreign session can never be claimed.
const fakeWorkspace = {
  id: 'ws-fake', path: 'C:/Users/wujid/.dsh/channel-workspace', title: '手机通道', sessionIds: [],
  async attachSession(id) {
    if (!id) throw new Error('no id');
    const cwd = String(seenCwd.get(id) || '').replace(/[\\/]+$/, '').toLowerCase();
    const want = this.path.replace(/[\\/]+$/, '').toLowerCase();
    if (cwd !== want) throw new Error(`session "${id}" cwd does not match workspace path`);
    this.sessionIds.push(id);
  },
};
const seenCwd = new Map();
const workspaceRegistry = {
  async resolveByPath() { return fakeWorkspace; },
  async create(p, t) { return fakeWorkspace; },
  get() { return fakeWorkspace; },
};
const systemPrompt = {
  // Mirror the host's own guard: non-finite order throws.
  section(s) {
    if (!s?.name) throw new Error('section needs name');
    if (!Number.isFinite(s.order)) throw new Error(`section "${s.name}" order must be a finite number`);
    if (typeof s.text !== 'string' && typeof s.text !== 'function') throw new Error('section needs text string|function');
    sections.push(s);
    return () => { };
  },
};
const ctx = {
  logger: { info: (m) => logged.push(['info', m]), warn: (m) => logged.push(['warn', m]), debug: (m) => logged.push(['debug', m]) },
  effect(fn) { const r = fn(); return r && typeof r.then === 'function' ? r.then(() => () => { }) : () => { }; },
  inject(names, cb) {
    injected.push(names);
    const host = {};
    for (const n of names) {
      if (n === 'workspaceRegistry') host.workspaceRegistry = workspaceRegistry;
      else if (n === 'systemPrompt') host.systemPrompt = systemPrompt;
      else if (n === 'sessions') host.sessions = { get: () => undefined, list: () => [] };
    }
    return cb(host);
  },
  on(evt, cb) { (events[evt] ||= []).push(cb); },
  tools: { register(t) { if (!t?.name) throw new Error('tool needs name'); registered.push(t); return () => { }; } },
  workspaceRegistry,
};

// Isolate all writes into a throwaway DSH_HOME so the test never touches the
// operator's real ~/.dsh (the plugin derives both dirs from it by default).
const SANDBOX = path.join(path.dirname(PLUGIN), '__contract_home');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
process.env.DSH_HOME = SANDBOX;

await mod.apply(ctx, {});

console.log(`\ninject calls    : ${JSON.stringify(injected)}`);
console.log(`events bound    : ${JSON.stringify(Object.keys(events))}`);
console.log(`prompt sections : ${sections.map((s) => `${s.name}@${s.order}(text=${typeof s.text})`).join(', ') || 'NONE'}`);
console.log(`tools registered: ${registered.length}`);
for (const t of registered) {
  console.log(`   ${t.name.padEnd(24)} params=${Object.keys(t.parameters?.properties || {}).length} required=${JSON.stringify(t.parameters?.required || [])} render=${typeof t.output?.render}`);
}

const call = async (name, args) => {
  const t = registered.find((x) => x.name === name);
  if (!t) throw new Error('no tool ' + name);
  // go through the host-compiled execute so arg validation runs
  return t.execute(args, { signal: AbortSignal.timeout(5000), callId: 'test', arguments: args });
};

console.log('\n--- behaviour ---');
const w = await call('memory_write', { text: '求职目标：AI 应用开发 / 算法实习，2027 届', kind: 'fact', pinned: true, tags: ['求职'] });
console.log('write  :', JSON.stringify(w).slice(0, 110));
const s = await call('memory_search', { query: '求职' });
console.log('search :', JSON.stringify(s.result).slice(0, 130));
const l = await call('memory_list', { include_digests: true });
console.log('list   :', JSON.stringify(l.result).slice(0, 130));
const info = await call('channel_workspace_info', {});
console.log('info   :', JSON.stringify(info.result).slice(0, 200));
const id = String(w.result).match(/\[(\w+)\]/)?.[1];
console.log('forget :', JSON.stringify(await call('memory_forget', { id })).slice(0, 110));
console.log('forget-missing:', JSON.stringify(await call('memory_forget', { id: 'zzzzzzzz' })).slice(0, 90));
console.log('empty-text    :', JSON.stringify(await call('memory_write', { text: '   ' })).slice(0, 90));

// arg validation must reject a wrong type via the compiled validator
try {
  await call('memory_write', { text: 12345 });
  console.log('!! validator accepted a number for a string param');
} catch (e) { console.log('type-guard :', String(e?.message || e).slice(0, 90)); }

// Re-add so the index has content, then render: proves text-as-function picks up
// writes made after apply() — a static string could not.
await call('memory_write', { text: '常驻事实：手机通道记忆需跨会话共享', kind: 'pref', pinned: true });
const rendered = sections.find((x) => x.name === 'channel-memory:index')?.text({});
console.log('\n--- rendered index (live, after a post-apply write) ---');
console.log(String(rendered).slice(0, 320));
const indexLive = String(rendered).includes('跨会话共享');
console.log('index reflects post-apply write:', indexLive);

console.log('\n--- event handling ---');
const CH = 'C:/Users/wujid/.dsh/channel-workspace';
// cwd is what the fake host validates inside attachSession; the plugin itself
// never inspects it, it only learns ownership from attach succeeding.
seenCwd.set('sess-abc', CH);
seenCwd.set('sess-elsewhere', 'C:/other/place');
for (const cb of events['session/created'] || []) await cb({ id: 'sess-abc' });
await new Promise((r) => setTimeout(r, 60));
console.log('attached (channel session):', JSON.stringify(fakeWorkspace.sessionIds));
for (const cb of events['session/created'] || []) await cb({ id: 'sess-elsewhere' });
await new Promise((r) => setTimeout(r, 60));
console.log('after foreign session     :', JSON.stringify(fakeWorkspace.sessionIds), '(must not contain sess-elsewhere)');
for (const cb of events['session/event'] || []) {
  await cb({ id: 'sess-abc' }, { type: 'turn/end', data: { reason: { kind: 'end_turn' } } });
  await cb({ id: 'sess-elsewhere' }, { type: 'turn/end', data: {} });
  await cb({ id: 'sess-abc' }, { type: 'step/end', data: {} });
}
console.log('digest rows (only channel turn/end):', JSON.stringify(await call('memory_list', { include_digests: true })).match(/自动流水 \d+ 条/)?.[0]);
const infoAfter = await call('channel_workspace_info', {});
console.log('info tool reads registry via inject:', JSON.stringify(infoAfter.result).includes('已归属会话: 1'));

console.log('\n--- plugin log ---');
for (const [lvl, m] of logged) console.log(`  ${lvl}: ${String(m).slice(0, 140)}`);

const ok = registered.length === 5 && sections.length === 1
  && fakeWorkspace.sessionIds.includes('sess-abc')
  && !fakeWorkspace.sessionIds.includes('sess-elsewhere')
  && indexLive;
console.log('\nRESULT:', ok ? 'PASS' : 'FAIL');
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
