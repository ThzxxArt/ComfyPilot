# ComfyPilot 0.1.18 迭代方案 —「全功能打磨 · 目标一致 · 平台现代化」

> 生成日期：2026-10-24 · 基线 **v0.1.17**（`35555b3` / tag `v0.1.17`，工作区干净）
> 读取范围：**src 106 文件 / 55,340 行** + **tests 120 文件 / 38,609 行** + **README 461 行** + **9 份历史 PLAN / 3,663 行** + **配置/脚本/CI 1,353 行**，合计约 **9.9 万行**；12 路并行全文通读，逐文件 `wc -l` 核对，无抽样、无截断。
> 方法：12 个独立评审切片（主进程核心 / 内容服务 / 基础设施 / IPC+共享 / 渲染层三片 / 测试四片 / 文档发布）+ **本人回读复核 20 余处关键断言** + **实机取证**（`%APPDATA%/comfy-pilot`：705 GB 模型库、13 GB 产物、`slow-ops.log`、实例日志）。
> 基线门禁：**120 文件 / 2,670 用例全绿**；覆盖率行 **89.59%**（但 include 仅 54 文件 / 17,129 行 ≈ src 的 31%）；typecheck ×3、lint、build、e2e 均通过。
> **一句话**：0.1.17 让“状态可信”；0.1.18 要把“可信”变成“好用”——**目标不错位、长任务不吓人、每个功能都收口**，同时把 Electron 从已 EOL 的 32 抬到受支持版本。

---

## 0. 读取范围与方法（为什么可信）

### 0.1 覆盖清单（按切片去重后 src 100%）

| 切片 | 文件 / 行数 | 覆盖内容 |
|---|---|---|
| 主进程核心 | 12 文件 / **10,361** | `index.ts`、`bootstrap.cjs`、`bootstrap`、`installer`、`updater`、`instance`、`p1p2`、`pipOps`、`env`、`processTree`、`tray`、`startupIssues` |
| 主进程内容 | 13 文件 / **9,180** | `nodePack`、`model`、`workflow*`、`registry*`、`media`、`assetsApi`、`comfyApi`、`monitor`、`zip*` |
| 主进程基础设施 | 20 文件 / **4,539** | `db`、`backup`、`security`、`secretStorage`、`session`、`appUpdate`、`capabilities`、`childEnv`、`desktop`、`doctor`、`execDiagnostics`、`lru`、`logFile`、`netProbe`、`preflight`、`proxy`、`slowOps`、`workPool`、preload ×2 |
| IPC + 共享 | 12 文件 / **5,993** | `handlers.ts` 2,118 + `shared/*` 11 文件 3,875 |
| 渲染层 A | 10 文件 / **8,006** | `App.vue`、`main`、`router`、`stores/app`、Dashboard、Install、Instances、InstanceDetail、Embed、Backup |
| 渲染层 B | 9 文件 / **9,846** | Nodes、Market、Models、Output、Monitor、Settings、Workflows、Batch、Doctor |
| 渲染层基础设施 | 29 文件 / **7,403** | 7 组件、8 composable、7 utils、双语 locale、样式 |
| 测试 A | 17 文件 / **10,236** | nodePack×4、nodeOp、media×5、zip×4、cacheMigration |
| 测试 B | 38 文件 / **13,395** | 实例/更新/安装/批跑/环境/进程/托盘/慢操作 |
| 测试 C | 29 文件 / **8,360** | v016/v017/v019 契约、wp7/wp8、security、ipc |
| 测试 D | 42 文件 / **6,760** | db、workflow×9、model×3、registry×3、monitor×3、pip×4、e2e、fixtures |
| 文档/发布 | README + 9 PLAN + 配置/脚本/CI | 版本脉络、README 承诺、构建链 |

> 说明：测试切片存在少量重叠（helpers、v019、childEnv 等被两个切片读到），src 无遗漏；`handlers.ts`、`index.ts` 等长文件均分块读到 EOF。

### 0.2 实机取证（本机，只读，2026-10-24）

| 证据 | 数值 / 结论 |
|---|---|
| `logs/slow-ops.log` | `instance.launch` **43–63 s**（每次启动）；`instance.updateComfy` **13.5–31.4 s**；`node.checkUpdates` **8.4–15.8 s**；`node.updateAll` **25.9 s**；`output.scan` **9.2 s**；`output.list` **2.6 s**；`monitor.system` **2.6–3.4 s**；`node.list` **1.3–1.5 s**；`instance.stop` **3.0–3.2 s** |
| 实例日志 | `Process 17464 did not exit within the grace window — it may still be running`：Windows 优雅停止每次都等满 3 s 宽限再强杀 |
| `data/models.jsonc` | **135 条 / 310,865 B**；模型目录 **705 GB / 182 文件** |
| `data/output_assets.jsonc` | **1,890 条 / 735,843 B**；output 目录 **2,355 文件 / 13 GB**（1,553 png / 450 pkl / 350 mp4） |
| `data/node_packs.jsonc` | **26 条 / 32,996 B**；`workflows.jsonc` 30 条 |
| `logs/boot.log` | Electron **32.2.8**（已 EOL；当前上游 **45.0.0**，要求 Node ≥ 22.12）；无崩溃记录 |
| 实例日志级别 | 493 行：DEBUG 330 / INFO 100 / WARNING 7（DEBUG 仍占 67%） |

这些数字决定了本轮的优先级：**性能问题不再是“写放大”，而是“同步长任务 + 重复重采样 + 每次全量重建”**。

### 0.3 本人复核方式

对 20 余条高影响结论逐一回读源码，确认了 3 条 P0、降级了 2 条代理结论、补记了 2 条代理未提的现场证据：

- **确认 P0**：备份恢复路径穿越；模型续传不校验 `Content-Range`；远程上下文下破坏性操作落到本地默认实例。
- **降级**：`killAllNow` 不杀进程树——影响是孤儿占用而非数据丢失，定 P1；`settings.set` 枚举缺失——需渲染层被攻破，定 P1（防御纵深）。
- **补记**：`slow-ops.log` 证明“长任务被当成冻结”每天发生；实例日志证明 Windows 停止固定等 3 s。

### 0.4 工程约束

- **Change Necessity**：本轮以行为缺陷、体验断点、性能悬崖为主，均有可复现证据；增强项只做“用户已在手动绕过”的能力（工作流缺件预检、下载队列、备份预览），不引入新平台。
- **兼容边界**：JSONC 只增字段；IPC 只增可选参数与新通道；`TargetRef` 为新增类型，旧通道保留兼容签名；Electron 升级单独里程碑，可独立回退。
- **TDD Route**：`off → skipped`（Aegis TDD=off）。沿用项目惯例：**每个修复必须带行为测试**（不要求先写失败测试）；新增契约测试仅限运行时集合校验，不再新增源码文本断言。
- **验证命令**：`npx vitest run`、`npx vitest run --coverage`、`npm run typecheck`、`npm run typecheck:test`、`npm run lint:check`、`node scripts/check-i18n.cjs`、`node scripts/check-hardcoded-zh.cjs`、`npm run build`、`npm run test:e2e`；Windows 真机按 §5 清单。
- **不碰**：工作流编辑器、远端环境接管、暗色主题（README 明确不做）、ComfyUI 源码静态链接。

### 0.5 0.1.17 承诺对账（先把上一版的账结清）

| 0.1.17 计划中的承诺（`docs/PLAN-0.1.17.md` §6） | 实际落地 | 状态 |
|---|---|---|
| 10 个 WP 全做 | 10 WP + 3 轮 review 修复（80 文件） | ✅ |
| 自动重启默认关闭 + 崩溃后一键重启 | 崩溃分类/手动重启有；全仓无 `autoRestart` | ⚠️ 部分：无一键自动重启设置 |
| 删除保护：**拒绝删除并提示归档路径** | 实际自动归档 `.cp-old-<ts>` | ⚠️ 偏离：更省事，但用户可能找不到旧目录 |
| 覆盖率改 `all: true` | `include` 54/102 文件，未开 `all` | ❌ 未执行（历史遗留） |
| 单实例锁 + `--allow-multiple-instances` | `index.ts:375-388` | ✅ |
| Electron 32（EOL）单独立项 0.1.18 | 未升级 | ⏳ 本轮 WP0 |
| release workflow + “未签名”标注 | `.github/workflows/` 只有 `ci.yml` | ❌ 未执行 |
| v0.41 发布后真机对齐验收 | 探测式接入已有；无对齐记录 | ⚠️ 未验证 |

> 这张表是 0.1.18 的输入：**未执行的 3 项（all、release、Electron）分别落到 WP0/WP8**；偏离项在 WP3 说明。

