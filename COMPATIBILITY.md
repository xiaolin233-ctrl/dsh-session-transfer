# `dsh-session-transfer` 跨版本兼容性分析

> 仓库：<https://github.com/xiaolin233-ctrl/dsh-session-transfer>
> 插件版本：**1.0.0**（Git tag `v1.0.0`）
> 分析基线：DeepSeek Harness **v4**（会话文件 `session.v4.jsonl.zstd`，`formatStatus === 'current'`），2026-11-06
> 文档版本：第二版（2026-11-06）。本版修正了首版的行号、客户端服务调用描述与 `stat()` 返回值描述，并补充发布/安装章节；差异见 [§10](#10-文档更新记录)

---

## 目录

1. [插件架构总览](#1-插件架构总览)
2. [Harness API 依赖全景](#2-harness-api-依赖全景)
3. [稳定性分层分析](#3-稳定性分层分析)
4. [脆点逐一剖析](#4-脆点逐一剖析)
5. [插件自身的防御设计](#5-插件自身的防御设计)
6. [版本升级场景推演](#6-版本升级场景推演)
7. [适配工作量估算](#7-适配工作量估算)
8. [长期的维护建议](#8-长期的维护建议)
9. [发布、安装与升级检查](#9-发布安装与升级检查)
10. [文档更新记录](#10-文档更新记录)

---

## 1. 插件架构总览

### 1.1 文件分工

| 文件 | 行数 | 运行位置 | 职责 | 热加载 |
|------|------|---------|------|--------|
| `index.js` | 101 | Host | HTTP 路由注册 + 每次请求重新 `import()` `impl.js` | 否（Host 入口，安装时注册一次） |
| `impl.js` | 406 | Host（每次请求热加载） | 全部转移逻辑：读源会话 → 创建副本 → 验证 → 挂载 → 归档 | ✅ 是（时间戳 cache-bust） |
| `client.js` | 742 | 浏览器 | 菜单行 + 转移对话框 UI + 组件内 CSS | 否（刷新页面重新注入） |
| `cordis.patch.yml` | 2 | Host | 将插件插入 Host composition | 否（安装时一次性） |

`client.js` 的样式优先通过客户端 `styles` 服务注入（`ctx.get('styles')?.insert(CSS)`，`client.js:706-718`）；只有取不到该服务时才回退到组件内渲染 `<style>`（`client.js:187-188`、`client.js:290-291`）。

**关键设计**：`index.js:58-60` 在每次 HTTP 请求到来时动态 `import()` `impl.js`，并附加 `?stamp=${Date.now()}-${Math.random()}` 查询参数绕过 ESM 缓存。这意味着 **Host 端的转移逻辑修改后，无需重启 DSH，下一次点击“转移”即生效**。

```js
// index.js:58-60
async function loadImplementation() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return import(`${pathToFileURL(IMPL_PATH).href}?stamp=${stamp}`)
}
```

### 1.2 数据传输流

```
┌──────────────────────┐     HTTP GET/POST     ┌──────────────────────┐
│   client.js (浏览器)  │ ◄─────────────────────► │   index.js (Host)    │
│                      │   /dsh-session-transfer │                      │
│  菜单行 → 对话框 → 确认  │                        │  路由分发 → 热加载      │
│                      │                        │  impl.js             │
└──────────────────────┘                        └──────────┬───────────┘
                                                           │
                                              ┌────────────▼───────────┐
                                              │     impl.js (Host)      │
                                              │                        │
                                              │  ┌──────────────────┐  │
                                              │  │ sessionPersistence│  │
                                              │  │ workspaceRegistry │  │
                                              │  │ sessions (optional)│  │
                                              │  │ projectionCache   │  │
                                              │  │ (optional)        │  │
                                              │  └──────────────────┘  │
                                              └────────────────────────┘
```

客户端请求统一走 `client.js:250-252` 的 `fetch(url, { cache: 'no-store', credentials: 'same-origin' })`，与 DSH Web 自身同源，不需要额外的鉴权协商。

### 1.3 转移流程（8 步）

```
1. 读取源会话完整事件日志
   ├─ 活会话先 sessions.flush() 落盘
   ├─ 存储优先，内存兜底
   └─ 不一致则拒绝（read-failed）
2. 校验：seq 从 0 连续
3. 拒绝：正在回答（mid-turn）、子代理（subagent）、同工作区、格式需迁移
4. create 新会话 → 复制 header，将 cwd 指向目标工作区
5. 分页 append（500 条/批）→ flush()
6. 重新读回副本 → 核对条数 + seq 连续性 + 末条 seq
7. attachSession 挂到目标工作区 + coldSnapshot 补投影缓存
8. 默认归档原会话（可勾选保留）
```

---

## 2. Harness API 依赖全景

### 2.1 Host 端服务依赖

#### 2.1.1 `sessionPersistence`（必需）

| 方法 | 使用位置 | 用途 |
|------|---------|------|
| `stat(sessionId)` | `impl.js:201`, `impl.js:285`, `impl.js:154` | 获取会话元数据；**会话不存在时返回 `undefined`，不抛错** |
| `open(sessionId, 'read')` | `impl.js:76`, `impl.js:137` | 打开只读句柄，读取事件日志 |
| `handle.read(offset, pageSize)` | `impl.js:80`, `impl.js:141` | 分页读取事件（PAGE_SIZE = 500） |
| `handle.inheritedEventCount` | `impl.js:86` | 读取继承的事件数（种子会话） |
| `handle.close()` | `impl.js:89` | 关闭只读句柄 |
| `create(header, options)` | `impl.js:327` | 创建新会话，传入 `{ inheritedEventCount }`；返回的句柄自带写所有权 |
| `created.append(events)` | `impl.js:334` | 分页追加事件（seq 必须连续） |
| `created.flush()` | `impl.js:336` | 强制落盘 |
| `created.close()` | `impl.js:348` | 关闭写句柄 |

`stat()` 的返回形状是 `{ header, formatStatus, revision, sizeBytes }`——**没有 `eventCount`**。因此写后校验（`verifyCopy`，`impl.js:153-165`）不依赖 `stat` 的计数，而是重新 `readAll` 副本、逐条比对条数与 seq。

> **稳定性评级**：🟢 极高。这是 DSH 最核心的会话持久层 API，语义是 CRUD，几乎不可能在不兼容的范围内变化。即使格式升级到 v5/v6，create/append/flush/close 的基本契约也应保持。

#### 2.1.2 `workspaceRegistry`（必需）

| 方法 | 使用位置 | 用途 |
|------|---------|------|
| `list()` | `impl.js:50` | 获取全部工作区列表 |
| `get(id)` | `impl.js:247` | 按 id 获取工作区对象 |
| `resolveByPath(cwd)` | `impl.js:62` | 按路径反查工作区（**async**） |
| `workspace.id` / `.title` / `.path` | 多处 | 工作区标识、显示名、绝对路径 |
| `workspace.sessionIds` | `impl.js:54-55` | 工作区下的会话 id 列表（已按 header.cwd 索引过滤） |
| `.attachSession(newSessionId)` | `impl.js:368` | 将新会话挂到目标工作区（**async**，校验 header.cwd） |
| `.archiveSession(sessionId)` | `impl.js:389` | 归档原会话（**async**） |

> **稳定性评级**：🟢 极高。工作区注册表是 Harness 的基础设施，list/get/attach/archive 的语义不会轻易变。
> 注意：`attachSession` 会 `realpath` 规范化 `header.cwd` 并与 `workspace.path` 严格比较，所以副本 header 的 `cwd` 必须是目标工作区的真实路径（`impl.js:320` 直接使用 `target.path`）。

#### 2.1.3 `sessions`（可选，required: false）

| 方法 | 使用位置 | 用途 |
|------|---------|------|
| `get(sessionId)` | `impl.js:170`, `impl.js:302` | 获取活会话对象 |
| `flush(live)` | `impl.js:173` | 将内存中的活会话落盘 |
| `live.snapshotEvents()` | `impl.js:70`, `impl.js:225` | 获取活会话的事件快照 |
| `live.seq` | `impl.js:175`, `impl.js:226` | 活会话的当前序列号 |
| `live.inheritedEventCount` | `impl.js:71` | 活会话的继承事件数 |

> **稳定性评级**：🟡 中高。活会话 API 随 agent 生命周期演进的可能性高于持久层，但它被标记为 `required: false`，不可用时插件降级为纯存储读取。

#### 2.1.4 `sessionProjectionCache`（可选，required: false）

| 方法 | 使用位置 | 用途 |
|------|---------|------|
| `coldSnapshot(header, inheritedEventCount, events)` | `impl.js:378` | 为冷会话预写入投影缓存，使侧栏能显示标题 |

> **稳定性评级**：🟡 中。投影缓存是优化层，签名变化的可能性相对较高，但它是可选的且被 `try/catch` 包裹。失败仅导致侧栏标题暂时显示“未命名对话”，打开会话即重建。

#### 2.1.5 `webServer`（必需）

| 方法 | 使用位置 | 用途 |
|------|---------|------|
| `register({ kind: 'prefix', path, handler })` | `index.js:100` | 注册 HTTP 路由前缀；返回的 disposer 由 `ctx.effect` 管理（`index.js:101`） |

> **稳定性评级**：🟢 极高。HTTP 服务器注册是 Harness 插件系统的基础契约。

#### 2.1.6 `ctx` 上下文对象

| 方法 | 使用位置 | 用途 |
|------|---------|------|
| `ctx.get(key)` | `impl.js:35` | 获取服务实例（通过 Cordis DI），封装在 `service()` 里 |

> **稳定性评级**：🟢 极高。Cordis 的 `ctx.get()` 是依赖注入的标准接口。

### 2.2 客户端依赖

#### 2.2.1 模块加载器

```js
// client.js:9
window.__ModuleLoader__.load({ id: 'dsh-session-transfer', factory(require) { ... } })
```

这是客户端的唯一入口。它依赖 `window.__ModuleLoader__` 全局对象和 `require('react')`。

> **稳定性评级**：🟡 中。`__ModuleLoader__` 是 Harness Web 客户端的模块系统，如果改用标准的 ESM import 或 Webpack Module Federation，需要改写入口。

#### 2.2.2 UI 插槽

```js
// client.js:17-18
const MENU_SLOT   = 'sidebar.workspaces.session.menu.item'   // 侧栏会话菜单行
const OVERLAY_SLOT = 'shell.overlay'                          // 覆盖层（对话框）
```

注册发生在 `client.js:719-742`，两个插槽都通过 `ctx.slots.inject(slot, () => ctx.slots.register({ name, id, order, ... }, Component))` 完成，组件卸载时由 Cordis 统一清理。

> **稳定性评级**：🟡 中。插槽名是字符串契约，UI 重构时可能改名。

#### 2.2.3 主题 Token

客户端 **100% 使用 `--dsw-*` 语义 token**，从未引原始色值，全部带 `var(..., fallback)` 兜底：

| Token | 用途 |
|-------|------|
| `--dsw-alias-label-primary` | 主文本色 |
| `--dsw-alias-label-secondary` | 次要文本色 |
| `--dsw-alias-label-tertiary` | 三级文本色 |
| `--dsw-alias-label-primary-inverse` | 反色文本（主按钮） |
| `--dsw-alias-interactive-bg-hover` | 悬停背景 |
| `--dsw-alias-state-business-primary` | 品牌色 / 主色调 |
| `--dsw-alias-state-success-primary` | 成功色 |
| `--dsw-alias-state-error-primary` | 错误色 |
| `--dsw-alias-border-l2` / `--dsw-alias-border-l4` | 边框色 |
| `--dsw-alias-bg-layer-1` / `--dsw-alias-bg-base` | 背景色 |
| `--dsw-radius-sm` / `--dsw-radius-md` / `--dsw-radius-lg` | 圆角 |
| `--dsw-focus-ring-width` | 焦点环宽度 |

> **稳定性评级**：🟢 高。语义 token 是 Harness 设计系统的对外合约，删除/重命名意味着破坏所有第三方插件的视觉一致性。

#### 2.2.4 插件上下文与客户端服务

```js
// client.js:190-199
let pluginCtx = null

const getService = (key) => {
  if (pluginCtx === null) return null
  try { return pluginCtx.get?.(key) ?? null }
  catch (error) { return null }
}
```

`apply(ctx)` 把 DSH 客户端上下文存到 `pluginCtx`（`client.js:707`），组件通过 `getService()` 取服务。实际用到三处：

| 调用 | 位置 | 用途 |
|------|------|------|
| `sessions.refresh()` | `client.js:459-462` | 转移成功后刷新会话清单（新冷会话需要它才会进侧栏） |
| `sessions.refreshProjections(newId)` | `client.js:490-494` | 为新会话触发一次投影刷新 |
| `uiWorkspace.openSession(newId)` | `client.js:506-509` | 结果页「打开新会话」按钮 |

> **稳定性评级**：🟢 高。与 Host 端的 `ctx.get()` 相同机制；三个方法都是客户端 `sessions` / `uiWorkspace` 服务的公开方法。

#### 2.2.5 声明式注入目标

```json
// package.json:34-45
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "immediately": true,
    "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
  }
}
```

`inject` 声明了客户端代码的注入目标模块。如果该模块被拆分或重命名，注入可能失效。

> **稳定性评级**：🟡 中。这个字符串是插件清单的一部分，Harness 的插件管理器会处理模块解析。

---

## 3. 稳定性分层分析

```
┌─────────────────────────────────────────────────────────┐
│  🔵 极稳定层（Harness 基石，改了全崩）                       │
│                                                         │
│  • session.v4.jsonl.zstd 磁盘格式                        │
│  • sessionPersistence CRUD API                          │
│  • workspaceRegistry 基础操作                             │
│  • webServer.register() 路由注册                          │
│  • ctx.get() 依赖注入                                     │
│  • --dsw-alias-* 语义主题 token                           │
│                                                         │
│  → 这些是 Harness 的"宪法级"接口，短期绝不会变                │
└─────────────────────────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│  🟡 中等稳定层（可能变化，但有保护）                           │
│                                                         │
│  • sessions (活会话) — 标记 optional，不可用时降级           │
│  • sessionProjectionCache — 标记 optional + try/catch     │
│  • 客户端 UI 插槽名 — 字符串契约可能改                       │
│  • window.__ModuleLoader__ — 模块加载机制可能换              │
│  • inject 目标模块名 — 声明在 package.json，可能改            │
│  • 客户端 sessions / uiWorkspace 服务方法 — 可能改名         │
│                                                         │
│  → 变了对插件有影响但都是可修的问题                            │
└─────────────────────────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│  🔴 高敏感层（硬编码字符串，改了直接挂）                        │
│                                                         │
│  • 'session-log-deepseek/delivery-accepted' 事件类型       │
│  • formatStatus === 'current' 格式版本检查                 │
│  • inheritedEventCount 种子会话语义                       │
│                                                         │
│  → 这些是 Harness v4 特有的概念，在格式/协议升级时必须跟进      │
└─────────────────────────────────────────────────────────┘
```

---

## 4. 脆点逐一剖析

### 4.1 🔴 高危

#### 4.1.1 事件类型字符串：`'session-log-deepseek/delivery-accepted'`

**位置**：`impl.js:127`

```js
function retargetDeliveryMarkers(events, fromSeq, sessionId, keepsInheritedPrefix) {
  return events.map((event) => {
    if (event.type !== 'session-log-deepseek/delivery-accepted') return event
    if (keepsInheritedPrefix && event.seq < fromSeq) return event
    const data = event.data
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return event
    if (data.sessionId === sessionId) return event
    return { ...event, data: { ...data, sessionId } }
  })
}
```

**为什么脆**：这是插件里唯一硬编码的 Harness 内部事件类型。如果 Harness 重命名此事件类型（例如格式升级时改成 `v5:delivery-accepted`），改写会**静默失效**——不报错，也不改 `data.sessionId`。

**失败模式**：副本保留源会话 id，而 v4 的关系校验（`dsh-session-format-v3-to-v4` 的 `validateDeliveryAccepted`）会拒绝打开：

```
SessionFormatError: current-generation delivery marker names the wrong Session
```

好消息是 `verifyCopy`（`impl.js:153-165`）会重新读回副本并做条数/seq 校验；但投递标记的 id 不在它的比对范围内，所以**校验会通过、打开却失败**——这类问题只能在安装后跑一次真实转移来暴露。

**触发范围**：所有复制路径都会经过改写逻辑。普通（非种子）会话同样会携带投递标记——实测样本 `session-e96a0f8c-…`（26 个事件、`isSeeded: false`）在 seq 18/19 就有 `delivery-accepted`；种子会话则额外要求“继承前缀（`seq < inheritedEventCount`）保持原样”。首版文档写的“零种子会话不受影响”是不准确的。

**修复难度**：极低——扩成一个事件类型集合即可：

```js
const DELIVERY_MARKER_TYPES = new Set(['session-log-deepseek/delivery-accepted'])
```

---

#### 4.1.2 客户端 UI 插槽名

**位置**：`client.js:17-18`

```js
const MENU_SLOT   = 'sidebar.workspaces.session.menu.item'
const OVERLAY_SLOT = 'shell.overlay'
```

**为什么脆**：插槽名是 Harness 前端组件树的路径字符串。UI 重构（例如侧栏组件改名）可能改变插槽名。

**失败模式**：
- `MENU_SLOT` 不存在 → 侧栏菜单不出现“转移到其他工作区…”行，功能入口消失
- `OVERLAY_SLOT` 不存在 → 对话框无法渲染到覆盖层

**排查手段**：`cordis_inspect_query(platform=client, provider=Slots, method=listSubTree, root=<slot>)` 可确认插槽是否存在、本插件注册是否 active。

**修复难度**：低——更新两个常量字符串即可。

**触发时机**：Harness 前端 UI 重构（重命名组件/路由）。

---

#### 4.1.3 `window.__ModuleLoader__`

**位置**：`client.js:9`

```js
window.__ModuleLoader__.load({
  id: 'dsh-session-transfer',
  factory(require) { ... }
})
```

**为什么脆**：这是 Harness Web 客户端的模块引导机制。如果 Harness 迁移到标准的 ESM `import()` 或 Module Federation 等方案，整个客户端入口需要重写。

**失败模式**：`__ModuleLoader__` 不存在 → `TypeError`，客户端完全无法加载。

**修复难度**：中——需要跟随 Harness 的新模块加载机制改写入口。但逻辑代码（React 组件、CSS、fetch 逻辑）不受影响，只需改写外层包装。

**触发时机**：Harness 客户端打包体系变更。

---

### 4.2 🟡 中危

#### 4.2.1 会话格式版本检查

**位置**：`impl.js:295`

```js
if (typeof stat.formatStatus === 'string' && stat.formatStatus !== 'current') {
  return failures('format-migration-required',
    `this session first needs a format migration (${stat.formatStatus}) before it can be copied`)
}
```

**为什么脆**：当前只接受 `formatStatus === 'current'`。如果 Harness 推出 v5 格式：
- 新创建的 v5 会话 `formatStatus` 可能是 `'current'`（当前主格式），插件直接可以复制 ✓
- 但复制出来的副本 header 里 `version` 是原样复制的（`impl.js:113`），也就是说如果源是 v4 会话、v5 仍是当前主格式，复制没问题
- 如果 Harness 同时支持 v4 和 v5 但 `formatStatus` 的语义改变（如 v4 标记为 `'legacy'`），旧会话全部被拒

**注意**：`buildHeader` 并不是硬编码 `version: 4`：

```js
// impl.js:113
version: Number.isSafeInteger(header.version) ? header.version : 4,
```

它**原样复制**源 header 的 version 字段，只有当字段不存在/不合法时才 fallback 到 4。所以如果源已经是 v5 格式且 `formatStatus === 'current'`，副本也自然是 v5。

**失败模式**：所有需要格式迁移的旧会话被拒，转移目标只剩最新格式的会话。

**这是正确的安全行为**：把一个旧格式会话不经转换就复制到新 header 下才是危险的。用户应先通过 Harness 提供的格式迁移工具升级会话。

**修复难度**：低——放宽 `formatStatus` 检查为接受多版本，或添加自动迁移路径（但这需要理解 Harness 内部的格式转换 API）。

---

#### 4.2.2 `inheritedEventCount` 语义变化

**位置**：`impl.js:71,86,327,378` + `retargetDeliveryMarkers`

**为什么脆**：`inheritedEventCount` 是 v4 种子会话的核心概念：fork 出的会话继承了父会话的部分事件前缀。投递标记重写以它为分界：

```js
if (keepsInheritedPrefix && event.seq < fromSeq) return event  // 继承的部分不动
// ... 自身产生的事件改写 sessionId
```

如果 Harness 改变种子/分支模型（如引入 deduplication 引用、或改为软链接），`inheritedEventCount` 的语义可能变化。

**失败模式**：投递标记重写逻辑错误，导致打开副本时报格式错误。

**修复难度**：中——需要理解新的种子模型，但核心逻辑（复制全部事件并修改自身的投递标记）思想不变。

---

#### 4.2.3 客户端 inject 目标

**位置**：`package.json:38-44`

```json
"client": {
  "platform": "web",
  "immediately": true,
  "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
}
```

**为什么脆**：`inject` 告诉 Harness 插件管理器把这个客户端的代码注入到哪个已有的前端模块里。如果对端模块被重组，注入可能失效。

**失败模式**：客户端代码不加载，菜单行不出。

**修复难度**：极低——更新 `package.json` 中一行字符串。

---

### 4.3 🟢 低危（设计上已防御）

#### 4.3.1 `sessionProjectionCache.coldSnapshot()` 签名变化

**防御**：可选服务 + `typeof` 检查 + `try/catch`

```js
// impl.js:375-383
let cacheWritten = false
try {
  if (projectionCache !== undefined && typeof projectionCache.coldSnapshot === 'function') {
    const written = await Promise.resolve(projectionCache.coldSnapshot(newHeader, source.inheritedEventCount, payload))
    cacheWritten = written !== false
  }
} catch {
  /* the cache is fail-soft: opening the session rebuilds it */
}
```

**失败仅导致**：侧栏暂时显示“未命名对话”，用户打开会话后缓存自动重建。

---

#### 4.3.2 `sessions.flush()` 返回的行为变化

**防御**：三层 fallback

```
存储优先（fromStoredLog）
  └─ 存储落后 → 内存兜底（fromLiveSession）
       └─ 两者都不对 → 拒绝转移（read-failed）
```

```js
// impl.js:169-183
async function readSource(persistence, sessions, sessionId) {
  const live = sessions?.get?.(sessionId)
  if (live === undefined) return fromStoredLog(persistence, sessionId)
  if (typeof sessions.flush === 'function') await sessions.flush(live)
  const stored = await fromStoredLog(persistence, sessionId)
  if (stored.events.length === live.seq) return stored
  const memory = fromLiveSession(live)
  if (memory.events.length === live.seq) return memory
  throw new Error(`only ${stored.events.length} of ${live.seq} events reached durable storage, ...`)
}
```

**失败只影响**：正在回答中的活会话（但这种情况本身会被 `isMidTurn` 检查拦截）。

---

#### 4.3.3 主题 Token 改名

**防御**：使用的是 Harness 设计系统的**语义 token（`--dsw-alias-*`）**，不是原始色值（如 `--dsw-blue-500`）。语义 token 是设计系统的对外合约，改名的概率远低于底层 token；且每个 `var()` 都带了 fallback 值。

如果极端情况下连语义 token 层也重组了，客户端所有按钮/文字/背景颜色都会崩塌，但**结构不坏**（布局仍正确），修复成本是全局搜索替换 16 个 CSS 变量名。

---

## 5. 插件自身的防御设计

### 5.1 读写分离 + 零改写原则

> **插件从不改写源会话的任何字节。** 它只读源日志，通过 `sessionPersistence` 官方 API 在新 id 下重放。

这保证了即使插件出 bug，源会话毫发无伤。

### 5.2 写后验证

```js
// impl.js:353-365
const expectedLastSeq = events.length === 0 ? -1 : events[events.length - 1].seq
const verified = await verifyCopy(persistence, newSessionId, events.length, expectedLastSeq)
if (!verified.ok) {
  return failures('verify-failed', `the copied log does not match the source: ${verified.message}`, {
    partialSessionId: newSessionId,
  })
}
```

创建 + 写入完成后，重新打开副本逐条核对 —— 如果磁盘上的事件和内存中的不一致，绝不假装成功，并返回 `partialSessionId` 供清理。

### 5.3 批量失败隔离

```js
// impl.js:251-258
for (const sessionId of sessionIds) {
  try {
    results.push(await transferOne(ctx, sessionId, target, keepOriginal, title))
  } catch (error) {
    results.push({ sessionId, ok: false, code: 'transfer-failed', message: messageOf(error) })
  }
}
```

批量转移中任一会话失败不影响其他。业务失败在单项 `results[]` 中返回，不抛 HTTP 500。

### 5.4 前置拦截

转移前依次检查，尽早拒绝：

| 检查 | 位置 | 错误码 |
|------|------|--------|
| 会话不存在 | `impl.js:289` | `session-not-found` |
| 子代理会话 | `impl.js:292-294` | `subagent-session` |
| 格式需迁移 | `impl.js:295-297` | `format-migration-required` |
| 已在目标工作区 | `impl.js:298-300` | `same-workspace` |
| 日志读不出 | `impl.js:304-308` | `read-failed` |
| 日志损坏/不连续 | `impl.js:310-314` | `log-corrupt` |
| 正在回答 | `impl.js:315-317` | `session-running` |

### 5.5 部分失败清理指引

| 失败阶段 | 是否写入 | 返回 |
|----------|---------|------|
| create 失败 | 否 | `create-failed` |
| append/flush 失败 | 是（不完整） | `copy-failed` + `partialSessionId` |
| verify 失败 | 是（已验证不匹配） | `verify-failed` + `partialSessionId` |
| attach 失败 | 是（完整） | `attach-failed` + `partialSessionId` |
| 归档失败 | 副本成功 | `ok: true` + `note: 'original-active'` 或 `'original-archive-failed: …'` |

### 5.6 热加载

```js
// index.js:58-60
async function loadImplementation() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return import(`${pathToFileURL(IMPL_PATH).href}?stamp=${stamp}`)
}
```

`impl.js` 的每一次代码变更在下一个 HTTP 请求（下一次点击“转移”）时自动生效，无需重启 DSH。这是插件迭代友好性的核心设计。

---

## 6. 版本升级场景推演

### 6.1 场景 A：Harness 补丁版本（v4.x.1 → v4.x.2）

**预期影响**：零。

| 检查项 | 结论 |
|--------|------|
| 磁盘格式不变（仍是 v4） | ✅ |
| sessionPersistence API 不变 | ✅ |
| workspaceRegistry API 不变 | ✅ |
| 插槽名不变 | ✅ |
| 事件类型字符串不变 | ✅ |
| 主题 token 不变 | ✅ |

**需要的动作**：无。插件照常工作。

---

### 6.2 场景 B：Harness 次版本（v4.5 → v4.6，新功能但不改格式）

**预期影响**：极低。需检查：

| 检查项 | 风险 | 动作 |
|--------|------|------|
| 新增会话类型（如 `origin` 新值） | 低 — 子代理检查是精确匹配 `'subagent'`，新类型不会被拦 | 确认新类型是否需要单独转移 |
| 客户端 UI 重构 | 中 — 插槽名可能变 | 检查 `MENU_SLOT` / `OVERLAY_SLOT` 是否仍有效 |
| 主题 token 新增 | 零 — 插件只用现有 token | 无 |
| `sessions` API 扩展 | 低 — optional + fallback | 确认降级路径仍通 |
| 新增事件类型 | 低 — `retargetDeliveryMarkers` 只处理指定类型 | 确认新事件类型是否需要处理 |

**需要的动作**：运行一次回归测试（安装 → 转移到新工作区 → 验证标题/token/事件完整）。

---

### 6.3 场景 C：Harness 主版本（v4 → v5，格式升级）

**预期影响**：中等。需要逐一确认：

| 检查项 | 风险 | 需要的改动 |
|--------|------|-----------|
| 会话格式升级到 v5 | 🔴 | `formatStatus` 检查需要更新；如果 v4 变为 `'legacy'`，插件会拒绝所有 v4 会话 |
| 新格式的 `sessionPersistence` API | 🟡 | 如果 create/append/flush 签名变化，需要适配 `transferOne` |
| `inheritedEventCount` 概念是否保留 | 🟡 | 如果种子模型变，`retargetDeliveryMarkers` 需要重写 |
| 事件类型字符串 | 🔴 | `'session-log-deepseek/delivery-accepted'` 可能改名 |
| `sessionProjectionCache.coldSnapshot()` | 🟢 | optional + try/catch，不影响功能 |
| 客户端插槽名 | 🟡 | 取决于 v5 的前端是否重写 |

**需要的动作**：

1. 阅读 v5 的 CHANGELOG / migration guide
2. 在 v5 上安装插件，跑自检脚本验证基本功能
3. 更新 `formatStatus` 检查逻辑
4. 如果投递标记事件类型变了，更新 `retargetDeliveryMarkers` 中的字符串集合
5. 如果 `inheritedEventCount` 概念有变，重新评估投递标记重写策略
6. 验证客户端插槽名和模块加载器
7. 发布新版本

**预估改动量**：10-30 行代码。

---

### 6.4 场景 D：Harness 大重构（架构级变化）

**例如**：Web 客户端从 React 切到其他框架；模块系统从 `__ModuleLoader__` 切到 ESM；持久层从文件系统切到数据库。

**预期影响**：大。

| 检查项 | 风险 | 影响 |
|--------|------|------|
| `window.__ModuleLoader__` 消失 | 🔴 | `client.js` 入口需完全重写 |
| UI 框架切换 | 🔴 | React 组件需用新框架重写 |
| 持久层 API 全换 | 🔴 | `impl.js` 的核心逻辑需要重新对接 |
| 插槽 + 主题系统重构 | 🔴 | 整个客户端 UI 需要适配 |

**这种情况属于极端事件，Harness 本身必须提供迁移指南**。插件的 UI 逻辑（约 740 行）和转移逻辑（约 400 行）是独立的，可以分别移植。

---

## 7. 适配工作量估算

| 场景 | Host 端改动 | 客户端改动 | 总工时 |
|------|------------|-----------|--------|
| 补丁版本（v4.x → v4.y） | 0 | 0 | 0 |
| 次版本（v4.x → v4.y）新功能 | 0-5 行 | 0-2 行 | < 1h |
| 主版本（v4 → v5）格式升级 | 10-30 行 | 0-5 行 | 2-4h |
| 架构大变化（换框架/持久层） | 100-300 行 | 300-600 行 | 2-5d |

> 说明：工时含阅读 CHANGELOG、运行回归测试、修复边界 case。

---

## 8. 长期的维护建议

### 8.1 对插件开发者

1. **关注 Harness 的 CHANGELOG**：尤其注意 `sessionPersistence`、`workspaceRegistry`、UI 插槽相关的变更。
2. **在 Harness 发布 beta/rc 时及时测试**：安装插件 → 转移 → 验证 → 报告兼容性问题。
3. **为 `formatStatus` 检查留下扩展空间**：当前的精确匹配 `!== 'current'` 可以改为白名单式，例如 `ALLOWED = new Set(['current', 'v5-current'])`。
4. **为事件类型建立映射表**：而不是单个字符串常量：

   ```js
   const DELIVERY_MARKER_TYPES = new Set([
     'session-log-deepseek/delivery-accepted',
     // 'session-log-deepseek/v5:delivery-accepted',  // 未来版本
   ])
   ```

5. **提取 Harness API 访问到一个薄的适配层**：把所有 `service(ctx, 'sessionPersistence')` 调用集中到一个模块，未来 API 变化只需改这一层。
6. **保留自检用例**：两个真实样本（26 条事件、`isSeeded: false`；1250 条事件、`isSeeded: true`、`inheritedEventCount: 1248`）应在每个 Harness 版本上重新跑。首版分析时，这套用例抓出了三个真实缺陷：
   - v4 header 的 `delegationDepth` 是必填字段；
   - 副本必须改写 `delivery-accepted` 里的 `sessionId`，否则打开即报 `SessionFormatError`；
   - `workspaceRegistry.resolveByPath()` 是 async，漏 `await` 会让 `currentWorkspaceId` 恒为 `null`。

### 8.2 对 Harness 团队（建议）

如果 Harness 愿意让第三方插件更稳定，可以考虑：

1. **为插槽名提供稳定的别名映射**：`sidebar.workspaces.session.menu.item → v1:session-menu-item`
2. **为事件类型建立语义常量**：让插件不依赖硬编码字符串，而是通过 `ctx.events.DELIVERY_ACCEPTED` 引用
3. **`dsh.pluginApi` 版本号**：在 `package.json` 中声明 `"dsh": { "pluginApi": 1 }`，Harness 据此判断兼容性
4. **提供 `sessionPersistence.transferSession()` 作为内置 API**：把迁移逻辑内置化，插件只需 UI

---

## 9. 发布、安装与升级检查

- 源码 / 发布地址：<https://github.com/xiaolin233-ctrl/dsh-session-transfer>
- 当前版本：`1.0.0`，对应 Git tag `v1.0.0`
- 默认分支：`main`；许可证：MIT

### 9.1 安装

插件以“本地 bundle”方式安装，不需要发 npm：

```text
plugin_manager action=install_bundle target=D:\ProJect\dsh-session-transfer
```

安装结果以返回里的 `application` 与 `warnings` 为准（应为 `application: "applied"`、`warnings: []`）。Host 入口注册后无需重启；浏览器半边需要刷新页面才会注入最新的 `client.js`。

### 9.2 安装后自检（3 步）

1. `plugin_manager action=list_plugins`：确认 `include:dsh-session-transfer` 为 enabled / `fiberPhase: "active"`。
2. 客户端插槽：`cordis_inspect_query(platform=client, provider=Slots, method=listSubTree, root="sidebar.workspaces.session.menu.item")` 应看到 `dsh-session-transfer:menu`（order 350，位于 fork 300 与 archive 400 之间）；`root="shell.overlay"` 应看到 `dsh-session-transfer:dialog`。
3. HTTP 路由：

   ```bash
   curl "http://127.0.0.1:<端口>/dsh-session-transfer/state?sessionId=<任意会话 id>"
   ```

   应返回 `{"ok":true,"workspaces":[…],"currentWorkspaceId":"…","session":{…}}`。

### 9.3 升级发布流程

1. 改代码后跑 `node -e "import('file:///…/impl.js')"` 与 `node --check client.js`，再跑一次真实转移回归（设计 → 目标工作区、核对标题与历史）。
2. 升 `package.json` 的 `version`，同步 `README.md` / `README.en.md` 里的版本说明。
3. `git commit` → `git tag vX.Y.Z` → `git push origin main --tags`。

---

## 10. 文档更新记录

### 第二版（2026-11-06）

对照当前源码（`index.js` 101 行、`impl.js` 406 行、`client.js` 742 行）逐条校准，变更如下：

1. **行数**：首版写 102 / 407 / 743，实际为 101 / 406 / 742。
2. **客户端服务调用**：首版称“客户端只用了 `pluginCtx.navigateToSession()`”，实际不存在该调用；代码里用的是 `sessions.refresh()`（`client.js:459-462`）、`sessions.refreshProjections()`（`client.js:490-494`）、`uiWorkspace.openSession()`（`client.js:506-509`）。
3. **`stat()` 返回值**：首版附录写成 `{ header, formatStatus, eventCount }`；实际是 `{ header, formatStatus, revision, sizeBytes }`，且**会话不存在时返回 `undefined` 而不抛错**（`impl.js:289` 专门判空）。`verifyCopy` 因此靠重读日志而不是 `stat` 的计数来校验。
4. **投递标记触发范围**：首版称“零种子会话不受影响、纯新会话不产生投递标记”，与实测不符——普通会话同样会写 `delivery-accepted`（样本 `session-e96a0f8c-…` 的 seq 18/19），所以改写逻辑对所有副本都会执行；种子会话只是额外保留继承前缀。
5. **§4.1.1 截断句**：首版该段结尾的 `**` 未写完，本版补全。
6. **主题 token**：按实读补齐为 16 个（含 `--dsw-radius-*`、`--dsw-focus-ring-width`），并注明全部带 fallback。
7. **新增 §9**：发布地址、安装命令、安装后 3 步自检、版本升级流程。
8. **行号校正**：`turn/start` / `turn/end` 在 `impl.js:105-106`（首版写 103-104）；服务封装 `service()` 在 `impl.js:34`；`package.json` 的 `dsh.client` 在 38-44 行（首版写 30-34）。

---

## 附录 A：插件完整 API 依赖速查表

```
sessionPersistence
 ├── stat(sessionId)                          → { header, formatStatus, revision, sizeBytes } | undefined
 ├── open(sessionId, 'read')                  → { read(offset, limit), inheritedEventCount, close() }
 ├── create(header, { inheritedEventCount })  → { append(events), flush(), close() }（句柄自带写所有权）
 └── (readAll 是封装在 impl 里的辅助函数)

workspaceRegistry
 ├── list()                                   → [{ id, title, path, sessionIds }]
 ├── get(id)                                  → workspace
 ├── resolveByPath(cwd)                       → Promise<workspace | undefined>
 ├── workspace.attachSession(sessionId)       → Promise<void>
 └── workspace.archiveSession(sessionId)      → Promise<void>

sessions (optional)
 ├── get(sessionId)                           → live session | undefined
 ├── flush(live)                              → Promise<boolean>
 ├── live.snapshotEvents()                    → Event[]
 ├── live.seq
 └── live.inheritedEventCount

sessionProjectionCache (optional)
 └── coldSnapshot(header, inheritedEventCount, events) → snapshot | false

webServer
 └── register({ kind: 'prefix', path, handler }) → dispose

ctx
 └── get(key) → service | undefined

window.__ModuleLoader__ (客户端)
 └── load({ id, factory(require) })

pluginCtx (客户端)
 ├── get(key) → service | null
 └── (经服务调用) sessions.refresh / sessions.refreshProjections / uiWorkspace.openSession
```

---

## 附录 B：硬编码字符串清单

| 字符串 | 文件:行 | 类别 | 敏感度 |
|--------|---------|------|--------|
| `'dsh-session-transfer'` | `index.js:11`, `client.js:10` | 插件自身标识 | 🟢 |
| `'sessionPersistence'` | `impl.js:275` | 服务名 | 🟢 |
| `'workspaceRegistry'` | `impl.js:276` | 服务名 | 🟢 |
| `'sessions'` | `impl.js:280` | 服务名 | 🟢 |
| `'sessionProjectionCache'` | `impl.js:281` | 服务名 | 🟢 |
| `'webServer'` | `index.js:12` | 服务名 | 🟢 |
| `'/dsh-session-transfer'` | `index.js:14` | HTTP 路由前缀 | 🟢 |
| `'session-log-deepseek/delivery-accepted'` | `impl.js:127` | 事件类型 | 🔴 |
| `'current'` | `impl.js:295` | 格式状态 | 🔴 |
| `'subagent'` | `impl.js:292` | 会话 origin | 🟡 |
| `'turn/start'` / `'turn/end'` | `impl.js:105-106` | 事件类型（isMidTurn） | 🟡 |
| `'sidebar.workspaces.session.menu.item'` | `client.js:17` | UI 插槽 | 🔴 |
| `'shell.overlay'` | `client.js:18` | UI 插槽 | 🔴 |
| `'@deepseek-ai/dsh-client-ui-conversation'` | `package.json:42` | 注入目标 | 🟡 |
| `'WorkspaceActiveSessionError'` | `impl.js:392` | 错误类型名 | 🟢 |
| `--dsw-alias-*` / `--dsw-radius-*` / `--dsw-focus-ring-width`（16 个） | `client.js:100-188` | 主题 token | 🟢 |