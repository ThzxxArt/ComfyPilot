# ComfyPilot 0.2.0 迭代方案 —「问题闭环 · 运行时现代化 · 架构收口 · 不兼容升级」

> 生成日期：2026-11-02 · 基线 **v0.1.18**（`b2c3531` / tag `v0.1.18`，工作区干净）
> 读取范围：**src 116 文件 / 61,281 行** + **tests 128 文件 / 36,302 行** + **docs 12 文件 / 3,934 行** + 配置/脚本/CI 23 文件；逐文件切片通读，关键链路逐行回读，未抽样、未截断。
> 基线实测：`npx vitest run` → **121 文件 / 1,725 用例全绿**（26.33 s）。
> **文档清理**：按爸爸要求，`docs/` 下除本文件外的历史方案/回归文档已全部删除；本文件是 0.2.0 唯一有效方案。
> **一句话**：0.2.0 不是 0.1.18 的兼容增量，而是一次**不兼容大版本**：把“看得见的问题”变成“点得动、修得掉、不会再冒出来”的闭环，同时只支持 Python 3.13、升级工具链、收口架构。

---

## 0. 版本定位：不兼容升级

### 0.1 兼容策略

**0.2.0 不承诺任何向下兼容。**

| 面 | 0.2.0 的处理 |
|---|---|
| IPC | 可重命名/删除通道、改参数与返回 shape；不保留旧 optional 签名；preload 白名单与全部 renderer 调用点同批更新 |
| 共享类型 | 删除 `src/shared/types.ts` 单体，改为 `shared/types/*`；不保留兼容 re-export |
| 服务 API | `nodePack` / `p1p2` / `instance` / `db` 直接抽领域模块；不保留 facade，不保留旧 import 路径 |
| 数据格式 | JSONC 升 `schemaVersion: 2`；v1 → v2 **一次性单向迁移**；迁移后 0.2.0 拒绝 v1 |
| 旧版本回读 | 0.1.18 不能读 v2 数据/备份；只能靠迁移前 `pre-upgrade-<ts>` 快照 + 重装 0.1.18 回退 |
| Python | 只支持 **3.13.x**；旧 3.12 实例阻断启动，强制迁移；不提供 3.12 运行兼容 |
| torch | **cu124 整体移除**；只保留 cu130 / cu126 / rocm / xpu / mps / cpu |
| 凭据 | `settings.get` 不再返回代理密码明文；`remote.list` 不再返回 API key 明文 |
| 渲染层 | 主窗口默认 `sandbox:true` + CSP；IPC 增加 sender frame 校验 |
| 依赖 | Node `^22.13.0 || >=24.0.0`；Pinia 4 / Router 5 / vue-i18n 11 / ESLint 10 直接升级，不保留旧写法 |

### 0.2 一次性迁移不是兼容层

- 首次启动生成 `data/pre-upgrade-<ts>/` 全量快照，然后执行 v1 → v2 迁移。
- 迁移成功后，0.2.0 **只读写 v2**；旧 v1 文件不会再被解析。
- 迁移失败：恢复快照，应用进入“迁移失败”状态，只允许“重试 / 导出快照 / 重装 0.1.18”；不允许跳过迁移继续用旧 schema。
- 所有破坏性变更必须写入 release note。

### 0.3 修复原则

- **只做根因修复**：每个问题必须回答“为什么会发生”，并在数据流、状态机、信任边界或持久化层修掉。
- **禁止症状修复**：不允许只改 toast 文案、只加一次刷新、只隐藏 UI、只吞异常、只加兼容分支。
- **全部在 0.2.0 完成**：不设临时补丁、不拆版本、不做“先修一半”。

### 0.4 非目标

- 不做工作流画布编辑器（继续交给官方 Frontend）。
- 不做暗色主题（README 明确不做）。
- 不做远端 agent（0.2.0 只做目标隔离与明确拒绝）。
- 不引入 SQLite/原生数据库（Electron ABI/便携性风险，后续单独评估）。
- 不保留 Python 3.12 运行兼容、不保留旧 IPC/旧数据双读。

---

## 1. 读取范围、基线与方法

### 1.1 覆盖清单

| 切片 | 覆盖内容 |
|---|---|
| 主进程基础设施 | `db`、`security`、`secretStorage`、`session`、`backup`、`proxy`、`logFile`、`slowOps`、`workPool`、`lru`、`childEnv`、`desktop`、`tray`、`target`、`bootTiming`、`capabilities`、`appUpdate`、`assetsApi`、`comfyApi`、`netProbe`、`preflight` |
| 主进程生命周期 | `instance`、`installer`、`updater`、`bootstrap`、`env`、`pipOps`、`processTree`、`doctor`、`startupIssues`、`launchArgs`、`pipVersion`、`pipRecipes` |
| 主进程内容 | `nodePack`、`model`、`workflow*`、`registry*`、`media`、`monitor`、`p1p2`、`zipSafe`、`zipWrite`、`nodeLoadReport`、`mediaTypes` |
| 装配/构建/测试 | `index`、`bootstrap.cjs`、`handlers`、`trust`、preload、`package.json`、builder、Vite/Vitest/tsconfig、CI、scripts、全部测试文件 |
| 渲染层 | `App.vue`、15 视图、12 组件、8 composable、7 utils、双语 locale、设计 token、样式 |

### 1.2 基线事实

| 项 | 数值 / 结论 |
|---|---|
| 版本 | 0.1.18（`package.json`、lock、`constants.ts`、README 一致） |
| 测试 | 121 文件 / 1,725 用例全绿 |
| 覆盖率 | include 60 文件；全局 floor statements 82 / branches 74 / functions 83 / lines 84；ratchet 按基线 −2pp |
| 类型检查 | `vue-tsc` 2.2.12 + TypeScript 5.9.3 |
| 平台 | Electron 45.0.0（lock）、electron-builder 26.15.3；CI Node 24、Windows + Linux e2e |
| 运行时 | 便携 Python **3.12.11**；uv 0.8.15；MinGit 2.47.1 |
| 数据 | JSONC（settings / instances / node_packs / models / output_assets / workflows / downloads / batch_jobs / backups 等） |
| 用户日志证据 | `节点加载失败（2）`：`ComfyUI-Manager`（`torch_npu`、`OpenGL_accelerate`）+ `video2dlssnr.trash-1793110538069`（缺 `__init__.py`） |

### 1.3 方法与证据

- 5 路只读评审：主进程基础设施 / 生命周期 / 内容服务 / 渲染层 / 装配构建测试。
- 本人回读通知、审计、启动问题、深链、启动参数、Python 运行时、凭据/备份、IPC 信任边界等关键链路。
- 外部事实均为 2026-11-02 查询：ComfyUI v0.43.0、Python 3.13.18、uv 0.13.6、MinGit 2.56.0.4、Electron 45.2.1、Vue 3.5.44、TypeScript 6.0.3 / 7.0.2。
- 未修改任何源码、依赖或版本；只维护本方案文档。

---

## 2. 0.2.0 目标与验收画面

### 2.1 目标

1. **关闭用户问题**：通知回放、依赖体检假缺失、启动残留无入口、诊断深链空页、自定义启动参数不可用。
2. **运行时现代化**：只支持 Python 3.13.18；旧 3.12 实例一次性迁移；torch 矩阵按 3.13 重建。
3. **工具链现代化**：Electron 45.2.1、TypeScript 6.0.3、Pinia 4、Router 5、i18n 11、ESLint 10。
4. **架构收口**：IPC 契约 + sender 校验、IssueCenter、OperationHub、数据 v2 迁移、服务拆分。
5. **安全/数据可信**：凭据端点绑定、备份事务、realpath 媒体、任意文件导出/打开收口、崩溃级 flush。

### 2.2 验收画面

- 新装只使用 Python 3.13.18；旧 3.12 实例首次启动被拦截并进入迁移向导，迁移完成前不能启动。
- 启动参数可自由追加带引号的自定义参数，路径不被空格切碎。
- 节点更新只弹一条汇总通知；历史通知不重放。
- 依赖体检补装后看到“已解决 / 仍缺失 / 平台不适用”的真实回执；不再出现 `Package verification note`。
- 启动残留自动隔离；ComfyUI 不再重复 IMPORT FAILED；节点页/IssueCenter 可清理。
- 点“去修复”一定落在正确的实例和节点上；找不到包时有明确空态和清理入口。
- 所有问题在 IssueCenter 有统一入口、动作和生命周期。

---

## 3. 全仓审计

### 3.1 模块地图（现状）

```text
Electron main
  index.ts ── window / tray / protocol / lifecycle / event wiring
  ipc/handlers.ts (2,303 行 / 203 通道) ── 直接 import 20+ 单例服务
  services/
    instance.ts (2,135)      生命周期、日志、spawn、就绪探测
    installer.ts (1,569)     一键装机状态机
    updater.ts (1,868)       ComfyUI 更新/备份/回滚
    bootstrap.ts (777)       uv / python / mingit 自举
    env.ts (870)             venv / torch / pip 流式执行
    pipOps.ts (626)          pip 操作单一入口
    nodePack.ts (3,583)      节点包安装/更新/依赖审计/恢复
    model.ts (1,514)         模型扫描/下载/校验
    workflow.ts (1,303)      工作流库/导入/队列
    p1p2.ts (1,734)          批跑 + 产物 + 远程 + 市场
    monitor.ts (719)         CPU/GPU/WS/队列
    db.ts (1,130)            JSONC 持久化
  shared/types.ts (2,304)    领域类型 + IPC 表 + 事件表
renderer
  App.vue (996)              壳层、通知 toast、任务中心、命令面板
  stores/app.ts (291)        实例/远程/通知/WS
  15 views / 12 components / 8 composables / 7 utils
```

### 3.2 三条数据流与断点