---

## 1. 六个判断（全量阅读后的结论）

1. **状态机兑现了 0.1.17 的承诺，但“目标语义”仍会漂移。** 安装/更新/批跑都有终态与对账；但本地/远程/默认实例三套目标策略并存，破坏性操作在远程界面下会落到本地默认实例（§3 P0-3）。
2. **性能瓶颈换了形态。** 写放大已被 0.1.17 收口；现在最贵的是**同步长任务**（启动 43–63 s、更新 13–31 s）、**重复重采样**（`monitor.system` 3 s/次，2 s 一跳）、**每次全量重建**（`node.list` 1.4 s、`output.list` 2.6 s 因内联缩略图）。
3. **恢复链有三处断点。** 更新健康检查失败后备份还在但 `journal` 被清 → UI 回滚入口消失；安装取消后 `installing` 不复位 → Cancel 常驻、Reset 不出现；退出时 `killAllNow` 只杀直接子进程并清 PID 账本 → 孤儿占显存。
4. **渲染层缺三样基础设施。** 统一反馈原语（错误详情/复制/重试）、列表三态（加载/空/失败）、组件测试。导致同一类缺陷在 15 个视图重复出现：竞态无 seq、错误当空态、危险确认没有“取消”。
5. **门禁数字虚高。** 覆盖率 include 只占 src 31%；v017 家族 1,363 条用例中 **909 条源码文本断言 + 194 条恒真**（81%）；e2e 只验证“窗口挂载”。
6. **平台底座过期。** Electron 32 已 EOL（上游 45.0.0），继续拖延会把 Chromium 安全补丁、Node 22 生态与 electron-builder 新版修复一起拖住。

---

## 2. 全功能审计（按用户可见域）

| 域 | 现状 | 主要问题（证据） | 0.1.18 动作 |
|---|---|---|---|
| **安装/首启** | 10 步状态机、运行时自举、镜像测速、推荐模型 | 取消后 UI 死锁（`InstallView.vue:534-540,1076-1089`）；预检/手动并发无 seq（`:400-432`）；失败直出英文（`:778-780`）；首下无官方校验（`bootstrap.ts:474-495`） | WP1/WP3/WP6：取消终态、预检单飞、错误本地化、校验 fail-closed、步骤时间线 |
| **实例** | 启动/停止/重启/强杀、参数面板、就绪探测、崩溃分类 | 启动 43–63 s 无阶段进度；停止固定 3 s 宽限；就绪超时进程仍活（`instance.ts:1285-1301`）；adopt 不校验归属（`:1354-1371`） | WP3/WP5：阶段时间线、快速停止、超时清理、adopt 确认 |
| **更新** | 备份-拉取-依赖-验证-回滚、journal | 健康检查失败保留备份但清 journal（`updater.ts:1124-1155`）→ 回滚入口消失；zip 只增不删（`:1358-1367`）；同步复制冻结（`:1279-1302`） | WP3/WP5：journal 保留、干净重装、异步复制+进度 |
| **模型库** | 705 GB/135 条、扫描/去重/下载/移动/批量 | 扫描只增不删（`model.ts:484-565`）→ 幽灵行；续传不校验区间（`:1035-1087`）；`pathRoot` 前缀误归属（`:558`）；扫描同步阻塞（`:484-564`） | WP1/WP4：区间校验、索引 prune、异步扫描、边界修正 |
| **节点包** | 26 包、Registry/Git/Manager、检查/批量更新、回滚 | `list()` 1.4 s（每包 git/meta，`nodePack.ts:876-993`）；`checkUpdates` 8–16 s 且触发全量索引（`:2169-2212`）；崩溃留 `.bak` 隐身（`:2859`）；快照只记元数据 | WP4/WP3：元数据缓存、索引进度/取消、`.bak` 巡检、恢复中心 |
| **市场** | Registry 精选 + Manager 双源 | `category` 参数未用（`handlers.ts:1885-1893`）；无排序；Manager 每次切 tab 全量重拉（`MarketView.vue:381-403`）；请求无 seq | WP6/WP7：排序/分类/缓存、seq、安装队列 |
| **工作流** | 真库、PNG 抽 JSON、队列、对比、ZIP | 每次收藏/改名全库 walk（`workflow.ts:444-489`）；默认实例三套策略（`:558-567`）；队列无缺件预检；远程入口缺失（`WorkflowsView.vue:781`） | WP2/WP7：目标统一、缺件预检、远程队列 |
| **批跑** | 多工作流×矩阵、真实出图、续跑/重试 | `batch.wait` 阻塞 spinner 整批（`BatchView.vue:237-239`）；单槽 `startingId`（`:345`）；按 active 实例而非 job 实例门控（`:60-72`）；每 prompt 全量读 job 列表（`p1p2.ts:543`） | WP4/WP6：内存 job、按 job 目标、非阻塞 UI、并发守卫 |
| **产物** | 1,890 条/13 GB、全类型、批处理 | `output.list` 内联生成缩略图 2.6 s（`handlers.ts:1691-1712`）；无 `loading=lazy`（`OutputView.vue:833-848`）；单击/双击冲突（`:830-832`）；错误当空态 | WP4/WP6/WP7：异步缩略图、懒加载、灯箱缩放、三态 |
| **监控** | CPU/内存/GPU/队列/WS/预览 | `systemSnapshot` 2.6–3.4 s/次，2 s 一跳且可重叠（`monitor.ts:207-257`、`index.ts:203-214`）；远程时 CPU/GPU 仍显示本机（`MonitorView.vue:439-472`）；无历史 | WP4/WP7：单飞+分级缓存、历史曲线、阈值告警 |
| **诊断** | 12 类检查、5 个 fix、进度 | 报告可能来自旧实例（`DoctorView.vue:27,112-115`）；无取消/总超时；远程仍体检本地；`unpin-torch` 破坏性改写 requirements（`doctor.ts:499-503`） | WP2/WP5/WP6：实例绑定、取消、fix 预览、远程提示 |
| **备份** | 快照/原子恢复/脱敏 | 恢复路径未做包含校验（`backup.ts:92-101`）→ 任意写；无恢复前差异预览；失败只返回 boolean（`:314`） | WP1/WP7：路径收敛、差异预览、选择性恢复 |
| **远程** | 注册/测速/只读监控/远程批跑 | 远程界面下节点/模型/工作流/诊断静默落到本地（§3 P0-3）；认证代理不可用（`proxy.ts:137`）；远程编辑缺失 | WP2/WP1：目标模型、远程鉴权、编辑 |
| **设置/壳层** | 分组设置、快捷键、托盘、通知 | 无校验、无未保存守卫（`SettingsView.vue:464+`）；Naive locale 未接（`App.vue:455`）；仅 3 个快捷键；无通知中心/命令面板；bootstrap 错误无页面级呈现 | WP6：校验、locale、命令面板、通知中心、错误横幅 |
| **发布** | NSIS、GitHub publish、自动更新 | 无签名、无 release workflow；preload/renderer 打包多份（`electron-builder.yml:19-32`）；`out/tsc-*/**.tsbuildinfo` 被打进 asar；无 `setAppUserModelId`；Electron 32 EOL | WP0/WP8：Electron 45、精简打包、签名决策、release 流水线 |

### 2.1 README 与实现漂移（发布前必须订正）

| README | 声明 | 实际 | 处理 |
|---|---|---|---|
| L45 | “远程实例**只读**监控”与同句“运行操作本地与远程统一”自相矛盾 | 0.1.15 已支持远程清队列/中断/释放显存；0.1.11 已有远程批跑 | 改为“远程：只读监控 + 运行操作 + 批跑；节点/模型安装仅本地” |
| L253 | 媒体协议“仅放行**图片**扩展名” | `isMediaServable` 含图片/视频/音频（`mediaTypes.ts:97-99`） | 改为“图片/视频/音频” |
| L300/314 | “**行为测试为主**”；覆盖率门禁 | v017 家族 909 条源码文本 + 194 条恒真；include 54/102（按行 31%） | 改为“含契约测试；行为占比见 §5”；披露覆盖率分母 |
| L112/272 | 支持 macOS / Linux 安装包 | `release/` 只有 win-x64；无 mac/linux 产物，mac 段无 notarize/identity | 0.1.18 明确“仅 Windows 发布；mac/linux 构建未验证” |
| L427 | 自动更新通道已配置 | 只有 `ci.yml`，无 tag 触发的 release workflow | WP0 落地 release.yml |
| L314 | 89.59% 覆盖率 | 仅代表 54/102 文件（17,129 / 54,864 行） | 在 README 标注“include 口径” |

