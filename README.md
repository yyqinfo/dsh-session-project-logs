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

**为什么必须停 DSH**：后端把 `root` 固定在进程里，并且每次追加都按 `root + cwd + id` 重新算路径。
会话目录被搬走后，运行中的写句柄下次追加会指向一个不存在的目录，日志就写不进去了（实测踩过：
搬走了正在跑的那个会话，必须重启 DSH 才恢复）。

所以：

```
node bin/session-project-logs.mjs status                  # 看每个项目的中心/项目内会话数
node bin/session-project-logs.mjs migrate --dry-run --all  # 预览全量
node bin/session-project-logs.mjs migrate --all            # 真正搬迁（先停 DSH）
node bin/session-project-logs.mjs restore --all            # 反悔：搬回中心根目录
```

**活动保护**：`migrate` 会跳过最近 `--quiet`（默认 10）分钟内有写入的会话，并打印
`written N min ago, looks live — left in place`。真要搬就在停掉 DSH 后重跑；确实需要强制时用
`--force`，但正在运行的会话会因此写不进日志。

`migrate` 的目标范围：不带参数时是**插件登记过的项目**（`$DSH_HOME/logs/session-project-logs.state.json`），
`--all` 则从中心根目录的会话头里反查全部项目。项目目录已不存在、或落在用户主目录/临时目录/盘符根的项目不会搬。

## 与路径类插件共存（兼容视图）

有些插件**不向宿主询问**会话目录，而是自己按 `~/.dsh/sessions/<projectKey(cwd)>/<sessionId>` 现推路径
（例如 `@xrn1997/dsh-session-delete`），项目内存储会让它们报「会话目录不存在」。

插件默认维护一个**兼容视图**：把 `<root>/<projectKey>` 做成指向
`<项目>/<dirName>/<projectKey>` 的目录链接（Windows junction / POSIX symlink）。效果：

- 宿主后端枚举项目目录用的是 `Dirent.isDirectory()`，链接不算目录 → **不会重复列出、不会双写**；
- 通过该路径做的**内部操作**（读目录大小、把会话目录 `rename` 进回收站、再 `rename` 回来）
  作用于项目里的真实目录，删除/恢复能真正生效；
- 挂载的项目后端挂在**根上下文**并按 root 复用，所以热替换插件（`dsh plugin add`、HMR）
  **不会关掉正在运行会话的写句柄**；
- 插件停用时会自动撤掉这些链接；不想要就配置 `centralView: false`。

⚠️ **`~/.dsh/sessions` 不再"空着"**：里面会出现指向项目的链接。**不要递归删除或移动这个目录**
（`rm -rf`、资源管理器删除都会顺着链接删进项目目录）。要清理只删**非链接**的子项。

⚠️ **跨卷限制**：`dsh-session-delete` 用 `rename` 搬目录，`$DSH_HOME` 与项目不在同一卷时会 `EXDEV`
失败（它自己的代码里就明确拒绝跨卷）。这类项目若要能删会话，只有两条路：
用 `ignore` 让该项目保持中心存储（再 `restore` 该项目），或等上游加"复制后删除"的回退。

## 同步到另一台机器（Junction 会被"跟进去"）

兼容视图是 **junction / 符号链接**，只在**本机**有意义。同步工具对它的处理各不相同：

| 工具 | 默认行为 | 规避 |
| --- | --- | --- |
| robocopy | 跟进去，把目标**复制成真目录** | 加 `/XJ`（或 `/SJ`）排除 junction |
| `rsync -a` | 复制链接本身 | 不要加 `-L` / `--copy-links` |
| Syncthing / OneDrive / 网盘 | 多数会跟随或忽略 | 用忽略规则排除 `sessions/<key>` |

**视图是派生状态，正确做法是"同步前撤掉、落地后重建"：**

```powershell
# 同步前（本机）
node bin/session-project-logs.mjs views strip --dry-run   # 先看会删哪些
node bin/session-project-logs.mjs views strip             # 撤掉链接，项目里的真实日志不动
# ……执行同步……
# 另一台机器启动 DSH 后，插件按需自动重建视图；也可以立刻手动重建：
node bin/session-project-logs.mjs views repair
```

**已经被同步成"真目录"了怎么办？** 在目标机器上：

```powershell
node bin/session-project-logs.mjs views status   # 逐个报告 link / 真目录 / 缺失
node bin/session-project-logs.mjs views repair   # 副本内容都在项目里 → 删副本、换回链接
```

`views repair` 只在**安全**时替换：副本里若有多出来的会话（`only in the root`）、或某会话的日志
比项目里的大（说明有人在副本上写过），会报 `blocked` 并**保持原样**。
处理办法：先 `migrate <project>` 把这些会话搬进项目，再 `views repair`。

目标机器如果**不需要**按路径推算目录的插件（例如不装 `dsh-session-delete`），最省事的做法是
直接把它配成 `centralView: false`——那里根本不生成 junction，同步自然没这个麻烦。

## 校验与修复会话日志（0.2.2 起后端更严）

DSH 0.2.2 起会话日志多了两条硬约束，0.2.1 之前能读的日志会被拒：

| 症状 | 触发原因 |
| --- | --- |
| `complete frame contains a torn JSONL record` | 某个 zstd 帧没有落在 JSON 记录边界上（记录跨帧、或写入被中断留下半截行） |
| `invalid committed event at line N: … seq gap (expected X, got Y)` | 序号断档，中间那段事件丢了（块级同步覆盖是最常见的原因） |

```powershell
node bin/session-project-logs.mjs verify          # 扫描登记项目 + 中心根
node bin/session-project-logs.mjs verify --all    # 再按中心根的会话头反查项目
node bin/session-project-logs.mjs verify --json
```

