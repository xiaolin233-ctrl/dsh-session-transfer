# 对话转移（dsh-session-transfer）

<sub>English: [README.en.md](README.en.md)</sub>

在侧栏的会话「⋯」菜单里多一行 **「转移到其他工作区…」**：选一个目标工作区，这段对话就会完整地出现在那里，标题、工具调用、token 用量都保留，可以照常打开并继续。

## 安装

1. 把这个仓库放到本机任意目录（路径里有空格也行）。
2. 在 DSH 会话里安装本地插件包 —— 目标指向仓库根目录（含 `package.json` 的那层）：

   ```
   plugin_manager  action: install_bundle  target: <仓库绝对路径>
   ```

   装完 `application` 应为 `applied`、`warnings` 为空；插件列表里出现 `dsh-session-transfer`（enabled / active）。
3. **刷新浏览器页面**加载浏览器半边（Host 半边安装时即生效，无需重启 DSH）。

要求：DSH 支持插件包（Host + Web 客户端），Node.js ≥ 22.5。卸载：`plugin_manager action: remove_bundle target: dsh-session-transfer`。

> 仓库就是插件包本身：没有构建步骤、没有运行时依赖，`impl.js` 每次请求热加载，改完直接刷新页面即可验证。

## 它怎么保证「不损坏对话」

会话在磁盘上是一段只追加的事件日志（`session.v4.jsonl.zstd`，header + 每个 append 批次一帧 zstd）。插件**从不改写任何已有字节**，而是走官方 `sessionPersistence` API 重放：

1. 读源会话的完整日志（活会话先 `sessions.flush()` 落盘，再以存储为准；存储落后于内存时才回退到内存日志）。
2. 校验 seq 从 0 连续；中途正在回答的活会话会拒绝，避免复制到半截的回合。
3. 用新 id 在目标工作区 `create`：header 逐字段复制（`version` / `createdAt` / `isSeeded` / `delegationDepth` / `agentPreset` / `parentSession`），只把 `cwd` 指向目标工作区；`inheritedEventCount` 原样继承。
4. 按 500 条一批 `append` 全部事件，然后 `flush()`。
5. 关闭写句柄后**重新读回来核对**：条数、seq 连续性、末条 seq 必须与源一致，不一致就报告 `verify-failed`，不会假装成功。
6. `attachSession(新 id)` 挂到目标工作区（这一步会向侧栏推送更新）。
7. `sessionProjectionCache.coldSnapshot(...)` 补投影缓存 —— 侧栏里冷会话的标题就来自它，不补会显示「未命名对话」。
8. 默认把原会话**归档**（`archiveSession`）：归档只是从分组表面隐藏，未删除任何数据，可在侧栏「已归档」里恢复；勾选「保留原工作区的对话」则完全不动原会话。

因为事件是原样重放的，`session/title` 事件也在其中，所以标题天然保留；会话目录里只有这一个日志文件，附件在全局存储里，不随会话目录迁移，引用不会断。

一个容易踩的坑：`session-log-deepseek/delivery-accepted` 事件里记着会话 id（v4 格式要求它与 header 的 id 一致）。原样复制会让副本一读就报 `SessionFormatError: current-generation delivery marker names the wrong Session`。所以复制时只把**这段会话自己产生的**（`seq >= inheritedEventCount`）投递标记改写成新 id；从父会话继承的前缀（副本仍带 `parentSession`）保持原样。

## 使用

1. 侧栏里把鼠标移到某个对话上，打开「⋯」菜单 → **转移到其他工作区…**
2. 选择目标工作区，按需勾选：
   - **保留原工作区的对话**：默认不勾（原对话归档，可恢复）。
   - 源工作区有多个对话时会多出 **同时转移该工作区全部对话**：逐个复制，子代理会话自动跳过。
3. 点 **转移**。完成后可以点 **打开新会话** 直接进入副本。

子代理会话（`header.origin === 'subagent'`）跟随父会话，单独转移会变成孤儿，因此一律拒绝并单独报错。需要格式迁移的旧会话也会先被拒绝（`format-migration-required`），避免把旧格式写成新 header。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 入口：只注册 `/dsh-session-transfer` 的 HTTP 路由，并把 Header 注入所需的 `webServer` 声明出来。 |
| `impl.js` | 真正的迁移逻辑，**每次请求都以带戳的 `import()` 重新加载**，所以改这里不用重启 DSH。 |
| `client.js` | 浏览器半边：菜单行 + 覆盖层对话框（`sidebar.workspaces.session.menu.item` / `shell.overlay`），只用 `--dsw-alias-*` 主题 token，不依赖 UI primitives。 |
| `cordis.patch.yml` | 把本插件插入 Host composition。 |
| `locale/{zh,en}.json` | 插件管理页里显示的标题与描述。 |

## 接口（Host 路由）

- `GET /dsh-session-transfer/state?sessionId=…` → `{ ok, workspaces:[{id,title,path,sessionCount}], currentWorkspaceId, sourceSessionIds, session }`
- `POST /dsh-session-transfer/transfer`，body `{ sessionIds:[…], targetWorkspaceId, keepOriginal?:boolean, titles?:{id:title} }` → `{ ok, targetWorkspaceId, targetTitle, targetPath, results:[{ sessionId, ok, newSessionId?, eventCount?, archivedOriginal?, cacheWritten?, note?, code?, message?, partialSessionId? }] }`

业务失败放在 `results[]` 的单项里，不抛 HTTP 错误，这样批量转移里一个失败不影响其他会话。

## 失败时会发生什么

- `read-failed` / `log-corrupt`：源日志读不出或不连续 → 不写任何东西。
- `session-running`：源会话正在回答 → 等待本轮结束再试。
- `copy-failed`：写入中途失败 → 返回 `partialSessionId`，可在存储里找到并清理；原会话不作任何改动。
- `verify-failed`：读回核对不一致 → 报告 `partialSessionId`，不挂到工作区。
- `attach-failed`：副本已存在但挂载失败 → 返回 `partialSessionId`。
- 归档失败（原会话仍在运行等）→ 副本照常成功，`note` 说明原会话被保留。

## 兼容性

见 [COMPATIBILITY.md](COMPATIBILITY.md)：逐项列出本插件依赖的 Harness API、稳定性分层、已知脆点（投递标记事件类型、客户端插槽名、`__ModuleLoader__` 等）、v4 → v5 的升级推演与适配工作量估算。

## 验证

插件装好后用一次性自检插件在真实的 Host 进程里跑了两个用例（26 条事件的无种子会话、1250 条事件、`inheritedEventCount = 1248` 的种子会话），逐项全通过：

- 副本 `cwd` 指向目标工作区，`createdAt` / `isSeeded` / `delegationDepth` / `agentPreset` / `inheritedEventCount` 全部保留；
- 副本事件数组与源一致（投递标记的 id 除外）、seq 从 0 连续、标题保留；
- 副本立即出现在目标工作区的 `sessionIds` 里，投影缓存文件写入成功，侧栏能显示标题；
- 自检用的临时工作区、会话目录与缓存均已清理，用户原有工作区未受影响。