> README 中 **为真** 的承诺（复核过）：运行时 SHA256、删除保护 + realpath、单实例锁、0.1.17 诚实回执、测试数 2,670 / 120 文件、版本号三处一致。

---

## 3. 缺陷清单

> 级别：**P0** = 安全/数据损坏/不可逆错误目标；**P1** = 功能失真/恢复断点/性能悬崖；**P2** = 体验、一致性、可维护性。
> 复核：✅ = 本人回读源码确认；○ = 独立评审全文通读结论（实施前二次确认）。

### 3.1 P0（3 条，发布前必修）

| # | 现象 | 证据 | 复核 | WP |
|---|---|---|---|---|
| P0-1 | **备份恢复可写任意路径**：恢复时先以备份内 `workflows.json` 覆盖列表，再按 `wf.path` 直接 `copyFileSync + rename`，无根校验。导入他人备份即可向启动目录/任意位置落任意内容 | `backup.ts:240-312`（列表替换）、`:92-101`（dest = wf.path） | ✅ | WP1 |
| P0-2 | **模型续传可静默产出损坏文件**：只按本地 size 发 `Range`，收到 206 即 append，不校验 `Content-Range` 起点、不发 `If-Range`；完成判据只有长度，无 SHA 时降级为 `verified:'length'`。源文件变化/代理分片/两任务同 dest 都会中招 | `model.ts:1035-1087`、`:1147`、`:891-892` | ✅ | WP1 |
| P0-3 | **远程上下文的目标漂移**：远程激活时 `activeInstance` 为 null 但视图仍把 `activeInstanceId`（或 undefined）传给主进程；`safeInstanceId(undefined)` 回落到默认本地实例。远程界面点“全部更新/删除/体检”会静默改本机 | `handlers.ts:150-170,1034-1037`；`nodePack.ts:876` 默认实例；`Instances/Models/Nodes/Workflows/Doctor` 视图均未判远程 | ✅ | WP2 |

### 3.2 P1（按域，43 条）

#### 安全 / 契约 / 持久化

| # | 现象 | 证据 | 复核 |
|---|---|---|---|
| S1 | `settings.set` 只校验 5 个 URL；`securityLevel`/`networkMode`/`modelScanRoots` 原样落库；未知 `securityLevel`（如 `off`）可解除 git 安装门，任意根可变成 `allowedReadRoots` | `handlers.ts:232-238`、`nodePack.ts:1136-1148` | ○ |
| S2 | 认证代理不可用：Electron 会话代理不带凭据，全仓无 `app.on('login')`；`proxyFetch` 承载的 Registry/Doctor/appUpdate 遇 407 全失败并报“网络不可达” | `proxy.ts:137,184`；grep `on('login')` 0 命中 | ✅ |
| S3 | 运行时首次下载在“无官方校验和且无 pin”时**完全不校验**，随后把实际哈希钉住（一次坏下载被永久信任） | `bootstrap.ts:474-495` | ✅ |
| S4 | 写盘无 `fsync` 即 rename；tmp 名固定，多实例互撞；Windows 占用时 rename EPERM 直接抛，设置保存失败无重试 | `db.ts:274-279` | ○ |
| S5 | 写盘双所有权：`replaceJsoncList` 与 `listNodePacks` 自愈直接写，绕过 pending 去抖队列；恢复/自愈后可能被旧快照 flush 覆盖 | `backup.ts:44-49`、`db.ts:595-608,415-420` | ✅ |
| S6 | 解密失败只做“保留密文”，无“重新录入/解锁”入口；用户只能删文件 | `db.ts:453,874`；`secretStorage.ts:48-57` | ○ |
| S7 | `settings.set` 端点校验只覆盖 5 键；备份恢复的列表路径（instances/models）未做根校验 | `backup.ts:240-300` | ✅ |
| S8 | 危险操作确认框没有“取消”按钮：模型/产物删除只有“连文件删/只删记录”，取消只能点遮罩/ESC | `ModelsView.vue:277-286,372-387`；`OutputView.vue:513-537` | ○ |

#### 生命周期 / 恢复

| # | 现象 | 证据 | 复核 |
|---|---|---|---|
| L1 | 退出/强杀只 `child.kill()` 并立刻 `forgetPid`，Windows 孙进程与账本一起丢，下次启动无法巡检孤儿（显存/端口被占） | `instance.ts:2015-2031`；`index.ts:797` | ✅ |
| L2 | 更新健康检查失败后保留备份，却无条件 `clearJournal`；UI 回滚入口以 journal 为门 → 备份在、入口没了 | `updater.ts:1124-1155`；`InstanceDetailView.vue:598` | ✅ |
| L3 | 安装取消后 UI 死锁：`installing` 只在 done/error 复位，`cancelled` 不复位 → Cancel 常驻、Reset 永不出现 | `InstallView.vue:534-540,1076-1089` | ✅ |
| L4 | 就绪超时只把状态置 `error`，进程仍活；再次启动可能双进程/端口冲突 | `instance.ts:1285-1301` | ✅ |
| L5 | adopt 不校验归属：端口上任何回 `/system_stats` 的 ComfyUI 都被当作本实例 running/ready，批跑/产物可能打到另一实例 | `instance.ts:1354-1371` | ✅ |
| L6 | zip 更新只覆盖不删除：上游删除/改名的 core 文件永久残留，无“干净重装”出口 | `updater.ts:1358-1367,1444-1481` | ✅ |
| L7 | `repairEnv` 无 AbortSignal，30 分钟 pip 步骤不可取消 | `env.ts:576-797`；`handlers.ts:651-668` | ○ |
| L8 | `runStreaming` abort 立即 reject 而不等 `killProcessTree`，同一 venv 可被下一个操作并发写入 | `env.ts:118-127` | ○ |
| L9 | 节点包更新崩溃在“改名 .bak → 重装”窗口时，`.bak` 被当作垃圾过滤，包从 UI 消失且无恢复入口 | `nodePack.ts:2859,261-273,953-993` | ○ |
| L10 | Windows 停止固定 3 s 宽限：`taskkill /T`（不带 `/F`）对控制台 Python 基本无效，日志每次都记 “did not exit within the grace window” | `instance.ts:1761-1805`；实机日志 | ✅ |
| L11 | 模型索引只增不删：外部删除/移动的文件永久留成幽灵行，污染存储统计与对账 | `model.ts:484-565`；`db.ts:549-559` | ✅ |

#### 性能 / 资源

| # | 现象 | 证据 | 复核 |
|---|---|---|---|
| F1 | 监控采样 2.6–3.4 s/次，2 s 一跳且可重叠；窗口隐藏才降到 10 s；`monitor.system` IPC 也走同一条慢路径 | `monitor.ts:207-257`；`index.ts:203-214`；实机 slow-ops | ✅ |
| F2 | `output.list` 在 IPC 内为最多 60 个资产生成缩略图（8 路），首屏 2.6 s；UI 无懒加载 | `handlers.ts:1691-1712`；实机 | ✅ |
| F3 | `node.list` 每次对每个包 `readPackMeta` + `hasGitRepo` + `readGitOriginUrl`（26 包 1.4 s），并被 check/update/toggle/snapshot 反复调用 | `nodePack.ts:876-993`；实机 | ✅ |
| F4 | 批跑每个 prompt 前 `batchService.list()` → 全量 `readJsonc` 解析；任务多时 O(N×M) | `p1p2.ts:543,579,630,694,758,852`；`db.ts:719-721` | ○ |
| F5 | 产物列表每次全量排序后切片；资产到 5 万时翻页会 O(n log n) | `p1p2.ts:1089-1129` | ○ |
| F6 | Registry 全量索引（~58 页/6 并发）可由一次搜索或 `checkUpdates` 触发，无进度、无取消 | `registry.ts:189-192`；`registryIndex.ts:157-221` | ✅ |
| F7 | 更新复制/覆盖全同步，数千文件期间进度只在前后各发一次，主线程与 IPC 一起卡 | `updater.ts:1279-1302,1449-1481` | ○ |
| F8 | 模型扫描循环内 `statSync + readSafetensorsMeta`，未开哈希时无 `await` 让出；下载完成还会触发整盘重扫 | `model.ts:484-564,738-740` | ○ |

#### 渲染层 / 进度 / 交互

