#!/usr/bin/env node
/**
 * 把插件 host 半身真正 `import` 的 DSH 包准备到本包自己的 node_modules。
 *
 * host 半身（lib/index.js / lib/web.js / lib/config.js）会 import：
 *   - @deepseek-ai/dsh-system-prompt  （PERSONA_PREFIX_SECTION / renderPrompt）
 *   - @deepseek-ai/schemastery        （本条目 Config；**必须支持 .volatile()**）
 *   - @deepseek-ai/cosmokit           （isVolatile()，读 volatile 引用）
 *
 * 这些包由 DSH 宿主提供（peerDependencies）。Node 的解析是从「本包目录」向上
 * 找 node_modules，而 profile 的 node_modules 里通常没有 @deepseek-ai/*，所以
 * 必须在本包内准备一份（Windows 用 junction，免管理员权限；asar 来源则落盘）。
 *
 * ## 为什么是「闭包」而不只是这三个包
 *
 * `dsh-system-prompt` 自己还会 import `@deepseek-ai/cordis`、`@deepseek-ai/dsh-scope`，
 * cordis 又依赖 `@deepseek-ai/cosmokit` 与 `@standard-schema/spec`……DSH 0.1.7 时代
 * 这些包能在 npm 全局安装的 `dsh` 目录里被「顺带」解析到；从 app.asar 解出来的是
 * **平铺**目录，没有兄弟包，所以必须把整条依赖闭包一起准备，否则第一个 import 就会
 * `ERR_MODULE_NOT_FOUND`。本脚本从根包出发，按「声明的 dependencies ∪ 代码里真实的
 * 裸导入」递归求闭包。
 *
 * ## 为什么还要校验版本
 *
 * DSH settings 只投影插件 Config 里的 `.volatile()` 字段，而 `.volatile()` 是
 * schemastery 3.18.4 才有的 API（`@deepseek-ai/dsh-settings` 的 peerDependencies
 * 要求 `schemastery ~3.18.4`）。如果顺手链到旧版 schemastery，插件会在 import 期
 * 直接抛 `...volatile is not a function`，或者设置页整个不出现 —— 所以根包逐个校验
 * 能力（探针），不合格就换下一个来源，而不是静默链上。
 *
 * ## 来源顺序
 *
 *   1. `$DSH_CHECKOUT`：deepseek-harness 源码 checkout（显式开发意图，优先级最高）
 *   2. DSH Desktop 的 app.asar：`--asar <path>` / `$DSH_DESKTOP_ASAR` / `$DSH_DESKTOP_HOME`，
 *      否则从注册表（InstallLocation / DisplayIcon / UninstallString）与常见安装目录探测。
 *      **这是「宿主实际在跑的那份代码」，所以优先于全局 npm 安装。**
 *   3. npm 全局安装的 dsh（`npm i -g @deepseek-ai/dsh`）
 *   4. profile 自己的 node_modules（`~/.dsh/profiles/node_modules`）
 *
 * 用法：
 *   node scripts/link-deps.mjs
 *   node scripts/link-deps.mjs --asar "D:\\Deepseekharness\\resources\\app.asar"
 *   DSH_CHECKOUT=/path/to/deepseek-harness node scripts/link-deps.mjs
 */
import fs from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { builtinModules } from 'node:module'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCOPE = '@deepseek-ai'
/** 本包自己的 node_modules：按 specifier 原样平铺（`@scope/name` → `@scope/name/`）。 */
const NM_ROOT = join(PKG_ROOT, 'node_modules')

/**
 * 必须就绪的根包（**完整 specifier**，和插件源码里的 import 一致）。
 * `probe` 对 lib/ 下的产物源码判断「这份拷贝真的能用吗」。
 */
const ROOTS = [
  { spec: `${SCOPE}/dsh-system-prompt`, probe: (text) => text.includes('PERSONA_PREFIX_SECTION'), why: '提示词 section 名与 renderPrompt' },
  { spec: `${SCOPE}/schemastery`, probe: (text) => /prototype\.volatile\s*=/.test(text), why: 'Config 的 .volatile()（settings 必需）' },
  { spec: `${SCOPE}/cosmokit`, probe: (text) => text.includes('isVolatile'), why: 'isVolatile() 读 volatile 引用' },
]
const ROOT_SPECS = new Set(ROOTS.map((root) => root.spec))

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])