| 数据流 | 现状 | 断点 |
|---|---|---|
| 进程事实 | `spawn → stdout/stderr → pushLog → 内存 + 日志文件 → getLogs → 渲染层` | 启动问题解析没有“本次启动”边界，读最后 3000 行跨会话日志 |
| HTTP 事实 | `/system_stats` `/features` `/queue` `/history` `/api/jobs` `/object_info` `/api/assets` | 依赖审计只看 `pip list`，不看 pip 的 marker/解析结果 |
| 磁盘事实 | `custom_nodes` / `models` / `output` / `user` 扫描 | `.trash-*` / `.bak-*` / `._unzip_tmp_*` 被 UI 隐藏，但 ComfyUI 仍加载 |

### 3.3 巨型文件与耦合

| 文件 | 行数 | 问题 |
|---|---:|---|
| `nodePack.ts` | 3,583 | 安装、更新、依赖、恢复、检查、快照、列表全在一个类 |
| `types.ts` | 2,304 | 领域类型 + IPC 表 + 事件表混在一起 |
| `handlers.ts` | 2,303 | 203 个 `ipcMain.handle` 单文件；静态 import 全部服务，循环依赖靠动态 import |
| `instance.ts` | 2,135 | 生命周期 + 日志 + 环境探测 + 启动预览 + 自检 |
| `updater.ts` | 1,868 | 下载、解压、复制、回滚、journal 全在一起 |
| `p1p2.ts` | 1,734 | 批跑 + 产物 + 远程 + 市场四域合一 |

后果：同一个事实有多个写入口（例如 `.trash` 的创建在 `uninstall`，清理不在 `scanRecovery`；通知在 `handlers`，toast 游标在 `App`），最终表现为“没地方解决”。

### 3.4 依赖与工具链现状