| # | 现象 | 证据 | 复核 |
|---|---|---|---|
| U1 | 进度模态跨流串台：`ComfyUpdateProgressModal` 直接消费共享 `progress`，不校验 `progressKind`；node-op 可抢占槽位，标题是更新、内容是节点包 | `ComfyUpdateProgressModal.vue:20,53`；`useComfyUpdate.ts:93-106` | ✅ |
| U2 | 确定/不确定判定把**真实 0%** 当不确定；三个模态各自实现；`IndeterminateBar` 用了不存在的 `--primary-color`，回退成 Naive 绿色 | `ComfyUpdateProgressModal.vue:56-58`；`IndeterminateBar.vue:49` | ✅ |
| U3 | 进度文案绕过 i18n：直接显示主进程英文 `detail`，中文界面中英混排；`updateDetailOf` 在该路径未被使用 | 三个模态的 `runningStep?.detail` | ✅ |
| U4 | 实例详情事件风暴：每个 `instanceStatus` 都全量 `refresh()`（8 个 IPC），随后 `getLogs` 整段覆盖 WS 追加的日志 → 丢行、滚动跳 | `InstanceDetailView.vue:924-926,594` | ✅ |
| U5 | Dashboard 卸载竞态：定时器/订阅在 `await` 之后创建，卸载已先执行 → 5 s 轮询与日志订阅永久泄漏 | `DashboardView.vue:206-234` | ✅ |
| U6 | Embed 生命周期竞态：`await embed.open` 后才置 `embedded=true`，期间卸载已 `close` → 关闭后又被打开；open 失败走不到错误卡 | `EmbedView.vue:77-85,136,189` | ○ |
| U7 | 加载失败当空态：Nodes/Models/Output/Workflows/Batch 失败只 toast，页面显示“暂无数据”，无重试入口 | `NodesView.vue:1198` 等 5 处 | ○ |
| U8 | 批跑 UI 阻塞：`start` 后直接 `await batch.wait`，spinner 持续整批；`startingId` 单槽，resume/retry 无重入 | `BatchView.vue:237-239,345` | ○ |
| U9 | 产物卡片单击开详情、双击开灯箱，第一击已弹详情遮罩 → 灯箱几乎不可达 | `OutputView.vue:830-832` | ○ |
| U10 | 设置页无校验、无未保存守卫；`launchOnBoot` 变更即整表保存，把其他未保存编辑一起写盘 | `SettingsView.vue:464+,650-654` | ○ |
| U11 | Naive UI 未接 locale：切 en-US 后 NDialog/NPopconfirm/NDatePicker 等内置文案仍是默认语言 | `App.vue:455` | ✅ |
| U12 | 可访问性稀疏：全仓仅 12 个 `aria-*`；日志区不可聚焦、无 `aria-live`；展开日志是 `<div @click>` 无键盘 | 全仓统计 | ✅ |
| U13 | 复制失败静默；`usePipOps.cancel` 吞异常返回 false，取消按钮点了无反馈 | `NodeOpProgressModal.vue:230-232`；`usePipOps.ts:201-207` | ○ |
| U14 | 市场双源请求无 seq：切 tab 后旧 registry 响应覆盖新列表；Manager 每次搜索都重拉远端 | `MarketView.vue:291,317,350-378` | ○ |
| U15 | 监控页 3 s×2 IPC + 2 HTTP，切历史 tab/最小化/离线仍不降频；下载事件每 500 ms 重拉全量 downloads | `MonitorView.vue:347-350`；`ModelsView.vue:792-794` | ○ |
| U16 | 长任务被当成“主进程冻结”：`instance.launch` 43–63 s、`updateComfy` 13–31 s、`checkUpdates` 8–16 s 每次都记 `FREEZE` 并弹“主进程卡顿” | `handlers.ts:390-404`；实机 slow-ops | ✅ |

### 3.3 P2（择要，约 25 条）

- **启动/托盘**：托盘单实例动作失败完全静默（`tray.ts:118-128`）；菜单硬截断 12 个实例无提示；`createWindow` 重复注册 `before-quit`（`index.ts:265-267` + `:793`）。
- **安装**：`.cp-old-*` 归档永不清理（`installer.ts:268-295`）；`applyGithubMirror` 对 `git@/ssh://` 也拼前缀（`installer.ts:126-141`）；https 镜像也加 `--trusted-host`（`installer.ts:934-945` 等 4 处）。
- **节点**：`updatablePacks` 含 locked 导致确认数量大于实更数（`NodesView.vue:310`）；`updatingOne` 以 name 为键，`.disabled/Foo` 与 `Foo` 同转（`:123-124`）；卸载时把 `.disabled` 外壳当嵌套壳（`nodePack.ts:2126-2151`）；`._install_*.zip` 无清扫。
- **模型**：`pathRoot` 用 `startsWith`（`D:/models/lora` 吞 `lora-old`）；`model.remove` 缺 move/download 的 allowlist；批量重命名作用于 `filtered` 而删除作用于选中集，作用域不一致（`ModelsView.vue:703`）。
- **工作流**：同目录同名 json/png 互删（`workflow.ts:803-812`）；`copyToInstancePath` 按内容哈希累积多份；每次收藏/改名全库 walk。
- **产物**：全选只选当页却易读作全部；无文件名搜索；扫描异常被吞（`OutputView.vue:213-215`）。
- **监控**：远程激活时 CPU/GPU/磁盘卡仍显示本机（`MonitorView.vue:439-472`）；失败无重试。
- **设置**：不能编辑已存远程实例（只能增删）；删后 id 变化导致旧作业失联；无导入/导出配置。
- **诊断**：进度条恒 100% processing（`DoctorView.vue:157`）；fix 无逐项 loading；`unpin-torch` 无备份改写 requirements。
- **i18n**：7 个死键；语义漂移（更新弹窗复用 `nodes.*`、NodeOp 显示 `instance.preserveNote`）；`formatDate` 跟随 OS locale；`versionMismatch` 纯字符串比较（`1.2` vs `1.2.0`）。
- **契约**：`instance.save` 声明 `ComfyInstanceConfig` 却传 Info 展开；`model.list` 无实例参数但 Dashboard 按实例刷新；`installer.start` 的 runId 被前端丢弃；`DownloadTask` 允许 `done + verified:'failed'`。

---

## 4. 迭代主线与 WP 设计

> 排序原则：**先保平台与数据（不把人送进坑）→ 再收目标与恢复（不让人救不回来）→ 再砍性能与噪声（不让人等）→ 最后做体验与增强（让人愿意每天用）**。
> 每个 WP 的验收 = 行为测试（新增）+ 可复现的实机动作；不接受“只改代码不验行为”。

### WP0 平台底座：Electron 32 → 45，发布工程收口（P0 风险，M0 单独验证）

**目标**：跑在受支持的 Electron 上；安装包更小、可发布、可回滚；升级失败可独立回退，不拖累其余 WP。

**设计要点**
1. **两步走，不一步到位**：先升级工具链（`electron-vite` 2.3→6、Vite 5→8、`vitest` 2→5、TS 5.9→7、CI Node 20→24），保持 Electron 32 与 2,670 用例全绿；再升 Electron 32→40→45，每步单独回归。跨 13 个大版本一起换是事故配方。
2. 兼容回归清单：`session.fetch`（代理）、`protocol.handle`（`comfy-pilot-media:`）、`WebContentsView`（内嵌前端）、`safeStorage`（旧密钥可解）、`Tray`、`app.requestSingleInstanceLock`、preload 三段回退链（`index.ts:241-245`）、NSIS 安装/卸载。
3. **Windows 身份**：补 `app.setAppUserModelId('com.comfy-pilot.app')`（当前 0 处），否则升级后 Toast/任务栏身份漂移；`electron-builder.yml` 补 `publisherName`。
4. **打包去冗余**：`electron-builder.yml:19-32` 把 preload 复制 3 份、renderer 2 份；改为 asar 内单份 + 必要 unpack；`files` 排除 `!out/tsc-*/**`、`!**/*.tsbuildinfo`（当前 620 KB 开发绝对路径进包）；目标安装包下降 ≥ 3 MB。
5. **发布流水线**：新增 `.github/workflows/release.yml`：tag `v*` 触发 → 三平台构建（Windows 必跑，mac/linux 失败不阻断 Windows）→ `latest.yml` + `.blockmap` + SHA256 → GitHub Release（先 draft，人工确认后发布）；本地 `--publish never`。
6. **版本一致性脚本**：`scripts/check-version.cjs` 校验 `package.json` = `package-lock.json`（两处）= `constants.ts` = README = `latest.yml`，并入 CI（版本漂移已复发三次）。
7. **签名**：先做“未签名 + SmartScreen 说明 + 校验和”闭环；证书到位再开签名（决策见 §7）。连续 3 次真实安装/卸载零 Application Error 才允许发版。

