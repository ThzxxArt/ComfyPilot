# 0.1.18 执行台账

> 基线：`35555b3`（v0.1.17）· 方案：[PLAN-0.1.18.md](PLAN-0.1.18.md)
> 本文件只记录**已落地并可复核**的项；未完成的项明确标为待办，不用“部分完成”包装。
> 最近更新：执行轮 2（WP0 平台、WP1 收尾、WP6 视图、WP7 五项、WP8 基建）。

## 门禁现状（执行轮 1 实测）

| 门禁 | 结果 |
|---|---|
| `npx vitest run` | **118 文件 / 1,701 用例全绿**（删除约 1,050 条纯源码文本断言） |
| `npx vitest run --coverage` | 全局 84.69 / 75.99 / 85.87 / 86.95，每文件下限 + ratchet 通过 |
| `npm run typecheck` ×2 + `typecheck:test` | 0 错 |
| `npx eslint .` | 0 错 0 警 |
| `node scripts/check-i18n.cjs` | 键对齐、0 未用（exit 0） |
| `node scripts/check-hardcoded-zh.cjs` | 0 硬编码 |
| `node scripts/check-version.cjs` | 通过 |
| `npm run build` | 成功（Electron 45 / electron-vite 6 / Vite 8） |
| `npm run test:e2e` | 通过（渲染挂载 + preload 桥 + 真实 IPC + console 置红） |

## WP1 安全与数据完整性

| 项 | 状态 | 证据 |
|---|---|---|
| 备份恢复路径收敛（P0-1） | ✅ | `backup.ts` 统一 `restoreRoots()` + `resolveInsideAnyRoot`；工作流文件只写 `join(可信根, basename)`，越界路径重映射；实例/模型越界整次中止 |
| 恢复预检 + 差异预览 + 选择性恢复 | ✅ | `backup.preview` IPC + BackupView 预览弹窗（设置差异、重映射/缺失、非法路径、分区选择） |
| 续传完整性（P0-2） | ✅ | 206 校验 `Content-Range` 起点与总长；`If-Range`；不一致删残片重下；同 dest 单活动任务 |
| 写盘持久性 | ✅ | 唯一 tmp + `fsync(file/dir)` + Windows EPERM 退避重试 |
| 单一写入者 | ✅ | `replaceList()` 统一备份恢复写入；`listNodePacks` 自愈走去抖队列 |
| 设置枚举/范围校验 | ✅ | `assertSafeSettingsPatch` 覆盖 locale/securityLevel/networkMode/stopMode/布尔/深度/proxy/扫描根；settings.set 与备份恢复共用 |
| 运行时校验 fail-closed | ✅ | 无官方校验和且无历史 pin 时删除下载并抛 `RUNTIME_UNVERIFIED`；`allowUnverifiedRuntime` 显式开关；哈希失败也 fatal（S3） |
| 凭据解锁 UX | ✅ | `settings.credentialStatus`（代理密码不可解 + 远程 apiKey 锁定）；设置页“需要重新录入”提示与重填入口；远程表单补 API Key | 
| 认证代理 | ✅ | `proxyAuthFor()` 只回答代理挑战（站点登录绝不拿到代理密码）；`app.on('login')` 接入 |

## WP2 目标一致性（P0-3）

| 项 | 状态 | 证据 |
|---|---|---|
| `TargetRef` + store 单一目标 | ✅ | `activeInstance` 不再回退 `instances[0]`；新增 `activeTarget` / `localTargetId` |
| 破坏性 IPC 显式目标 | ✅ | `requireLocalTarget()` 覆盖 node 安装/更新/卸载/开关/快照/检查、doctor.run/fix、恢复扫描/还原/清理；未传返回 `TARGET_REQUIRED` |
| 远程上下文不落本地 | ✅ | 节点/模型/诊断/市场/工作流视图使用 `localTargetId`；远程时按钮守卫 + `TargetBanner` |
| 默认实例策略收敛 | ✅ | 唯一实现 `services/target.ts`（`resolveReadTarget` / `resolveActiveTarget` / `resolveLocalInstance`）；`grep 'instances\[0\]'` 只剩注释 |
| 契约收口 | ✅ | `installer.start` 的 `runId` 被视图保存并按 runId 过滤进度；`instance.save` 服务层只落配置字段（已存在，复核确认）；进度 `errorCode` 待 WP5 收尾 |

