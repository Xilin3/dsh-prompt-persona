#!/usr/bin/env node
/**
 * 适配自检：拿真实的 DSH 宿主包（schemastery / cosmokit / dsh-system-prompt）
 * 跑一遍插件 host 半身，确认它用的是当前 DSH 的契约。
 *
 * 目标版本：DSH **0.2.0-rc.2**（0.1.7-rc.2 起的契约基本延续，断裂点见 README）。
 *
 * 前置：先跑 `node scripts/link-deps.mjs`（本脚本 import 的 @deepseek-ai/* 就是它
 * 准备的那几份）。用法：`node scripts/check-adaptation.mjs`
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { Config, SETTINGS_NAMESPACE, live, resolveConfig } = await import('../lib/config.js')
const { applyPersona, deploymentPersonaPrefix, apply } = await import('../lib/index.js')
const { PromptPersonaWebBackend, SETTINGS_ROUTE } = await import('../lib/web.js')

let passed = 0
const failures = []

async function test(name, body) {
  try {
    await body()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

/** 报告本次自检实际跑在哪个宿主版本上 —— 适配结论必须能对上是哪一份包。 */
function linkedHostVersions() {
  const scope = join(PKG_ROOT, 'node_modules', '@deepseek-ai')
  const rows = []
  for (const name of ['dsh-system-prompt', 'schemastery', 'cosmokit', 'cordis', 'dsh-scope']) {
    try {
      rows.push(`${name}@${JSON.parse(fs.readFileSync(join(scope, name, 'package.json'), 'utf8')).version}`)
    } catch {
      rows.push(`${name}@(未链接)`)
    }
  }
  return rows.join('  ')
}

console.log('prompt-persona · DSH 0.2.0 适配自检')
console.log(`  宿主包：${linkedHostVersions()}\n`)

/* ---------------------------------------------------- Config 与 volatile 契约 */

await test('Config 的字段是可写的 volatile（settings 表单只投影 volatile 字段）', () => {
  const parsed = Config({})
  assert.equal(typeof parsed.persona?.get, 'function', 'persona 应该是 volatile 引用')
  assert.equal(typeof parsed.mode?.get, 'function', 'mode 应该是 volatile 引用')
  assert.equal(parsed.persona.get(), '')
  assert.equal(parsed.mode.get(), 'replace')
  // dsh-settings 的 volatileForm() 直接读 schema.meta.volatile
  assert.equal(Config.dict.persona.meta.volatile, true)
  assert.equal(Config.dict.mode.meta.volatile, true)
})

await test('live() 同时接受 volatile 引用与普通值', () => {
  const parsed = Config({ persona: 'hello' })
  assert.equal(live(parsed.persona), 'hello')
  assert.equal(live('plain'), 'plain')
  assert.equal(live(undefined), undefined)
})

await test('resolveConfig 归一化：trim + 非法 mode 回落 replace', () => {
  assert.deepEqual(resolveConfig(Config({})), { persona: '', mode: 'replace' })
  assert.deepEqual(resolveConfig(Config({ persona: '  x  ', mode: 'append' })), { persona: 'x', mode: 'append' })
  assert.deepEqual(resolveConfig(Config({ persona: 'x', mode: 'off' })), { persona: 'x', mode: 'off' })
  assert.deepEqual(resolveConfig({ persona: 'y', mode: 'bogus' }), { persona: 'y', mode: 'replace' })
  assert.deepEqual(resolveConfig(), { persona: '', mode: 'replace' })
})

/* ------------------------------------------------------------ 注入语义不变 */

const PERSONA = 'deployment:persona-prefix'
const section = (text) => ({ name: PERSONA, text, order: 0 })
const other = { name: 'harness:identity', text: 'identity', order: -1000 }
const baseAssembly = () => ({ sections: [other, section('deploy')], contexts: [], tools: [], variables: { cwd: 'E:\\work' } })