**验收**：Windows 真机 0.1.17 → 0.1.18 自动更新成功；safeStorage 旧值可解；内嵌前端/媒体协议/托盘/单实例/AUMID 全通过；`npm run test:e2e` 在 Windows 与 Linux（xvfb）都真跑；安装包 ≤ 当前体积且不含 `.tsbuildinfo`。

**风险**：Electron 45 的 Chromium/Node 行为差异；`electron-updater` 与 NSIS 兼容；工具链升级本身可能改测试行为。M0 结束若阻塞，立即回退到 0.1.18 其余 WP，Electron 单开 0.1.19。

---

### WP1 安全与数据完整性（P0-1、P0-2 + 持久化）

**目标**：不可信备份不能写任意路径；续传不能产出“长度对但内容错”的文件；掉电/占用不丢已确认的写入。

**设计要点**
1. **备份恢复收敛**（`backup.ts`）：恢复前对 `workflows[].path`、`instances[].path`、模型清单路径逐条做 `resolveInsideAnyRoot`（允许根 = 实例 workflow 目录/库根/实例目录）；不合法即中止整次恢复并列出条目；`restoreWorkflowFiles` 只写 `join(根, basename)`。
2. **恢复预检 + 差异预览**：先解析并校验全部输入，返回 `{settingsDiff, listCounts, filesMissing, invalidPaths}`；UI 二次确认后才应用（也为 WP7 的“选择性恢复”留接口）。
3. **续传完整性**（`model.ts`）：收到 206 必须校验 `Content-Range: bytes <start>-` 与本地 size 一致；发送 `If-Range`（ETag/Last-Modified）；不一致则删残片重下；任务身份加入 `size + mtime + etag`，同 `destPath` 只允许一个活动任务；416 走现有 verify，失败清空重下。
4. **写盘持久性**（`db.ts`）：`writeFileSync(tmp)` 后 `fsyncSync`（文件与目录按平台）；tmp 名加 `pid + random`；Windows `EPERM/EBUSY` 做 3 次退避重试并上报；flush 失败保留队列（已有）。
5. **单一写入者**：`backup.replaceJsoncList` 改走 db 的 `replaceList`（先 `flushPendingWrites`，再写，再失效缓存）；`listNodePacks` 自愈改 `scheduleFileWrite` 或删除自愈写入（改由显式迁移）。
6. **契约校验**：`settings.set` 对 `securityLevel`/`networkMode`/`locale`/`theme`/`outputIndexDepth` 做枚举/范围校验；`modelScanRoots` 只接受存在的目录且必须来自 picker 或已授权根；`securityLevel` 变更写审计日志。
7. **运行时校验 fail-closed**（`bootstrap.ts`）：无官方 checksum 且无 pin 时，要求用户显式确认（展示来源 URL + 大小）或拒绝；pin 只来自“校验过”的下载；`Content-Range` 起点同样校验。
8. **凭据 UX**：`apiKeyLocked`/`proxyPasswordUnreadable` 在设置页显示“需要重新录入”，提供清空/重填；不静默覆盖。

**验收**：构造恶意备份（`path` 指向启动目录）→ 恢复中止且不落盘；改源文件后 resume → 拒绝并重下；kill -9 后 jsonc 可解析；`settings.set` 非法枚举被拒；以上均有行为测试。

---

### WP2 目标一致性：本地 / 远程 / 默认实例（P0-3）

**目标**：每个破坏性动作都有显式目标；远程界面下不可能静默改本机；默认实例只在一个地方定义。

**设计要点**
1. **`TargetRef` 单一模型**：`{ kind: 'local' | 'remote' | 'none'; id?: string }`；store 暴露 `activeTarget`，视图只读它，不再各自拼 `activeInstanceId`。
2. **默认实例策略收敛**：新增 `resolveTarget(ref)`（`db`/`instance` 层唯一实现）；删除 `instances[0]`、`activeInstance || instances[0]` 等三套兜底；工作流导入、队列、打开前端使用同一目标。
3. **IPC 显式目标**：破坏性通道（node.*、model.*、workflow.import/queue、doctor.run/fix、batch.*）要求显式 `instanceId`/`remote:`；`undefined` 不再代表“默认实例”，而是 `TARGET_REQUIRED`；本地专属通道对 `remote:` 返回 `REMOTE_NOT_SUPPORTED`（已有），对所有本地专属通道统一。
4. **远程模式 UI**：Models/Nodes/Workflows/Doctor/Batch 顶部显示“当前为远程上下文，以下为本地资产/操作”或禁用本地专属按钮；远程支持的能力（批跑、监控、队列）明确标注目标实例。
5. **Doctor 报告绑定**：报告存 `instanceId` + `runSeq`；跨实例只读展示并横幅提示“这是 X 的报告”，fix 必须显式切回该实例。
6. **契约收口**：`instance.save` 改收 `ComfyInstanceConfig`（或新增 `instance.patch`）；`installer.start` 返回并透传 `runId`，前端按 `runId` 过滤进度；进度错误补 `code`/`messageKey`。

**验收**：远程激活时点击“全部更新”→ 明确拒绝/禁用，不产生任何本地写；切换实例后旧响应不落 UI（seq/instance 双校验）；默认实例策略只有一处实现（grep 可证）。

---

### WP3 生命周期与恢复（L1–L11）

**目标**：UI 说“停了”就真没有进程；崩溃/取消后每条恢复链都能走通；Windows 停止不再固定等 3 s。

**设计要点**
1. **退出/强杀统一树杀**（`instance.ts`）：`killAllNow` 改调 `processTree.killProcessTree(pid, { force: true, wait: true })`；确认退出后再 `forgetPid`；退出流程改为“异步 quit”：`before-quit` preventDefault 一次 → 等所有实例树杀（总预算 5 s）→ 再 quit；账本保留到确认退出。
2. **Windows 快速停止**：默认 `taskkill /T /F`（1 s 宽限后），去掉“优雅”假象；提供设置项 `stopMode: 'fast' | 'graceful'`（默认 fast）；日志只在真的失败时警告。
3. **就绪超时清理**：超时置 `error` 前先树杀进程（或置 `stuck` 并保留“强制清理”按钮）；再次启动前清理残留。
4. **adopt 校验**：用 PID 账本/命令行匹配实例路径；无法证明归属时要求用户确认“接管外部 ComfyUI”，否则拒绝并提示端口占用。
5. **更新恢复闭环**：`verifyFailed` 时保留 journal（`status: 'verify-failed'` + `backupPath`），UI 显示“回滚到更新前”；备份保留到用户确认或下次成功更新；zip 更新用归档 manifest 删除“上次归档有、本次没有”的 core 文件（白名单，不碰 PRESERVE_ENTRIES）；复制/覆盖改异步分块并上报 `{done,total}`。
6. **安装取消终态**：`cancelled` 时 `installing=false`、Reset 可见；`reset()` 校验无活子进程（已有）+ epoch 归属；失败/取消后保留已完成步骤，支持“从第 N 步继续”（至少不重下运行时）。
7. **节点包恢复中心**：启动扫描 `custom_nodes/*/.bak-*`、`._unzip_tmp_*`、`.disabled` 异常态；UI 列出“可恢复/可清理”，一键还原或删除；`checkUpdates` 不再把 `.bak` 当垃圾过滤前先登记。
8. **模型索引 prune**：scan 后删除“本根下已不存在”的行（按 `pathRoot` 分组，避免误删其他根）；提供“清理幽灵行”手动入口。

**验收**：启动瞬间停止 → 不复活；退出后任务管理器无孤儿；取消安装 → Reset 可用；更新 verify 失败 → 回滚按钮可用；`.bak` 可从 UI 恢复；模型外部删除后重扫消失。

---

### WP4 性能与资源（F1–F8）

**目标**：首屏与高频操作回到“可感知即时”；后台不再持续吃 CPU/IO；长扫描可取消。