## WP3 生命周期与恢复

| 项 | 状态 | 证据 |
|---|---|---|
| 退出/强杀统一树杀（L1） | ✅ | `killAllNow` 走 `killProcessTree`，账本保留到确认退出；`before-quit` 异步等待（5 s 预算） |
| Windows 快速停止（L10） | ✅ | `stopMode`（默认 `fast`）：直接树杀；`graceful` 保留 3 s 宽限；两态测试 |
| 就绪超时清理（L4） | ✅ | 超时先树杀未就绪进程，再置 error |
| adopt 归属校验（L5） | ✅ | 仅 PID 账本证明归属或用户确认才接管；否则 `ADOPT_CONFIRM_REQUIRED` + UI 确认 |
| 更新 journal 保留（L2） | ✅ | 健康检查失败写 `status:'verify-failed'` 并保留 journal/备份 |
| 安装取消终态（L3） | ✅ | `cancelled/failed/done` 都释放 `installing`，Reset 可见 |
| zip 干净重装（L6） | ✅ | 归档 manifest（`.comfypilot-archive.json`）删除“上次有、这次没有”的 core 文件；只删 manifest 记录路径；目录自底向上清理；两条测试 |
| 异步复制 + 进度（F7） | ✅ | `copyCoreTree` / `overlayTree` 改 async 分块 + `workDone/workTotal` + 每 50 个文件让出事件循环 |
| `.bak` 恢复中心（L9） | ✅ | `node.recoveryScan/Restore/Clean` + NodesView 横幅与弹窗；还原拒绝覆盖现存包；越界名拒绝；四条测试 |
| 模型索引 prune（L11） | ✅ | 扫描后按扫描根删除不存在行；`pathRoot` 改用包含判断 |
| `repairEnv` 可取消（L7/L8） | ✅ | `EnvService` 拥有 `AbortController`；`instance.repairCancel`；abort 等到进程树真死才 reject；进度模态按 repair 分发取消 |

## WP4 性能

| 项 | 状态 | 证据 |
|---|---|---|
| 监控单飞 + 分级缓存（F1） | ✅ | CPU/RAM 2 s、GPU 5 s、磁盘 10 s；并发共享同一采样 |
| 产物缩略图异步（F2） | ✅ | `output.list` 不再生成缩略图；新增 `output.thumb` 按需；首屏后 4 并发补齐 + `loading=lazy` |
| 节点列表缓存（F3） | ✅ | 目录/元数据签名缓存；签名未变直接返回 |
| 批跑内存化（F4） | ✅ | `BatchService` 内存缓存 + 400 ms 合并写；终止态立即落盘；`list()` 返回副本；重启后自愈为 interrupted |
| 产物排序缓存（F5） | ✅ | `db.outputAssetsRev()` 版本号驱动的排序缓存，任何写入即失效 |
| Registry 进度/取消（F6） | ✅ | `ensure({allowBuild})`、`cancelBuild()`、`status.building/done/totalPages`；`market.list` 返回 `needsIndex`；MarketView 先询问再建索引、可见进度与取消；`nodePack` 只用缓存索引不再静默爬 58 页 |
| 模型扫描异步 + prune（F8） | ✅ | 每 25 个文件让出事件循环 |
| 启动与首屏测量 | ✅ | `bootTiming.ts`：module → app-ready → renderer-loaded → window-shown → 首次 `node.list`/`model.list` 写入 `boot.log` |

## WP5 长任务体验