await test('applyPersona：replace / append / off 与 shadow 守卫', () => {
  assert.equal(applyPersona([section('base')], { persona: 'new', mode: 'replace' }, false)[0].text, 'new')
  assert.equal(applyPersona([section('base')], { persona: 'new', mode: 'append' }, false)[0].text, 'base\n\nnew')
  assert.equal(applyPersona([section('')], { persona: 'new', mode: 'append' }, false)[0].text, 'new')
  assert.equal(applyPersona([section('base')], { persona: 'new', mode: 'off' }, false)[0].text, 'base')
  // 被 preset / 子 agent 遮蔽时不覆盖
  assert.equal(applyPersona([section('preset')], { persona: 'new', mode: 'replace' }, true)[0].text, 'preset')
  // 其它 section 原样保留；无改动时返回原数组
  const sections = [other, section('base')]
  assert.deepEqual(applyPersona(sections, { persona: 'new', mode: 'replace' }, false).map((s) => s.name), ['harness:identity', PERSONA])
  assert.equal(applyPersona(sections, { persona: '', mode: 'replace' }, false), sections)
})

await test('deploymentPersonaPrefix：loader / configEditor 两条来源 + 拿不到时不判定', () => {
  const entries = () => [{ options: { name: '@deepseek-ai/dsh-system-prompt', config: { personaPrefix: 'deploy' } } }]
  // 0.1.7 的可选服务读法（非硬依赖服务用 ctx.get）
  assert.equal(deploymentPersonaPrefix({ get: (name) => (name === 'loader' ? { entries } : undefined) }), 'deploy')
  // 退回属性访问
  assert.equal(deploymentPersonaPrefix({ loader: { entries } }), 'deploy')
  // loader 拿不到时用 configEditor.configuration()（dsh-settings 走的同一面）
  const editor = { configuration: () => [{ entry: { options: { name: '@deepseek-ai/dsh-system-prompt', config: { personaPrefix: 'via-editor' } } } }] }
  assert.equal(deploymentPersonaPrefix({ get: (name) => (name === 'configEditor' ? editor : undefined) }), 'via-editor')
  // 没有 personaPrefix 字段 → 空串（部署层确实没有 persona），不是 undefined
  assert.equal(deploymentPersonaPrefix({ loader: { entries: () => [{ options: { name: '@deepseek-ai/dsh-system-prompt', config: {} } }] } }), '')
  // 完全拿不到 → undefined（无法判定）
  assert.equal(deploymentPersonaPrefix({ loader: { entries: () => [] } }), undefined)
  assert.equal(deploymentPersonaPrefix({}), undefined)
  // get 抛错（服务不存在）时不应炸
  assert.equal(deploymentPersonaPrefix({ get: () => { throw new Error('nope') } }), undefined)
})

/* ------------------------------------------------- 用假 ctx 跑一遍 apply() */

/** 一份符合 0.1.7 dsh-settings 契约的假 settings 服务。 */
function fakeSettings({ writable = true, value = { persona: '', mode: 'replace' } } = {}) {
  const state = { revision: 3, value, writes: [] }
  return {
    state,
    configured: [],
    writable,
    configure(presentation, owner) {
      this.configured.push({ presentation, owner })
      return () => {}
    },
    describe: () => [{ ns: SETTINGS_NAMESPACE, revision: state.revision, applies: 'live', value: state.value }],
    async update(ns, patch, expectedRevision) {
      if (ns !== SETTINGS_NAMESPACE) throw new Error(`unexpected ns ${ns}`)
      if (expectedRevision !== undefined && expectedRevision !== state.revision) {
        const error = new Error('conflict')
        error.code = 'SETTINGS_CONFLICT'
        throw error
      }
      state.writes.push(patch)
      state.value = { ...state.value, ...patch }
      state.revision += 1
    },
  }
}

function fakeCtx({ settings = fakeSettings() } = {}) {
  const ctx = {
    services: {
      settings,
      webServer: undefined,
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
      systemPrompt: undefined,
    },
    fiber: { id: 'plugin-fiber' },
    listeners: [],
    effects: [],
    routes: [],
    get(name) {
      return this.services[name]
    },
    inject(deps, callback) {
      for (const dep of deps) {
        if (this.services[dep] === undefined) continue
        const child = {
          settings: dep === 'settings' ? this.services.settings : undefined,
          webServer: dep === 'webServer' ? this.services.webServer : undefined,
          fiber: this.fiber,
          effect: (fn, label) => {
            this.effects.push(label)
            return fn()
          },
        }
        const dispose = callback(child)
        return typeof dispose === 'function' ? dispose : () => {}
      }
      return () => {}
    },
    on(event, listener) {
      this.listeners.push({ event, listener })
      return () => {}
    },
  }
  ctx.loader = { entries: () => [{ options: { name: '@deepseek-ai/dsh-system-prompt', config: { personaPrefix: 'deploy' } } }] }
  ctx.systemPrompt = { assemble: async () => baseAssembly() }
  ctx.services.systemPrompt = ctx.systemPrompt
  ctx.services.webServer = {
    register(route) {
      ctx.routes.push(route)
      return () => {}
    },
  }
  return ctx
}