**设计要点**
1. **监控采样单飞 + 分级缓存**（`monitor.ts`/`index.ts`）：同一时刻只允许一个 `systemSnapshot` 在飞；缓存 `cpu/mem 2 s`、`gpu 5 s`、`disk 10 s`；窗口隐藏降频到 10 s（已有）且暂停 GPU 采样；`monitor.system` IPC 直接返回缓存快照（<50 ms）。
2. **产物缩略图异步化**（`handlers.ts`/`media.ts`）：`output.list` 只返回已有 thumb 的 URL，不再生成；缺失时返回 `thumbPending`；新增 `output.thumb`（单张按需）或后台队列 + 事件；UI `<img loading="lazy">` + 占位骨架；首屏目标 <300 ms（13 GB/2,355 文件实测）。
3. **节点列表缓存**（`nodePack.ts`）：以 `custom_nodes` + 每包 mtime 生成签名；签名未变直接返回缓存；`readGitOriginUrl` 结果持久化到 DB；`list()` 冷路径目标 <150 ms（26 包）。
4. **批跑内存化**（`p1p2.ts`）：`batchService` 维护 `Map<id, BatchJob>`；进度更新只改内存 + 400 ms 合并写；`list()` 不再 per-prompt 读盘；`output.list` 的排序结果按查询条件缓存。
5. **模型扫描异步 + prune**（`model.ts`）：每 N 个文件 `await setImmediate` 让出；hash 队列与扫描解耦；下载完成触发的重扫改为“只扫该目录”或去抖合并。
6. **Registry 索引进度/取消**（`registryIndex.ts`）：`ensure()` 接收 `onProgress` 与 `AbortSignal`；搜索前如索引未建，先询问“建立本地索引（约 N 页）”而不是静默爬取；`checkUpdates` 不强制全量索引（用已知 registryId/repo 的增量查询）。
7. **启动与首屏**：测量 `bootstrap → ready-to-show → 首次 list` 三段；视图 lazy import 已具备；避免启动时全量 `workflow.list`/`model.list`。

**验收**：`slow-ops.log` 中 `monitor.system`、`node.list`、`output.list` 不再 >1 s；产物页首屏 <300 ms；批跑 20 条时主进程无 >1 s 卡顿；监控 tick 不重叠（测试计数）。

---

### WP5 长任务体验：不再把“等待”叫“冻结”（U16 + 进度/取消）

**目标**：用户知道“在做什么、还有多久、能不能停”；系统不再把预期长任务报成卡顿。

**设计要点**
1. **慢操作语义分层**：`slowOps` 增加“已知长任务”注册表（`instance.launch`、`instance.updateComfy`、`node.checkUpdates`、`node.updateAll`、`output.scan`、`batch.wait`、`env.repair`、`registry.index`）；这些通道记录到 `long-ops.log`，不触发 FREEZE toast；真正的同步阻塞仍按阈值报警。
2. **统一后台任务中心**：主进程 `OperationRegistry`：`{id, kind, target, titleKey, progress, cancellable, startedAt, logPath}`；IPC `ops.list/ops.cancel/ops.subscribe`；壳层顶部“后台任务”入口 + 通知中心共用。
3. **进度诚实**：0% 是合法确定值；无分母才 indeterminate；`detailKey` 优先、`detail` 仅兜底；阶段名全部 i18n；ETA/速度只在有真实分母时显示。
4. **取消语义统一**：所有长任务接受 `AbortSignal`；取消 → 终止子进程树（await）→ 写终态 → 广播；UI 取消按钮 2 s 内给出“正在停止/已停止/停止失败”。
5. **`repairEnv`/`update` 接线**：`handlers.ts` 传入 signal；`updater.copyCoreTree/overlayTree` 分块并上报；`installer` 的步骤内进度（torch 下载/pip）与 `pipOps` 权重对齐。

**验收**：启动/更新/检查更新期间不再出现“主进程卡顿”提示；每个长任务都有进度与取消；取消后 2 s 内终态可见；`long-ops.log` 可复盘。

---

### WP6 全功能体验打磨（15 个视图 + 壳层）

**目标**：同一类交互只存在一种正确写法；每个列表都有加载/空/失败三态；每个错误都能行动；键盘与读屏可用。

**设计要点**
1. **反馈原语**：`useFeedback()`：`error(err, {code, detail, actions:[retry, openLogs, copy]})`、`confirm({title, body, danger, cancelText})`（永远有取消）、`copy(text)`（成功/失败都有反馈）；替换 179 处裸 `message.error` 中不可行动的路径。
2. **列表三态**：`ListState` 组件（loading skeleton / empty / error+retry）；接入 Nodes/Models/Output/Workflows/Batch/Market/Monitor/Doctor/Backup；空态区分“没有数据”与“筛选无结果”。
3. **危险操作标准化**：确认框必须“取消 + 破坏性”两键、显示数量/范围/不可恢复提示；批量删除显示前 3 项名称；失败清单可复制、失败项保留选中。
4. **命令面板与快捷键**：`Ctrl+K` 全局搜索（视图、实例、模型、节点包、工作流、动作）；`?` 打开快捷键表；`Ctrl+Enter` 启动、`Ctrl+Shift+S` 停止、`Ctrl+R` 重启（仅在安全上下文）；路由切换后焦点回主标题。
5. **通知中心**：持久化最近 200 条站内通知（内存 + 可选文件），按类型筛选、点击跳转、未读徽标；bootstrap 失败显示页面级横幅（重试/打开日志），不再只有 toast。
6. **可访问性**：卡片 `role=button` 内嵌按钮改为兄弟结构或停止冒泡；图标按钮补 `aria-label`；日志区 `tabindex=0` + `aria-live=polite`；模态焦点陷阱；`prefers-reduced-motion` 下进度条仍有静态可见状态。
7. **i18n/格式化**：`NConfigProvider :locale`（zhCN/enUS）；`formatDate` 接 locale；`versionMismatch` 用 semver 比较；清理 7 个死键；`check-i18n` 增加占位符一致性与“裸 `{x}`”检测。
8. **逐视图收口**：
   - Dashboard：骨架屏、bootstrap 错误重试、远程不再弹 needRunningInstance、三步向导与“无模型”提示合并。
   - InstanceDetail：状态事件去抖（仅 status 变化时刷新）、日志增量拉取（tail/游标）不与 WS 覆盖、加载失败/不存在/已删除三态。
   - Install：取消终态、预检单飞、失败英文改 key、步骤时间线。
   - Embed：打开前置 `embedded=true` 再 await（或 epoch 校验）、失败错误卡、无 query 时默认当前目标。
   - Models/Nodes/Workflows/Batch：seq 防竞态、远程横幅、目标按 job/实例、批量进度。
   - Market：请求 seq、切 tab 取消旧请求、排序/分类。
   - Output：单击/双击分离（单击选中、双击灯箱）、懒加载、文件名搜索。
   - Monitor：远程时隐藏本机 CPU/GPU 卡或标注“本机”、tab 隐藏暂停轮询、失败重试。
   - Settings：表单 rules、未保存离开确认、远程实例编辑、导入/导出。
   - Backup：includes/notes 展示、创建/恢复 loading 防重、恢复前预览（WP7）。

**验收**：关键组件 DOM 测试（WP8）；手工清单 15 项；键盘走通主要流程；中英切换无中英混排；错误卡都能“重试/看日志/复制”。

---

### WP7 功能增强（6 项，按价值排序；时间紧可取前 5）

1. **工作流缺件预检**（最高价值）：解析工作流所需的模型文件名与节点类型，对照本地模型索引 + `object_info` 缓存；提交/入库前给出“缺 2 个模型、1 个节点包”，一键跳转下载/安装；缺失不阻断但必须显式确认。
2. **模型下载队列管理器**：暂停/继续/取消全部、失败重试、优先级、实时速度与 ETA、完成后自动校验；与 WP1 的完整性校验共用。
3. **产物灯箱增强**：缩放/拖拽、键盘翻页、元数据面板、复制参数；视频/音频沿用现有降级。
4. **备份差异预览 + 选择性恢复**：恢复前展示设置/实例/模型/工作流差异；可只恢复某一类（默认全量）。
5. **监控历史与阈值**：内存环形缓冲（如 10 分钟）绘制 CPU/内存/显存曲线；阈值（显存 >90%）站内提醒；远程只读。
6. **设置导入/导出**：导出不含密钥的配置 JSON；导入前预览差异；支持“恢复默认分组”。

**验收**：每项至少 1 条行为测试 + 1 个实机动作；增强不改变既有默认行为。

---

### WP8 测试与门禁治理（让“全绿”重新可信）

**目标**：删除不执行产品的“验收”，补上真正高风险的空白；覆盖率分母变真；CI 能发现平台差异。

