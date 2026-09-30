import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { Config, SETTINGS_NAMESPACE, resolveConfig } from './config.js'
import { PromptPersonaWebBackend, installPromptPersonaWeb } from './web.js'

export { Config }

export const name = '@xilin3/dsh-prompt-persona'

/**
 * 依赖的服务：`systemPrompt`（注入点）。
 *
 * `settings` 刻意**不是**硬依赖：DSH 0.1.7 起业务插件可以在没有 Settings 的
 * 组合里照常运行（配置改由 profile patch 提供）。本插件在 `apply` 里用可选的
 * `ctx.inject(['settings'], …)` 子级登记设置页策略，通过 `ctx.get('settings')`
 * 读/写表单值。
 *
 * 适配基线：DSH **0.2.0-rc.2**（宿主包 system-prompt / settings / webServer /
 * agentDefaultModel 的契约自 0.1.7-rc.2 起未变；0.2.0 的断裂点是 `settings.section`
 * 槽位改由 `dsh-client-ui-settings-general` 声明，见 package.json 的 dsh.client.inject）。
 */
export const inject = ['systemPrompt']

/** 提示词注册表自己的 loader entry 名（部署 persona 的配置来源）。 */
const SYSTEM_PROMPT_ENTRY = '@deepseek-ai/dsh-system-prompt'

/** 取可选服务：优先 0.1.7 的可选服务读法（ctx.get），再退回属性访问。 */
function readService(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') {
      const viaGet = ctx.get(name)
      if (viaGet !== undefined) return viaGet
    }
  } catch {
    // 服务不存在时 cordis 的 get 会抛错，按「没有这个服务」处理。
  }
  try {
    const direct = ctx?.[name] ?? ctx?.root?.[name]
    return direct ?? undefined
  } catch {
    return undefined
  }
}

/** 从提示词注册表这条 loader entry 上取它的 composition config。 */
function systemPromptEntryConfig(ctx) {
  const loader = readService(ctx, 'loader')
  if (loader !== undefined) {
    try {
      for (const entry of loader.entries()) {
        if (entry?.options?.name === SYSTEM_PROMPT_ENTRY) return entry.options.config
      }
    } catch {
      // entry 形态变化时换下一条路。
    }
  }
  // 备用：配置编辑器持有的条目表（dsh-settings 也走这条面）。
  const editor = readService(ctx, 'configEditor')
  if (editor !== undefined) {
    try {
      for (const row of editor.configuration()) {
        if (row?.entry?.options?.name !== SYSTEM_PROMPT_ENTRY) continue
        return row.entry.options.config ?? row.inherited
      }
    } catch {
      // 同上。
    }
  }
  return undefined
}

/**
 * 读取「部署层」自己的 persona-prefix 文本。
 *
 * 提示词注册表把 `deployment:persona-prefix` 注册为全局 section，文本取自它
 * 自己的 composition config（`personaPrefix`）。agent preset / 子 agent 会挂
 * `@deepseek-ai/dsh-persona`，用同名 section 在自己的 scope 里**遮蔽**它——拿到
 * 这段原文，才能区分「这段 persona 是部署层的」还是「这段 persona 是别人的」。
 *
 * @returns 部署层 prefix 文本；两处来源都拿不到时返回 `undefined`（表示无法判定）。
 */
export function deploymentPersonaPrefix(ctx) {
  const config = systemPromptEntryConfig(ctx)
  if (config === undefined) return undefined
  return typeof config.personaPrefix === 'string' ? config.personaPrefix : ''
}

/**
 * 把一份已解析配置作用到 section 列表上。
 * @param sections - 原件（不被修改）。
 * @param resolved - `resolveConfig` 的结果。
 * @param shadowed - 该 section 是否被更高优先级的 scope 遮蔽（遮蔽时不动它）。
 * @returns 新的 section 列表；无改动时原样返回。
 */
export function applyPersona(sections, resolved, shadowed) {
  const { persona, mode } = resolved
  if (mode === 'off' || persona.length === 0) return sections
  let changed = false
  const next = sections.map((section) => {
    if (section.name !== PERSONA_PREFIX_SECTION) return section
    if (shadowed) return section
    changed = true
    if (mode === 'replace') return { ...section, text: persona }
    const current = typeof section.text === 'string' ? section.text : ''
    return { ...section, text: current.length > 0 ? `${current}\n\n${persona}` : persona }
  })
  return changed ? next : sections
}

/**
 * 宿主插件入口。
 * 1. 声明设置页策略（关掉按 schema 自动生成的页面，由 client 半身的自定义页接管）。
 * 2. 在 `system-prompt/assemble` waterfall 里把 persona 注入 `deployment:persona-prefix`。
 * 3. 挂一个同源 HTTP 路由给浏览器设置页（当前提示词 / 预览 / 保存）。
 * @param ctx - 插件上下文。
 * @param config - 本条目自己的 Config（volatile 字段是引用，见 `config.js`）。
 */
export function apply(ctx, config = {}) {
  // settings 是可选服务。自带页面的插件按 0.1.7 约定在这里登记策略：
  // 子级让迟加载/被替换的 Settings 服务也会采用同一策略。
  const disposeSettings = ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), 'prompt-persona: settings page policy')
  })

  // 每次 prompt 组装后，把本条目配置（设置页写的就是它）里的 persona 写进
  // deployment:persona-prefix。volatile 引用现读，所以设置页保存后立刻生效。
  // untagged 的全局 listener 会被 scope dispatch 放行，覆盖所有 agent scope。
  const disposeAssembly = ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const assembled = await next()
    const resolved = resolveConfig(config)
    if (resolved.mode === 'off' || resolved.persona.length === 0) return assembled
    const deployment = deploymentPersonaPrefix(ctx)
    const current = assembled.sections.find((section) => section.name === PERSONA_PREFIX_SECTION)
    // 部署层之外的贡献（agent preset / 子 agent persona）遮蔽了这段 section：
    // 那份 persona 不归本插件管，不要覆盖它。
    const shadowed = deployment !== undefined && current !== undefined && current.text !== deployment
    const sections = applyPersona(assembled.sections, resolved, shadowed)
    return sections === assembled.sections ? assembled : { ...assembled, sections }
  })

  const backend = new PromptPersonaWebBackend(ctx, config)
  const disposeWeb = installPromptPersonaWeb(ctx, backend)

  return () => {
    disposeAssembly()
    disposeWeb?.()
    if (typeof disposeSettings === 'function') disposeSettings()
  }
}