| 项 | 状态 | 证据 |
|---|---|---|
| 慢操作语义分层（U16） | ✅ | `LONG_OP_CHANNELS`；长任务写 `long-ops.log`、`freeze=false`、不触发 toast |
| 统一后台任务中心 | ✅ | `services/ops.ts` 订阅 install/update/repair/node-op/node-batch/batch/index/scan 流；`ops.list/ops.cancel`；`event:op-changed`；App 顶部 TaskCenter（徽标/进度/取消） |
| 进度诚实（0% 合法 / detailKey） | ✅ | `utils/progress.ts` 单一判定：`workTotal>0` 或 `progress` 数值才确定；真实 0 显示 0；三个模态共用；`IndeterminateBar` 改用 `$color-primary` |
| 取消语义统一 | ✅ | 安装/更新/修复/节点/批跑/索引/扫描都可从任务中心停止；修复取消走 `AbortError` 终态 |

## WP6 全功能打磨

| 项 | 状态 | 证据 |
|---|---|---|
| 反馈原语 `useFeedback` | ⚠️ 撤回 | 只有定义、全仓无引用且 `danger` 无效；已删除，确认/错误反馈仍由各视图手工实现（见 review 文档 P2） |
| 列表三态 `ListState` | ✅ 组件 | 组件 + OutputView 接入；Nodes/Models/Workflows/Batch/Market/Monitor/Doctor/Backup 待接入 |
| 危险确认标准化（S8） | ✅ 模型/产物 | 取消显式；“只删记录”改为框内独立动作；不可恢复提示 |
| 命令面板 | ✅ | `Ctrl/Cmd+K`：13 个视图、实例切换、启动/停止、打开日志；上下键 + Enter |
| 通知中心 | ✅ | 保留 200 条、可回看、未读徽标、readSeq 持久化 |
| 启动失败横幅 | ✅ | `store.bootstrapError` 页面级 NAlert（重试/打开日志） |
| a11y / Naive locale / formatDate / versionMismatch | ✅ | Naive + 日期 locale；`formatDate(iso, locale)`；semver 数值比较（`1.2` == `1.2.0`） |
| 逐视图收口 | ✅ | Dashboard 卸载竞态、Embed 生命周期、Batch 非阻塞 + 缺模型确认、Output 单击/双击/错误态/灯箱缩放、Market 索引询问、Install runId、InstanceDetail 状态去抖 + 日志合并、Settings 未保存守卫 + 校验 + 导入导出、Monitor 远程“本机”标注 + 隐藏降频、Doctor 取消 + 诚实进度条、Nodes/Models/Workflows 三态；剩余：Workflows 远程队列入口、Doctor fix 逐项 loading |

## WP7 功能增强

| 项 | 状态 |
|---|---|
| 备份差异预览 + 选择性恢复 | ✅ |
| 工作流缺件预检 | ✅ | `collectPromptModelRefs` + `workflow.checkModels`；工作流卡片“依赖检查”弹窗；批跑提交前缺模型显式确认 |
| 模型下载队列 | ✅ | 队列优先（真正重排 waiter）、全部暂停/继续/取消、失败重试、速度/ETA、已完成清理 |
| 产物灯箱增强 | ✅ | 滚轮缩放、拖动平移、←/→ 翻页、+/-/0 快捷键、重置 |
| 监控历史/阈值 | ✅ | 主进程 10 分钟序列（300 点）+ `monitor.series`；CPU/RAM/VRAM 三线；VRAM≥90%/RAM≥95% 每 5 分钟最多一次站内提醒 |
| 设置导入/导出 | ✅ | 不含密钥的导出；导入前差异预览；主进程重新校验且拒绝写入密钥/未校验开关 |

## WP0 平台

| 项 | 状态 |
|---|---|
| 工具链升级 | ✅ | Electron **45** / electron-vite **6** / Vite **8** / Vitest **5** 全绿；TS 7 实测与 vue-tsc 不兼容，保留 5.9 并记录 |
| AUMID / 打包精简 | ✅ | `setAppUserModelId`；asar 不再重复 unpack preload；排除 `out/tsc-*` 与 `*.tsbuildinfo`；postbuild 产物存在性冒烟 |
| release.yml | ✅ | tag 触发、Windows 必跑、mac/linux 非阻断、draft + SHA256SUMS；Node 24；本地 Windows 侧已实打 0.1.18 安装包（见下） |
| check-version | ✅ | 五处一致性脚本 + npm script + CI + release tag 校验 |

