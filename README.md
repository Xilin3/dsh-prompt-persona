# @xilin3/dsh-prompt-persona

[![license](https://img.shields.io/badge/license-MIT-6758d4.svg)](./LICENSE)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-6758d4.svg)](https://github.com/topics/dsh-plugin)

一个 **DeepSeek Harness（DSH）插件**：在 Web 设置页里可视化编辑系统提示词（部署 persona），并实时预览改动效果。即「给 Harness 加系统提示词」的**方法 1 —— 改部署 persona**。

> 在 Harness 的系统提示词组装模型里，部署 persona 是唯一一段「由配置/部署作者撰写」的片段（order `0`）。本插件接管这段片段，把它变成设置页里可直接编辑、可预览、可持久化的内容，而无需改动 Harness 本体或手写 `cordis.patch.yml`。

**当前版本：0.4.0 — 已适配 DSH `0.2.0-rc.2`。** 兼容性改动见下方「版本适配」。

---

## 版本适配（0.2.0-rc.2）

DSH 0.2.0 把设置页的**槽位声明**从 `dsh-client-ui-settings` 搬到了新的
`dsh-client-ui-settings-general`（设置外壳：侧栏、导航、`settings.section` 的 children 表）。
插件依赖的宿主 API 其余部分（`system-prompt` 注册表、`settings` 服务、`webServer`、
`agentDefaultModel`、`whileServed`）在 0.2.0 上**契约不变**，所以这一版主要是声明与
依赖准备的问题，而不是逻辑改写：

| 断裂点 | 0.1.7-rc.2 | 现在（0.2.0-rc.2） | 本插件的处理 |
| --- | --- | --- | --- |
| `settings.section` 槽位声明方 | `@deepseek-ai/dsh-client-ui-settings` | **`@deepseek-ai/dsh-client-ui-settings-general`**（ui-settings 只剩 `configForms` 与共享镜像） | `dsh.client.inject` 补上 general；`slots.inject` 本身会等声明出现（declaration epoch），补声明方是为了让它先到 |
| 宿主依赖解析 | 宿主包能从 npm 全局 `dsh/node_modules` 里被顺带解析到 | 桌面版从 **app.asar** 装载，解出来是平铺目录，**没有兄弟包** | `link-deps.mjs` 改为从根包出发求**依赖闭包**（`dsh-system-prompt` → `cordis` / `dsh-scope` → `@standard-schema/spec` …），漏一个就 `ERR_MODULE_NOT_FOUND` |
| 桌面版安装目录探测 | 只读注册表 `InstallLocation` | 桌面版写的是 `DisplayIcon` / `UninstallString`，`InstallLocation` 不一定有 | 三个值都读；另加 `$DSH_DESKTOP_HOME`；asar 根前缀按 `@deepseek-ai/*` 校验 |
| peer 范围 | `>=0.1.7-rc.2 <0.2` | 0.2.x 会被这个上界**排除** | 上界放宽到 `<0.3` |
| 依赖来源优先级 | npm 全局 dsh 优先 | 桌面版**实际在跑的那份**是 app.asar | `$DSH_CHECKOUT`（显式开发意图）→ app.asar → npm 全局 / profile |

自检覆盖了这些点：`npm run check` 会打印本次跑在哪个宿主版本上（例如
`dsh-system-prompt@0.2.0-rc.2  schemastery@3.18.4  cosmokit@1.8.5  cordis@4.0.4`），
并断言 peer 上界不排除 0.2.x。

### 历史适配（0.1.7-rc.2）

DSH 0.1.7 重做了设置（settings）的持久化模型：**插件不再自报 settings namespace**，而是由自己的
Config schema 出表单，namespace 就是 profile 里这条 loader entry 的 **id**。该版本据此改写：

| 断裂点 | 0.1.5-rc.x | 现在（0.1.7-rc.2） | 本插件的处理 |
| --- | --- | --- | --- |
| 声明设置项 | `ctx.settings.register(ns, schema, opts)` | **该 API 已移除**；改为插件导出 `Config`，表单只投影 `.volatile()` 字段 | `Config` 两个字段都改成 `.volatile()`，`SETTINGS_NAMESPACE` 等于 `cordis.patch.yml` 里的 `insert.id`（`prompt-persona`） |
| 读自己的值 | `scope.get()` | 插件保留 Config 的 **volatile 引用**并 `.get()`（`dsh-agent-default-model` 同款写法） | `config.js` 的 `live()` 同时接受引用与普通值，`resolveConfig()` 每次组装现读 |
| 读设置页快照 | `settings.describe()` + `scope.get()` | `settings.describe()` 返回的就是表单投影值（`ns` = entry id） | `web.js` 从描述符取 `value`/`revision`/`applies`，settings 缺席时回落插件 Config |
| 设置页归属 | 无此概念 | 自带页面的插件要在 `ctx.inject(['settings'], …)` 子级里 `settings.configure({ auto: false }, ctx.fiber)`，否则会再长出一个自动生成的页面 | 已按官方写法登记 |
| settings 依赖 | 硬依赖 `inject: ['settings', …]` | settings 是**可选**服务（业务插件可以没有它照常跑） | 从 `inject` 去掉，改用 `ctx.get('settings')`；未挂载时仍能用 profile 配置注入 persona，只是不能保存 |
| client 端页面 | `ctx.slots` 直接注册即可 | 设置域多了 `configForms`；跨命名空间表面用 `configForms.whileServed(namespaces, register)` 跟随 | 页面改为 `inject = ['slots', 'configForms']` + `whileServed(['prompt-persona'], …)`：宿主没挂 settings 时页面上不留痕迹 |
| 默认模型 | `settings.get('agent-default-model')` | 该 namespace 已不存在，改由 `agentDefaultModel` 服务回答 | 预览回落改用 `ctx.get('agentDefaultModel').currentSelection()` |
| 依赖解析 | `@deepseek-ai/schemastery` 任意 3.x | `.volatile()` 由 **schemastery ≥ 3.18.4** 提供（`dsh-settings` 的 peer 要求 `~3.18.4`） | `scripts/link-deps.mjs` 现在会**逐个校验**依赖能力：不合格就换来源，必要时直接从 DSH Desktop 的 `app.asar` 里解出正确的 schemastery |
| 持久化位置 | `$DSH_HOME/settings.yaml` | 当前 profile 的 Cordis patch（由 `dsh-config-editor` 落盘）；旧的 `settings.yaml` 同名 section 会被**导入一次**后改名为 `settings.yaml.imported` | 无需手工迁移：原来的 `prompt-persona:` section 会被导入到同名 entry |

旧的 `settings.yaml` section 名与 entry id 同名（`prompt-persona`），所以从 0.2.x 升级**不需要重新填 persona**。

### 历史适配（0.1.5-rc.1）

上游把单个 `deployment:persona` section 拆成了 prefix / suffix 两段，并重命名了一批包：

| 断裂点 | 旧版（≤ 0.1.x 早期） | 0.1.5-rc.1 | 本插件的处理 |
| --- | --- | --- | --- |
| persona section | `PERSONA_SECTION = 'deployment:persona'` | 拆成 `deployment:persona-prefix`（order 0，身份）与 `deployment:persona-suffix`（order 10200，收尾） | 只接管 **prefix**（suffix 由部署配置保留） |
| schema 包 | `schemastery` | `@deepseek-ai/schemastery` | 改 import |
| settings 写入 | `settings.replace(ns, section)` | `replace` 会整段覆盖；`update` 只合并补丁 | 改用 `settings.update`，**非破坏性** |
| client 依赖声明 | `dsh.client.inject` 含 `@deepseek-ai/dsh-client-runtime`、`dsh-client-ui-slots` | 这两个包已不存在 | 收敛为 `["@deepseek-ai/dsh-client-ui-settings"]` |
| agent preset 冲突 | 不存在 | preset 可用同名 section 在 scope 内**遮蔽**部署 persona | 遮蔽守卫：只有该 section 文本等于部署层配置值时才会被改写 |

---

## 特性

- 🎛️ **可视化编辑**：设置页新增「系统提示词」区块，直接写 persona 文本。
- 🔀 **三种注入模式**：`replace`（替换）/ `append`（追加）/ `off`（关闭）。
- 👁️ **当前提示词**：实时显示当前生效的**完整系统提示词**（persona + harness 身份 + 工具引导等所有 section）。
- ✨ **添加效果（预览）**：把草稿应用到一份副本上，点「预览效果」即可看到**保存后的完整提示词**，不落盘、不污染当前状态。
- 💾 **乐观并发保存**：基于 settings revision 的冲突检测（`SETTINGS_CONFLICT` → HTTP 409），避免覆盖他人同时的修改。
- 🧩 **模板变量**：persona 支持 `{{model}}` / `{{cwd}}` / `{{provider}}` 严格插值。
- 🛡️ **不抢别人的 persona**：agent preset / 子 agent 在 scope 内遮蔽了 `deployment:persona-prefix` 时，本插件不覆盖它。

---

## 界面

设置页（Settings）里会多出一个「系统提示词」section，包含：

| 区块 | 说明 |
| --- | --- |
| 注入模式 | 下拉选择 替换 / 追加 / 关闭 |
| 自定义提示词 | 多行文本域，persona 内容，支持模板变量 |
| 保存并应用 / 预览效果 | 持久化到当前 profile 的配置；或仅预览草稿效果 |
| 当前提示词 | 当前生效的完整系统提示词（只读） |
| 添加效果（预览） | 草稿应用后的完整提示词（点击「预览效果」后出现） |

---

## 工作原理

```text
本条目 Config（volatile）              HTTP 路由
  prompt-persona ──────────────► /_dsh/prompt-persona/settings
       │  (persona, mode)              ▲
       ▼                               │ GET snapshot / POST preview|save
system-prompt/assemble waterfall ──────┘
       │  把 persona 写入 deployment:persona-prefix section
       ▼
完整系统提示词（每步动态组装）
```

1. **宿主插件**（`lib/index.js`）导出自己的 `Config`（两个 `.volatile()` 字段），并监听全局 `system-prompt/assemble` waterfall；每次组装完成后，把配置里的 persona 按 mode 写入 `deployment:persona-prefix` section。
   - 写入前先读一次提示词注册表自己的 composition config（`personaPrefix`）：若装配结果里该 section 的文本与之不符，说明它被更高优先级的 scope 遮蔽了（agent preset / 子 agent persona），此时**放弃改写**。
2. **HTTP 后端**（`lib/web.js`）在同源挂一个路由，向浏览器提供当前提示词、预览、保存三个能力；保存走 `settings.update(entryId, patch, revision)`。
3. **浏览器插件**（`lib/client.js`）用 `configForms.whileServed(['prompt-persona'], …)` 跟随本条目，并通过 `settings.section` slot 注入 React 设置面板。

> 设置页归属：`apply()` 里用 `ctx.inject(['settings'], …)` 子级登记 `settings.configure({ auto: false }, ctx.fiber)`，关掉 dsh-settings 按 schema 自动生成的通用页面，由本插件的自定义页面接管。

---

## 安装

### 方式 A：dsh-super-injector 运行时注入（本机开发推荐）

```js
dev_inject_plugin({ dir: 'C:\\Users\\<你>\\.dsh\\profiles\\web\\dsh-prompt-persona' })
```

注入即生效（不重启），清单持久化在 `~/.dsh/super-injector/registry.json`，重启后自动恢复。

### 方式 B：bundle 装配（生产态，需重启）

**方法 B1：命令行**

```bash
dsh plugin --profile web add github:xilin3/dsh-prompt-persona
```

然后把 `@xilin3/dsh-prompt-persona` 追加到该 profile `package.json` 的 `dsh.profile.bundles` 里（见 B2 的示例），最后重启 `dsh web`。

**方法 B2：手动编辑 profile 的 `package.json`**

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@xilin3/dsh-prompt-persona"
      ]
    }
  },
  "dependencies": {
    "@xilin3/dsh-prompt-persona": "github:xilin3/dsh-prompt-persona"
  }
}
```

然后在 profile 目录执行 `pnpm install`，最后重启 `dsh web`（前端/Host 改动**不会**热更新，必须重启进程并刷新浏览器）。

### 方式 C：本地目录挂载

把仓库放到 profile 目录（例如 `~/.dsh/profiles/web/dsh-prompt-persona`），在 profile `package.json` 里写 `"@xilin3/dsh-prompt-persona": "file:dsh-prompt-persona"` 并加进 `bundles`。

### 装完必做：准备宿主依赖

宿主半身 `import` 了 `@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/schemastery` 与 `@deepseek-ai/cosmokit`，而 profile 的 `node_modules/@deepseek-ai/` 通常是空的 —— 依赖必须能从**插件包自己的 `node_modules`** 解析出来：

```bash
cd <插件目录>
node scripts/link-deps.mjs        # 自动探测来源，逐个校验能力
```

脚本会在 `<插件>/node_modules/` 下按 specifier 原样准备依赖（Windows 下建 junction，等价于 `mklink /J`；asar 来源解包落盘），并打印每个包的实际版本。

**它求的是依赖闭包，不只是三个根包**：`dsh-system-prompt` 自己还会 `import` `@deepseek-ai/cordis`、`@deepseek-ai/dsh-scope`，cordis 又依赖 `@deepseek-ai/cosmokit` 与 `@standard-schema/spec`……DSH 0.1.7 时代这些包能从 npm 全局 `dsh` 目录里被顺带解析到，而桌面版从 app.asar 解出来的是**平铺**目录、没有兄弟包，漏一个就会在 import 期直接失败。

**它还会校验 `schemastery` 是否带 `.volatile()`**（能力探针 + 真实 `import`）：settings 只投影 volatile 字段，链到旧版（< 3.18.4）会导致设置页整个不出现。

**DSH Desktop 用户**：桌面版把宿主包放在安装目录的 `resources/app.asar` 里。脚本会自己找：显式 `--asar` → `$DSH_DESKTOP_ASAR` / `$DSH_DESKTOP_HOME` → 注册表（`InstallLocation` / `DisplayIcon` / `UninstallString`，桌面版写的是后两个）→ `%LOCALAPPDATA%\Programs` 等常见安装根。装在自定义目录又探测不到时显式指一下：

```bash
node scripts/link-deps.mjs --asar "D:\Deepseekharness\resources\app.asar"
```

来源优先级：`$DSH_CHECKOUT`（显式开发意图）→ **app.asar（宿主实际在跑的那份代码）** → npm 全局安装的 `dsh` → `~/.dsh/profiles/node_modules`。都不满足时脚本会失败并打印可选做法（例如 `npm i -g @deepseek-ai/dsh@<你正在用的版本>`），而不是静默链上不兼容的版本。

漏掉这一步的典型报错：

```text
Cannot find package '@deepseek-ai/dsh-system-prompt'
# 或者（闭包没求全）
Cannot find package '@deepseek-ai/cordis' imported from .../dsh-system-prompt/lib/index.js
# 或者（链到旧版 schemastery）
TypeError: z.string(...).volatile is not a function
```

### 自检

```bash
npm run check     # node --check 四个 lib 文件 + scripts/check-adaptation.mjs
```

`check-adaptation.mjs` 会用**真实的 DSH 宿主包**（从 `link-deps` 准备好的那份，运行时打印版本）跑一遍 host 半身（17 项）：Config 的 volatile 契约、注入语义、遮蔽守卫、`settings.describe()/update()` 往返、乐观锁冲突与只读降级、client 半身的 slot/configForms 约定、peer 范围覆盖 0.2.x。

还可以把插件挂进**真实的提示词注册表**跑集成自检（需要能读到 DSH 宿主包目录）：

```bash
DSH_HARNESS_PACKAGES=/path/to/node_modules/@deepseek-ai npm run check:integration
```

它用真实的 `cordis` + `dsh-system-prompt` 起一个最小 app，验证 replace 注入、**volatile 就地更新**（cordis-plugin-loader 只改 volatile 字段时不重挂插件，而是把新值写进同一个引用 —— 所以插件必须每次现读 `config.persona.get()`）、遮蔽守卫、`off` / `append` 语义。读不到包目录时脚本会打印说明并跳过（退出码 0）。

---

## 注入语义

`mode` 决定 persona 如何作用于 `deployment:persona-prefix` section（该 section 的部署原文记为 **当前 persona**）：

### `replace`（默认）

整段替换（会覆盖部署配置里的身份句）：

```text
当前 persona:
  You are a coding agent powered by the {{model}} model.

