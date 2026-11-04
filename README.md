# 项目内会话日志（@local/session-project-logs）

让 DSH 的**新会话**把日志写进项目自己的 `.dsh/sessions/`，而不是全部堆在 `~/.dsh/sessions`：

```
~/.dsh/sessions/                      项目目录/
  --D-Gitlab--/                          .dsh/sessions/
    session-旧会话/           ──►          --D-Gitlab--/          ← 本项目的新会话
                                            session-新会话/
                                              session.v4.jsonl.zstd
```

## 为什么不能直接把目录「挪成链接」

最直觉的做法是把 `~/.dsh/sessions/<项目键>` 换成指向项目目录的目录链接（junction/symlink）。
**这条路在本机实测走不通**：官方后端枚举项目目录用的是
`readdir(..., { withFileTypes: true }).filter(e => e.isDirectory())`，
而 Windows junction / POSIX symlink 的 `Dirent.isDirectory()` 是 `false`、`isSymbolicLink()` 是 `true`，
于是被链接的项目目录对后端**完全不可见**——会话列表、恢复、`stat` 全部看不到（实测会话数从 816 掉到 385）。
所以本插件不碰文件系统链接。

## 本插件怎么做

后端只有**一个** `root`，但可以**再挂一个**。插件保留原有后端（继续服务中心根目录里的历史会话），
为每个项目额外挂一个**同一版本、同一实现的官方后端**，`root = <项目>/.dsh/sessions`；
然后把持久化服务的入口按项目分流：

| 方法 | 行为 |
|---|---|
| `create()` | 会话的 `cwd` 属于合格项目 → 交给该项目的后端；否则交给原后端（中心根目录） |
| `open()` / `stat()` | 按会话 id 找到所属后端（索引 + 兜底扫描） |
| `list()` | 合并中心根目录与所有已挂载项目根目录的结果 |
| `flush()` | 扇出到所有后端 |

**存储格式完全没变**：每个项目后端就是官方后端，写出来的仍是标准的
`session.v4.jsonl.zstd`，所以"离线迁移"只需要移动目录，不需要转码。

### 与官方实现的耦合点（已做失败保护）

插件从 `process.argv[1]`（运行的 `@deepseek-ai/dsh` 包内）解析出
`@deepseek-ai/dsh-session-persistence-jsonl` 与 `@deepseek-ai/dsh-session-persistence`，
用**同一个模块实例**（ESM 缓存按 URL 命中）来挂载后端并复用错误类。
启动时会校验 `SessionPersistence` 的类身份与每个挂载出来的后端实例，任一处不符就**整体放弃并记日志**，
存储行为保持原样——绝不会"半开半闭"地改写用户日志。

## 行为

- **新会话**：`cwd` 合格的项目 → 写入 `<项目>/.dsh/sessions/<项目键>/<会话 id>/`。
- **历史会话**：仍在 `~/.dsh/sessions`，照常列出、恢复、续写（由原后端服务）。
- **项目目录消失**：该项目的后端仍会挂载（目录不存在时会重建），会话照常可读；写入时目录会重新创建。
- **插件停用**：立刻把 `create/open/stat/list/flush` 还原成官方实现，新会话回到中心根目录；已写入项目目录的会话仍在项目里，仍可读。

## 迁移历史会话（离线，需停止 DSH）

运行中的写句柄会继续写它被打开时所在的根目录，所以历史会话的搬迁必须**停掉 DSH** 再做：

```
node bin/session-project-logs.mjs status                 # 看每个项目的中心/项目内会话数
node bin/session-project-logs.mjs migrate --dry-run      # 预览
node bin/session-project-logs.mjs migrate                # 真正搬迁（需先停止 DSH）
node bin/session-project-logs.mjs restore --dry-run      # 反悔：搬回中心根目录
```

`migrate` 只搬**插件登记过的项目**（`$DSH_HOME/logs/session-project-logs.state.json`），
目录已经不存在、或落在用户主目录/临时目录/盘符根的项目不会被搬。

## 安装

本机试用直接指向源码目录即可（pnpm 用 `link:`，改代码立即生效）：

```
plugin_manager install_bundle(target = <本目录绝对路径>)
```

装好后 `cordis.patch.yml` 会向 profile 注入一行插件（id `session-project-logs`）。
`plugin_manager list_plugins` 里按 entryId `include:session-project-logs` 切换。

## 分发到别的机器

`install_bundle` 接受四种目标：绝对目录、**tgz 包**、npm registry 包名、git 地址。

### 方式一：发一个 tgz（推荐，不需要 registry）

```
npm pack                     # 生成 local-session-project-logs-1.0.0.tgz（约 20 KB）
```

把 tgz 拷到目标机器，然后：

```
plugin_manager install_bundle(target = "C:/Temp/local-session-project-logs-1.0.0.tgz")
```

装进去的是**拷贝**（`pnpm add file:...tgz`），不依赖你本机的源码目录。
命令行工具随之安装在 profile 里：