## WP8 测试与门禁

| 项 | 状态 |
|---|---|
| 清理文本/恒真测试 | ✅ | 删除 9 个纯源码文本文件（v017SourceContracts/DeepAudit/TypeFields/TypeSystem/ParametricAndSecurity/FinalPush/FinalBatch/LastMile/Contracts）与元测试块：用例 2,745 → 1,695；`scripts/test-behavior-ratio.cjs` 行为占比 97.5%（残留 41 条混在行为文件里，未整体删除） |
| 补 model/handlers 信任函数/Windows 分支 | ✅ | `ipc/trust.ts` 抽出 `safeInstanceId/safeInstanceTarget/isRemoteTarget/requireLocalInstanceId/requireLocalTarget`，18 条表驱动测试；`model.ts` 纳入 include；优先队列/代理认证/模型预检均有行为测试 |
| 渲染层 DOM 测试基建 | ✅ | `@vue/test-utils` + `happy-dom` + Vue 插件；`ListState`（4）与 `IndeterminateBar`（2）组件测试 |
| e2e 升级 | ✅ | 渲染挂载 + preload 桥 + 真实 IPC 往返 + console error/preload-error 置红 |
| 覆盖率棘轮 / include 扩展 | ✅ | `coverage-baseline.json` + `coverage-ratchet.cjs`（任一文件任一指标掉 >1pp 失败）；`perFileThresholds()` 从 baseline −2pp 派生，禁止手改数字 |

## 新增测试（累计）

- `backupService`：恶意路径、越界实例/模型、预览、选择性恢复、凭据保留（16）。
- `modelDownloadResume`：206 区间不符/缺失、源变化、If-Range、同目标并发（6）。
- `wp18Guards`：设置校验、长任务分层、`long-ops.log`（6）。
- `nodePackService`：恢复中心扫描/还原/拒绝覆盖/越界拒绝/重复副本（5）。
- `updaterPipeline`：归档 manifest 清理、首次无 manifest 不删、异步复制/覆盖（4）。
- `registryIndexService`：allowBuild=false 不爬取、cancelBuild 中止（2）。
- `p1p2Services`：批跑内存缓存与副本语义（1）。
- `instanceService`：fast/graceful 停止、adopt 拒绝/确认（3）。

## 已知未闭环（不要当成已完成）

1. 上述 ⏳ 项（WP0 全部、WP1 三项、WP6 视图收口、WP7 五项、WP8 全部）。
2. 实机验证：Windows 真机停止/安装/更新/13 GB 产物页尚未执行。
3. `handlers.ts` 仍未纳入覆盖率；WP8 之前不做数字包装。


## 执行轮 2 追加说明

- **WP0 平台**：Electron 45 / electron-vite 6 / Vite 8 / Vitest 5 升级后全部门禁通过（2,745 用例、build、真实 Electron e2e）。TypeScript 7 实测与 `vue-tsc` 2.x/3.x 均不兼容（`ERR_PACKAGE_PATH_NOT_EXPORTED`），保留 5.9 并写入 README；这是有证据的技术约束，不是遗漏。
- **WP8 覆盖口径**：`perFileThresholds()` 从 `coverage-baseline.json` 派生（实测 −2pp），`coverage-ratchet.cjs` 对任一文件任一指标掉 >1pp 失败；`npm run coverage:accept` 才能更新基线。`statements` 只保留全局门槛（lcov 无逐语句数据，避免编造数字）。
- **Windows 安装包实测（WSL 调用 Windows node）**：`ComfyPilot-0.1.18-win-x64.exe`，131,405,079 B，SHA256 `ae74c7d4…d6d3b`；`FileVersion/ProductVersion=0.1.18`、ProductName `ComfyPilot`、CompanyName `ThzxxArt`；asar 18,068 条、**0 个 `out/tsc-*`、0 个 `*.tsbuildinfo`**，`latest.yml` 的 size/sha512 与实际一致。体积从 0.1.17 的 93 MiB 增至 125 MiB —— 增量来自 Electron 45 运行时，不是打包冗余（冗余项已排除）。
- **仍未闭环（外部环境）**：Windows 真机安装/升级/停止瞬间/13 GB 产物页的人工验收；release workflow 尚未在 GitHub 上真实触发（需要 push tag，未获授权）。`handlers.ts` 的 IPC 装配层仍不纳入覆盖率（理由见 vitest.config.ts）。