保存 persona:
  你是一名资深数据分析师，工作目录是 {{cwd}}。

结果 deployment:persona-prefix:
  你是一名资深数据分析师，工作目录是 {{cwd}}。
```

### `append`

追加到现有 persona 之后（空行分隔），部署身份句保留：

```text
当前 persona:
  You are a coding agent powered by the {{model}} model.

保存 persona:
  请始终用简体中文回答。

结果 deployment:persona-prefix:
  You are a coding agent powered by the {{model}} model.

  请始终用简体中文回答。
```

### `off`

不注入，保留 deployment 默认 persona。

> `deployment:persona-suffix`（默认 `Your working directory is {{cwd}}.`）不属于本插件的管辖范围，始终保持部署配置。

---

## 模板变量

persona 是模板，保存/渲染时执行**严格插值**（未注册的变量会报错）。可用变量：

| 变量 | 含义 |
| --- | --- |
| `{{model}}` | 当前模型（agent-default-model 或运行时变量） |
| `{{provider}}` | 当前 provider |
| `{{cwd}}` | 进程工作目录 |

---

## 配置参考

持久化在当前 profile 的 Cordis patch 里（由 `dsh-config-editor` 落盘），**entry id** 为 `prompt-persona`：

```yaml
- id: prompt-persona
  name: '@xilin3/dsh-prompt-persona'
  config:
    persona: |
      你是一名资深数据分析师。
      工作目录是 {{cwd}}，模型是 {{model}}。
    mode: replace        # replace | append | off
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `persona` | string（volatile） | `""` | 自定义 persona 文本（模板） |
| `mode` | enum（volatile） | `"replace"` | `replace` / `append` / `off` |