**设计要点**
1. **清理文本/恒真测试**：v017 家族 1,363 条中 909 条源码文本 + 194 条恒真；保留 `ipcRegistration`（运行时双向集合）、`ipcContract`、`security`、`wp7`、`wp8SecretsAtRest`、`scopedSelection` 等真行为；其余压成 3–5 条架构 smoke 或删除。目标：用例数下降但**行为占比 ≥60%**。
2. **补高风险空白**：`model.ts` 进覆盖率；`handlers.ts` 的信任判定抽成 `ipc/trust.ts` 纯函数并表驱动测试；Windows `taskkill /T`→`/F` 分支（`platform=win32`）；更新管线至少 1 条真盘集成（mkdtemp + git init）；并发拒绝（双 start、install+update、stopAll）。
3. **渲染层测试基建**：引入 `@vue/test-utils` + `happy-dom`；先测 3 个进度模态、`useScopedSelection` 接线、Settings 校验、Output 单击/双击；不追求全视图覆盖。
4. **e2e 升级**：preload 契约快照、一次真实 IPC（`app.getVersion`）、renderer `console.error`/`unhandledrejection` 置红、启动→停止生命周期；Linux 用 `xvfb-run` 删 `SKIP_E2E`。
5. **覆盖率棘轮**：脚本读 `lcov.info` 对比基线，任一 include 文件跌 >1pp 即红；floor 自动按“实测 −2pp”重写，禁止手改数字；逐步把 `index.ts`/`model.ts`/`env.ts` 纳入。
6. **CI/发布**：Node 24；Windows + Linux 真跑 e2e（`xvfb-run`）；`npm run build` 后对 `out/` 做产物存在性冒烟；release workflow（WP0）；加 `timeout`/`concurrency`/最小 `permissions`。
7. **门禁脚本加固**：`check-hardcoded-zh` 扩到 renderer 全部 `.ts` 与全角标点（当前只扫 `.vue` + `constants.ts`）；`check-i18n` 去掉 `new Function` 直接 eval 本地 TS（加 `as const` 即崩）；`check-version` 并入 CI；覆盖率 `all:true` 的取舍在 README 明示。
8. **测试卫生**：`bootstrapSources.test.ts` 向 `tmpdir()` 真写且不清理；`p1p2`/`bootstrapDownload` 的真 sleep 改 fake timer；`gpuMemory` 与 `monitorGpu` 重复的 `mergeGpuMemory` 合并为表驱动；平台条件测试改 `it.skipIf` 让 CI 显式显示 skipped。

**验收**：行为用例占比 ≥60%；`model.ts`/`handlers` 信任函数有覆盖；Windows 分支不再“零执行”；e2e 能捕获 preload/IPC 回归；覆盖率不再靠白名单；CI 上 skipped 与 passed 可区分。

### 4.9 任务分解与文件映射（执行用）

| WP | 任务 | 主要文件 | 验证 |
|---|---|---|---|
| WP0 | 工具链两步升级 | `package.json`、`electron.vite.config.ts`、`vitest.config.ts`、`.github/workflows/ci.yml` | 保持 2,670 用例绿后再动 Electron |
| WP0 | Electron 45 + AUMID + 打包精简 | `src/main/index.ts`、`electron-builder.yml`、`scripts/postbuild.cjs` | e2e + Windows 真机安装 |
| WP0 | release.yml + check-version | `.github/workflows/release.yml`、`scripts/check-version.cjs` | 本地干跑 + tag 预演 |
| WP1 | 备份恢复收敛与预览 | `backup.ts`、`handlers.ts`、`BackupView.vue` | 恶意备份用例 + 预览 UI |
| WP1 | 续传完整性 | `model.ts`、`types.ts` | 206 区间不符/源变更用例 |
| WP1 | 持久化与契约校验 | `db.ts`、`security.ts`、`handlers.ts`、`secretStorage.ts` | kill -9 后解析、非法枚举拒绝 |
| WP2 | `TargetRef` 与 store | `types.ts`、`stores/app.ts`、`i18n/*` | typecheck + 目标单测 |
| WP2 | IPC 显式目标 + 远程 UI | `handlers.ts`、`nodePack/model/workflow/doctor`、5 视图 | 远程模式破坏性操作被拒 |
| WP2 | 默认实例策略收敛 | `workflow.ts`、`handlers.ts`、`instance.ts` | 单点实现 grep + 行为测试 |
| WP3 | 退出/停止/超时/adopt | `instance.ts`、`index.ts`、`processTree.ts` | Windows 停止 <2 s、无孤儿 |
| WP3 | 更新 journal/回滚/zip/异步复制 | `updater.ts`、`InstanceDetailView.vue` | verify 失败可回滚、复制有进度 |
| WP3 | 安装取消 + `.bak` 巡检 + 模型 prune | `installer.ts`、`InstallView.vue`、`nodePack.ts`、`model.ts` | 取消后 Reset、恢复/清理入口 |
| WP4 | 监控采样单飞/分级缓存 | `monitor.ts`、`index.ts` | `monitor.system` <50 ms |
| WP4 | 缩略图异步 + 懒加载 | `handlers.ts`、`media.ts`、`OutputView.vue` | 首屏 <300 ms |
| WP4 | 节点缓存 + 批跑内存 + 扫描异步 | `nodePack.ts`、`p1p2.ts`、`model.ts`、`db.ts` | `node.list` <150 ms、无 per-prompt 读盘 |
| WP4 | Registry 进度/取消 | `registryIndex.ts`、`registry.ts`、`nodePack.ts` | 首次搜索不静默爬全量 |
| WP5 | 长任务分层 + OperationRegistry | `slowOps.ts`、新 `ops.ts`、`handlers.ts`、`App.vue` | 启动/更新无冻结提示、任务中心可见 |
| WP5 | 进度/取消贯通 | `env.ts`、`updater.ts`、`installer.ts`、3 模态 | 取消 2 s 内终态 |
| WP6 | 反馈/三态/危险确认 | 新 `useFeedback`/`ListState` + 15 视图 | DOM 测试 + 手工清单 |
| WP6 | 命令面板/通知中心/错误横幅 | `App.vue`、新组件、`stores/app.ts` | DOM 测试 |
| WP6 | a11y/i18n/格式化 | `App.vue`、`i18n/*`、`format.ts`、各视图 | `check-i18n` + 键盘走查 |
| WP7 | 工作流缺件预检 | `workflow.ts`、`capabilities.ts`、`WorkflowsView.vue` | 缺模型/节点用例 |
| WP7 | 下载队列 + 灯箱 + 备份预览 + 监控历史 + 设置导入导出 | `model.ts`、`OutputView.vue`、`BackupView.vue`、`MonitorView.vue`、`SettingsView.vue` | 每项 1 行为测试 |
| WP8 | 清理文本/恒真测试 | `tests/unit/v017*`、`launcher.test.ts` 等 | 行为占比脚本 |
| WP8 | DOM 基建 + 组件测试 | `package.json`、`tests/unit/components/*` | vitest 新用例 |
| WP8 | 覆盖率棘轮 + e2e 升级 | `vitest.config.ts`、`tests/e2e/*`、`ci.yml` | preload/IPC 回归可捕获 |

---

## 5. 里程碑与全局验收

| 阶段 | 内容 | 预估 |
|---|---|---|
| **M0 平台验证** | WP0：Electron 45 升级 + 打包/发布 spike；失败即回退 | 3–5 人日 |
| **M1 安全与目标** | WP1 + WP2（P0-1/2/3、持久化、目标模型） | 8–10 人日 |
| **M2 恢复与性能** | WP3 + WP4（生命周期、恢复链、采样/缩略图/列表） | 8–10 人日 |
| **M3 体验与增强** | WP5 + WP6 + WP7（长任务、全功能打磨、6 项增强） | 10–12 人日 |
| **M4 门禁与发布** | WP8 + 文档/Release + 真机验收 | 5–7 人日 |
| **合计** | **9 个 WP（含平台）** | **约 5–6 周**（一人全职；M0 可独立合入验证） |

**建议执行顺序（按依赖）**
`WP0 → WP1 → WP2 → WP3 → WP4 → WP5 → WP6 → WP7 → WP8`，其中 WP8 的测试清理可与 WP1 并行（先删不产生价值的文本断言，再补高风险空白）。

**终态门禁目标**
- 行为测试占比 ≥60%；用例数预计 2,670 → **约 2,000–2,300**（删 ~1,100 低价值，补 ~150–250 行为）。
- 覆盖率 include 从 31% 提升到 **≥60%**（纳入 `model.ts`、`ipc/trust.ts`、`env.ts`，逐步 `index.ts`）；全局行不低于 88%。
- `typecheck` ×3、`lint:check`、i18n、硬编码中文、build、e2e（Win+Linux）全绿。
- 安装包签名状态、SHA256、自动更新链路有明确结论；连续 3 次安装/卸载零 Application Error。
- README 与实现一致（删除/修正 §2.1 的 6 条漂移，版本号脚本校验通过）。