| 包 | lock 当前 | 最新 | 0.2.0 |
|---|---:|---:|---|
| electron | 45.0.0 | 45.2.1 | 升 45.2.1 |
| electron-builder | 26.15.3 | 26.18.0 | 升 |
| electron-updater | 6.8.9 | 6.8.11 | 升 |
| vue | 3.5.43 | 3.5.44 | 升 |
| vue-router | 4.6.4 | 5.4.0 | 升，按破坏性升级验证 |
| pinia | 2.3.1 | 4.1.0 | 升 + `@vue/devtools-api@8.2.1` |
| vue-i18n | 10.0.7 | 11.4.17 | 升（已是 `legacy:false`） |
| naive-ui | 2.45.3 | 2.45.3 | 保持，范围收紧 |
| @vueuse/core | 12.8.2 | 15.0.0 | **删除（源码零 import）** |
| echarts | 5.6.0 | 6.1.0 | **删除（源码零 import）** |
| dayjs | 1.11.23 | 1.11.23 | **删除（源码零 import）** |
| systeminformation | 5.33.15 | 5.33.19 | 升 |
| ws | 8.22.0 | 8.22.1 | 升 |
| js-yaml | 5.4.3 | 5.5.0 | 升；删除 `@types/js-yaml` |
| typescript | 5.9.3 | 6.0.3 / 7.0.2 | 升 6.0.3，不升 7 |
| vue-tsc | 2.2.12 | 3.3.14 | 升 |
| @types/node | 22.20.5 | 24.19.2 | 升 24，对齐 Electron 45 |
| eslint | 9.39.4 | 10.14.0 | 升 |
| eslint-plugin-vue | 9.33.0 | 10.12.0 | 升 |
| @typescript-eslint/* | 8.71.1 | 8.72.1 | 升（peer TS `<6.1.0`） |
| vue-eslint-parser | 9.4.3 | 10.4.1 | 升 |
| @vue/eslint-config-typescript | 14.9.0 | — | **删除（未被 import）** |
| @vue/eslint-config-prettier | 10.2.0 | 10.2.0 | 保持 |
| happy-dom | 20.14.6 | 21.0.4 | 升 |
| sass | 1.105.1 | 1.107.1 | 升 |
| prettier | 3.9.9 | 3.9.10 | 升 |
| vite / vitest / electron-vite | 8.3.5 / 5.0.5 / 6.0.0 | 同左 | 保持 |
| zod | — | 4.6.7 | 新增（IPC 校验） |

### 3.5 测试与门禁现状

- 121 文件 / 1,725 用例全绿；typecheck ×3、lint（0 error / 21 warning）、i18n、硬编码、version 均通过。
- 覆盖率 include 60 文件，仍不含 `handlers.ts` / `index.ts` / preload；`coverage` 数字不代表全仓。
- 行为占比 97.6%，但 e2e 仍以启动冒烟为主；release workflow 不跑测试/lint/version。
- 覆盖率最低模块：`registry.ts` 47.3%、`model.ts` 55.9%、`env.ts` 56.2%、`capabilities.ts` 65.5%、`monitor.ts` 73.7%。

### 3.6 README / 历史承诺对账

| 历史承诺 | 实际 | 0.2.0 |
|---|---|---|
| 0.1.13「补装后刷新审计」 | 刷新了，但审计语义仍把 marker 不适用/别名/部分失败算缺失 | WP2 修根因 |
| 0.1.16「IMPORT FAILED 跳转修复」 | 只 `router.push('/nodes')`，无 focus/动作 | WP4 IssueCenter + 深链 |
| 0.1.18「通知中心持久化」 | 历史持久化，但 App toast 游标从 0 开始 | WP1 拆 toastQueue |
| README「便携 Python 3.12」 | 与上游推荐 3.13 脱节；uv 路径已硬编码 3.13，非 uv 仍 3.12 | WP6 只支持 3.13 |
| README「工作流库设置可改」 | `db.ts` 固定返回，无设置字段 | 文档修正或加设置项 |
| README「备份原子恢复」 | 热集合去抖 + 返回前不 flush，仅进程内异常回滚 | WP8-A 崩溃级事务 |
| README「运行时官方 checksum」 | 0.1.18 已改 fail-closed | 文档同步 |
| README「测试 1,725 / 覆盖率」 | 数字为真，但 include 仅 60 文件 | 更新口径 |

---

## 4. 缺陷总表（按严重度，0.2.0 全修）

> 级别：**P0** = 数据丢失/进程失控/信任边界/核心状态说谎；**P1** = 功能失真/高概率兼容失败/恢复断点；**P2** = 体验、一致性、维护性。
> “WP”列是修复归属；详细根因在 §5。

### 4.1 P0

| # | 缺陷 | 证据 | WP |
|---|---|---|---|
| P0-1 | 首次新通知回放全部历史 toast：`notifiedSeq=0` vs localStorage `notificationSeq` | `App.vue:297,301-324`、`stores/app.ts:68-75` | WP1 |
| P0-2 | 依赖审计三连：marker 被丢弃、部分安装被成功标记掩盖、补装后无逐项验证且固定发通用 warning | `pipVersion.ts:66-68`、`env.ts:82-92`、`pipOps.ts:242-246` | WP2 |
| P0-3 | `.trash-*` 残留在 `custom_nodes`，ComfyUI 会加载；`list()` 隐藏、`scanRecovery` 不扫 → 启动每次报错且无入口 | `nodePack.ts:2099-2108,262-274,3457-3507` | WP3 |
| P0-4 | 启动问题解析无 boot 会话边界，旧日志永久复现；self-check 污染 boot report | `instance.ts:714-719,439-499`、`startupIssues.ts`、`nodeLoadReport.ts` | WP3 |
| P0-5 | 详情页“去修复”只 `router.push('/nodes')`；`?focus` 只写搜索框，不匹配 path/folder、不清过滤、不滚动/高亮 | `InstanceDetailView.vue:574-576`、`NodesView.vue:766-773` | WP4 |
| P0-6 | `output.exportZip` 用 `isSafeOpenPath` 回退，任意无扩展名文件可被打包导出 | `handlers.ts:1964-1989`、`security.ts:271-279`、`p1p2.ts:1524-1539` | WP8-A |
| P0-7 | 渲染层可决定可执行路径：`instance.save`、`env.probe`、`installer.start`、`aria2Path` 只做存在检查 | `handlers.ts:537-563,1524-1560`、`security.ts:497-505` | WP8-A |
| P0-8 | IPC 不校验 `senderFrame`；203 通道对任何拿到 preload 桥的 frame 开放 | `handlers.ts:103-114`、`preload/index.ts:35-47` | WP8-A |
| P0-9 | 导入设置/恢复备份把本机代理密码复用到新 host；remote API key 按 id 复用到新 baseUrl | `security.ts:519-528`、`db.ts:635-653`、`backup.ts:518-526` | WP8-A |
| P0-10 | 无法解密的 remote 在恢复时被跳过并全量覆盖；回滚快照又把密文写成空 | `backup.ts:702-708,517-528,304,318-324` | WP8-A |
| P0-11 | 备份恢复不是崩溃级事务：热集合去抖、返回前不 flush、工作流文件无 fsync | `db.ts:440-452,537-541`、`backup.ts:548-554,255-257` | WP8-A |
| P0-12 | `resolveInstancePythonPath` 不检查实例目录 `.venv`/`venv`，启动/pip/审计用错解释器 | `instance.ts:109-134` | WP6 |
| P0-13 | `repairEnv` 创建 venv 后不写回 `venvPath`；默认 `dirname(comfyDir)/.venv` | `env.ts:661-732` | WP6 |
| P0-14 | `installer.reset()` 在 zip 下载期间可重置，旧 `runPlan` 继续写盘；旧 finally 清掉新 children | `installer.ts:353-372,1420-1422` | WP6 |
| P0-15 | `updater` 的 stop 只看内存状态，外部运行中的 ComfyUI 会被直接覆盖 | `updater.ts:799-835` | WP6 |
| P0-16 | Python 运行时分裂：uv 路径已硬编码 3.13，非 uv 仍 3.12；旧 3.12 venv 无迁移 | `installer.ts:1037-1071`、`constants.ts:224-250` | WP6 |
| P0-17 | 用户显式清空实例选择后，`refreshInstances()` 又自动选回 `instances[0]` | `stores/app.ts:174-180`、`App.vue:235-251` | WP1 |

### 4.2 P1（按域）

| # | 缺陷 | 证据 | WP |
|---|---|---|---|
| N1 | TaskCenter 把 `update-batch` 的 `phase/index/total` 当 `done/running/cancelled`，第一个 `checking` 就 finish | `ops.ts:321-347`、`types.ts:1472-1490` | WP1 |
| N2 | 批量更新没有主进程终端通知；切走页面完全静默 | `nodePack.ts:2532-2684`、`handlers.ts:1142-1146` | WP1 |
| N3 | “全部停止”忽略 `exited === false`，未退出报成功 | `InstancesView.vue:701-710` | WP1 |
| N4 | 节点更新先 `message.success` 再 `refresh()`；刷新失败被吞，旧数据被标记已更新 | `NodesView.vue:340-364,510-536` | WP1 |
| N5 | `installRequirementsFor` 返回 `installed:[]` + 固定 warning；`notifyPipResult` 弹 `Package verification note` | `pipOps.ts:242-246`、`handlers.ts:2283-2289` | WP2 |
| N6 | `comparePipVersions('1.0','1.0.0')` 错、`1.0.0rc1` 大于 `1.0`、`post` 排序错 | `pipVersion.ts:135-201` | WP2 |
| N7 | `pip list` JSON 被 stderr 污染；解析失败报“环境不可用” | `env.ts:59-68`、`nodePack.ts:114-132` | WP2 |
| N8 | 嵌套包 `path` 记录外层 shell，requirements/`__init__.py` 在 packed 内 | `nodePack.ts:952,996,3124,3213` | WP2 |
| N9 | `installDeps` 绕过 `allowPipInstall` | `nodePack.ts:1801-1824,3210-3219` | WP2 |
| N10 | audit 与 pip op 并发，抓半成品快照 | `nodePack.ts:3119-3203` | WP2 |
| N11 | `startupIssues` 路径遇空格截断、无 prestartup、`lastPack` 跨 traceback 泄漏 | `startupIssues.ts:12-16,31-77` | WP3 |
| N12 | `nodeLoadReport` reasons 不 strip ANSI；重复 header 只取最后一个；policy refusal 永久累积 | `nodeLoadReport.ts:65-107` | WP3 |
| N13 | `.bak`/`._clone_tmp_`/`._install_*.zip` 也不在 recovery 范围；回滚 sweep 可能误删用户目录 | `nodePack.ts:3481-3506,2976-2992` | WP3 |
| N14 | 可选模块 `torch_npu`/`OpenGL_accelerate` 被当硬缺失；Manager 探测无失败锚点也成 issue | `startupIssues.ts:73-77` | WP3 |
| N15 | Dismiss 只清前端 ref，刷新即回来；无持久化 ack | `InstanceDetailView.vue:1505-1517` | WP3 |
| N16 | 深链大多只在 mount 读一次；`?focus` 不搜 path/folder、不清 `loadFailedOnly`、不滚动/高亮 | `NodesView.vue:766-773`、`OutputView.vue:792-800`、`BatchView.vue:501-510` | WP4 |
| N17 | Workflows 远程队列被本地 `instanceRunning` 禁用；Batch 用活动实例而不是 `job.instanceId` | `WorkflowsView.vue:425-439`、`BatchView.vue:60-72` | WP4/WP8 |
| N18 | `LaunchProfileEditor` 的 `'default'` option 与 `undefined` 不映射；`changedCount` 把默认算修改 | `LaunchProfileEditor.vue:51-157` | WP5 |
| N19 | `extraArgs` 三处 `split(/\s+/)`；详情页无编辑入口；`--flag=value` 去重不识别 | `InstancesView.vue:120-121`、`instance.ts:1087-1125` | WP5 |
| N20 | `launchProfile.outputDirectory` 已进 argv，但 OutputView/主进程只读 `extraArgs` | `OutputView.vue:322-337`、`p1p2.ts:64` | WP5 |
| N21 | 静态 CATALOG 缺 ComfyUI 0.43 新参数（`--enable-agent`、`--disable-product-tips` 等） | `launchArgs.ts:237-351` | WP5 |
| N22 | `resolveReadTarget` 的读回退被 `installer.installStarter` 用于写模型 | `installer.ts:1533-1548`、`target.ts:58-63` | WP8-A |
| N23 | 预检按 basename 匹配模型，`SDXL/model` 与 `SD15/model` 互相误判；损坏 workflow 仍 `available:true` | `preflight.ts:100-157`、`shared/preflight.ts:48-49` | WP8-A |
| N24 | `settings.importConfig` 可把 securityLevel 改 weak、允许 git/pip 安装 | `security.ts:432-460`、`handlers.ts:396-441` | WP8-A |
| N25 | `safeStorage` 不可用时静默明文；`settings.get`/`remote.list` 明文返回凭据 | `secretStorage.ts:8-32`、`db.ts:588-599,1015-1029` | WP8-A |
| N26 | 媒体协议只做词法 containment，output/thumbs 根内 symlink 可读任意文件 | `media.ts:278-298`、`security.ts:119-132` | WP8-A |
| N27 | `output.open` 只按扩展名黑名单，不限根/realpath/魔数 | `security.ts:235-278`、`handlers.ts:1919-1925` | WP8-A |
| N28 | `readTextTail` 用 `allocUnsafe` 且忽略 `readSync` 返回值，短读泄露未初始化内存 | `logFile.ts:40-42` | WP8-A |
| N29 | `session.json` 非原子、单文件多实例共享，损坏默认 clean | `session.ts:43-67` | WP8-A |
| N30 | 退出 `flushPendingWrites()` 失败被忽略后 `app.exit(0)` | `index.ts:888-898`、`db.ts:461-495` | WP8-A |
| N31 | 日志/pip/node-op 每行一次 IPC + 每行 `writeFileSync`；batch progress 每次传完整 Job | `instance.ts:236-267`、`index.ts:616-617,770,791`、`p1p2.ts:382-697` | WP8-B |
| N32 | `BatchService.startAsync` 在 `runningIds.add()` 前 await，紧接 `list()` 自愈成 interrupted | `p1p2.ts:430-449,522-559,262-280` | WP8-B |
| N33 | resume 用 `submitted + failed` 估算已尝试数，exec 失败重复计算 | `p1p2.ts:350-353,659,671-681` | WP8-B |
| N34 | Registry 全量索引失败页直接覆盖完整旧索引 | `registryIndex.ts:217-261` | WP8-B |
| N35 | 输出索引外部手改不 bump revision，列表缓存永久陈旧 | `db.ts:415-426,902-905`、`p1p2.ts:1161-1174` | WP8-B |
| N36 | `capabilities` 缓存按 baseUrl 不按 instanceId，并发 probe 无 single-flight | `capabilities.ts:123,144-148,221-230` | WP8-B |
| N37 | `netProbe` 任何 HTTP 响应算健康，session 失败回退直连；HEAD 405 不 GET | `netProbe.ts:100-143` | WP8-B |
| N38 | `comfyApi`/`monitor.queueSnapshot` 用全局 `fetch` 不走代理 | `comfyApi.ts:40-45`、`monitor.ts:370` | WP8-B |
| N39 | `release.yml` 的 mac/linux 不跑测试/lint/version；Windows 也只 build+package | `.github/workflows/release.yml:20-77` | WP9 |
| N40 | `files: out/**` 含 preload/renderer，extraResources 又复制一份；未使用依赖/类型版本错配 | `electron-builder.yml:11-32`、`package.json:49-63` | WP7 |
| N41 | `engines.node >=20` 与实际 Vitest 5 / Vite 8 / ESLint 10 要求不一致 | `package.json:87-89`、`README:126` | WP7 |
| N42 | `output.exportZip` 同名 basename 冲突；`zipWrite` 无原子写 | `p1p2.ts:1530-1536`、`zipWrite.ts:42,59-135` | WP8-B |
| N43 | `workflow.remove` 同目录同名 json/png 当兄弟文件删除 | `workflow.ts:800-809` | WP8-B |
| N44 | `model.reconcile` 用全局文件名集合，跨类别同名掩盖缺失；scan 不重算已有哈希 | `model.ts:1482-1488,530-539` | WP8-B |
| N45 | `workflowFingerprint` 索引签名不含名称，改名 5 秒内归因旧名 | `workflowFingerprint.ts:93-104` | WP8-B |

### 4.3 P2（择要）

- 托盘/桌面/会话：`tray` destroy 不移除 status 监听；`refreshTray` 并发无单飞；`desktop` 用 `%USERPROFILE%/Desktop`、Linux 开机自启无效；`boot.log` 无轮转；`slowOps` 全局 pause 误伤其他 IPC。
- 安装/更新：同路径重装覆盖 `name/extraArgs/launchProfile/argTemplateId/pinned/autoStart/notes`；`pickPort` 最后无条件 8388；zip 复用写 `comfyFetchedAt`；`.cp-old` 归档不恢复。
- 节点：`updateAll` 用 name 而非 id；内层 install 提前清更新横幅；pip 失败仍发成功通知；`lastCheckedAt` 安装即写。
- 模型/产物：缩略图不缩放/不刷新/Civitai 不校验 content-type；输出 ghost 行不清理；ZIP 同名冲突。
- 渲染层：`ModelsView` 切实例 refresh/scan 并发；`BackupView` 预览关闭后被迟到响应重开；`MarketView` `loadCurrentPage` 无 seq；`DoctorView` fix 后不校验实例；`SettingsView` 远程失败显示空；`EmbedView` 错误卡条件写错。
- i18n/a11y：Doctor 英文直出；日期使用 `toLocaleString` 不跟 locale；部分卡片无键盘/aria；`IndeterminateBar` 缺 progressbar 语义。

---

## 5. 用户报告问题：根因与修复

### 5.1 节点更新完成时，把未读通知全部弹出来

**代码链**：
1. `stores/app.ts:68-75` 从 localStorage 恢复 `notificationSeq`（例如 250）。
2. `App.vue:297` 的 `notifiedSeq` 从 0 开始。
3. 第一条新通知到达时 `newCount = 250+1`，`start = max(0, items.length - newCount) = 0`，循环把 200 条历史全部弹一遍（`App.vue:301-324`）。
4. 通知中心另用 `cp.notifications.readSeq`，与历史 seq 可能不同步（`NotificationCenter.vue:18-70`）。

**根因**：通知只有“历史”，没有“toast 队列/已读”生命周期；用 seq 差值推断新通知，历史与游标跨会话失配。

**修复（WP1）**：
- `AppNotification` 增 `id/at/dedupeKey/readAt/action`。
- Store 拆 `notifications`（200 条持久化）与 `toastQueue`（会话内）；App 只消费 toastQueue，消费后移除，不再用 seq 差值。
- 未读 = `items.filter(!readAt).length`；打开通知中心标读；增加“全部已读”；迁移旧 `readSeq`。
- 主进程 `dedupeKey`；批量更新只发一条汇总；通知中心与视图 `message.success` 不重复。
- 同时修：清空实例后不被 `refreshInstances` 选回；`stopAll` 统计 `exited:false`；节点更新只有 refresh 成功才报成功；TaskCenter 按 `phase` 映射。

**验收**：50 条历史 + 1 条新 → 1 条 toast；重开不重弹；批量更新 1 条汇总。

### 5.2 依赖体检补装后还在；弹 `Package verification note`

**不是单点 Bug，是三层叠加**：

| 层 | 缺陷 | 证据 | 后果 |
|---|---|---|---|
| A | `parsePipRequirement` 直接截掉 `; marker`，审计把平台/版本不适用依赖当缺失 | `pipVersion.ts:66-68`、`nodePack.ts:3126-3131` | 假缺失永远修不掉 |
| B | `outputIndicatesFailure` 看到 `Successfully installed`/`Installed N` 就返回 false，部分安装被当整体成功 | `env.ts:82-92` | 补装“完成”，失败项仍在 |
| C | `installRequirementsFor` 固定返回 `installed:[]` + 通用 warning；`notifyPipResult` 弹 `Package verification note` | `pipOps.ts:242-246`、`handlers.ts:2283-2289` | 每次补装都弹无意义提示 |
| D | `fixPackDeps` 用 `activeInstanceId`，审计用 `localTargetId` | `NodesView.vue:738-740 vs 726` | 可能装错实例 |
| E | PEP 440 比较错误：`1.0 != 1.0.0`、`rc`/`post` 排序错 | `pipVersion.ts:135-201` | 假版本不符 |
| F | `pip list` JSON 被 stderr 污染 | `env.ts:59-68`、`nodePack.ts:114-132` | 审计报环境不可用 |
| G | 嵌套包 `path` 是外层 shell | `nodePack.ts:952,996,3124,3213` | 审计跳过/补装 NO_REQUIREMENTS |
| H | `installDeps` 绕过 `allowPipInstall` | `nodePack.ts:1801-1824,3210-3219` | 设置与行为不一致 |
| I | audit 与 pip op 并发 | `nodePack.ts:3119-3203` | 抓半成品快照 |

**修复（WP2）**：
1. marker 按目标解释器求值（`pip._vendor.packaging` 优先，JS 兜底）；未知 marker 标 `unknown`，不报缺失。
2. 支持 `-r`/`-c` 递归、续行、extras、URL/VCS；不可审计行进 `unsupported`。
3. 别名表（`OpenGL_accelerate → PyOpenGL-accelerate`、`cv2 → opencv-python`、`PIL → Pillow` 等）。
4. PEP 440 版本比较：补齐尾零，显式 `dev < a < b < rc < release < post`。
5. `pip list` JSON 从输出中截取 `[...]`；失败改用 `importlib.metadata` 脚本。
6. 安装后逐项 `pip show` 验证；返回 `PipReceipt { installed, skipped, unresolved, failed, markersEvaluated }`；`ok` 只在 unresolved/failed 为空时为 true；删除通用 warning。
7. UI 主按钮“补齐缺失项”，只传 missing/mismatched specs；补装后显示 before/after 与未解决原因。
8. 嵌套包 `path` 改真实包根；`installDeps` 检查 `allowPipInstall`；audit 与 pip op 共用 `EnvOperationLock`；`pyproject.toml` 依赖纳入。
9. 新增 `EnvMarker`（`.comfypilot-env.json`）记录实际解释器 `sys.executable/sys.prefix/site-packages`；审计/补装/启动必须同 `envId`，不一致 `ENV_MISMATCH`。

**验收**：Windows 上 marker 不适用 → 0 缺失；混合成功/ERROR → `ok:false`；真正装好后重新体检清空；干净补装不再出现 `Package verification note`。

### 5.3 每次启动都有“节点加载失败（2）”，且没有地方解决

**A. `video2dlssnr.trash-*`：ComfyUI 会加载，但 ComfyPilot 不让处理**
1. `nodePack.uninstall` 把包重命名为 `<target>.trash-<ts>` 放在 `custom_nodes` 内，再 `rmSync`；Windows 占用时删除失败（`nodePack.ts:2097-2109`）。
2. ComfyUI 只移除 `__pycache__`、只跳过 `.disabled` 结尾的顶层项，不跳过隐藏目录；`.trash-*` 被当节点包加载（ComfyUI `nodes.py:2368-2385`）。
3. `isJunkPackName` 把 `.trash-*` 从列表隐藏（`nodePack.ts:258-274`）。
4. `scanRecovery` 不扫 `.trash-*`/`._clone_tmp_*`/`._install_*.zip`（`nodePack.ts:3457-3507`）。
5. `parseStartupIssues` 不忽略 transient；路径正则遇空格截断；无 `PRESTARTUP FAILED`。
6. `analyzeStartupIssues` 读最后 3000 行，无本次启动边界；self-check 写进主日志。
7. `parseNodeLoadReport` policy refusal 无正向清除；`Cannot import` 原因不 strip ANSI。
8. “去修复”只 `router.push('/nodes')`，没有 focus；即使带 focus，列表也没有 `.trash-*` 行。

**B. `torch_npu` / `OpenGL_accelerate`：可选/平台模块被当硬缺失**
- `parseStartupIssues` 只要看到 `No module named` 就挂到 `lastPack`，不判断 try/except、平台可选。
- `torch_npu` 是昇腾 NPU 专用；`OpenGL_accelerate` 是 PyOpenGL 可选加速；`No OpenGL_accelerate module loaded` 本身是 INFO、无害。
- Manager 探测没有 `IMPORT FAILED` 时不应变成“节点加载失败”。
- 卡片没有持久化忽略，刷新就回来。

**修复（WP3/WP4）**：
1. 启动 boot marker（`=== ComfyPilot boot <bootId> <iso> ===`）；`analyzeStartupIssues` 只解析本次 boot；self-check 用独立 `kind='selfcheck'` session。
2. 解析器只在有 `IMPORT FAILED`/`PRESTARTUP FAILED`/`Cannot import`/`temporarily disabled` 时建 issue；`No module named` 必须同 traceback 块；`lastPack` 边界重置；路径允许空格；支持 prestartup；与 `list()` 交叉验证。
3. transient 目录过滤；可选模块进 `optionalModules`，不计 error；Manager 探测降级为 info。
4. **残留隔离区**：临时/备份目录统一放 `custom_nodes/.disabled/.trash-*` / `.bak-*`；安装临时目录放 `userData/app-cache/node-tmp/`；启动前自动 quarantine 顶层 `.trash-*`/`.bak-*`/`._clone_tmp_*`/`._unzip_tmp_*`，不删除。
5. `scanRecovery` 扩展 `trash` 类型 + `.disabled` 内部；UI 显示路径/大小/时间，支持还原/清理/全部清理。
6. `issues.jsonc` 持久化 `fingerprint → {dismissedAt, ignoredPacks}`；fingerprint 含 instance+pack+模块+mtime+bootId；包更新/新 boot 重新提示；支持“显示已忽略”。
7. 每条 issue 动作：安装模块、运行依赖体检、隔离/清理残留、打开节点页（带 instance/focus/source）、忽略/已修复。

**验收**：`.trash` 自动隔离，ComfyUI 不再 IMPORT FAILED；旧 boot 失败不再出现；可选模块不计 error；忽略后重启不提示，包变更后重新提示。

### 5.4 详情页“去修复”跳到节点页却什么都没有

**代码链**：
- `reviewStartupIssues()` 只 `router.push('/nodes')`（`InstanceDetailView.vue:574-576`）。
- `goPack(f)` 带 `?focus=<packFolder>`，但没带 instance；`applyFocus` 只写 `installedQuery`（`NodesView.vue:766-773`）；不搜 path/folder、不清 `loadFailedOnly`、不滚动/高亮。
- focus 命中 `.trash-*`/`.bak-*` 时列表为空；空态没有解释/清理入口。
- 无 `packFolder` 时连按钮都没有。

**修复（WP4）**：
- 统一深链 `NodesDeepLink { instanceId, focus, source, module, issueId, showRecovery }`；`router.push({ path:'/nodes', query:{...} })`。
- NodesView：先切实例 → `loadSeq` 等 refresh → 匹配 `name/displayName/path/folder` → 清冲突过滤 → 高亮/滚动 → 顶栏上下文条（安装模块/体检/隔离/显示全部）。
- 未匹配：`.trash` 显示“残留，ComfyUI 仍会加载” + “隔离并清理”；否则“未找到 X（已删除/已禁用/属于其他实例）” + 显示全部/切换实例/去市场。
- query 消费后 `router.replace` 移除；watch query，不只 mount；`#logs`/`?workflowId`/`?jobId` 同样 watch。
- `IssueCenter` 作为统一入口；详情页启动卡/运行失败卡都指向它。

### 5.5 启动参数自定义

**现状**：`extraArgs` 只在创建/编辑弹窗；三处 `split(/\s+/)`；详情页只预览不编辑；`--flag=value` 去重不识别；CATALOG 静态。

**修复（WP5）**：
- 新增 `shared/argv.ts`：`parseArgv` 支持单/双引号、反斜杠、`--flag=value`、未闭合报错；`formatArgv` 可逆；`splitFlagArg`。
- 所有 split 替换；旧数组原样保留。
- `LaunchProfileEditor` 增 `v-model:extra-args`：多行输入、token 预览、错误/警告、每行一个参数开关；详情页保存 `extraArgs`。
- `instance.launchArgCatalog` 读取当前实例 `comfy/cli_args.py`，动态补全/未知 flag；静态 CATALOG 补 0.43。
- 导出 `.bat/.sh` 用 `formatArgv`。
- 修 `'default' ↔ undefined` 映射与 `changedCount`。
- `resolveOutputDir` 抽 shared，同时读 `extraArgs` 与 `launchProfile.outputDirectory`。

### 5.6 Python 3.13

**现状**：
- 便携包 3.12.11；`findInRuntimes` 只认 `python3.12`；系统探测 312→311→313。
- installer 的 uv 路径硬编码 3.13，非 uv 路径仍 3.12；`repairEnv` 不写回 `venvPath`。
- 无 Python 版本字段、无版本化 runtime、无迁移。

**上游事实**：ComfyUI 官方推荐 Python 3.13；Windows 便携包 3.13 + torch cu130；PyTorch 2.7+ 最低；cp313 cu124 只有 torch 2.6.0（低于 2.7），因此 0.2.0 删除 cu124。

**修复（WP6）**：只支持 Python 3.13.18；旧 3.12 实例启动阻断并迁移；旧运行时归档不参与运行；详见 §8。

---

## 6. 0.2.0 WP 设计

> 依赖顺序：**WP7 → WP8-A → WP6 → WP1/WP2/WP3/WP4 → WP5 + WP8-B/C/D → WP9**。
> 每个 WP 的验收 = 行为测试 + 可复现动作；不接受“只改代码不验行为”。

### WP1 通知与反馈：只提示新的

**目标**：通知中心是历史，toast 是“此刻”；节点更新/安装只发有意义的终端通知；目标不被静默改回。

**任务**：
1. `AppNotification` 增 `id/at/dedupeKey/readAt/action`。
2. Store 拆 `notifications` + `toastQueue`；`pushNotification` 生成 id/at；`dedupeKey` 10s 去重；`markRead/unreadCount/consumeToast`。
3. `App.vue` 删除 `notifiedSeq` 差值逻辑，改为消费 `toastQueue`；最多 3 条并发；不再回放历史。
4. `NotificationCenter` 未读从 `readAt` 算；持久化同一 key；全部已读；迁移旧 `readSeq`。
5. 主进程：`node.install/update` 用 dedupeKey；`node.updateAll` 一条汇总；`notifyPipResult` 用 i18n key，只有 unresolved 告警；`broadcastNotification` 增 dedupeKey/action。
6. 同时修：清空实例不被 `refreshInstances` 选回；`stopAll` 统计 `exited:false`；节点 refresh 失败不报成功；TaskCenter 按 `phase` 映射。

**文件**：`shared/types.ts`、`stores/app.ts`、`App.vue`、`NotificationCenter.vue`、`handlers.ts`、`ops.ts`、`NodesView.vue`、`InstancesView.vue`。

**测试**：`notificationStore`、`useNotificationToasts`、`ops`、`appStoreTarget`、`NodesView.dom`、`TaskCenter.dom`。

**验收**：50 历史 + 1 新 → 1 toast；批量更新 1 条汇总；清空实例不自动选回；`exited:false` 警告。

### WP2 依赖审计与补装闭环

**目标**：只报当前环境真正适用且确实缺失的依赖；补装后能证明；失败有具体原因；不再有通用 warning。

**任务**：§5.2 的 1-9 全部落地。
- `shared/pipVersion.ts`：marker、PEP 440、`-r`/续行。
- 新 `main/services/depsAudit.ts`：collectRequirements / evaluateMarkers / installedPackages / pip check。
- `shared/pipAliases.ts`。
- `env.installRequirements` + `installSpecs`；`outputIndicatesFailure` 逐行判定。
- `pipOps.installRequirementsFor` 返回 receipt；`node.installDeps` 接受 specs；UI before/after。
- `EnvMarker` + `EnvOperationLock`；`allowPipInstall` 检查；pyproject 依赖。

**文件**：`pipVersion.ts`、`pipAliases.ts`、`depsAudit.ts`、`env.ts`、`pipOps.ts`、`nodePack.ts`、`NodesView.vue`、`handlers.ts`。

**测试**：`depsAudit`（marker/extras/include/alias/unknown/partial/pip check）、`pipOps`（receipt/unresolved/no warning）、`NodesView.dom`。

**验收**：§5.2 验收；干净补装不再出现 `Package verification note`。

### WP3 启动问题生命周期与残留隔离

**目标**：每次启动不复现旧问题；ComfyPilot 自己的残留不再被 ComfyUI 加载；每个问题可隔离/清理/忽略。

**任务**：
1. boot marker + self-check 独立 session。
2. 解析器收紧（失败锚点、lastPack、prestartup、空格路径、transient、optional、Manager 降级、ANSI）。
3. 残留隔离区与自动 quarantine；`scanRecovery` 扩展 `trash`/clone/zip；`recoveryCleanAll`。
4. `issues.jsonc` ack/fingerprint；UI 启动卡改为 IssueCenter 内嵌视图。
5. `nodeLoadReport` 按 session、合并多 header、case-fold、policy 正向清除。

**文件**：`startupIssues.ts`、`nodeLoadReport.ts`、`instance.ts`、`nodePack.ts`、`issueHub.ts`、`InstanceDetailView.vue`、`NodesView.vue`。

**测试**：`startupIssues`、`nodePackRecovery`、`nodeLoadReport`、`issueHub`、`InstanceDetailView.dom`。

**验收**：§5.3 验收；自动隔离后下一次启动 0 IMPORT FAILED。

### WP4 IssueCenter 与诊断深链

**目标**：所有问题有一个统一去处；每个问题有动作；从详情/节点页/仪表盘都带上下文到达。

**任务**：
- `shared/issues.ts`：`AppIssue`、`IssueAction`、fingerprint。
- `issueHub.ts`：聚合 startup/exec/node-load/deps/doctor；scan/dismiss/resolve/list；`issues.jsonc`；`event:issues-changed`。
- IPC：`issue.list/scan/dismiss/restore/resolve`。
- `IssueCenter.vue`：过滤/分组/动作/全部已读/全部忽略/重新检查。
- 入口：App header、Dashboard、InstanceDetail、NodesView。
- 深链：`nodesDeepLink`；NodesView 切实例/匹配/高亮/空态/清 query；watch query。
- `runIssueAction` 统一调用现有 IPC；成功后 resolve + scan。

**文件**：`issues.ts`、`issueHub.ts`、`IssueCenter.vue`、`InstanceDetailView.vue`、`NodesView.vue`、`DashboardView.vue`、`App.vue`、`router/deepLinks.ts`。

**测试**：`issueHub`、`nodesDeepLink`、`NodesView.dom`、`IssueCenter.dom`、e2e 深链。

**验收**：§5.4 验收；三处入口到同一 issue；关闭后状态持久化。

### WP5 自定义启动参数

**目标**：详情页/编辑弹窗都能设置任意参数；引号路径不碎；来源/冲突可见；导出可复现。

**任务**：§5.5 全部；新增 `shared/argv.ts`、`cliArgsCatalog.ts`、`instance.launchArgCatalog`；`LaunchProfileEditor` 自定义区；`resolveOutputDir` 统一。

**文件**：`argv.ts`、`launchArgs.ts`、`cliArgsCatalog.ts`、`InstanceDetailView.vue`、`InstancesView.vue`、`LaunchProfileEditor.vue`、`instance.ts`、`p1p2.ts`、`OutputView.vue`。

**测试**：`launchArgs`（引号/反斜杠/等号/未闭合）、`cliArgsCatalog`、`LaunchProfileEditor.dom`、`OutputView` 自定义输出目录。

**验收**：§5.5 验收。

### WP6 Python 3.13 运行时

**目标**：0.2.0 只支持 Python 3.13.18；旧 3.12 实例阻断并迁移；torch 矩阵与 3.13 匹配；安装/诊断/设置只展示 3.13。

**任务**：见 §8。核心：
- `constants.ts`：新 `RUNTIME_SOURCES` + `PYTHON_RUNTIME_VERSION` + `TORCH_PYTHON_MATRIX`。
- `bootstrap.ts`：只解析 3.13；旧 runtime 归档；`BootstrapStatus.pythonVersion/supportedPython/legacyPython`。
- `installer.ts`：只用 3.13；删除 cu124；`verifyTorchChannel` 最低 2.7；修 reset/cancel/samePath/venv 版本。
- `env.ts`/`doctor.ts`：非 3.13 → `PYTHON_UNSUPPORTED`/`PYTHON_MIGRATION_REQUIRED`；迁移动作。
- `instance.ts`：启动前检查 venv 版本；`.venv` 解析；阻断状态。
- `types.ts`：`InstanceStatus` 增 `migration-required/migration-failed`；`MigrationState`。
- UI：Install/InstanceDetail/Settings 只展示 3.13；阻断式迁移向导。
- `updater.ts`：用统一解释器解析；外部运行进程拒绝覆盖；verify 后取消不回滚。
- `processTree.ts`/`instance.ts`：Windows 树杀等待真实退出；remove/forceKill/quit 统一树杀。
- `pipVersion.ts`/`env.ts`：PEP 440、pip/uv 输出、ensurePip、timeout 等树杀。

**测试**：`pythonResolve`、`bootstrapSources`、`installerService`、`updaterPipeline`、`processTree`、`envService`、`doctorService`、`dataMigration`。

**验收**：§8.6。

### WP7 依赖与工具链升级

**目标**：依赖到当前受支持版本；TS6.0.3；Electron 45.2.1；构建/测试/e2e 全绿；不引入 TS7。

**任务**：§7 的批次 A-D；删除未使用依赖；修 `baseUrl`；补 `@eslint/js`；打包去重；`engines.node`。

**验收**：§7.4。

### WP8 架构收口（分 A/B/C/D）

**目标**：领域模块 + 运行时校验 + 单一事实源；安全/数据 P0 先修。

**WP8-A 安全/数据**（P0，先于 WP6）：
- 凭据端点绑定；凭据不跨 IPC 明文；备份事务/journal/v2；锁定 remote 不删除；恢复后应用 proxy/launchOnBoot/tray。
- `PathPolicy` realpath + 根 + 魔数；媒体协议；`output.open/exportZip`；`output.open` 根限制。
- IPC sender 校验；可执行路径 allow-list；`settings.importConfig` 安全字段确认；sandbox/CSP。
- `readTextTail` bytesRead；`session.json` 原子/分实例；`boot.log` 轮转。
- `ReadTarget/WriteTarget` branded type；`installStarter` 写目标。
- 预检 basename → category/subdir/filename；损坏 workflow `available:false`。
- `flushPendingWrites` 失败不静默 exit；后台 import 失败留痕。

**WP8-B IPC/类型**：
- `ipc/contract.ts` + `ipc/domains/*` + zod；`handlers.ts` <200 行。
- 删除 `types.ts` 单体，改 `shared/types/*`；不保留 re-export。
- 允许破坏性通道/参数；preload 白名单同源；sender 校验。
- `IpcResult` 增 messageKey/params/detail/retryable。

**WP8-C 服务拆分**：
- `nodePack`、`p1p2`、`instance`、`db` 直接抽模块；不保留 facade。
- 修 startAsync/runningIds、resume 计数、Registry partial index、输出 revision、capabilities cache、netProbe、comfyApi proxy、event backpressure、batch progress 增量。
- 数据 v2 单向迁移；`issues.jsonc`；外部手改 revision。

**WP8-D 渲染层基建**：
- `useScopedResource`、`useAsyncAction`、`OperationHub`、`NotificationBus`、`ErrorBoundary`、深链协议、订阅生命周期。
- 修 Monitor/Models/Nodes/Output/Market 竞态；Backup 预览；Settings 远程错误；Embed 错误卡；Workflows 远程队列；Batch 目标实例。

**测试**：`ipcHandlers.domains`、`ipcContract.runtime`、`security`、`backupService`、`dataMigration`、`eventBackpressure`、`useScopedResource`、`exitFlush`、`releaseGates`。

**验收**：P0-6–P0-11 与 N22–N30 各自回归；handlers <200 行；新通道 zod+sender；行为测试零回归。

### WP9 测试、门禁与发布

**目标**：每个修复有行为测试；覆盖率分母变真；Windows 真机验收；README/版本/发布一致。

**任务**：
- 新增测试清单见 §9；目标 1,900–2,050 用例；behavior ≥95%。
- coverage include 新模块；`handlers`/preload/`index` 纯函数纳入；每文件 floor。
- e2e：打包产物 + UI 流（通知、深链、导入、10k 日志）。
- CI：lint `--max-warnings=0`、prettier、engine-strict、audit/OSV。
- release：`gate` job + `needs`；全平台 tag/version；SHA256；mac zip/签名策略明确。
- Windows 真机 3 次安装/卸载；Python 3.13 迁移；依赖补装；残留清理；自定义参数。

---

## 7. 依赖升级矩阵与顺序

### 7.1 运行时依赖

| 包 | 当前 | 0.2.0 | 说明 |
|---|---:|---:|---|
| electron | 45.0.0 | **45.2.1** | 同 major；Node 24；e2e/NSIS 回归 |
| electron-builder | 26.15.3 | **26.18.0** | NSIS 模板已修复 |
| electron-updater | 6.8.9 | **6.8.11** | 自动更新 |
| vue | 3.5.43 | **3.5.44** | patch |
| vue-router | 4.6.4 | **5.4.0** | `type: module`；按破坏性升级验证 |
| pinia | 2.3.1 | **4.1.0** | ESM only；`@vue/devtools-api@8.2.1` |
| vue-i18n | 10.0.7 | **11.4.17** | 已 `legacy:false`；检查 `tc/$tc` |
| naive-ui | 2.45.3 | **2.45.3** | 最新；范围收紧 |
| @vueuse/core | 12.8.2 | **删除** | 源码零 import |
| echarts | 5.6.0 | **删除** | 源码零 import |
| dayjs | 1.11.23 | **删除** | 源码零 import |
| systeminformation | 5.33.15 | **5.33.19** | GPU/磁盘 |
| ws | 8.22.0 | **8.22.1** | ComfyUI WS |
| js-yaml | 5.4.3 | **5.5.0** | 删 `@types/js-yaml` |
| zod | — | **4.6.7** | IPC 校验 |
| @vue/devtools-api | — | **8.2.1** | Pinia 4 peer |

### 7.2 开发依赖

| 包 | 当前 | 0.2.0 | 说明 |
|---|---:|---:|---|
| typescript | 5.9.3 | **6.0.3** | TS7 不可用；用 `~6.0.3` |
| vue-tsc | 2.2.12 | **3.3.14** | 配 TS6.0.3 |
| @types/node | 22.20.5 | **24.19.2** | 对齐 Electron 45 |
| eslint | 9.39.4 | **10.14.0** | flat config |
| eslint-plugin-vue | 9.33.0 | **10.12.0** | 配 ESLint 10 |
| @typescript-eslint/* | 8.71.1 | **8.72.1** | peer TS `<6.1.0` |
| vue-eslint-parser | 9.4.3 | **10.4.1** | peer `^10.3.0` |
| @vue/eslint-config-typescript | 14.9.0 | **删除** | 未被 import |
| @vue/eslint-config-prettier | 10.2.0 | **10.2.0** | 保持 |
| @eslint/js | 未显式 | **10.0.1** | 显式依赖 |
| @types/js-yaml | 4.0.9 | **删除** | js-yaml 5 自带类型 |
| happy-dom | 20.14.6 | **21.0.4** | DOM 测试 |
| sass | 1.105.1 | **1.107.1** | 样式 |
| prettier | 3.9.9 | **3.9.10** | patch |
| vite / vitest / electron-vite | 8.3.5 / 5.0.5 / 6.0.0 | 保持 | 最新 |
| @vitejs/plugin-vue | 6.0.10 | **6.0.10** | 最新 |

`engines.node` 改为 `^22.13.0 || >=24.0.0`，加 `.npmrc` `engine-strict=true`，CI Node 24。

### 7.3 TypeScript 6 的证据与迁移

- TS 7.0.2 + vue-tsc 3.3.14：`ERR_PACKAGE_PATH_NOT_EXPORTED: './lib/tsc'`。
- TS 6.0.3 + vue-tsc 3.3.14：最小 Vue SFC `vue-tsc --noEmit` exit 0。
- `@typescript-eslint@8.72.1` peer `typescript >=4.8.4 <6.1.0` → 6.0.3 是生态上限。
- 当前 `tsconfig.node.json:17`、`tsconfig.web.json:19`、`tsconfig.test.json:17` 有 `baseUrl`；TS6 报 `TS5101`。升级时删除 `baseUrl`，`paths` 改相对 `./src/...`，不要用 `ignoreDeprecations` 长期绕过。

### 7.4 升级顺序与回滚

1. **批次 A**：Electron 45.2.1、builder 26.18、updater 6.8.11、Vue 3.5.44、Naive、systeminformation、ws、js-yaml、sass、prettier、plugin-vue、@types/node 24；删除未使用依赖 `@vueuse/core`/`echarts`/`dayjs`/`@types/js-yaml`。
2. **批次 B**：TS 6.0.3 + vue-tsc 3.3.14 + ESLint 10 + 插件链；删 `baseUrl`；删 `@vue/eslint-config-typescript`；补 `@eslint/js`。
3. **批次 C**：Pinia 4 + Router 5 + i18n 11 + happy-dom 21 + zod/devtools-api。
4. **批次 D**：打包去重（`files` 排除 `out/preload/**`、`out/renderer/**`）、asar 清单断言、三平台 `--dir`、Windows NSIS 安装/卸载 3 次。

每批：`npm ci` → typecheck ×3 → vitest → lint `--max-warnings=0` → build → e2e；失败即停，不混批。

---

## 8. Python 3.13 迁移设计

### 8.1 版本钉（20261026 / 3.13.18）

| 平台 | 资产 | 大小 | SHA256 |
|---|---|---:|---|
| Windows x64 | `cpython-3.13.18+20261026-x86_64-pc-windows-msvc-install_only_stripped.tar.gz` | 22,023,022 | `7369f7a35f261222a6ac8b3a87c1c88eeebee8af945d85346202591a64038dd3` |
| Linux x64 | `cpython-3.13.18+20261026-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz` | 35,395,906 | `df15fe60d3ff55bf9dcf25824b5572756bb8816ff93865a273d3301d7066a8b7` |
| Linux arm64 | `cpython-3.13.18+20261026-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz` | 29,492,455 | `578d9da1983463ffb0c8c98ab0da2f18177f44069328eb0af847860c1eb05c3e` |
| macOS arm64 | `cpython-3.13.18+20261026-aarch64-apple-darwin-install_only_stripped.tar.gz` | 25,265,774 | `8392b6ea51d94391befb2c31ebe75463f045d0b69dfcf5e1bb3234e1f5fa3405` |
| macOS x64 | `cpython-3.13.18+20261026-x86_64-apple-darwin-install_only_stripped.tar.gz` | 25,055,263 | `7412c19d896c99431b74a18a5643e110449a7f9590fbab179c3e5ab27b9aa9e3` |

| 运行时 | 版本 | SHA256（Windows x64） |
|---|---|---:|
| uv | **0.13.6** | `a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f` |
| MinGit | **2.56.0.4** | `e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877` |

uv 其他平台：Linux x64 `f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645`；Linux arm64 `229e194255c7958d86d56e8790d969a6f74736592133f0dfd0076f754c642c1d`；macOS arm64 `60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472`；macOS x64 `63ba17fdda55ad1a230d4b37fc6017ffa10c23688c83818bd3bfdf914c652a02`。

### 8.2 运行时布局

0.2.0 只认 Python 3.13.18。旧 3.12 runtime 只归档，不参与运行：

```text
userData/runtimes/
  python-3.13.18/          # 唯一受支持
  legacy/python-3.12.11/   # 仅用于人工重装 0.1.18 回退
  python-current.json      # { "version": "3.13.18" }
  uv-0.13.6/
  mingit-2.56.0.4/
  checksums.json
```

- `findInRuntimes('python')` 只扫描 `python-3.13.*`；`legacy/**` 不参与。
- `probeKind('python')` 只返回 3.13；只有 3.12 时 `installed:false, legacyVersion`。
- `BootstrapStatus`：`pythonVersion`、`supportedPython:'3.13'`、`legacyPython?`；删除 `compatPython`。
- 旧 `runtimes/python/` 移到 `legacy/python-<version>/`，写 `legacy.json`；**归档不等于兼容**，0.2.0 不加载。
- 设置页删除 legacy 必须明确确认；删除后不能回退 0.1.18。

### 8.3 新装 / 旧实例 / 迁移

| 场景 | 行为 |
|---|---|
| 新装 | 只用 3.13.18；venv 后 `python --version` 必须 3.13.x |
| 旧 3.12 启动 | **阻断**，`PYTHON_MIGRATION_REQUIRED`；状态 `migration-required` |
| 旧实例迁移 | 停止 → 旧 venv 改名 `venv-3.12-<ts>` 归档 → 新建 3.13 venv → 装 torch/requirements → 启动验证 → 成功写回配置；失败恢复归档，但 0.2.0 仍不允许 3.12 启动 |
| 迁移失败 | `migration-failed`；重试或下载 0.1.18 回退；不提供 3.12 运行开关 |
| cu124 | 删除；旧配置迁移强制 cu126/cu130 |
| 旧运行时清理 | 不参与启动；仅在确认“不再回退 0.1.18”后删除 |

### 8.4 torch 矩阵（仅 3.13）

| 通道 | 3.13 | 说明 |
|---|---|---|
| cu130 | ✅ | RTX 20+ 推荐；torch 2.9+ |
| cu126 | ✅ | 较旧驱动；torch 2.7.1–2.9.1 cp313 |
| cu124 | ❌ | cp313 只有 2.6.0，低于 ComfyUI 2.7 |
| rocm | ✅（Linux） | 按轮子可用性 |
| xpu | ✅ | Intel |
| mps | ✅ | macOS |
| cpu | ✅ | 兜底 |

- `verifyTorchChannel` 加 `torch >= 2.7`；低于 2.7 报错。
- 安装前 `uv pip install --dry-run` 或索引探测确认 3.13 有轮子。
- `detectGpu` 删除 cu124；旧配置 cu124 迁移时强制改。

### 8.5 UI / 诊断

- 安装向导只显示 Python 3.13.18、来源、SHA。
- 实例详情非 3.13 显示红色阻断条 + “开始迁移”（会归档旧 venv，迁移完成前不能启动）。
- 设置 → 运行时只展示 3.13；legacy 单独区，删除需确认。
- Doctor：3.13 pass；非 3.13 fail + `migrate-python-313`；torch <2.7 fail；runtime integrity。
- 诊断包含 Python 版本、venv `pyvenv.cfg`、torch 版本、通道、迁移状态。

### 8.6 验收

- 新装：`python-3.13.18` → 3.13.18；venv → 3.13.18；torch cu130 >=2.7。
- 旧 0.1.18 实例首次启动 → 阻断；迁移后 3.13 可启动；未迁移不可启动。
- 旧配置 cu124 → 强制改 cu126/cu130。
- 迁移失败 → 旧 venv 归档仍在，但 0.2.0 不运行 3.12；可重试或回退 0.1.18。

---

## 9. 测试、门禁与发布

### 9.1 新增行为测试

| 测试 | 用例 |
|---|---|
| `notificationStore` / `useNotificationToasts` | 历史不回放；只消费新；dedupe；readAt；旧 readSeq 迁移 |
| `depsAudit` | marker 适用/不适用；extras；`-r`；别名；unknown；partial success；pip check |
| `pipOps` | receipt；unresolved → ok:false；无通用 warning；只装 specs；验证 |
| `startupIssues` | 两次 boot 只取最后；transient；optional；Manager；fingerprint |
| `nodePackRecovery` | `.trash`/`.bak`/clone/zip 隔离/恢复/清理；越界拒绝 |
| `issueHub` / `nodesDeepLink` | 聚合/去重/忽略/恢复；深链 query |
| `launchArgs` / `cliArgsCatalog` | 引号/反斜杠/等号/未闭合；动态目录 |
| `pythonResolve` / `bootstrapSources` / `installerService` | 只选 3.13；legacy 忽略；非 3.13 拒绝；cu124 删除；torch <2.7 |
| `updaterPipeline` | 外部运行进程拒绝覆盖；verify 后取消不回滚；嵌入 venv |
| `processTree` | Windows 真退出；remove/forceKill 树杀 |
| `dataMigration` | v1→v2；pre-upgrade；拒绝 v1；失败回滚 |
| `backupService` | 凭据端点绑定；锁定 key 不删；恢复后应用 proxy/launchOnBoot；同名 workflow |
| `security` | 媒体 symlink；output.open/exportZip；脚本/ELF/无扩展名；保留名；BOM |
| `ipcHandlers.domains` | 203 通道 valid/invalid/target；sender；可执行路径 allow-list；安全字段 |
| `eventBackpressure` | 10k 日志批量；batch 增量；同步写盘 |
| `useScopedResource` | 切目标/卸载丢弃旧响应 |
| `NodesView.dom` / `IssueCenter.dom` | 深链/高亮/空态/动作/忽略 |
| `exitFlush` / `releaseGates` | 退出 flush；release gate；asar 无重复 preload/renderer |
| `app-smoke.e2e` | 历史通知 1 toast；深链；Python 版本；打包产物 |

### 9.2 实机验收（Windows）

1. 新装 0.2.0 → Python 3.13.18 → venv 3.13 → torch cu130 >=2.7 → 出图。
2. 旧 0.1.18 实例（3.12）启动 → 阻断 → 迁移 → 3.13 可启动；未迁移不可启动。
3. 节点更新 → 1 条汇总 toast；50 条历史不重弹；通知中心未读正确。
4. 依赖体检：marker 不适用显示“已跳过”；补装真实缺失 → receipt；再体检清空；无 `Package verification note`。
5. `.trash-*` 残留 → 自动隔离；ComfyUI 无 IMPORT FAILED；恢复中心可清理。
6. 详情失败诊断 → 节点页选中正确实例、focus 高亮/空态；`.trash` 可隔离清理。
7. 自定义参数 `--base-directory "D:\My Models"` → 预览/保存/导出/启动一致；未闭合引号报错。
8. 依赖升级后：路由/图表/i18n/Naive locale/WS/代理/自动更新/托盘/单实例正常。
9. 自动更新 0.1.18 → 0.2.0：pre-upgrade 快照、v1→v2 迁移；失败可回退 0.1.18；0.2.0 不双读。
10. 连续 3 次安装/卸载零 Application Error；10k 行日志不卡死。

### 9.3 门禁

```bash
npm ci
npm run typecheck
npm run typecheck:test
npm run lint:check          # --max-warnings=0
npm run test:coverage
npm run test:behavior
node scripts/check-i18n.cjs
node scripts/check-hardcoded-zh.cjs
node scripts/check-version.cjs
npm run build
npm run test:e2e
```

CI 增加 Node 24、Windows/Linux e2e、`prettier --check`、`engine-strict`、`npm audit`/OSV；release 增加 `gate` job + `needs`，全平台 tag/version。

---

## 10. 破坏性变更清单（release note 必须逐条列出）

- IPC 通道可重命名/删除，参数与返回 shape 可改；不保留旧通道。
- `shared/types.ts` 单体删除，改 `shared/types/*`；不保留兼容 re-export。
- JSONC schemaVersion 2；v1→v2 单向迁移；0.2.0 拒绝 v1，0.1.18 不能读 v2。
- 只支持 Python 3.13.x；旧 3.12 实例阻断并迁移；不提供 3.12 运行兼容。
- cu124 通道删除。
- `settings.get` 不再返回代理密码；`remote.list` 不再返回 API key；表单改为已设置/重录。
- IPC sender 校验；`instance.save/pythonPath`、`env.probe`、`installer.start`、`aria2Path` 走 allow-list。
- `output.exportZip` 只允许受控读路径/输出根；`output.open` 根/魔数限制。
- `NodePackRecord.path` 改真实包根；不保留双字段。
- 主窗口 `sandbox:true` + CSP；`engines.node` 提升。
- Pinia 4 / Router 5 / i18n 11 / ESLint 10 不保留旧写法。

---

## 11. 里程碑与工作量

| 阶段 | 内容 | 预估 |
|---|---|---|
| **M1 依赖/工具链** | WP7：TS6 / Electron 45.2.1 / ESLint10 / Pinia4 / Router5 / i18n11 | 6–8 人日 |
| **M2 安全/数据** | WP8-A：凭据/备份/realpath/sender/路径/凭据/session/写目标 | 8–10 人日 |
| **M3 Python 3.13** | WP6：3.13.18 + 版本化运行时 + torch 矩阵 + 迁移 UI | 8–10 人日 |
| **M4 问题闭环** | WP1/WP2/WP3/WP4：通知/审计/启动问题/IssueCenter/深链 | 10–12 人日 |
| **M5 参数/架构** | WP5 + WP8-B/C/D：自定义参数/IPC/类型/服务/渲染基建 | 10–12 人日 |
| **M6 测试/发布** | WP9：全量测试、Windows 真机、文档/版本/发布 | 6–8 人日 |
| **合计** | **9 个 WP，全部在 0.2.0 内完成** | **约 10–12 周**（一人全职；48–60 人日） |

执行顺序：`M1 → M2 → M3 → M4 → M5 → M6`。
**M2 必须先于 M3**：Python 迁移会重写 venv/路径/配置；凭据/备份/路径边界未修会把问题放大。
**不拆版本**：五个用户问题按 §5 根因方案直接进入 0.2.0；架构拆分可与 M3/M4 并行，但不与依赖升级同一 commit。

---

## 12. 风险与边界

1. **Python 3.13 + 自定义节点轮子**：部分节点可能没有 cp313 轮子；0.2.0 不提供 3.12 回退，只能升级/移除节点或回退 0.1.18 安装包。这是有意的破坏性变更。
2. **旧 venv 迁移**：0.2.0 不允许 3.12 启动；迁移强制；旧 venv 只归档用于回退 0.1.18；失败保持 `migration-failed`，不能绕过。
3. **cu124 在 3.13 不可用**：cp313 只有 torch 2.6.0，低于 ComfyUI 2.7；0.2.0 删除该通道。
4. **依赖大升级**：Pinia 4 ESM、Router 5 `type: module`、ESLint 10 flat config、TS6 类型行为变化；分四批提交，每批全门禁。
5. **TypeScript 7 不可用**：实测 `./lib/tsc` 错误；0.2.0 只到 6.0.3。
6. **数据迁移**：v1→v2 单向；pre-upgrade 快照；0.2.0 拒绝 v1、0.1.18 不能读 v2；不双读。
7. **凭据端点绑定**：旧配置/备份只改 host 不再保留密码；用户需重录；release note 说明。
8. **凭据不跨 IPC**：Settings/Remote 表单改为“已设置/重录”；有 UI 改动。
9. **备份事务/journal**：高风险改造，先用恶意/崩溃 fixture；不与 Python 迁移同一 commit。
10. **`sandbox:true`**：可能改变 preload 加载；先验证，失败则保留 `sandbox:false` 但必须 CSP/sender 校验。
11. **事件批量/日志流式**：影响终端实时感；保留逐行开关/完整日志，测试 10k 行不丢行。
12. **Windows 真机仍是门槛**：CI 不能覆盖 NSIS/AUMID/杀软/文件占用；发版前连续 3 次安装/卸载。
13. **macOS/Linux 未验证**：0.2.0 只承诺 Windows；mac/linux 构建配置保留，README 明示未验证。
14. **`NodePackRecord.path` 语义变化**：旧记录 v2 迁移重建；迁移失败删除并重扫，不静默兼容旧值。

---

## 13. 待爸爸决策

| # | 决策 | 推荐 |
|---|---|---|
| 1 | Python 3.13 策略 | **只支持 3.13；旧 3.12 阻断并迁移；不提供 3.12 运行兼容** |
| 2 | 旧实例迁移 | **阻断式向导（归档旧 venv + 新 3.13 venv + 验证 + 失败重试/回退 0.1.18）** |
| 3 | TypeScript | **6.0.3**（TS7 实测不可用） |
| 4 | 依赖升级 | **0.2.0 全做，分四批提交，不拆版本** |
| 5 | IssueCenter | **完整生命周期（open/ack/resolved/ignored + 动作）** |
| 6 | `.trash` 处理 | **自动隔离（不删除）+ 显式清理 + 7 天后提醒** |
| 7 | 数据层 | **JSONC v2 单向迁移 + pre-upgrade 快照；不双读；不引入 SQLite** |
| 8 | 安全优先级 | **WP8-A 先于 Python 3.13** |
| 9 | 凭据跨 IPC | **不返回明文，只返回 hasPassword/backend** |
| 10 | 签名/发布 | 仍“未签名 + SHA256 + SmartScreen 说明”；证书到位再单独做 |
| 11 | 跨平台 | 只承诺 Windows；mac/linux 构建配置保留，未验证 |

---

## 14. 候选池（本版不做）

| 项 | 价值 | 为何不进 0.2.0 |
|---|---|---|
| SQLite / 原生数据库 | 高：大索引性能 | Electron ABI、便携性、迁移风险；后续单独评估 |
| 远端 agent | 高：远程装节点/模型 | 架构面太大；0.2.0 只做目标隔离 |
| ComfyUI 本体断点续传/镜像回退 | 中：国内装机 | 下载管线改造大；0.2.0 先做运行时校验 |
| 代码签名/公证 | 高：信任 | 需要证书/预算 |
| macOS/Linux 真机验收 | 中 | 无真机；只保证 CI 构建 |
| 暗色主题 | 低 | README 明确不做 |
| 工作流画布内嵌编辑 | 低 | 控制塔不编辑器 |
| Electron 46 / Vue Router 6 / TS7 | 中 | 上游未稳定/不兼容；单独 spike |

---

## 15. 证据索引

### 15.1 代码位

- 通知：`App.vue:294-326`、`stores/app.ts:68-130`、`NotificationCenter.vue:18-70`、`types.ts:2293-2303`。
- 审计：`pipVersion.ts:59-97,135-201`、`nodePack.ts:3119-3219`、`pipOps.ts:213-249`、`env.ts:82-92,249-319`、`handlers.ts:1092-1105,2262-2302`、`NodesView.vue:717-764,1480-1539`。
- 启动问题：`startupIssues.ts:24-82`、`instance.ts:665-720,439-499`、`nodePack.ts:258-274,2049-2110,3457-3579`、`nodeLoadReport.ts:62-145`、`InstanceDetailView.vue:563-576,1505-1533`。
- 深链：`InstanceDetailView.vue:418-420,574-576`、`NodesView.vue:261-276,766-773,851-876`、`stores/app.ts:85-101`。
- 参数：`launchArgs.ts:45-136,237-351`、`instance.ts:1087-1125`、`InstancesView.vue:118-121,373,451,1268-1390`、`LaunchProfileEditor.vue:22-23,51-157`、`InstanceDetailView.vue:1432-1455`。
- Python：`constants.ts:177-251`、`bootstrap.ts:127-145,193-243,304-352`、`installer.ts:544-603,885-933,1037-1071,1141-1207`、`env.ts:661-732`、`README.md:60-68`。
- 安全/数据：`handlers.ts:1964-1989,103-114`、`security.ts:119-132,235-278,519-528`、`backup.ts:518-526,702-708,548-554`、`media.ts:278-298`、`logFile.ts:40-42`、`session.ts:43-67`、`db.ts:440-452,537-541`。
- 架构：`handlers.ts` 2,303 行 / 203 通道、`types.ts` 2,304 行、`nodePack.ts` 3,583 行、`p1p2.ts` 1,734 行、`instance.ts` 2,135 行。
- 测试/门禁：`vitest.config.ts:69-147`、`.github/workflows/*.yml`、`scripts/check-version.cjs`、`coverage-baseline.json`。

### 15.2 外部事实

- ComfyUI 系统要求（Python 3.13 recommended / PyTorch 2.7+ / Windows portable 3.13 + cu130）：<https://docs.comfy.org/installation/system_requirements>
- ComfyUI v0.43.0：<https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.43.0>
- ComfyUI 自定义节点加载（只跳过 `.disabled`，不跳过隐藏目录）：<https://github.com/Comfy-Org/ComfyUI/blob/master/nodes.py#L2368-L2385>
- ComfyUI cli_args：<https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/cli_args.py>
- python-build-standalone `20261026`（3.13.18）：<https://github.com/astral-sh/python-build-standalone/releases/tag/20261026>
- uv `0.13.6`：<https://github.com/astral-sh/uv/releases/tag/0.13.6>
- MinGit `2.56.0.4`：<https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.4>
- Pinia 4：<https://github.com/vuejs/pinia/releases/tag/v4.0.0>
- vue-i18n 11：<https://vue-i18n.intlify.dev/guide/migration/breaking11>
- Vue Router 5：<https://router.vuejs.org/guide/migration/v4-to-v5.html>

### 15.3 基线命令

```text
npx vitest run --reporter=dot
Test Files  121 passed (121)
Tests       1725 passed (1725)
Duration    26.33s
```

> **过程说明**：5 路只读评审 + 本人对通知、审计、启动问题、深链、启动参数、Python 运行时、凭据/备份、IPC 信任边界逐行回读；未修改源码/依赖，只维护本方案。所有“待实机确认”的结论均已标注；外部版本/轮子事实为 2026-11-02 查询结果。