非法 `mode` 会被 schema 拒绝（写入侧）/ 归一化为 `replace`（读取侧）；`persona` 会做 `trim`。

> **升级说明**：0.1.6 及更早版本把配置写在 `$DSH_HOME/settings.yaml` 的 `prompt-persona:` section。0.1.7 的
> dsh-settings 会在启动时把这类 section **导入一次**同名 entry，然后把文件改名为 `settings.yaml.imported`
> ——section 名与 entry id 同名，所以不需要手工迁移。

> 保存走 `settings.update`：只写 `persona` / `mode` 两个键，条目里其它字段不会被删除。

### 直接改配置文件（不经设置页）

`Config` 的两个字段在配置里就是普通字符串；`live()`（`lib/config.js`）对「volatile 引用」和「普通值」都接受，所以用 Cordis 配置写死的部署照样工作 —— 只是设置页会显示为只读（`settings` 未挂载时 `writable: false`）。

---

## HTTP API

浏览器设置页使用的同源路由 `/_dsh/prompt-persona/settings`：

| 方法 | 请求体 | 说明 |
| --- | --- | --- |
| `GET` | — | 返回 `{ settings: {value, revision, applies, writable}, currentPrompt }` |
| `POST` | `{ action: "preview", persona, mode }` | 返回 `{ previewPrompt }` |
| `POST` | `{ action: "save", persona, mode, expectedRevision }` | 保存；返回新的 snapshot |