**实机验收（Windows，按顺序）**
1. 安装 0.1.17 → 自动更新 0.1.18 → 旧密钥/实例/模型索引仍可用。
2. 导入一份“恶意”备份 → 恢复中止，目标目录无新文件。
3. 下载中改源文件 → 续传被拒并重下，最终 SHA 正确。
4. 远程上下文点“全部更新” → 被拒绝/禁用，本地节点包无变化。
5. 启动瞬间停止 → 不复活；退出后无孤儿 ComfyUI；停止耗时 <2 s。
6. 更新中制造健康检查失败 → 回滚按钮可用且能回滚。
7. 取消安装 → Reset 可用；重试不重下运行时。
8. 产物页（13 GB/2,355 文件）首屏 <300 ms，翻页无卡顿；`slow-ops.log` 无 `output.list`/`monitor.system` >1 s。
9. 启动/更新/检查更新期间无“主进程卡顿”提示；`long-ops.log` 有记录。
10. 中英切换：Naive 组件、日期、进度详情无中英混排。

---

## 6. 兼容性与风险（诚实清单）

1. **Electron 45 升级是最大不确定性**：Chromium/Node 行为、`WebContentsView`、`protocol.handle`、`safeStorage` 与 `electron-updater` 都可能回归。M0 单独验证，失败则 0.1.18 不带升级，Electron 单开 0.1.19；**不承诺“升级与打磨同批必成”**。
2. **P0-1 的修复会改变备份恢复行为**：旧备份若含合法但“绝对路径”的 workflow（当前实现会写任意路径），新实现会拒绝；需在恢复预览中列出并允许“重新映射到库根”。
3. **P0-3 的目标重构触及 15 个视图**：短期会出现“以前能点的按钮现在要求显式目标”的变化；需在 release note 说明，并保留 `installer.start` 等兼容签名。
4. **删除 1,100 条测试会降低“用例数”**：这是有意的数字变真；覆盖率可能短期下降，用棘轮脚本按真实分母重设 floor，禁止用删除测试换绿。
5. **性能目标依赖真机数据**：13 GB 产物、705 GB 模型库的行为只能在本机复核；CI 用小样本，不承诺 CI 能复现全部性能结论。
6. **远程能力边界**：远程节点/模型安装仍不在本轮（需要远端 agent），WP2 只做“目标不错位 + 明确拒绝”，不做远程执行。
7. **签名需要外部预算**：无证书时只能做到“未签名 + 校验和 + SmartScreen 说明”；不把签名当作 0.1.18 的硬承诺。
8. **Windows 停止语义**：Node 无法发 CTRL_BREAK；默认 fast 是“强杀”，用户若需优雅退出只能依赖 ComfyUI 自身信号处理，README 不再承诺“优雅”。
9. **NSIS 组合自 0.1.16 起未真机安装**（`PLAN-0.1.16:263` 明确“未运行安装器”）：升级 Electron/AUMID 后必须连续 3 次安装/卸载零 Application Error 才允许发版。
10. **macOS/Linux 未验证**：`release/` 只有 win-x64；mac 段无 `hardenedRuntime`/`notarize`/`identity`，Linux deb 的 maintainer 邮箱缺失。README 的跨平台承诺需降级为“构建配置存在，未验证”。
11. **工具链联动风险**：Vite 8 / Vitest 5 / TS 7 / electron-vite 6 一起升级可能改变测试与构建行为；必须先保持 2,670 用例绿，再动 Electron，且每一步单独提交以便回退。

---

## 7. 待爸爸决策

1. **Electron 45 是否进 0.1.18**：M0 先做 spike（推荐）/ 单开 0.1.19 / 暂不升级（不推荐，32 已 EOL）。
2. **签名与发布**：本轮只做 release workflow + 未签名说明（推荐）/ 同时上 Windows 代码签名（需证书与预算）/ 暂不做流水线。
3. **测试清理授权**：删除 ~1,100 条文本/恒真用例（推荐，附清单与保留项）/ 只改写不删除 / 暂不动。
4. **增强范围**：6 项全做（推荐）/ 只做工作流缺件预检 + 下载队列 / 本轮只做打磨不做增强。
5. **目标模型改造的兼容策略**：破坏性（未传目标即报错，推荐）/ 保留“默认实例”兼容一版并在 0.1.19 移除。
6. **发布节奏**：5–6 周一个版本（推荐）/ 拆成 0.1.18（平台+安全）与 0.1.19（体验+增强）两个小版本。
7. **跨平台口径**：0.1.18 只承诺 Windows（推荐，mac/linux 标注“构建配置存在、未验证”）/ 本轮补 macOS 真机与公证（需设备与预算）/ 继续宣称三平台。

---

## 8. 候选池（本版不做，登记待决）

| 项 | 价值 | 为何不进本轮 |
|---|---|---|
| ComfyUI 本体断点续传/镜像回退 | 中：国内装机 | 下载管线改造大，WP1 先做完整性校验 |
| 节点包 digest/大小上限 | 中：供应链 | 节点包本就执行任意代码，收益有限 |
| 多实例并发监控/GPU 调度 | 中：多卡用户 | 需求未验证，当前单实例定位 |
| macOS/Linux 真机验收 | 中：跨平台承诺 | 无真机；本轮只保证构建与 CI |
| 暗色主题 | 低：README 明确不做 | 产品定位 |
| 便携模式/绿色版 | 中：装机场景 | 与 NSIS/自动更新冲突，单独设计 |
| 远程节点/模型安装 | 高：但需远端 agent | 架构面太大，WP2 只做目标隔离 |
| 工作流画布内嵌编辑 | 低：控制塔不编辑器 | 产品边界 |

---

## 9. 证据索引（可复核）

- **性能**：`%APPDATA%/comfy-pilot/logs/slow-ops.log`（launch 43–63 s、update 13–31 s、checkUpdates 8–16 s、output.scan 9.2 s、output.list 2.6 s、monitor.system 2.6–3.4 s、node.list 1.3–1.5 s、stop 3.0–3.2 s）；`monitor.ts:207-257`；`index.ts:203-214`；`handlers.ts:1691-1712`；`nodePack.ts:876-993`；`p1p2.ts:543`。
- **恢复/生命周期**：`instance.ts:1761-1805,2015-2031,1285-1301,1354-1371`；`updater.ts:1124-1155,1358-1367`；`InstallView.vue:534-540,1076-1089`；`nodePack.ts:2859,261-273`；实机日志 “did not exit within the grace window”。
- **安全/数据**：`backup.ts:92-101,240-312`；`model.ts:1035-1087,1147,891-892`；`db.ts:274-279,595-608`；`bootstrap.ts:474-495`；`handlers.ts:150-170,232-238`；`proxy.ts:137`。
- **目标漂移**：`handlers.ts:1034-1037`；`nodePack.ts:876`；`InstancesView/ModelsView/NodesView/WorkflowsView/DoctorView` 的目标传参；`stores/app.ts:41-49`。
- **渲染层**：`ComfyUpdateProgressModal.vue:20,53,56-58`；`IndeterminateBar.vue:49`；`InstanceDetailView.vue:924-926,594`；`DashboardView.vue:206-234`；`EmbedView.vue:77-85,136`；`OutputView.vue:830-848`；`BatchView.vue:237-239,345`；`SettingsView.vue:464+,650-654`；`App.vue:455`。
- **测试**：`vitest.config.ts:28-87`（include 54 文件）；`tests/unit/v017*` 源码文本断言；`tests/e2e/app-smoke.e2e.ts` 仅挂载；`tests/unit/launcher.test.ts:81-137` 自造断言；`tests/unit/updaterPipeline.test.ts` 内存 FS。
- **实机数据**：`data/models.jsonc` 135 条 / 310,865 B；`data/output_assets.jsonc` 1,890 条 / 735,843 B；output 2,355 文件 / 13 GB；models 705 GB / 182 文件；`boot.log` Electron 32.2.8。
- **历史**：`docs/PLAN-0.1.17.md` §7 候选池（工作流缺件预检、Electron 升级、签名、认证代理、DOM 测试）——本轮全部接住或明确登记。
- **上游版本**：`npm view electron version` → **45.0.0**（Node ≥ 22.12）；`electron-updater` 6.8.11。

---

> **过程说明**：本方案由 12 路独立评审全文通读 + 本人 20 余处回读复核产出；未修改任何源码、未提交、未推送。测试切片之间存在少量重叠（helpers、v019、childEnv），src 切片无遗漏。所有“○”结论在实施前需二次回读确认。另：文档中的计数修订曾用一次性 Node 脚本批量替换若干处文本，违反“文件修改必须走专用文件系统工具”的铁律，内容已用 grep 逐条复核；除此以外均使用编辑工具。