const assembleListener = (ctx) => ctx.listeners.find((row) => row.event === 'system-prompt/assemble').listener

await test('apply()：登记设置页策略（auto:false）并挂同源路由 + assemble 监听', () => {
  const settings = fakeSettings()
  const ctx = fakeCtx({ settings })
  const dispose = apply(ctx, Config({ persona: 'p', mode: 'replace' }))
  assert.equal(settings.configured.length, 1, '应调用 settings.configure()')
  assert.deepEqual(settings.configured[0].presentation, { auto: false })
  assert.equal(settings.configured[0].owner, ctx.fiber)
  assert.equal(ctx.routes.length, 1, '应该注册一条 web 路由')
  assert.equal(ctx.routes[0].kind, 'exact')
  assert.equal(ctx.routes[0].path, SETTINGS_ROUTE)
  assert.ok(ctx.listeners.some((row) => row.event === 'system-prompt/assemble'), '应该挂 system-prompt/assemble')
  assert.equal(typeof dispose, 'function')
})

await test('apply()：assemble waterfall 把 persona 写进 deployment:persona-prefix', async () => {
  const ctx = fakeCtx()
  apply(ctx, Config({ persona: '自定义', mode: 'replace' }))
  const assembled = await assembleListener(ctx)(baseAssembly(), {}, async () => baseAssembly())
  assert.equal(assembled.sections.find((s) => s.name === PERSONA).text, '自定义')
  assert.equal(assembled.sections.find((s) => s.name === 'harness:identity').text, 'identity')
})

await test('apply()：agent preset 遮蔽时不覆盖（部署原文 != 组装值）', async () => {
  const shadowed = { sections: [other, section('preset-persona')], contexts: [], tools: [], variables: {} }
  const ctx = fakeCtx()
  apply(ctx, Config({ persona: '自定义', mode: 'replace' }))
  const assembled = await assembleListener(ctx)(shadowed, {}, async () => shadowed)
  assert.equal(assembled.sections.find((s) => s.name === PERSONA).text, 'preset-persona')
})

await test('apply()：mode=off / persona 为空时完全不碰 sections（返回同一个对象）', async () => {
  const assembly = baseAssembly()
  const ctx = fakeCtx()
  apply(ctx, Config({ persona: '自定义', mode: 'off' }))
  assert.equal(await assembleListener(ctx)(assembly, {}, async () => assembly), assembly)

  const ctx2 = fakeCtx()
  apply(ctx2, Config({ persona: '', mode: 'replace' }))
  assert.equal(await assembleListener(ctx2)(assembly, {}, async () => assembly), assembly)
})

/* --------------------------------------------------- web backend（0.1.7 契约） */

await test('snapshot()：value/revision/writable 来自 settings.describe()（不再是 settings.get()）', async () => {
  const settings = fakeSettings({ value: { persona: 'hello', mode: 'append' } })
  const ctx = fakeCtx({ settings })
  const backend = new PromptPersonaWebBackend(ctx, Config({}))
  const snapshot = await backend.snapshot()
  assert.deepEqual(snapshot.settings.value, { persona: 'hello', mode: 'append' })
  assert.equal(snapshot.settings.revision, 3)
  assert.equal(snapshot.settings.applies, 'live')
  assert.equal(snapshot.settings.writable, true)
  assert.ok(snapshot.currentPrompt.includes('deploy'), 'currentPrompt 应渲染当前 sections')
})

await test('snapshot()：settings 未挂载时回落到插件自己的 Config 引用', async () => {
  const ctx = fakeCtx()
  ctx.services.settings = undefined
  const backend = new PromptPersonaWebBackend(ctx, Config({ persona: 'from-patch', mode: 'replace' }))
  const snapshot = await backend.snapshot()
  assert.deepEqual(snapshot.settings.value, { persona: 'from-patch', mode: 'replace' })
  assert.equal(snapshot.settings.revision, 0)
  assert.equal(snapshot.settings.writable, false)
})