`settings.writable` 为 `false` 表示本部署没有挂 settings 服务（或其为只读），此时设置页仍可预览但不能保存。

保存带 `expectedRevision`（乐观锁）：revision 不匹配时返回 HTTP `409`（`code: "settings-conflict"`），客户端需重新加载后重试。

---

## 目录结构

```text
dsh-prompt-persona/
├── package.json                # dual-face 包：dsh.bundle.patch + dsh.client
├── cordis.patch.yml            # bundle patch：insert.id 即 settings entry id
├── scripts/
│   ├── link-deps.mjs           # 准备宿主依赖（能力校验 + app.asar 回退）
│   ├── check-adaptation.mjs    # 适配自检（拿真实 0.1.7 包跑 host 半身）
│   └── check-integration.mjs   # 集成自检（挂进真实提示词注册表）
├── lib/
│   ├── index.js                # host 插件：设置页策略 + waterfall 注入 + 遮蔽守卫
│   ├── config.js               # 本条目 Config（volatile）+ live()/resolveConfig()
│   ├── web.js                  # HTTP 后端（snapshot / preview / save）
│   └── client.js               # 浏览器设置 UI（CommonJS + window.__ModuleLoader__）
├── README.md
└── LICENSE
```

无构建步骤：`lib/client.js` 是手写的 CommonJS 模块，由 DSH 客户端模块加载器（`window.__ModuleLoader__`）直接装载。