/* ------------------------------------------------------------------ 小工具 */

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function readIfFile(path, max = 8 * 1024 * 1024) {
  try {
    const stat = fs.statSync(path)
    if (!stat.isFile() || stat.size > max) return ''
    return fs.readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** 把一个包 lib/ 下的构建产物拼成一份文本（用于能力探针与依赖扫描）。 */
function libText(dir, maxDepth = 3) {
  const lib = join(dir, 'lib')
  let text = ''
  const walk = (current, depth) => {
    if (depth > maxDepth || text.length > 4 * 1024 * 1024) return
    for (const entry of safeReaddir(current)) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      else if (/\.(mjs|cjs|js)$/.test(entry.name)) text += readIfFile(path)
    }
  }
  walk(lib, 0)
  return text
}

function manifestOf(dir) {
  const raw = readIfFile(join(dir, 'package.json'))
  if (raw === '') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** 探针结果：{ ok, version, reason }。 */
function inspect(dir, root) {
  if (!fs.existsSync(join(dir, 'package.json'))) return { ok: false, version: undefined, reason: '不存在' }
  const version = manifestOf(dir)?.version
  const probe = root?.probe
  if (probe !== undefined && !probe(libText(dir))) {
    return { ok: false, version, reason: `缺少所需 API（${root.why}）` }
  }
  return { ok: true, version, reason: '' }
}

/**
 * 一个包的直接依赖（用于闭包遍历）：声明的 `dependencies` ∪ 代码里真实出现的裸导入。
 *
 * 刻意**不**跟随 `peerDependencies`：宿主包之间互相声明了一大堆 peer，全部跟随会让
 * 闭包膨胀；真正会在运行期被解析的是「代码里 import 了什么」，那部分扫描已经覆盖。
 * @param dir - 包目录。
 * @returns 需要一并准备的完整 specifier 集合。
 */
function childSpecs(dir) {
  const found = new Set()
  const manifest = manifestOf(dir) ?? {}
  for (const name of Object.keys(manifest.dependencies ?? {})) found.add(name)
  const code = libText(dir, 4)
  const patterns = [/(?:from|require)\s*\(?\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.add(match[1])
  }
  const result = new Set()
  for (const spec of found) {
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
    if (BUILTINS.has(spec)) continue
    // 归一到「包名」：@scope/name 或 name（丢掉子路径）。
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    if (name === '' || name === '.' || name === '..') continue
    result.add(name)
  }
  return result
}

/* --------------------------------------------------------------- asar 读取 */

/**
 * 读取 asar 的目录索引。
 *
 * 布局：[4B 4][4B header pickle 大小][4B …][4B JSON 长度][JSON][… 数据]
 * 数据区从 `8 + header pickle 大小` 开始（4 字节对齐）。
 * @param asarPath - app.asar 路径。
 * @returns `{ dataOffset, files, fd }`，`files` 是 `路径 -> { size, offset }`。
 */
function readAsarIndex(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const slug = head.toString('latin1', 0, 4)
    if (slug !== 'b3' && head.readUInt32LE(0) !== 4) throw new Error('不是 asar 文件')
    const jsonLength = head.readUInt32LE(12)
    if (jsonLength <= 0 || jsonLength > 64 * 1024 * 1024) throw new Error('asar 头部长度异常')
    const jsonBuf = Buffer.alloc(jsonLength)
    fs.readSync(fd, jsonBuf, 0, jsonLength, 16)
    const header = JSON.parse(jsonBuf.toString('utf8'))
    const dataOffset = 8 + head.readUInt32LE(4)
    const files = new Map()
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const path = prefix === '' ? name : `${prefix}/${name}`
        if (entry.files) walk(entry, path)
        else if (entry.offset !== undefined) files.set(path, { size: entry.size ?? 0, offset: Number(entry.offset) })
      }
    }
    walk(header, '')
    return { dataOffset, files, fd }
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}

/** asar 里的运行时包根（宿主包都是 `@deepseek-ai/*`）。 */
function asarRuntimePrefix(index) {
  for (const prefix of ['dsh/node_modules', 'node_modules', '']) {
    const probe = `${prefix === '' ? '' : `${prefix}/`}${SCOPE}/dsh-system-prompt/package.json`
    if (index.files.has(probe)) return prefix
  }
  return undefined
}

/* --------------------------------------------------------------- 来源发现 */

/**
 * 可用的平铺来源。两种形态：
 *   - `node_modules`：包直接位于 `<dir>/<spec>`（`@scope/name` → `<dir>/@scope/name`）
 *   - `scope`：`@deepseek-ai` 的包目录（monorepo 的 `packages/`），`<dir>/<短名>`
 */
function flatSources() {
  const list = []
  const push = (dir, kind) => {
    if (typeof dir === 'string' && dir !== '' && fs.existsSync(dir) && !list.some((row) => row.dir === dir && row.kind === kind)) {
      list.push({ dir, kind })
    }
  }
  const checkout = process.env.DSH_CHECKOUT
  if (checkout) {
    push(join(checkout, 'node_modules'), 'node_modules')
    push(join(checkout, 'node_modules', SCOPE, 'dsh', 'node_modules'), 'node_modules')
    push(join(checkout, 'packages'), 'scope')
  }
  if (process.env.APPDATA) push(join(process.env.APPDATA, 'npm', 'node_modules'), 'node_modules')
  push(join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules'), 'node_modules')
  push(join(homedir(), '.npm-global', 'lib', 'node_modules'), 'node_modules')
  push('/usr/local/lib/node_modules', 'node_modules')
  push('/usr/lib/node_modules', 'node_modules')
  push(join(homedir(), '.dsh', 'profiles', 'node_modules'), 'node_modules')
  push(join(homedir(), '.dsh', 'node_modules'), 'node_modules')
  return list
}

/** 解析某个来源里这个 specifier 的具体目录；该来源不适用时返回 undefined。 */
function sourcePath(source, spec) {
  if (source.kind === 'node_modules') return join(source.dir, ...spec.split('/'))
  if (!spec.startsWith(`${SCOPE}/`)) return undefined
  return join(source.dir, spec.slice(SCOPE.length + 1))
}

/**
 * Windows 桌面版安装目录。
 *
 * 桌面版安装器写的是 `DisplayIcon`（`<安装目录>\DeepSeek Harness.exe,0`）与
 * `UninstallString`，`InstallLocation` 不一定有 —— 所以三个值都要看，再加上显式
 * 环境变量。
 */
function desktopInstallDirs() {
  const dirs = []
  const push = (path) => {
    if (typeof path === 'string' && path.trim() !== '' && !dirs.includes(path)) dirs.push(path)
  }
  push(process.env.DSH_DESKTOP_HOME)
  if (process.env.LOCALAPPDATA) push(join(process.env.LOCALAPPDATA, 'Programs'))
  for (const key of ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'ProgramW6432']) {
    if (process.env[key]) push(process.env[key])
  }
  if (process.platform === 'win32') {
    const keys = [
      'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ]
    for (const key of keys) {
      let out = ''
      try {
        out = execFileSync('reg', ['query', key, '/s'], { encoding: 'utf8', timeout: 8000, maxBuffer: 32 * 1024 * 1024 })
      } catch {
        continue
      }
      // 按 Uninstall 子键切块，只在「看起来是 DSH」的块里取值。
      for (const block of out.split(/\r?\n\r?\n/)) {
        if (!/deepseek|harness|\bdsh\b/i.test(block)) continue
        for (const line of block.split(/\r?\n/)) {
          const match = /^\s*(InstallLocation|DisplayIcon|UninstallString|InstallDir)\s+REG_[A-Z_]+\s+(.+?)\s*$/.exec(line)
          if (match === null) continue
          let value = match[2].trim().replace(/^"|"$/g, '').replace(/,\d+$/, '')
          if (/\.exe$/i.test(value)) value = dirname(value)
          else if (!fs.existsSync(value) && fs.existsSync(dirname(value))) value = dirname(value)
          push(value)
        }
      }
    }
  }
  return dirs
}

/** 在若干安装根目录下找 resources/app.asar（深度 2 以内）。 */
function asarCandidates(explicit) {
  const found = []
  const push = (path) => {
    if (path && fs.existsSync(path) && !found.includes(path)) found.push(path)
  }
  push(explicit)
  push(process.env.DSH_DESKTOP_ASAR)
  const roots = desktopInstallDirs()
  for (const home of roots) push(join(home, 'resources', 'app.asar'))
  for (const root of roots) {
    for (const app of safeReaddir(root)) {
      if (!app.isDirectory()) continue
      push(join(root, app.name, 'resources', 'app.asar'))
      for (const inner of safeReaddir(join(root, app.name))) {
        if (!inner.isDirectory()) continue
        push(join(root, app.name, inner.name, 'resources', 'app.asar'))
      }
    }
  }
  return found.filter((asarPath) => {
    try {
      const index = readAsarIndex(asarPath)
      const prefix = asarRuntimePrefix(index)
      fs.closeSync(index.fd)
      return prefix !== undefined
    } catch {
      return false
    }
  })
}

/* ------------------------------------------------------------------- 主流程 */

function parseArgs(argv) {
  const args = { asar: undefined, help: false, verbose: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--asar') args.asar = argv[++i]
    else if (argv[i] === '--verbose' || argv[i] === '-v') args.verbose = true
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true
  }
  return args
}

/** 把一个目录准备成 `<本包>/node_modules/<spec>`：优先 junction，跨盘/asar 则落盘。 */
function link(from, to) {
  fs.mkdirSync(dirname(to), { recursive: true })
  if (fs.existsSync(to)) {
    try {
      if (fs.realpathSync(to) === fs.realpathSync(from)) return 'kept'
    } catch {
      // 落盘拷贝（不是链接）时 realpath 不相等：删掉重建。
    }
    fs.rmSync(to, { recursive: true, force: true })
  }
  fs.symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir')
  return 'linked'
}

/** 从 asar 把 `<prefix>/<spec>` 整棵子树落到 `<本包>/node_modules/<spec>`。 */
function materializeFromAsar(asarPath, spec, prefix, index) {
  const base = `${prefix === '' ? '' : `${prefix}/`}${spec}/`
  const matches = [...index.files].filter(([path]) => path.startsWith(base))
  if (matches.length === 0) return { ok: false, reason: `asar 里没有 ${base}` }
  const target = join(NM_ROOT, ...spec.split('/'))
  fs.rmSync(target, { recursive: true, force: true })
  for (const [path, meta] of matches) {
    const dest = join(target, ...path.slice(base.length).split('/'))
    fs.mkdirSync(dirname(dest), { recursive: true })
    const buf = Buffer.alloc(meta.size)
    if (meta.size > 0) fs.readSync(index.fd, buf, 0, meta.size, index.dataOffset + meta.offset)
    fs.writeFileSync(dest, buf)
  }
  return { ok: true, files: matches.length }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(readIfFile(fileURLToPath(import.meta.url)).split('\n').slice(0, 50).join('\n'))
    return
  }

  // 0) 找到 app.asar（宿主实际在跑的那份代码）；显式 --asar 优先。
  let asar
  let asarPrefix
  let asarIndex
  const openAsar = () => {
    if (asar !== undefined) return asar
    const candidate = asarCandidates(args.asar)[0]
    if (candidate === undefined) return undefined
    asarIndex = readAsarIndex(candidate)
    const prefix = asarRuntimePrefix(asarIndex)
    if (prefix === undefined) {
      fs.closeSync(asarIndex.fd)
      return undefined
    }
    asar = candidate
    asarPrefix = prefix
    return asar
  }
  const closeAsar = () => {
    if (asarIndex !== undefined) fs.closeSync(asarIndex.fd)
  }

  const sources = flatSources()
  const prepared = new Map()
  const failures = []

  /** 准备一个 specifier（返回来源记录；失败返回 undefined）。 */
  const ensure = (spec) => {
    if (prepared.has(spec)) return prepared.get(spec)
    const target = join(NM_ROOT, ...spec.split('/'))
    const root = ROOTS.find((row) => row.spec === spec)
    const checkoutOnly = sources.filter((source) => source.dir.startsWith(process.env.DSH_CHECKOUT ?? '\u0000'))
    let record

    // 1) 显式 checkout（开发意图），2) app.asar（宿主实际在跑的那份），3) 其它平铺来源。
    const flatCandidates = (process.env.DSH_CHECKOUT ? checkoutOnly : []).concat(sources.filter((source) => !checkoutOnly.includes(source)))
    for (const source of flatCandidates) {
      const path = sourcePath(source, spec)
      if (path === undefined) continue
      const result = inspect(path, root)
      if (!result.ok) continue
      record = { spec, source: source.dir, version: result.version, action: link(path, target) }
      break
    }
    if (record === undefined && openAsar() !== undefined) {
      const result = materializeFromAsar(asar, spec, asarPrefix, asarIndex)
      const after = inspect(target, root)
      if (result.ok && after.ok) {
        record = { spec, source: `${asar} (解出 ${result.files} 个文件)`, version: after.version, action: 'extracted' }
      } else {
        record = { spec, source: asar, version: after.version, action: `失败：${after.ok ? '解包失败' : after.reason}` }
      }
    }
    if (record === undefined) {
      record = { spec, source: '(无来源)', version: undefined, action: `失败：没有可用的来源提供 ${spec}` }
    }

    if (record.action.startsWith('失败')) {
      // 只有根包失败才算致命；闭包成员缺失（可选依赖、宿主注入）跳过即可。
      if (ROOT_SPECS.has(spec)) failures.push(record)
      fs.rmSync(target, { recursive: true, force: true })
      return undefined
    }
    prepared.set(spec, record)
    return record
  }

  // 根包优先：先确保三个能力探针通过，再展开闭包。
  for (const spec of ROOT_SPECS) ensure(spec)

  const queue = [...ROOT_SPECS]
  const seen = new Set()
  while (queue.length > 0) {
    const spec = queue.shift()
    if (seen.has(spec)) continue
    seen.add(spec)
    if (ensure(spec) === undefined) continue
    const dir = join(NM_ROOT, ...spec.split('/'))
    if (!fs.existsSync(join(dir, 'package.json'))) continue
    for (const child of childSpecs(dir)) if (!seen.has(child)) queue.push(child)
  }

  // 汇总。
  const rows = [...prepared.values()].sort((a, b) => (a.spec < b.spec ? -1 : 1))
  console.log(`[link-deps] 依赖来源与结果（${rows.length} 个包，含依赖闭包）`)
  for (const row of rows) {
    if (!args.verbose && row.action === 'kept') continue
    console.log(`  ${row.spec.padEnd(38)} ${String(row.version ?? '-').padEnd(12)} ${row.action}  <- ${row.source}`)
  }
  if (asar !== undefined) console.log(`[link-deps] app.asar：${asar}`)
  closeAsar()

  // 真实 import 验证：走完整条闭包，是最有力的通过证据。
  const problems = []
  const probe = async (spec, entry, check, label) => {
    try {
      const loaded = await import(pathToFileURL(join(NM_ROOT, ...spec.split('/'), entry)).href)
      const problem = check(loaded)
      if (problem !== undefined) problems.push(problem)
    } catch (error) {
      problems.push(`${label} import 失败：${error.message}`)
    }
  }
  await probe(`${SCOPE}/schemastery`, 'lib/index.mjs', (m) => (typeof m.default?.string?.().volatile === 'function' ? undefined : 'schemastery 没有 .volatile()'), 'schemastery')
  await probe(`${SCOPE}/dsh-system-prompt`, 'lib/index.js', (m) => (typeof m.PERSONA_PREFIX_SECTION === 'string' ? undefined : 'dsh-system-prompt 没有导出 PERSONA_PREFIX_SECTION'), 'dsh-system-prompt')
  await probe(`${SCOPE}/cosmokit`, 'lib/index.js', (m) => (typeof m.isVolatile === 'function' ? undefined : 'cosmokit 没有导出 isVolatile()'), 'cosmokit')

  for (const row of failures) console.error(`[link-deps] 根包失败：${row.spec}（${row.action}）`)
  for (const problem of problems) console.error(`[link-deps] 验证失败：${problem}`)

  if (failures.length > 0 || problems.length > 0) {
    console.error(
      [
        '',
        '[link-deps] 无法为当前 DSH 版本准备依赖。请任选一种方式：',
        '',
        '  1. 指向桌面版安装内的 app.asar：',
        '       node scripts/link-deps.mjs --asar "<安装目录>\\resources\\app.asar"',
        '     或设 DSH_DESKTOP_ASAR / DSH_DESKTOP_HOME 环境变量。',
        '  2. 安装与宿主同版本的 CLI，再重跑：',
        '       npm i -g @deepseek-ai/dsh@<你正在用的版本> && node scripts/link-deps.mjs',
        '  3. 指向 deepseek-harness 源码 checkout：',
        '       DSH_CHECKOUT=/path/to/deepseek-harness node scripts/link-deps.mjs',
        '',
      ].join('\n'),
    )
    process.exit(1)
  }
  console.log('[link-deps] 验证通过：volatile / PERSONA_PREFIX_SECTION / isVolatile 均可用')
}

await main()