---

## 2026-10-24 全量回归 review 轮（goal round 1）

- 方法：6 路只读评审（主进程核心 / 实例内容服务 / 数据安全 / IPC 契约 / 渲染基建 / 视图工具链）+ 门禁复跑；结论与逐条状态见 `docs/REVIEW-0.1.18-REGRESSION.md`。
- 修复：1 个 P0（更新下载失败永久卡 running）、8 个 P1（停止竞态、quit 双杀、repair 取消、custom_nodes 回退、备份任意写、proxy.protocol、通知未读、导入副作用）、约 20 个 P2（详见 review 文档）。
- 新增回归测试：updater body-stream 失败、延迟 exit 的 fast-stop、模型预检按实例、备份相对路径/碰撞/凭据剥离、proxy/aria2 校验、trust 空白 id、索引取消标记等。
- 门禁：**121 文件 / 1,719 用例全绿**；覆盖率 84.86 / 75.96 / 85.94 / 87.17；ratchet 56 文件；typecheck×3、eslint、i18n、硬编码、version、**test:behavior 97.6%**、build、e2e 全部 exit 0。
- 仍未闭环：备份恢复事务化、POSIX 进程树真实退出等待、autoStart/sweep 串行化、二次 quit、批跑重试取消计数、节点弹窗在槽位被占时的快照。见 review 文档第四节。

## 2026-10-24 回归修复轮 2（goal round 2）

- **备份恢复事务化**：应用前自动创建 `pre-restore-<ts>` 磁盘快照（失败即中止、不改任何状态）；应用过程捕获 settings/五张列表/目标文件字节，任一步抛错或工作流文件写入失败即整体回滚，并回报 pre-restore id（`BackupRestoreResult.preRestoreId`，UI 会提示可回退）。新增 4 条测试：列表写失败回滚（settings + instances + 文件）、pre-restore 创建失败中止、回滚也失败的双错消息、已写工作流文件按原字节回滚。
- **POSIX 进程树**：SIGKILL 后不再立刻 resolve，轮询 `kill(pid,0)` / child exit / 超时（默认 3s）确认真实退出；grace 期间每 100ms 补杀新出现的子孙；child 退出时清理遗留子孙。新增“exit 前不得 resolve”回归测试。
- **启动/退出串行化**：`autoStart` 现在先 `await` 孤儿 sweep，避免 sweep 杀掉刚 adopt 的进程；`before-quit` 始终 `preventDefault()`，二次 quit 只等待首个处理器完成，清理结束后用 `app.exit(0)`（不会跳过 flush）。
- **批跑重试计数**：retry/resume plan 下，取消某条腿只把“本轮还欠的尝试”计为失败（`runCount - i`），不再按累计 `item.count` 把历史尝试一起报失败。
- **节点操作弹窗**：`nodeOpSnapshot` 独立于共享进度槽；repair/comfy 更新占用槽位时，节点弹窗仍能显示步骤、日志与取消按钮（新增 composable 行为测试）。
- **更新取消语义**：verify 后、relaunch 前的晚到取消不再进入回滚路径（避免把已验证的更新回滚掉），日志明确记录“source updated — finishing as done”。
- 门禁：**121 文件 / 1,725 用例全绿**；覆盖率 85.02 / 75.93 / 86.08 / 87.33，ratchet 56 文件；typecheck×3、eslint、i18n、硬编码、version、build、e2e、test:behavior 全部 exit 0。
- 仍未闭环：仅剩 Windows 真机人工验收与 release workflow 的真实 tag 触发（外部环境/需授权）。