输出会列出断档范围、缺失条数、帧内残行，以及**同目录有没有同步冲突副本**——
有副本就能无损合并。修复用 `$DSH_HOME/tools/` 下的两个工具：

```powershell
node $DSH_HOME\tools\scan-session-logs.mjs --all                              # 全量体检
node $DSH_HOME\tools\merge-session-log.mjs "<会话目录>\session.v4.jsonl.zstd" --apply
```

`merge-session-log` 先备份 `.bak-<时间>`、写后自校验，通过才替换原文件。
有冲突副本时按 `seq` 取"写入时间更晚"的行合并（无损，实测能补回几十到几百条）；
没有副本时加 `--renumber` 让日志重新可读（缺的事件无法恢复，工具会如实报告）。
修复完的日志是"每帧恰好一条完整记录"，也是后端最稳的布局。

## 安装

本机试用直接指向源码目录即可（pnpm 用 `link:`，改代码立即生效）：

```
plugin_manager install_bundle(target = <本目录绝对路径>)
```

装好后 `cordis.patch.yml` 会向 profile 注入一行插件（id `session-project-logs`）。
`plugin_manager list_plugins` 里按 entryId `include:session-project-logs` 切换。

## 分发到别的机器

`install_bundle` 接受四种目标：绝对目录、**tgz 包**、npm registry 包名、git 地址。

### 方式一：命令行 `dsh plugin add`（推荐，一条命令）

仓库：<https://github.com/yyqinfo/dsh-session-project-logs>

`dsh plugin --profile <档案名> <pnpm 参数>` 会把包装进档案，并**自动把这个 bundle 加进
`dsh.profile.bundles`**（实测：装完 `package.json` 里同时出现 dependency 和 bundle 条目）。

```
# 从 Release 装（包已打好，最快）
dsh plugin --profile web add "https://github.com/yyqinfo/dsh-session-project-logs/releases/download/v0.0.2/local-session-project-logs-0.0.2.tgz"

# 或直接从仓库装（pnpm 会 clone 后打包）
dsh plugin --profile web add "git+https://github.com/yyqinfo/dsh-session-project-logs.git"
```

装完**重启 DSH** 生效（命令行安装不经过运行中的 Host，热更新不会自己加载新 bundle）。
卸载：

```
dsh plugin --profile web remove @local/session-project-logs
```

> - `--profile` 是必填项，`web` 就是 `dsh web` 用的那个档案；`dsh tui` 则是 `tui`。
> - Desktop 用户把档案换成 `desktop`，并且要先完全退出 Desktop 再执行。
> - 装之前最好先停掉 DSH：运行中的进程会占住它启动时加载的包。

### 方式二：会话里用 `plugin_manager` 工具

不想敲命令行时，在任意 DSH 会话里让 agent 调 `plugin_manager`：

```
plugin_manager install_bundle(target = "https://github.com/yyqinfo/dsh-session-project-logs/releases/download/v0.0.2/local-session-project-logs-0.0.2.tgz")
```

它走的是运行中的 Host 的插件管理器，能热加载（不需要重启），并且会返回 `application` 结果。

### 方式三：本地打 tgz 再拷过去

```
npm pack                     # 生成 local-session-project-logs-0.0.2.tgz（约 21 KB）
```

把 tgz 拷到目标机器，然后：

```
dsh plugin --profile web add "C:/Temp/local-session-project-logs-0.0.2.tgz"
```

或 `plugin_manager install_bundle(target = "C:/Temp/local-session-project-logs-0.0.2.tgz")`。

装进去的是**拷贝**（`pnpm add file:...tgz`），不依赖你本机的源码目录。
命令行工具随之安装在 profile 里：

```
node "$env:DSH_PROFILE_DIR/node_modules/@local/session-project-logs/bin/session-project-logs.mjs" status
```
### 方式四：直接把目录拷过去

把整个 `session-project-logs` 目录放到目标机器某个固定路径，用目录路径作为安装目标。
注意 pnpm 会做成 `link:`，**这个目录以后不能删或移动**，否则插件失效。

### 方式五：发到 npm registry（多台机器统一升级）

先把 `package.json` 的 `private` 去掉、`name` 换成自己在 npm 上拥有的 scope
（`@local` 不是可发布的 scope），`npm publish --access public` 之后：

```
plugin_manager install_bundle(target = "@your-scope/session-project-logs@^0.0.2")
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

- **升级**：版本号 +1、重新打包并更新 Release 资产；目标机器直接
  `dsh plugin --profile web add "<新 tgz 地址>"` 覆盖旧版本，然后重启 DSH
  （替换已安装包需要重启才会加载新的 JS 模块）。
- **卸载**：`dsh plugin --profile web remove @local/session-project-logs`
  （`plugin_manager` 里用 `remove_bundle`）。
- **停用（保留数据）**：`plugin_manager set_plugin(enabled=false, target="include:session-project-logs")`，
  立即把持久化入口还原成官方实现，新会话回中心根目录；项目目录里的日志仍可读。
- **撤销迁移**：停掉 DSH 后 `node bin/session-project-logs.mjs restore --all`。

## 配置（`cordis.patch.yml` 的 `config`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `root` | `$DSH_HOME/sessions` | 官方后端使用的中心根目录；只有自定义过持久化 root 时才需要填 |
| `dirName` | `.dsh/sessions` | 项目内的日志目录（相对项目根，必须在项目内） |
| `routeNewSessions` | `true` | 是否把新会话分流到项目目录；`false` 时只保留离线迁移能力 |
| `centralView` | `true` | 是否在中心根目录维护指向项目的兼容视图（给按路径推算目录的第三方插件用） |
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