---

## 依赖（peerDependencies，由 DSH 宿主提供）

| 包 | 用途 |
| --- | --- |
| `@deepseek-ai/dsh-settings`（可选） | 设置表单投影 / 写入 / revision 并发控制；未挂载时插件仍能靠配置注入 persona |
| `@deepseek-ai/dsh-system-prompt` | `PERSONA_PREFIX_SECTION`、`renderPrompt`、assemble waterfall |
| `@deepseek-ai/dsh-host-webserver`（可选） | 挂载同源 HTTP 路由 |
| `@deepseek-ai/dsh-client-ui-settings` | 浏览器端 `settings.section` slot 与 `configForms` |
| `@deepseek-ai/dsh-client-ui-slots` | 浏览器端 slot 注册（`settings.section`） |
| `@deepseek-ai/schemastery`（≥ 3.18.4） | 本条目 `Config`；`.volatile()` 是 0.1.7 settings 的硬要求 |
| `@deepseek-ai/cosmokit` | `isVolatile()`：识别 volatile 引用 |
| `@deepseek-ai/cordis` / `react` | 运行时由宿主注入 |

---

## 已知问题

- **Node 解析缓存会记住失败的解析**：若进程内第一次解析 `@xilin3/dsh-prompt-persona` 时 profile 的 `node_modules/@xilin3/dsh-prompt-persona` junction 是坏的（空目录、悬空），这次失败会被缓存到进程结束 —— 之后即使修好 junction，同一进程内的 `dev_inject_plugin` 仍会失败。**重启 `dsh web` 即自愈**（注入器按 registry 用包名恢复）。同一进程内需要立刻恢复时，可用相对路径挂 entry（`name: './dsh-prompt-persona/lib/index.js'`）。
- **HTTP 路由不在 Web 鉴权闸门之后**：`/_dsh/prompt-persona/settings` 能读到完整系统提示词并改写 persona。默认只监听 `127.0.0.1`；若把 `dsh-host-webserver` 的 `host` 改为 `0.0.0.0`，请自行评估暴露面。

---

## License

[MIT](./LICENSE) © 2026 xilin3