```
node "$env:DSH_PROFILE_DIR/node_modules/@local/session-project-logs/bin/session-project-logs.mjs" status
```

### 方式二：直接把目录拷过去

把整个 `session-project-logs` 目录放到目标机器某个固定路径，用方式里的目录目标安装。
注意 pnpm 会做成 `link:`，**这个目录以后不能删或移动**，否则插件失效。

### 方式三：发到 registry（多台机器统一升级）

先把 `package.json` 的 `private` 去掉、`name` 换成自己的 scope（`@local` 不是可发布的 scope），
`npm publish` 之后在目标机器：

```
plugin_manager install_bundle(target = "@your-scope/session-project-logs@^1.0.0")
```

git 地址与 tarball URL 也可以直接作为目标。

### 目标机器的前提

| 项 | 要求 |
|---|---|
| DSH | 0.2.x（本机实测 `0.2.1-rc.5`）；版本不同不一定会坏——插件启动时会校验官方持久化类的身份，不符就**记日志并保持原样** |
| Node | ≥ 22（`migrate --all` 读会话头用到 Node 内置 zstd；Host 路由本身不依赖它） |
| 路径 | `$DSH_HOME/logs` 可写（登记表与报告） |
| 安装形态 | 官方包必须能按 `process.argv[1]` 解析到；DSH Desktop（`app.asar`）**未实测**，识别不到时会自动放弃，不会改坏日志 |

### 装完怎么验

1. `plugin_manager list_plugins` 里 `include:session-project-logs` 为 active 且 `fiberPhase` 正常；
2. 在任意项目里新建一个会话，然后看 `<项目>/.dsh/sessions/<项目键>/<会话 id>/session.v4.jsonl.zstd` 是否出现；
3. 看 `$DSH_HOME/logs/session-project-logs.json`：`routedProjects` 里有该项目、`totals.errors` 为 0；
4. 跑一次 `doctor`，确认两个官方包解析成功。

### 升级与卸载

- **升级**：版本号 +1，重新 `npm pack`；目标机器先 `remove_bundle`，再 `install_bundle` 新 tgz，
  然后重启 DSH（替换已安装包需要重启才会加载新的 JS 模块）。
- **停用（保留数据）**：`plugin_manager set_plugin(enabled=false, target="include:session-project-logs")`，
  立即把持久化入口还原成官方实现，新会话回中心根目录；项目目录里的日志仍可读。
- **撤销迁移**：停掉 DSH 后 `node bin/session-project-logs.mjs restore --all`。

## 配置（`cordis.patch.yml` 的 `config`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `root` | `$DSH_HOME/sessions` | 官方后端使用的中心根目录；只有自定义过持久化 root 时才需要填 |
| `dirName` | `.dsh/sessions` | 项目内的日志目录（相对项目根，必须在项目内） |
| `routeNewSessions` | `true` | 是否把新会话分流到项目目录；`false` 时只保留离线迁移能力 |
| `gitignore` | `true` | 在项目日志目录写 `.gitignore`（`*` + `!.gitignore`），避免误提交 |
| `ignore` | `[]` | 额外跳过的绝对路径前缀 |
| `statePath` | `$DSH_HOME/logs/session-project-logs.state.json` | 项目登记表；`false` 关闭（关闭后 CLI 需显式指定项目目录） |

环境变量 `DSH_HARNESS_ANCHOR` 可指定解析官方包的锚点（默认用 `process.argv[1]`），
用于非标准启动方式的部署。

## 排障

```
node bin/session-project-logs.mjs doctor
```

输出插件看到的中心根目录、项目目录名、登记表路径，以及两个官方包是否解析成功。
运行期还会写 `$DSH_HOME/logs/session-project-logs.json`（已挂载的项目、计数）。
Host 日志里插件的前缀是 `[session-project-logs]`。

## 已知限制

- **历史会话默认仍在中心根目录**：运行期不搬（写句柄会写回原根目录），需要离线跑 `migrate`。
- **每个项目多一个后端实例**：项目多时内存与启动开销随之增加（每个后端只缓存自己的元数据）。
- **`~/.dsh/sessions` 里可能残留空的 `--项目键--` 目录**（会话搬走后），可手工删除。
- **子目录各自成键**：会话 `cwd` 是项目子目录时按后端既定规则单独成键，插件不做合并。
- **依赖官方包路径**：如果将来的 DSH 改了包布局或持久化实现，插件会在启动时检测到身份不符并自动放弃（不写坏数据）。

## 开发与 CI

本地跑测试（Node 内置模块，无需 install）：

```
npm test
```

`test/core.test.mjs` 覆盖布局、跳过规则、离线迁移/回滚与登记表；
`test/routing.test.mjs` 用真实的官方包做路由集成测试，解析不到官方包时自动跳过。

CI 配置放在 [`ci/test.yml`](ci/test.yml)。需要启用时把它复制成 `.github/workflows/test.yml` 并用网页提交
（用 PAT 推送 workflow 文件需要 token 带 `Workflows: Read and write` 权限，网页提交不需要）。