await test('save()：走 settings.update(entryId, {persona,mode}, revision)', async () => {
  const settings = fakeSettings()
  const ctx = fakeCtx({ settings })
  const backend = new PromptPersonaWebBackend(ctx, Config({}))
  const snapshot = await backend.save({ persona: '  saved  ', mode: 'append' }, 3)
  assert.deepEqual(settings.state.writes, [{ persona: 'saved', mode: 'append' }])
  assert.deepEqual(snapshot.settings.value, { persona: 'saved', mode: 'append' })
})

await test('save()：修订号过期 → SETTINGS_CONFLICT（HTTP 409 路径）', async () => {
  const settings = fakeSettings()
  const ctx = fakeCtx({ settings })
  const backend = new PromptPersonaWebBackend(ctx, Config({}))
  await assert.rejects(() => backend.save({ persona: 'x', mode: 'replace' }, 99), (error) => error.code === 'SETTINGS_CONFLICT')
})

await test('save()：settings 未挂载 / 只读时给出明确错误', async () => {
  const ctx = fakeCtx()
  ctx.services.settings = undefined
  await assert.rejects(() => new PromptPersonaWebBackend(ctx, Config({})).save({ persona: 'x' }, 0), /settings service is unavailable/)

  const ctx2 = fakeCtx({ settings: fakeSettings({ writable: false }) })
  await assert.rejects(() => new PromptPersonaWebBackend(ctx2, Config({})).save({ persona: 'x' }, 3), /read-only/)
})

await test('preview()：只影响草稿，不改动存档值', async () => {
  const settings = fakeSettings({ value: { persona: 'stored', mode: 'replace' } })
  const ctx = fakeCtx({ settings })
  const backend = new PromptPersonaWebBackend(ctx, Config({}))
  const { previewPrompt } = await backend.preview({ persona: 'draft', mode: 'replace' })
  assert.ok(previewPrompt.includes('draft'))
  assert.deepEqual(settings.state.value, { persona: 'stored', mode: 'replace' })
  assert.equal(settings.state.writes.length, 0)
})

/* ------------------------------------------------------------ client 半身契约 */

await test('client 半身使用当前的 slots / configForms 约定', () => {
  const source = fs.readFileSync(join(PKG_ROOT, 'lib', 'client.js'), 'utf8')
  assert.match(source, /const inject = \["slots", "configForms"\]/, '应注入 slots 与 configForms')
  assert.match(source, /configForms\.whileServed\(\[SETTINGS_NAMESPACE\]/, '应通过 whileServed 跟随本条目')
  assert.match(source, /name: "settings\.section"/, '应注册到 settings.section')
  assert.match(source, /writable === false/, '应处理只读部署')
  // 0.2.0 起 settings.section 由 ui-settings-general 声明（不再在 ui-settings 里）。
  // slots.inject 会等声明出现，但 inject 列表里指名 owner 才能保证先到。
  const pkg = JSON.parse(fs.readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
  assert.ok(
    pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-general'),
    'client.inject 应包含 settings.section 的声明方 dsh-client-ui-settings-general',
  )
})

await test('package.json 的依赖范围覆盖 0.2.x（上界不早于 0.3）', () => {
  const pkg = JSON.parse(fs.readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.peerDependencies['@deepseek-ai/schemastery'], '^3.18.4')
  assert.ok(pkg.peerDependencies['@deepseek-ai/cosmokit'], '需要 cosmokit（isVolatile）')
  for (const name of ['@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-client-ui-settings']) {
    const range = pkg.peerDependencies[name]
    assert.ok(range, `${name} 应有 peer 范围`)
    assert.doesNotMatch(range, /<\s*0\.2(\D|$)/, `${name} 的上界不能把 0.2.x 排除在外（当前 ${range}）`)
  }
  assert.ok(pkg.peerDependenciesMeta['@deepseek-ai/dsh-settings']?.optional, 'settings 应是可选依赖')
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
})

/* ---------------------------------------------------------------- 结果汇总 */

console.log(`\n${passed} 通过，${failures.length} 失败`)
if (failures.length > 0) process.exit(1)
