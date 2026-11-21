# ComfyPilot 0.2.5 迭代方案 —「运行真相 · 卡死救援 · 上游对齐」

> **版本定位：0.2.4 让日志说真话；0.2.5 让运行状态说真话。**
>
> 0.2.5 不追求功能数量，先修三个会直接破坏信任的根因：
>
> 1. **进程活着 ≠ 服务可用**：实例卡死时仍显示“运行中”。
> 2. **配置写了 ≠ 实际生效**：`--port` / `--listen` / `--base-directory` / `--user-directory` 等参数没有被下游资产操作正确解析。
> 3. **更新完成 ≠ 能启动**：ComfyUI 更新只做静态 Doctor 检查，没有真实启动验证，也没有稳定版通道。
>
> 同时对齐 ComfyUI **0.46.0**、ComfyUI-Manager **4.4.2**、Python 3.13 / CUDA 13 / ROCm 7.2 的上游现实。
>
> **数据格式保持 `schemaVersion: 2`，不强制迁移、不破坏 0.2.4 数据。**

---

## 目录

- [0. 为什么是现在](#0-为什么是现在)
- [1. 读取范围、基线与方法](#1-读取范围基线与方法)
- [2. 上游与竞品：ComfyPilot 应该站在哪](#2-上游与竞品comfypilot-应该站在哪)
- [3. 全仓审计：P0 / P1 / P2](#3-全仓审计p0--p1--p2)
- [4. 0.2.5 目标与验收画面](#4-025-目标与验收画面)
- [5. WP 设计](#5-wp-设计)
- [6. 数据与 IPC 变更](#6-数据与-ipc-变更)
- [7. 测试矩阵](#7-测试矩阵)
- [8. 里程碑与实机验收](#8-里程碑与实机验收)
- [9. 风险与缓解](#9-风险与缓解)
- [10. 待确认的实现选择](#10-待确认的实现选择)
- [11. 非目标与后续路线](#11-非目标与后续路线)
- [12. 证据索引](#12-证据索引)
- [13. 一句话总结](#13-一句话总结)

---

## 结论先行

- **0.2.5 不该再堆功能。** 当前最伤信任的是“进程活着就显示运行中”“配置写了但下游不认”“更新完成但起不来”。
- **0.2.5 全量包含 11 个 WP**：运行真相 + 安全边界 + 资产 P0 + Manager v4.4 + stable 更新 + 运行时矩阵 + 渲染层反馈 + 发布可信度。约 **46–58 人日**（含缓冲 50–64），按 4 个里程碑推进，内部 beta 可分阶段，但最终 0.2.5 一次发完。
- **不升数据 schema。** 全部新增字段可选，0.2.4 数据直接可用。
- **最高优先的 9 个 P0**：持续存活探测、有效 port/listen/dirs、更新真实启动验证、Manager v4.4 真实 schema/路径、生命周期/安装器状态说谎、端口冲突丢迁移字段、发布门禁不能证明打包产物、资产域（Civitai/批跑/备份/输出 containment/下载半成品）、安全边界（渲染器可扩权到 RCE）。

---

## 0. 为什么是现在

### 0.1 一次真实的“假运行”

2026-11-11 的本机实例事故：

| 事实            | 观测值                                                                 |
| --------------- | ---------------------------------------------------------------------- |
| ComfyPilot 状态 | `running`，窗口响应正常                                                |
| 实例进程        | 父 PID `10588` → 实际服务 PID `19756`，都还活着                        |
| 端口            | `127.0.0.1:8188` 仍 `LISTENING`                                        |
| 新连接          | Windows 本机与 WSL 都连不上，HTTP 超时                                 |
| TCP 连接        | 大量 `CLOSE_WAIT`，说明服务端事件循环没有回收连接                      |
| GPU             | 利用率 **0%**，显存占用 `14336 / 16376 MiB`                            |
| 日志            | 最后业务日志停在 `Context window 4/6`，之后约 **8 小时 47 分钟**无输出 |

ComfyPilot 的判断依据只有“进程存在 + 启动时 `/system_stats` 成功过一次”，所以它没有说谎的意图，但它**没有能力知道服务已经死了**。

0.2.5 的第一个验收画面就是：同样的事故在 3 分钟内显示为“无响应”，并能在不解锁 Windows 的情况下救回来。

### 0.2 上游已经变了

| 上游            | 2026-11-20 的事实                                                         | 对 ComfyPilot 的影响                             |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| ComfyUI         | **v0.46.0**（2026-11-18），frontend 1.59.6，templates 0.11.111            | 新增/变更大量启动参数与 API；DirectML 已移除     |
| ComfyUI-Manager | **4.4.2**（2026-11-19），v3.38 起配置迁移到 `user/__manager/`             | ComfyPilot 仍按旧路径/旧语义理解 Manager         |
| Python          | 官方推荐 **3.13**；3.12 可回退；3.14 可用但有节点兼容问题                 | 0.2.0 的“只支持 3.13”需要更诚实的措辞与边界      |
| PyTorch         | CUDA 13.0 为稳定线；索引已有 cu132 / cu134；ROCm 7.2 / 7.14 / 10.0 / 10.1 | 0.2.4 仍固定 `rocm6.2`，Windows AMD 直接回退 CPU |
| 官方 Desktop    | 多实例、快照、稳定/最新通道、共享目录、Manager 安全等级、终端             | ComfyPilot 的“安装器”优势被大幅抹平              |

### 0.3 不做什么

0.2.5 **不做**：

- 不重写 JSONC / 不引入 SQLite / 不升 `schemaVersion`。
- 不做完整 venv 字节级快照。
- 不做多实例 GPU 调度器。
- 不做 macOS / Linux 实机认证。
- 不做工作流市场或云端部署。
- 不为“功能数量”牺牲 0.2.4 已建立的门禁与测试纪律。

---

## 1. 读取范围、基线与方法

### 1.1 读取范围

| 范围           | 规模                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| 仓库文件       | 366 个（不含 `node_modules` / `out` / `release`）                                                       |
| `src/`         | **69,116 行**                                                                                           |
| `src/main`     | 34,622 行                                                                                               |
| `src/renderer` | 29,408 行                                                                                               |
| `src/shared`   | 5,010 行                                                                                                |
| `src/preload`  | 76 行                                                                                                   |
| `tests/`       | 40,704 行 / 148 个测试文件                                                                              |
| 文档与脚本     | README、`docs/PLAN-0.2.0.md`、CI / Release、11 个 `scripts/*.cjs`                                       |
| 关键外部事实   | ComfyUI v0.46.0、ComfyUI-Manager 4.4.2、官方 Desktop、Stability Matrix、ComfyUI-Launcher、ComfyLauncher |

> 方法：核心链路逐行复核；其余模块按“整文件读到 EOF”的方式并行审计；外部事实以官方文档 / Release / 源码为准，不用记忆代替证据。

### 1.2 当前基线

| 项       | 值                                                                                    |
| -------- | ------------------------------------------------------------------------------------- |
| HEAD     | `4155279`（README 重设计）                                                            |
| 版本     | `0.2.4`                                                                               |
| 测试     | 148 文件 / **1,930 用例**（实测 `npx vitest run` 全通过）                             |
| 覆盖率   | statements **64.64%** · branches **53.84%** · functions **49.49%** · lines **66.81%** |
| 覆盖分母 | **172 个运行时代码文件**（main / preload / shared / renderer）                        |
| CI       | Ubuntu + Windows 双平台；当前 `4155279` 全绿                                          |
| 数据     | JSONC v2；`coverage-baseline.json` 172 个文件逐文件 ratchet                           |

### 1.3 三个“真相断点”

```
用户看到的 ComfyUI 状态
        │
        ├─ 进程存在 ──► 启动时 /system_stats 成功一次 ──► 永远 running
        │                                      ✗ 之后不再复检
        │
        ├─ 配置里的 port/listen/dirs
        │        ✗ extraArgs / launchProfile 的覆盖没有回写到探针与资产操作
        │
        └─ 更新完成
                 ✗ Doctor 静态检查 ≠ 真实启动成功
```

---

## 2. 上游与竞品：ComfyPilot 应该站在哪

### 2.0 先理解 ComfyUI 的运行模型

ComfyUI 不是一个“桌面单体应用”，而是：

```
Electron / 浏览器（ComfyUI Frontend）
        │  HTTP + WebSocket
        ▼
Python 服务器（main.py）
  ├─ asyncio HTTP/WS 事件循环
  ├─ prompt worker（执行队列）
  ├─ 模型加载 / 采样 / VAE / 自定义节点
  └─ SQLite（user/comfyui.db，0.4x）
        │
        ├─ models/、custom_nodes/、user/、output/、input/、temp/
        └─ ComfyUI-Manager（user/__manager/，v3.38+）
```

由此得出三个对 0.2.5 至关重要的事实：

1. **TCP 监听 ≠ HTTP 可用**：事件循环被原生算子/自定义节点阻塞时，内核仍保持 `LISTENING`，新连接进入 backlog，HTTP 超时。端口检查只能证明“socket 还在”，不能证明“服务还活着”。
2. **ComfyUI 的真实状态是分散的**：进程、端口、HTTP、WebSocket、队列、日志、GPU、user 目录、自定义节点、Manager 配置，任何一项都可能单独失真。管理器必须做“证据对账”，不能只信一个布尔值。
3. **ComfyUI 的目录是参数化的**：`--base-directory`、`--user-directory`、`--models-directory`、`--output-directory` 会改变所有资产位置；`--port` / `--listen` 可被 `extraArgs` 覆盖。管理器如果只读 `config.port` / `<instance>/models`，就会“看错实例”。

ComfyUI 的版本/通道也要分清：

| 维度     | 事实                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------- |
| 源码通道 | GitHub `master`（nightly）vs Release tag（stable，v0.46.0）                                             |
| 前端     | 独立 npm 包 `comfyui-frontend-package`（1.59.x），可 `--front-end-version` 指定                         |
| Python   | 3.13 推荐；3.12 可回退；3.14 可用但有节点兼容问题                                                       |
| Manager  | v3.38+ 配置迁到 `user/__manager/`；v4.4.2 为 pip 安装；API 改为 POST + JSON + 批量队列                  |
| 安全     | Manager `strong / normal / normal- / weak`；Comfy Desktop UI 用 Strict/Standard/Relaxed/Permissive 映射 |

这也是为什么 0.2.5 的“健康证据链”必须同时看 HTTP、TCP、进程、日志、WS/队列、GPU，而不能只加一个 `setInterval(fetch)`。

ComfyUI 当前对管理器最重要的 API 面：

| API                                       | 用途                             | ComfyPilot 0.2.4 现状                          |
| ----------------------------------------- | -------------------------------- | ---------------------------------------------- |
| `GET /system_stats`                       | 版本、Python/torch、argv、包版本 | ✅ 就绪探测 + 能力探测                         |
| `GET /features`                           | 服务端 feature flags             | ✅ 能力探测                                    |
| `GET /object_info`                        | 节点类型 → `python_module` 归属  | ✅ 预检/失败归因（缓存 180s）                  |
| `GET /queue` / `POST /queue`              | 队列、清空、删除 pending         | ✅ 监控/批跑                                   |
| `GET /history`                            | 历史与输出                       | ✅ 监控/产物关联                               |
| `POST /prompt`                            | 提交工作流                       | ✅ 工作流/批跑                                 |
| `POST /interrupt` / `POST /free`          | 中断、释放显存                   | ✅ 监控                                        |
| `GET /api/jobs` / `POST /api/jobs/cancel` | 统一作业列表/取消（0.39+）       | ✅ 探测 + 批跑取消；监控仍以 legacy queue 为主 |
| `GET /api/assets`                         | 资产系统（0.40+，feature-gated） | ✅ 只读增强                                    |
| `GET /default_workflow`                   | 内置默认工作流（0.41+）          | ✅ 工作流导入                                  |
| `WS /ws`                                  | 进度、预览、执行错误             | ✅ 监控/批跑/诊断                              |

0.2.5 不重写这些 API，只在健康、Manager、更新通道上补“事实来源”。

### 2.1 竞品能力矩阵

| 能力     | ComfyPilot 0.2.4                  | 官方 Comfy Desktop  | Stability Matrix          | ComfyUI-Launcher    | ComfyLauncher     |
| -------- | --------------------------------- | ------------------- | ------------------------- | ------------------- | ----------------- |
| 定位     | ComfyUI 生产控制塔                | 官方安装/运行器     | 多工具包管理器            | 工作流零配置运行    | 轻量便携启动器    |
| 多实例   | ✅ 本地多实例                     | ✅ 多 install       | ⚠️ 多包，每包通常一个实例 | ✅ 每工作流隔离环境 | ✅ 多便携构建     |
| 零预装   | ✅ 便携 Python / uv / MinGit      | ✅ 预构建 GPU 环境  | ✅ 内嵌 Git / Python      | ⚠️ Docker / Python  | ❌ 依赖现有便携包 |
| 模型库   | ✅ 扫描/去重/下载/缩略图/对账     | ✅ 共享目录         | ✅ 共享目录 + Civitai/HF  | ⚠️ 按工作流下载     | ❌                |
| 节点管理 | ✅ Registry/Manager/Git/依赖/冲突 | ✅ Manager          | ✅ 扩展                   | ✅ 自动安装         | ❌                |
| 工作流库 | ✅ 导入/标签/同步/批跑            | ❌（只画布）        | ⚠️ 推理项目               | ✅ 零配置项目       | ❌                |
| 批跑     | ✅ 多工作流 × 矩阵                | ❌                  | ❌                        | ⚠️ 多项目           | ❌                |
| 监控     | ✅ CPU/内存/GPU/队列/WS/预览      | ⚠️ 基础             | ⚠️ 基础                   | ❌                  | ⚠️ 状态灯         |
| 诊断     | ✅ Doctor/日志/崩溃归因/启动问题  | ⚠️ 更新日志         | ❌                        | ❌                  | ⚠️ 控制台         |
| 快照     | ⚠️ 配置备份 + 节点启用状态        | ✅ 版本/包/节点快照 | ❌                        | ⚠️ 隔离环境         | ❌                |
| 远程     | ✅ 远程监控/队列                  | ✅ Remote/Cloud     | ❌                        | ⚠️ 云端             | ❌                |
| 更新通道 | ⚠️ 只跟 master                    | ✅ Stable / Latest  | ✅ 包版本                 | ⚠️                  | ❌                |
| 跨平台   | ⚠️ Windows 验证；mac/Linux 未验证 | ✅ Win/mac/Linux    | ✅ Win/Linux/mac          | ✅ Docker/手动      | ⚠️ Win/Linux      |
| License  | MIT                               | AGPL / 商业双许可   | AGPL                      | AGPL                | MIT               |

### 2.2 结论

官方 Desktop 已经把“装得上、跑得起来、能回滚”做成默认体验。ComfyPilot 继续在“安装器”上正面竞争，投入产出比很低。

ComfyPilot 的差异化应该收敛为一句话：

> **官方 Desktop 管“装和跑”，ComfyPilot 管“跑得稳、看得见、救得回、批得动”。**

0.2.5 因此把资源压在：

1. **运行真相**：健康状态、证据、诊断包。
2. **可恢复性**：卡死救援、安全模式、更新失败回滚。
3. **上游对齐**：Manager v4.4、稳定版通道、torch 矩阵。
4. **路径真相**：所有资产操作与 ComfyUI 实际目录一致。

---

## 3. 全仓审计：P0 / P1 / P2

### 3.1 P0（0.2.5 必须修）

#### P0-1 只有“启动就绪”，没有“持续存活”

**证据**

- `src/main/services/instance/lifecycle.ts:172-271`：`beginReadyProbe()` 只在启动阶段轮询 `/system_stats`；成功后设置 `rt.ready = true`、清掉定时器，之后不再复检。
- `src/shared/types/instance.ts:4-12`：`InstanceStatus` 只有 `stopped / starting / running / error / unknown / migration-*`，没有健康维度。
- `src/main/services/instance/runtime.ts:92-119`：`toInfo()` 只返回进程状态、PID、URL、版本，没有心跳、延迟、最后日志时间、队列状态。
- `src/main/services/monitor.ts:282-400`：监控只有系统采样与队列快照，没有“实例健康”判断。

**影响**

- ComfyUI 事件循环卡死、端口仍在监听时，UI 继续显示绿色“运行中”。
- 批跑、工作流提交、监控全部会失败，但用户先看到的是“成功”的状态。
- 14 GB 显存可能被一个已死实例占住数小时。

**修复方向**

- 新增 `InstanceHealth`（运行时字段，不落盘），由独立 `health.ts` 维护。
- 证据链：HTTP `/system_stats` 超时、TCP 端口是否监听、进程是否存活、最后日志时间、WS/队列进度、GPU 利用率。
- 状态：`healthy / busy / suspect / unresponsive / crashed / unknown`。
- 只有“HTTP 连续失败 + 端口仍监听 + 进程存活 + 日志/进度停滞”才判 `unresponsive`；队列仍在跑且有进度时判 `busy`，绝不误杀长任务。

#### P0-2 配置的 port / listen / 目录没有成为“有效事实”

**证据**

- `src/main/services/instance/launchArgs.ts:46-78`：`buildArgs()` 把模板、`launchProfile`、`extraArgs` 依次拼接，**最后一个 `--port` / `--listen` 会赢**。
- `src/main/services/instance/lifecycle.ts:342`：端口检查用的是 `config.port`。
- `src/main/services/instance/runtime.ts:85-90`：`baseUrlOf()` 用 `config.listen` / `config.port`，不解析 `extraArgs`。
- `src/main/services/capabilities.ts:46-51`：同样的单值假设。
- `src/main/services/workflow.ts:699-705`：同样的单值假设。
- `src/shared/types/instance.ts:4` 的 `listen` 是单字符串；ComfyUI 0.46 的 `--listen` 已支持逗号分隔多地址。
- `src/shared/outputDir.ts:25-45` 只解析 `--output-directory`，不处理 `--base-directory`。
- `src/main/services/nodePack/common.ts:320-331` 固定 `<instance>/custom_nodes`。
- `src/main/services/workflow.ts:563, 877, 1000` 固定 `<instance>/user/default/workflows`。
- `src/main/services/model.ts:417-424, 508-511` 固定 `<instance>/models`。
- `src/main/services/media.ts:278`、`backup.ts:115,137`、`diagnostics.ts:66-78`、`doctor.ts:322-330`、`p1p2/market.ts:61` 同样固定旧路径。

**影响**

- 用户在启动参数里写 `--port 9999`，ComfyPilot 仍探 8188，启动检查、就绪探测、监控全部错位。
- 使用 `--base-directory` / `--user-directory` / `--models-directory` 的实例：
  - 节点包装到 `<instance>/custom_nodes`，ComfyUI 从 `<base>/custom_nodes` 加载 → 装了但“没装”。
  - 工作流同步到 `<instance>/user/default/workflows`，ComfyUI 从 `<user>/default/workflows` 读 → 同步了但“看不到”。
  - 模型扫描/下载根不在实际 models 目录 → 扫不到、下载被门禁拒绝。
  - 备份、诊断、Market 安装检测全部指错目录。
- 这是“支持了参数但下游不认”的典型半实现，属于数据写错位置的 P0。

**修复方向**

- 新增 `resolveEffectiveInstance(config)`：
  - 从最终 argv 解析 `port`、`listen`、`base/user/models/custom_nodes/input/output/temp/previews`。
  - 多地址 listen 解析出可探测的 loopback / 首地址。
  - 统一派生 `url`、`workflowsDir`、`managerDir`、`modelsRoots`、`customNodesDir`。
- 所有资产/探针/诊断/备份/Manager 代码改用该解析器。
- `ComfyInstanceInfo` 增加 `effectivePort` / `effectiveListen` / `resolvedDirs`（只读运行时字段）。
- `instance.save` 对 renderer 传入的目录参数做批准根校验；磁盘上已有的用户配置保持兼容。

#### P0-3 更新“完成”没有真实启动证明

**证据**

- `src/main/services/updater.ts:621-652`：稳定版 release 只作为“信息”展示，实际更新仍跟 master。
- `src/main/services/updater.ts:710-751`：zip 安装比较的是 GitHub master commit。
- `src/main/services/updater.ts:1204-1236`：更新后的 verify 调用 `doctorService.run()`，这是静态环境检查，不是真实启动。
- `src/main/services/updater.ts:1244-1292`：即使 `verifyFailed`，仍把 step 设为 `done`，只把 backup/journal 留下。
- `src/main/services/updater.ts:1549`：更新下载固定 `archive/refs/heads/master.zip`。

**影响**

- ComfyUI 源码更新成功、依赖也装上，但新版本 + 现有自定义节点组合可能根本起不来；UI 仍显示“更新完成”。
- 用户没有“稳定版”可选；每次更新都在跟 master，生产环境风险高。
- 失败后虽然能 rollback，但发现得太晚。

**修复方向**

- 新增 `updateChannel: 'stable' | 'nightly'`；新实例默认 stable，旧实例保持 nightly 并显式提示。
- stable 使用 GitHub Release tag + tag archive；nightly 保持 master。
- 更新后执行真实启动自检（复用 `runStartupSelfCheck` 的 `--quick-test-for-ci --cpu`），失败自动回滚源码并保留 journal。
- 更新前记录节点版本快照；失败时提供“回滚源码 / 只回滚节点版本”。

#### P0-4 ComfyUI-Manager v4.4 未被真正理解

**证据**

- 全仓没有读取 `user/__manager/`、`config.ini`、`security_level` 的实现；Manager 只作为 `--enable-manager` 启动参数和远端节点列表存在。
- `src/main/services/nodePack/install.ts:54-86` 使用 ComfyPilot 自己的 `securityLevel` 做安装门禁，但 UI 文案把它叫作 `security_level`（`zh-CN.ts:176`、`en-US.ts:182`），容易让用户以为改的是 Manager 的安全等级。
- `src/main/services/nodePack/list.ts:405-411` 的 Manager 列表源把 `ltdrdata` 放在第一位，且 `466` 行一旦拿到非空结果就 `break`，v4 列表可能永远不被使用。
- `src/main/services/nodePack/list.ts:431-465` 按“顶层数组 + id/name/repository/version”解析；真实 `custom-node-list.json` 是 `{ custom_nodes: [...] }`，字段是 `title/reference/files/install_type`。结果大多数条目被去重丢弃，幸存条目 `repository=''`，Manager 安装报 “no repository URL”。
- `src/main/services/instance/runtime.ts:114` 的 `managerEnabled` 只检查 `config.extraArgs`，不检查 `LAUNCH_TEMPLATES`；选了 Manager 模板也会显示未启用。
- `src/main/services/doctor.ts:549-559` 同样只看 `extraArgs`。

**影响**

- 用户按 UI 提示把 ComfyPilot 的 `securityLevel` 调成 `normal`，Manager 的 `config.ini` 仍是 `strong`，Manager 侧安装继续失败。
- Manager v3.38+ 把配置迁到 `user/__manager/`，旧路径的检查/清理/快照会看错位置。
- Manager v4.4.2 的 API 已改为 POST + `application/json`、批量队列；如果未来接 Manager API，旧调用会 400。
- v4 列表可能被旧列表遮蔽，用户看到过期节点。

**修复方向**

- 新增 `managerInfo`：版本、安装方式（pip / git）、`config.ini` 路径、安全等级、网络模式、快照目录、legacy backup。
- 明确区分：
  - **ComfyPilot 安装策略**（应用自己的门禁）。
  - **ComfyUI-Manager 安全等级**（Manager 的 `config.ini`，下次启动生效）。
- 默认只读展示；写 Manager 配置必须显式确认、备份、原子写、保留未知键/注释。
- Manager 列表优先 v4，带缓存/ETag/离线回退；不再“第一个源成功就停止”。
- 同时解析两种真实 schema：`custom-node-list.json` 的 `{custom_nodes:[...]}`（`reference` / `files` / `install_type`）与 `extension-node-map.json`；用真实 fixture 测试，不再用自造数组。

#### P0-5 生命周期 / 安装器仍在“状态说谎”（S1）

这组问题不修，健康检测与救援就会建立在不可靠的状态机上。

| ID    | 问题                         | 证据                                       | 后果                                                                                                     |
| ----- | ---------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| P0-5a | 安装器 reset 跨轮污染        | `installer.ts:414-442, 1574-1629`          | 旧 run 的 catch 写进新 run 的 progress，并 `children.clear()` 清掉新 run 的取消句柄                      |
| P0-5b | `repairEnv` 伪造 Python 3.13 | `env.ts:922-941, 1087-1118`                | 3.12 venv 点一次“修复环境”后配置显示 3.13 / `migrationState:'none'`，下次启动才被真实解释器拦下          |
| P0-5c | spawn 晚于 stop 的孤儿       | `lifecycle.ts:436-570, 1033-1039, 654-671` | stop 等 10s 超时后返回 stopped，start 仍 spawn；取消分支因 generation 已变而跳过清理，留下无人管理的进程 |
| P0-5d | 收养后丢失所有权             | `lifecycle.ts:371-398`                     | 台账可证明是本应用启动的孤儿被标 `managed=false`，Stop/ForceKill 拒绝杀，只能等下次启动 sweep            |
| P0-5e | ENV_MISMATCH 卡 `starting`   | `lifecycle.ts:440-489`                     | 抛错前已置 `starting`，但不在 spawn 的 try 内，也不置 `error`，UI 永久“启动中”                           |
| P0-5f | ComfyUI zip 不可取消、零校验 | `installer.ts:444-485, 1633-1672`          | 取消后仍下载/解包；镜像可返回任意 zip，下次启动执行其 `main.py`                                          |

**修复方向**

- 每个安装 run 捕获自己的 `token + progress` 引用；catch/finally 先确认仍是当前 run，再写状态/清 children。
- `repairEnv` 只有在 venv 实测 3.13 时才写 `pythonVersion:'3.13.18'` / `migrationState:'none'`；否则保留真实版本并给出迁移提示。
- `startInner` 在每次 await 后、spawn 前校验 `generation` 与 `cancelRequested`；spawn 后若已过期立即 tree kill，且 stop 等待改为可取消的显式状态机。
- 收养时按台账 + 命令行 + 路径三重校验；确认 owned 后写回 `managed=true`，Stop 允许杀。
- ENV_MISMATCH / 启动参数非法 / Python 不支持统一置 `error` + emit。
- ComfyUI zip 下载加 AbortController、流内 token 检查、真实字节进度；至少校验 GitHub release 资产/自定义 manifest 的 SHA256；禁止 `http`（只允许 https）。

#### P0-6 端口冲突保存会清空迁移字段

**证据**

- `src/renderer/src/composables/useLaunch.ts:154-170`：端口冲突改用建议端口时，只构造了 `id/name/path/pythonPath/venvPath/port/listen/extraArgs/argTemplateId/enabled/notes/autoStart/frontendVersion/pinned/launchProfile`，漏掉 `pythonVersion` / `migrationState` / `migrationError`。
- `src/main/services/instance/discovery.ts:147-166`：`save()` 是整条记录替换，不是字段合并。
- `src/main/services/db/jsonc.ts:451-462`：`upsertInList` 替换整条。

**影响**

- 一个 3.12 实例本来 `migrationState:'required'`，用户点“端口冲突 → 使用建议端口”后，迁移状态被清空，`toInfo` 不再映射为 `migration-required`，下次启动才被真实解释器门禁拦下。
- 迁移失败原因 `migrationError` 丢失，用户失去诊断线索。

**修复方向**

- 新增 `instance.patch`（只传变更字段）或 `instance.setPort`；端口冲突只改 `port`，不再整条 save。
- 若保留 `instance.save`，渲染层必须构造完整配置；主进程增加“关键字段缺失时拒绝覆盖”的保护。
- 测试：3.12 实例改端口后 `migrationState` 仍为 `required`，`migrationError` 保留。

#### P0-7 发布门禁不能证明“打包产物能启动”

**证据**

- `.github/workflows/release.yml:20-42` 的 `gate` 没有 `npm run build`、没有 `test:e2e`、没有实际 `check-asar`；build/asar 只在 `build-windows` 里。
- `.github/workflows/ci.yml:74-78` Windows 只跑 `npm run test`，不跑覆盖率；注释理由“V8 counters differ”已过时（`vitest.config.ts:73-76` 已改用 Istanbul）。
- `.github/workflows/ci.yml:95-96` 只做 asar 配置正则检查，不检查真实 `app.asar`。
- `README.md:316` 却写“release.yml 会先跑完整 gate”；`README.md:481` 写“CI best-effort 构建 macOS”，实际 macOS 不打包。

**影响**

- 单元测试全绿、但 packaged preload/renderer 路径坏掉时，仍可能生成 draft Release。
- 正式发布平台 Windows 的覆盖率回归无人拦截。
- 安装包/卸载/快捷方式/托盘没有任何自动或人工 checklist 证据。

**修复方向**

- `release.yml` gate 增加 `npm run build`、Linux xvfb `test:e2e`；Windows job 对 `--dir` 产物跑一次真实启动 smoke。
- `ci.yml` Windows 也跑 `test:coverage`（Istanbul 已确定），或删除过时理由并明确只跑测试。
- `check-asar` 必须传入真实 `app.asar`，检查 `bootstrap.cjs` / `package.json` / 生产依赖。
- 新增 `docs/RELEASE.md` 发布 checklist（tag、gate、draft、checksum、安装/卸载、回滚）。
- 修正 README 的 CI/release/coverage 陈述。

#### P0-8 资产域的功能级缺陷（0.2.5 快修）

| ID    | 问题                                          | 证据                                                                                                                               | 影响                                                         |
| ----- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| P0-8a | Civitai 下载文件名没有扩展名                  | `model.ts:865-876` 改写成 `/api/download/models/<id>` 后取 pathname basename；不读 `Content-Disposition`；`MODEL_EXT` 不含空扩展名 | 下载落盘为纯数字文件，扫描/去重/缩略图全部失效               |
| P0-8b | 批跑 30 秒空 history 提前 break               | `p1p2/batch.ts:756` `consecutiveEmpty>=12 && settled.size===0`                                                                     | 正常排队 >30s 的任务被标超时，实际随后出图；用户重跑浪费算力 |
| P0-8c | 备份跨机恢复被模型绝对路径整体拒绝            | `backup.ts:552-556` invalidPaths 一律 abort；`:872-876` 模型路径不在当前根即 invalid；sections 不参与校验                          | 换机/换盘/移动盘时，连 settings 都无法恢复                   |
| P0-8d | history 输出路径无 containment / 删除无根校验 | `batch.ts:770-789` `join(base, subfolder, basename(filename))`；`output.ts:447-453` 只 `existsSync` 就 unlink                      | 恶意/异常 subfolder 可索引输出根外文件，随后可被删除         |
| P0-8e | 取消下载留下半成品最终文件                    | `model.ts:1227` 直接写 `destPath`；取消只 abort；再次下载因 `existsSync` 报 “Target already exists”                                | 模型库出现损坏条目，用户无法重下同一文件                     |

**修复方向**

- Civitai：解析 `Content-Disposition filename*`；回退用 API `files[].name`；按 model-version id 下载；强制安全扩展名；补真实 URL fixture。
- 批跑：只有 `/queue` 中也查不到 promptId 才判丢失；空 history 宽限与 deadline 一致；deadline 可配置，长任务按 queue 续期。
- 备份：按 section 作用域校验；模型/实例路径改为 warning + 跳过/重映射/清空选项；备份内 `modelScanRoots` 纳入候选根；补“仅恢复设置/工作流”预检。
- 输出：所有 history/output 路径 `resolveInsideAnyRoot`；`output.remove` 删除前校验输出根；拒绝绝对 subfolder/`..`。
- 下载：写 `.part`，校验后 rename；取消删除 `.part`；扫描跳过 `.part`；暂停排队任务时从 `pendingStarts` 移除。

#### P0-9 安全边界：渲染器可扩权到任意代码执行

`src/main/ipc/contract.ts:1-11` 明确把“被攻破/有 bug 的渲染进程”作为威胁模型。按这个模型，以下链是 P0：

| ID  | 链                                                                                                                                            | 证据                                                                                                                       | 影响                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| S1  | `model.download` 下载 `main.py` / `python.exe` → `instance.save` 注册 home 下任意目录 → `pythonPath` 指向实例内任意文件 → `instance.launch`   | `domains/models.ts:53-55`、`model.ts:831-876,1227`、`context.ts:220-231`、`discovery.ts:144-168`、`lifecycle.ts:490-565`   | 当前用户代码执行，绕过 picker / approved roots / executable approval |
| S2  | `settings.set({ modelScanRoots:['/'] })` → `model.download` 写 `.bashrc` / `authorized_keys` / Startup `.bat`；`output.scan/delete` 全盘读/删 | `domains/settings.ts:124-144`、`security.ts:563-572`、`model.ts:416-432`、`media.ts:266-285`、`context.ts:300-317,454-468` | allow-list 被渲染器自己扩到全盘，任意文件写/读/删                    |
| S3  | `instance.save` 不校验 `launchProfile.outputDirectory` / `extraArgs` / `listen`                                                               | `domains/instances.ts:74-82`、`discovery.ts:144-168`、`shared/outputDir.ts:25-46`、`domains/output.ts:24-37,154-161`       | 全盘扫描/打开/删除 + 受限 SSRF（`listen` 指向内网/云 metadata）      |
| S4  | 恶意备份注入 `pythonPath` / `venvPath` / `launchProfile` / node-pack path / `proxy.password`                                                  | `backup.ts:811-846,582-597,789-806,272-296`                                                                                | 恢复后启动即执行；代理密码可被注入，流量走攻击者代理                 |
| S5  | 开发模式 renderer URL 前缀信任                                                                                                                | `rendererEntry.ts:13-16`                                                                                                   | `http://localhost:5173@evil` / `51730` 可获得 preload + IPC          |
| S6  | Linux `basic_text` / 明文凭据回退                                                                                                             | `secretStorage.ts:19-44`                                                                                                   | 无 keyring 时凭据明文落盘，文件默认 0644                             |
| S7  | ComfyUI zip / 应用更新无哈希/签名/固定 commit                                                                                                 | `updater.ts:1547-1569`、`appUpdate.ts:189-203`、`electron-builder.yml:7-10`                                                | 镜像/发布账号被攻破即可下发恶意代码                                  |
| S8  | `shell.openPath` / `output.open` 未阻止 `.py/.sh/.pyc`                                                                                        | `security.ts:235-279`                                                                                                      | 结合 S1/S2，点击打开即执行                                           |
| S9  | `output.thumb` / `output.scan` 根未 realpath，符号链接可越界                                                                                  | `domains/output.ts:138-146`、`p1p2/output.ts:240-265`、`media.ts:194-238`                                                  | 任意图片读取 / 全盘媒体索引                                          |
| S10 | `exportLaunchScript` 的 `dir` 词法校验，符号链接可写到根外                                                                                    | `instances.ts:339-350`、`instance/launchArgs.ts:143-162`                                                                   | `.bat/.sh` 写到根外，覆盖已有文件                                    |
| S11 | `model.move/symlink` 信任 DB `fileName`                                                                                                       | `model.ts:706-756`                                                                                                         | `../../.config/autostart/evil.desktop` 可写到目标根外                |

**修复方向**

- **Capability 化路径审批**：main 进程签发 `{scope, root, source, expiresAt}`，替代全局 `approvedReadRoots/approvedWriteRoots/approvedExecutablePaths`；`settings.set modelScanRoots`、`instance.save`、`model.download`、`backup.restore` 都消费 capability，而不是“任何存在的路径”。
- **实例闭环**：新实例 path 必须来自 picker 或 `instance.discover`；`pythonPath` 必须 picker/已验证 venv/系统 Python；禁止实例内任意文件；`launchProfile` 所有路径字段、`listen`、`port`、`extraArgs` 白名单；启动前校验 `main.py` + ComfyUI 指纹。
- **下载闭环**：`model.download` 只允许模型扩展名；`destDir` 只允许明确模型根/picker；`flags:'wx'` 或显式覆盖确认；`model.move/symlink` 清洗 `rec.fileName` + realpath containment。
- **备份闭环**：备份 schemaVersion + 字段白名单；删除 `proxy.password`；node-pack/model/snapshot path 校验；restore mutex；workflow 写入 realpath/临时文件；恢复后重新同步代理/登录项/托盘。
- **IPC 硬化**：senderFrame fail-closed；dev URL 精确 origin；高风险对象 zod schema；事件 payload schema。
- **更新完整性**：ComfyUI stable tag + SHA-256 TOFU 连续性 pin（GitHub 不为自动生成的源码 zip 发布校验和）；应用更新发布者校验；去掉默认 `autoInstallOnAppQuit`；`journal.backupPath` 限定 `.cp-backups`；staging `mkdtemp`。

### 3.2 P1（0.2.5 应修）

| ID    | 问题                                                              | 证据                                                                                                                                                       | 影响                                                                |
| ----- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| P1-1  | 锁屏/界面无响应时没有救援通道                                     | `CommandPalette.vue:74-87` 只有启动/停止；`tray.ts:113-144` 只有停止/启动                                                                                  | 用户只能 `taskkill`，应用状态不一致                                 |
| P1-2  | 节点快照不恢复版本                                                | `nodePack/update.ts:971-1009` 记录 version/gitRev；`1011-1081` 只切启用/禁用                                                                               | “快照”不能回滚坏节点更新                                            |
| P1-3  | torch 矩阵过期                                                    | `installer.ts:59-66` 固定 `rocm6.2`；`630-645` Windows AMD 回退 CPU；`TORCH_DISK_GB` 未更新                                                                | AMD/新 CUDA 用户装错或性能损失                                      |
| P1-4  | Python 3.13 文案过期                                              | `doctor.ts:109-124`、`installer.ts:838-840` 说 3.14 没有 torch 轮子                                                                                        | 与官方文档冲突，用户被误导                                          |
| P1-5  | 诊断包缺健康证据                                                  | `instance/diagnostics.ts` 只有 config/log/env/自定义节点                                                                                                   | 卡死复盘缺少 PID 树、端口、健康、Manager、GPU                       |
| P1-6  | `managerEnabled` 忽略模板                                         | `runtime.ts:114`、`doctor.ts:550`                                                                                                                          | 选 Manager 模板仍显示未启用                                         |
| P1-7  | adopted 外部实例 stop 返回 `exited:true`                          | `lifecycle.ts:1070-1090` 初始化 `exited=true`                                                                                                              | API/批量汇总把“只发信号”当“已退出”                                  |
| P1-8  | restart 等端口只等 3 秒                                           | `lifecycle.ts:1104-1110`                                                                                                                                   | Windows 慢杀进程时 restart 误报端口占用                             |
| P1-9  | IPC schema 大量 `obj`                                             | `ipc/contract.ts:19-25`；219 个通道                                                                                                                        | 参数形状校验浅，破坏性通道依赖服务层                                |
| P1-10 | `--listen` 多地址 / TLS 参数不支持                                | `runtime.ts:85-90`、`capabilities.ts:46-51`                                                                                                                | 合法 ComfyUI 配置被探错地址                                         |
| P1-11 | 更新前没有节点版本快照                                            | `updater.ts` 只备份 core 文件                                                                                                                              | 更新后节点坏了只能手工修                                            |
| P1-12 | 备份/快照命名混淆                                                 | `backup.ts` 是配置/工作流元数据；`nodePack` 快照是启用状态                                                                                                 | 用户以为“快照”能回滚环境                                            |
| P1-13 | ROCm/XPU/MPS 的 torch 校验是空操作                                | `installer.ts:214-223, 1053-1062` 只比较 `torch.version.cuda`                                                                                              | 镜像给了 CPU wheel 也能“验证通过”，首次推理才失败                   |
| P1-14 | 镜像装错频道后不回退官方                                          | `installer.ts:1387-1399` 的 fallback 只包住安装，不包住 verify                                                                                             | 一个能装但给错 wheel 的镜像会让整个安装失败                         |
| P1-15 | `envLock` 实际只覆盖 pipOps / deps                                | `envLock.ts`；`env.repairEnv`、`pythonMigration`、installer 未拿锁                                                                                         | Doctor 修复 / 详情页修复 / 迁移可同时写同一 venv                    |
| P1-16 | 迁移失败卡 `migrating`                                            | `pythonMigration.ts:170-189` 基础解释器解析在 try 之外                                                                                                     | 下载失败/取消后 UI 无法再次触发迁移                                 |
| P1-17 | 重装不处理既有 3.12 venv                                          | `installer.ts:1183-1220` 直接往旧 venv 建，再校验失败                                                                                                      | 0.1.18 原路径重装大概率死在第 3 步，而不是走迁移向导                |
| P1-18 | selfcheck 与运行中实例共享 user/db                                | `selfcheck.ts:29-37` 只换端口，不传 base/user 目录                                                                                                         | 两个进程可能同时写 `comfyui.db`                                     |
| P1-19 | 工作流预检仍以全局模型索引为主                                    | `preflight.ts:100-180`                                                                                                                                     | 另一个实例里的同名模型会让预检误报“已存在”                          |
| P1-20 | Manager 互斥组未校验                                              | `shared/launchArgs.ts:433-457` 漏 `--disable-manager-ui` + `--enable-manager-legacy-ui`                                                                    | ComfyUI argparse 直接退出，应用却放行                               |
| P1-21 | `--force-output-rerun` 缺失 / `--directml` 过期                   | `shared/launchArgs.ts:237-353` 与上游 110 flag 差 1:1                                                                                                      | 新功能不可发现；旧 flag 对 0.46 无效                                |
| P1-22 | `frontendVersion` 是死字段                                        | `shared/launchArgs.ts` 从未渲染 `--front-end-version`                                                                                                      | 保存了但永远不生效                                                  |
| P1-23 | `escapeForBat` 在双引号内再转义 `^`                               | `instance/launchArgs.ts:31-39`                                                                                                                             | 含 `&` / `^` 的路径导出 .bat 后参数错误                             |
| P1-24 | ready 探针并发 tick / 超时回调无 generation 守卫                  | `lifecycle.ts:172-271`                                                                                                                                     | 重复 ready 日志；stop 后旧回调把状态翻回 error                      |
| P1-25 | `suggestPort` / `pickPort` 不排除其它实例端口                     | `lifecycle.ts:56-98`、`installer.ts:1762-1779`                                                                                                             | 多实例批量启动时端口冲突                                            |
| P1-26 | 安装后版本缓存不失效                                              | `runtime.ts:44-83`；installer 不调 `invalidateVersionCache`                                                                                                | 安装完成仍显示旧版本/`detected`                                     |
| P1-27 | 诊断包空日志/缺配置处理不健壮                                     | `diagnostics.ts:11-28`                                                                                                                                     | 有 runtime 但内存日志为空时写空 console.log；config 缺失可崩        |
| P1-28 | 远程/本地作用域不一致                                             | `NodesView.vue:660-684`、`WorkflowsView.vue:172,739`、`BatchView.vue:459-461`、`OutputView.vue:773-783`                                                    | 远程下仍可点本地专属操作；纯远程用户无法入队；查看产物进本地空库    |
| P1-29 | Nodes 深链冷启动失效                                              | `NodesView.vue:965-969` 先未 await 的 `applyFocus()` 再 `refresh()`                                                                                        | 从 IssueCenter 跳转不滚动、不高亮，甚至误报“找不到包”               |
| P1-30 | 加载失败被渲染成空数据                                            | `InstancesView.vue:182-194,1089-1104`、`BatchView.vue:143-159,757-761`、`IssueCenterView.vue:80-89,211-212`                                                | 主进程/网络故障被误读为“没有实例/任务/问题”                         |
| P1-31 | 破坏性操作确认不一致                                              | `IssueCenterView.vue:148-153`、`NodesView.vue:432-451`、`InstanceDetailView.vue:266-306,783-801`、`SettingsView.vue:467-475`                               | 一次误点忽略全部问题/清空残留/迁移/回滚/丢 API Key                  |
| P1-32 | 重装 torch 默认 CPU                                               | `InstanceDetailView.vue:917,934-937`                                                                                                                       | CUDA 用户容易把 GPU torch 换成 CPU                                  |
| P1-33 | 测试代理会静默保存整份表单                                        | `SettingsView.vue:329-353`                                                                                                                                 | 用户以为只测代理，实际把安全级别/网络模式等草稿全部持久化           |
| P1-34 | 列表/详情请求竞态与重复请求                                       | `OutputView.vue:379-394,729-753`、`WorkflowsView.vue:184-198`、`ModelsView.vue:725-732`、`InstallView.vue:414-448`                                         | 旧响应覆盖新实例；过滤一次触发两次请求；预检旧结果放行/阻断安装     |
| P1-35 | 误导性反馈 / i18n 缺口                                            | `SettingsView.vue:616`、`MarketView.vue:538`、`BatchView.vue:198`、`useComfyUpdate.ts:649`                                                                 | “全部测活”当成功文案；硬编码英文；`TARGET_REQUIRED` 未本地化        |
| P1-36 | Embed resize IPC 洪泛 / Dashboard 轮询不暂停                      | `EmbedView.vue:55-65,116-141`、`DashboardView.vue:220`                                                                                                     | 拖动窗口每像素一次 IPC；隐藏窗口仍 5s 轮询                          |
| P1-37 | 路由 `/embed` 无导航元数据                                        | `router/index.ts`、`App.vue:222-227,635`                                                                                                                   | 内嵌 ComfyUI 时侧栏高亮 Dashboard、页头标题“总览”                   |
| P1-38 | ErrorBoundary 不随路由重置                                        | `App.vue:781-787`、`ErrorBoundary.vue:17-26`                                                                                                               | 页面 A 崩溃后切到 B 仍是错误页，壳层导航失效                        |
| P1-39 | migrationState IPC 失败被当成迁移失败                             | `App.vue:351-360,761-780`                                                                                                                                  | 临时桥错误会把整个应用锁进迁移阻断页                                |
| P1-40 | 更新进度共享槽无 runId / `interrupted` 非终态                     | `useComfyUpdate.ts:94-106`、`NodeOpProgressModal.vue:86-92`                                                                                                | 并发更新/修复/节点操作互相覆盖；重载后永久“运行中”                  |
| P1-41 | `messageKey/params` 全链路未消费                                  | `useIpc.ts:58-66`、三个进度弹窗                                                                                                                            | 中文界面大量英文进度句与英文错误                                    |
| P1-42 | CSP `connect-src/frame-src` 允许任意 http(s)                      | `src/renderer/index.html:6-11`                                                                                                                             | 与注释不符；XSS 后外联不受限                                        |
| P1-43 | TaskCenter 会复活已结束 op / 不 prune                             | `TaskCenter.vue:115-128,163`                                                                                                                               | 运行中行永久残留，列表只增不减                                      |
| P1-44 | `pruneActiveInstance` 自动回退 `instances[0]`                     | `stores/app.ts:199-204`                                                                                                                                    | 用户正在操作 B，B 被删除后静默切到 A，破坏性操作可能落错目标        |
| P1-45 | 覆盖率 ratchet 可绕过                                             | `coverage-ratchet.cjs:96-101` 新文件仅 informational；baseline 可删条目/改名/`--update` 降级                                                               | README“新增代码不能拉低基线”不成立；新模块可 0% 通过                |
| P1-46 | 迁移/3.12 阻断测试过薄                                            | `dataMigration.test.ts` 仅 2 用例；`migration.ts` 48% lines / 25% branches；无 `migration-required` 生命周期测试                                           | 单向、可能丢数据的高风险路径没有回归锁                              |
| P1-47 | 深链 / IssueCenter 无 DOM 行为测试                                | `NodesView.vue:826-890`；`views.smoke.test.ts` 只挂载                                                                                                      | WP4 的“去修复一定落在正确实例和节点”无证据                          |
| P1-48 | 门禁脚本本身弱                                                    | `check-test-polarity.cjs:59` 漏 `it.each/options`；`test-behavior-ratio` 目标 60%；`check-hardcoded-zh` 只扫 `.vue` + constants；`format:check` 只扫 `src` | “完整中英双语/行为占比/格式”被夸大                                  |
| P1-49 | desktop / tray 几乎未测                                           | `desktop.ts` 4.41% lines；`tray.ts` 56.86%；`launcher.test.ts` 只测 `safeShortcutName`                                                                     | Windows 快捷方式/开机自启/托盘无自动验证                            |
| P1-50 | `test:all` 不是完整门禁                                           | `package.json:47` 缺 lint/format/i18n/hardcoded/polarity/version                                                                                           | 开发者本地自测会漏掉一半 CI                                         |
| P1-51 | 文档陈旧/矛盾                                                     | `README.md:231,316,389,481,502`；`docs/PLAN-0.2.0.md` 行号/文件数全部过期                                                                                  | 用户/贡献者被错误引导                                               |
| P1-52 | 依赖安装失败在 `list()` 后消失                                    | `nodePack/install.ts:749-755` 写 `pip-failed` issue；`list.ts:277-339` 只合并 `collectIssues`，不合并持久化 issues                                         | 刷新后包显示 installed，启动才报 ModuleNotFoundError                |
| P1-53 | `issueHub.scan(instanceId)` 误解决其他实例问题                    | `issueHub.ts:197,109-145` 未出现 fingerprint 一律 resolved                                                                                                 | 对单实例扫描会把其他实例问题标已解决并隐藏                          |
| P1-54 | 产物幽灵清理从未执行                                              | `output.ts:60-88` 的 `scan()` 无生产调用；`scanAsync` 不 prune                                                                                             | 外部删除的产物永久留在索引/统计/批删目标                            |
| P1-55 | `workflow.list` TOCTOU 整体抛错                                   | `workflow.ts:473-484` `existsSync` 后 `buildRecord` 内 `statSync` 无 try                                                                                   | 一个文件消失导致工作流页整体加载失败                                |
| P1-56 | 暂停排队下载无效 / resume 打 error                                | `model.ts:1330-1339` 只 abort 已有 controller；`scheduleDownload` 不检查 paused                                                                            | 排队任务暂停后仍启动；resume 触发 “already in progress”             |
| P1-57 | 每次下载完成触发全库 rehash + 并发 scan                           | `model.ts:818-820` `scan({hash:true})`；无单飞/去抖                                                                                                        | 大库下载一个小 LoRA 触发数分钟全盘读，重复标记互相覆盖              |
| P1-58 | 节点更新 `git reset --hard` 丢弃本地修改                          | `nodePack/update.ts:711-752`                                                                                                                               | 用户在 git 包内的本地补丁/配置被静默丢弃                            |
| P1-59 | 批跑进度事件数组/对象混发                                         | `p1p2/batch.ts:117` 自愈 emit 数组，其他 emit 单 job                                                                                                       | 渲染层按对象解析可能报错/丢更新                                     |
| P1-60 | 市场 category 过滤无效 / ban 包可经 git 安装                      | `p1p2/market.ts:40`；`nodePack/install.ts:358-425`                                                                                                         | 选视频仍返回全部；被 ban 的包有 repository 时直接 git clone         |
| P1-61 | IPv6 监听在监控/对账被拒                                          | `monitor.ts:35-38`、`model.ts:114-118` 不格式化 `[::1]`                                                                                                    | IPv6-only 环境监控/模型对账不可用                                   |
| P1-62 | Registry 索引全失败仍标 ready 24h                                 | `registryIndex.ts:268-276`                                                                                                                                 | 网络抖动一次后整天搜索为空且不提示刷新                              |
| P1-63 | `install-runs` 不在 debounce 集合却用 `scheduleFileWrite`         | `db/batch.ts:35-50`、`jsonc.ts:300-307`                                                                                                                    | 400ms 内第二次写入读不到 pending，安装历史丢记录/状态回退           |
| P1-64 | JSONC BOM 被当成损坏文件                                          | `jsonc.ts:27-77,151-174`                                                                                                                                   | Windows 编辑器保存带 BOM 的合法 JSONC 被 rename `.bad` 并报 corrupt |
| P1-65 | `toV2` spread 顺序可被对象自带 `schemaVersion` 覆盖；retry 不重置 | `schema.ts:19-27`、`migration.ts:122-133`                                                                                                                  | 迁移后仍可能写出 v1；重试统计累加                                   |
| P1-66 | senderFrame 缺失时 fail-open                                      | `contract.ts:315-322`、`context.ts:101-109`                                                                                                                | 未来 API/测试环境可绕过来源校验                                     |
| P1-67 | `activeInstance` 不在 `AppSettings` / known keys                  | `target.ts:70-76`、`db/settings.ts:38-61`                                                                                                                  | `resolveActiveTarget` 的 fallback 实际不可用                        |

### 3.3 P2（0.2.5 收尾或后续）

| ID    | 问题                                     | 说明                                                                                                                    |
| ----- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| P2-1  | `pids.json` 非原子写                     | 崩溃时可能丢失孤儿 PID；改为临时文件 + rename                                                                           |
| P2-2  | 日志逐行 `writeFileSync`                 | 高 debug 输出时阻塞主进程；可批量写                                                                                     |
| P2-3  | 巨文件                                   | `InstanceDetailView.vue` 2,247 行、`NodesView.vue` 2,027 行                                                             |
| P2-4  | 安装包未签名                             | SmartScreen 提示；需要证书/发布策略                                                                                     |
| P2-5  | macOS / Linux 未实机验证                 | 配置存在但未承诺                                                                                                        |
| P2-6  | 覆盖率 ratchet 只能防回退                | 新文件仍可能低覆盖；本次新增文件必须单独补测                                                                            |
| P2-7  | 端口冲突等待窗口偏短                     | 与 P1-8 同源，可配置化                                                                                                  |
| P2-8  | 备份恢复的跨机器路径重映射               | 已有安全重映射，但 UI 可更清楚                                                                                          |
| P2-9  | Linux/macOS 运行时 tar 符号链接被拒      | `zipSafe.ts:136-144` 拒绝一切符号链接，而 `bootstrap.ts:302-311` 接受 `python3 -> python3.13`；该平台运行时可能解包失败 |
| P2-10 | 自定义镜像 `--trusted-host` 关闭证书校验 | `installer.ts:1070-1078`；仅应在明确的离线/自签场景使用，需文档警示                                                     |

其他值得在 0.2.5 收尾或后续一并收口的 P2：

- `IPC_EVENTS.instanceLog` 是死事件，主进程只发 `instanceLogBatch`；`IpcChannelMap`/`IPC_CHANNELS`/handlers/schemas 四处手工同步，新增渠道易漂移。
- `activeInstance` 不在 `AppSettings` / `KNOWN_SETTINGS_KEYS`，`resolveActiveTarget` 的 fallback 实际不可用。
- `install-runs` 不在 debounce 集合却用 `scheduleFileWrite`，400ms 内二次写入会丢记录。
- JSONC 不剥 BOM；`toV2` 的 spread 顺序可被对象自带 `schemaVersion` 覆盖；`retryDataMigration` 不重置 `migratedFiles`。
- `senderFrame` 缺失时 fail-open；dev URL 用 `startsWith` 而非精确 origin。
- Linux `basic_text` 被显示为 os-keychain；无 keychain 时凭据明文落盘，文件默认 0644。
- `shell.openPath` 未阻止 `.py/.sh/.pyc`；`output.thumb/scan` 根未 realpath；`exportLaunchScript` 的 dir 可被符号链接重定向。
- `networkMode=offline` 只阻止 node install；`allowPipInstall` 只覆盖 nodePack/deps，`instance.pipInstall` 可绕过。
- app 自更新 `autoInstallOnAppQuit=true`，用户未点安装也可能在退出时安装；`error` 事件会覆盖已 `downloaded` 状态。
- `render-process-gone` / `did-fail-load` 只记录不恢复；窗口创建早于 IPC/协议注册，存在启动竞态。
- `uncaughtException` 后继续运行，主进程状态可能已损坏；`slowOps` 全局 pause 未生效。

---

## 4. 0.2.5 目标与验收画面

### 4.1 目标

| 目标              | 说明                                                                         |
| ----------------- | ---------------------------------------------------------------------------- |
| **G1 运行真相**   | 实例健康有独立状态、证据与时间线；卡死不再显示绿色                           |
| **G2 可救援**     | 不解锁 Windows 也能通过 `--rescue` / 托盘 / 命令面板救回；安全模式可排除节点 |
| **G3 更新可信**   | stable / nightly 双通道；更新后必须通过真实启动验证；失败自动回滚            |
| **G4 上游对齐**   | Manager v4.4、ComfyUI 0.46、CUDA 13 / ROCm 7.2 / 10.0                        |
| **G5 路径真相**   | port/listen/dirs 以最终 argv 为准，所有资产操作一致                          |
| **G6 安全边界**   | 路径 capability 化；S1/S2/S3 RCE 链、恶意备份、符号链接越界全部被负例锁死    |
| **G7 资产真相**   | Civitai 下载可入库；批跑不误判排队；备份可跨机/可重映射；输出路径不可越界    |
| **G8 体验与发布** | 远程作用域/错误态/确认一致；release gate 能证明 packaged 产物可启动          |
| **G9 无破坏**     | 数据 schema 不变；0.2.4 实例/设置/备份可直接用                               |

### 4.2 验收画面

#### A. 卡死可见

- 进程存活、端口 `LISTENING`、HTTP 连续 3 次超时、日志 3 分钟无新增 → `suspect`。
- 连续 6 次超时、端口仍监听、进程存活、日志/进度停滞 → `unresponsive`，并给出证据列表。
- 队列正在运行且有 WS/日志进度 → `busy`，不会因为 HTTP 短暂超时被判死。
- 实例卡死时，实例卡、详情页、托盘、Dashboard 四处状态一致。

#### B. 卡死可救

- 在 Windows 锁屏、ComfyPilot 窗口不可操作时，执行：

```bat
"D:\ProgramFiles\ComfyPilot\ComfyPilot.exe" --rescue <instanceId>
```

- 已运行的 ComfyPilot 通过 `second-instance` 收到命令，执行 `forceKill → launch → waitReady`。
- 结果写入 `%APPDATA%/comfy-pilot/logs/control.log`，并弹系统通知。
- 未知 id / remote id / 正在启动 / 重复救援都有明确拒绝，不会误杀。

#### C. 安全模式

- “安全模式启动”只对本次启动追加 `--disable-all-custom-nodes`，不删除、不禁用任何节点包。
- 启动成功后显示横幅：“安全模式：自定义节点未加载”，提供“退出安全模式并重启”。
- 安全模式仍失败时，诊断包能证明是核心/环境问题，而不是节点问题。

#### D. 更新可信

- 新实例默认 `stable`；旧 master 实例显示“当前跟踪 master（nightly）”，可一键切 stable。
- stable 检查到 v0.46.0 时，更新使用 tag archive；不是 master。
- 更新后执行真实启动自检；失败自动回滚源码，保留 journal 与节点快照。
- UI 不再出现“更新完成”但实例起不来的状态。

#### E. Manager 说清楚

- 实例详情显示 Manager 版本、`config.ini` 真实路径、安全等级、网络模式、快照目录、legacy backup。
- ComfyPilot 安装策略与 Manager 安全等级分开展示，文案不再混用 `security_level`。
- 修改 Manager 安全等级需要确认，备份原文件，原子写入，提示“下次启动生效”。

#### F. 路径一致

- 设置 `--base-directory D:\CP\base --user-directory D:\CP\user --models-directory D:\CP\models` 后：
  - 节点安装到 `D:\CP\base\custom_nodes`。
  - 工作流同步到 `D:\CP\user\default\workflows`。
  - 模型扫描/下载使用 `D:\CP\models`。
  - 诊断包显示相同路径。
- `--port 9999` / `--listen 0.0.0.0,::` 时，探针与 URL 使用有效值。

#### G. 安全边界

- `model.download` 写 `main.py` / `python.exe` / `.bashrc` / Startup `.bat` → 拒绝。
- `settings.set({ modelScanRoots:['/'] })` → 拒绝；扫描根只能由 picker 追加。
- `instance.save` 任意 home 路径 / 实例内任意 `python.exe` → 拒绝；启动前必须有 ComfyUI 指纹。
- 恶意备份注入 `pythonPath` / `launchProfile.outputDirectory` / `proxy.password` → 预览拒绝或剥离。
- `output.thumb/scan` 根、`exportLaunchScript` 目录、`model.move` 目标为符号链接 → 拒绝。

#### H. 资产真相

- Civitai 下载文件名带安全扩展名，下载完成后能被模型扫描索引。
- 批跑任务在 GPU 忙碌、排队 >30s 后正常出图，不被误判超时；queue 中仍存在时续期。
- 备份在换机/换盘/移动盘场景给出重映射/跳过选项，不再因模型绝对路径整体拒绝。
- 恶意 `subfolder` / 绝对路径 / `..` 的 history 输出不能被索引或删除。
- 取消下载清理 `.part`，同一文件可重新下载。

#### I. 体验与发布

- 远程上下文下本地专属按钮禁用；Workflows 远程入队可用；Nodes 深链刷新后高亮。
- 加载失败显示错误与重试，不显示空数据；破坏性操作有确认。
- release gate 包含 build + E2E + packaged `--dir` smoke；Windows 也跑覆盖率。
- `docs/PLAN-0.2.5.md` 的 release note、README、CI 陈述与实际一致。

#### J. 质量

- 每个新增正向行为都有对应失败/拒绝反例。
- 覆盖率不低于 0.2.4 基线；172 个文件逐文件 ratchet 不回退。
- Ubuntu + Windows CI 全绿；Windows 实机完成 §8.2 全部场景（7 个基础 + 安全/资产抽检）。

---

## 5. WP 设计

### 5.0 0.2.5 全量范围与执行顺序

**爸爸已确认：WP0–WP10 全部进入 0.2.5，不拆到后续版本。** 这是一次“大版本收口”，不是单纯功能迭代。

按 1 人 + AI 辅助估算：**46–58 人日**（WP 估算合计；含集成、回归、Windows 实机与发布缓冲约 **50–64 人日**）。

执行顺序按依赖排，不按编号排：

| 阶段              | WP                                                     | 依赖                                               | 关键产出                                                                                        |
| ----------------- | ------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **M1 基础事实**   | WP1 路径/有效启动、WP10 安全边界、WP0 生命周期/安装器  | WP1 与 WP10 可并行；WP0 依赖 WP1 的 effective 解析 | 路径/端口/目录全部一致；S1/S2/S3 RCE 链被堵；stop/start 无孤儿；安装器无跨轮污染                |
| **M2 运行真相**   | WP2 健康、WP3 救援/安全模式                            | WP2 依赖 WP0/WP1；WP3 依赖 WP2                     | 卡死 3 分钟内变红；`--rescue` 锁屏可救；安全模式可启动                                          |
| **M3 资产与上游** | WP9 资产 P0、WP4 Manager、WP5 更新安全、WP6 运行时矩阵 | WP9/WP4/WP6 依赖 WP1；WP5 依赖 WP0/WP4 的节点快照  | Civitai/批跑/备份/输出 P0 修复；Manager v4.4 真实 schema；stable 更新有启动验证；torch 矩阵对齐 |
| **M4 体验与发布** | WP7 渲染层反馈、WP8 测试/发布可信度 + 文档             | WP7 依赖 WP2/WP3；WP8 最后                         | 远程作用域/错误态/确认统一；release gate 能证明安装包能启动；CI 双平台绿                        |

**关键路径**：

```
WP1 + WP10 → WP0 → WP2 → WP3 → WP7 → WP8 → 0.2.5
```

**可并行**：WP9、WP4、WP5、WP6 在 WP1 完成后并行；WP8 的文档/门禁脚本可提前写，但最终验证必须等所有 WP 合并。

**内部 beta 不改变最终版本**：

- M1 完成 → `0.2.5-beta.1`（基础事实 + 安全边界）
- M2 完成 → `0.2.5-beta.2`（运行真相）
- M3 完成 → `0.2.5-beta.3`（资产/上游）
- M4 完成 → **`0.2.5` 正式版（包含全部 11 个 WP）**

> 每个 WP 仍可独立合并、独立测试；但最终 `0.2.5` 的 release note 必须覆盖全部 11 个 WP，不能把任何一个说成“下个版本”。

### WP0 生命周期与安装器根因修复（先做）

**问题**：P0-5。健康/救援建立在状态机之上，状态机不可信时，上层功能只会放大错误。

**0.1 安装器 run 隔离**

- 每个 run 保存自己的 `token`、`progress`、`children` 引用。
- `reset()` / 新 run 启动后，旧 run 的 catch/finally 在**写任何状态前**校验 `this.runToken === myToken && this.progress === myProgress`；不匹配直接 return，不碰新 run 的 children。
- `reset()` 只允许在没有活跃 child 且当前 run 已明确结束时清理；下载阶段也要有可取消的 token。
- ComfyUI zip 下载：
  - 加 `AbortController`，`cancel()` 立即 abort fetch；
  - 流内每 chunk 检查 token；
  - 真实 `setBytes` 进度；
  - 至少校验 release asset 的 SHA256；无法校验时默认拒绝（与运行时策略一致）；
  - 只允许 `https`，不允许 `http` 镜像。

**0.2 环境修复不再伪造版本**

- `repairEnv` 已存在 venv 时先 `pythonVersionText` 实测：
  - 3.13 → 才写 `pythonVersion:'3.13.18'`、`migrationState:'none'`；
  - 3.12 → 保留真实版本，返回 `PYTHON_MIGRATION_REQUIRED`，引导迁移；
  - 其它 → 保留真实版本，返回 `PYTHON_UNSUPPORTED`。
- `recreateVenv` 先归档旧 venv（`venv.pre-recreate-<ts>`），失败可回退，不再先删后建。
- `envLock` 接入 `repairEnv` / `pythonMigration` / installer register；冲突返回可读 `ENV_BUSY`。

**0.3 生命周期状态机**

- `startInner` 在每次 await 后、spawn 前校验 `generation` / `cancelRequested`；spawn 后若已过期立即 tree kill。
- `stop` 的“等待 start 结束”改为显式状态轮询 + 取消信号，不再固定 10s 后假设已停。
- ENV_MISMATCH / 启动参数非法 / Python 不支持统一置 `error` + emit + 清 ready。
- 收养：台账 PID + 命令行包含 `main.py` + 命令行包含 `config.path` 三重校验；owned 时写 `managed=true`，Stop 允许杀；`suggestedPort` 用真实空闲端口。
- `waitReady` 记录真实 elapsed；已停止且无进程时立即返回，不创建 305s 悬挂 waiter。
- `lastExit` 在 stop/forceKill 后清空，避免已停止实例继续展示上次崩溃原因。
- `suggestPort` / `pickPort` 排除所有已配置实例的端口；installer 的 `pickPort` 复用同一分配器。

**0.4 迁移与自我检查**

- `pythonMigration` 把基础解释器解析移进 `try`；失败/取消时置 `migration-failed`，不再卡 `migrating`。
- 迁移接受取消信号；torch 索引走 `resolveTorchIndex`（尊重镜像）；旧 venv 归档保留策略写入文档。
- `selfcheck` 传入 effective base/user 目录（WP1 的解析器），避免与运行中实例共享 `comfyui.db`。

**0.5 测试**

- `tests/unit/installerRunIsolation.test.ts`：reset 后旧 run 不污染新 run；取消中断 zip 下载；校验失败删除。
- `tests/unit/envTruth.test.ts`：3.12 venv 修复后仍报 3.12；3.13 才写 marker；recreate 归档。
- `tests/unit/lifecycleRace.test.ts`：start/stop/forceKill 在 spawn 前后交错；收养 owned → managed=true；ENV_MISMATCH → error；waitReady 立即返回。
- `tests/unit/selfcheckPaths.test.ts`：base/user 覆盖时 selfcheck 使用正确目录。
- 负例：旧 run token 不匹配、zip http 镜像、校验和错误、3.12 修复、spawn 过期、端口占用时建议端口仍被占用。

**工作量**：5–6 人日。

---

### WP1 有效启动解析与目录布局（基础，先做）

**问题**：P0-2。

**新增**

- `src/main/services/instance/effective.ts`（或 `src/shared/instanceLayout.ts`，主/渲染共用纯函数）。
- `src/shared/types/instance.ts` 增加：

```ts
export interface ResolvedInstanceDirs {
  base: string
  user: string
  models: string
  customNodes: string
  input: string
  output: string
  temp: string
  previews?: string
  workflows: string
  manager: string
}

export interface EffectiveLaunch {
  port: number
  listen: string
  probeHost: string
  url: string
  dirs: ResolvedInstanceDirs
}
```

**解析规则**

- 从最终 argv 取**最后一个** `--port`、`--listen`、目录 flag（与 argparse 行为一致）。
- 支持 `--flag value` 与 `--flag=value`。
- `--listen` 支持逗号分隔：
  - 含 `0.0.0.0` / `::` / `[::]` → 探测 `127.0.0.1`。
  - 含 `127.0.0.1` → 用它。
  - 否则用第一个非空地址。
- 目录：
  - `base` = `--base-directory`（相对则相对实例根）否则实例根。
  - `models` = `--models-directory` 否则 `base/models`。
  - `customNodes` = `base/custom_nodes`。
  - `user` = `--user-directory` 否则 `base/user`。
  - `input/output/temp/previews` 同理。
  - `workflows` = `user/default/workflows`。
  - `manager` = `user/__manager`。
- 纯函数，无 FS 访问；路径拼接兼容 Windows/POSIX。

**改造点**

| 模块                                    | 改动                                                             |
| --------------------------------------- | ---------------------------------------------------------------- |
| `instance/lifecycle.ts`                 | `checkPort` / `baseUrlOf` / 就绪探测用 effective                 |
| `instance/runtime.ts`                   | `toInfo()` 返回 `effectivePort/effectiveListen/url/resolvedDirs` |
| `capabilities.ts`                       | 用 effective URL                                                 |
| `monitor.ts`                            | `assertMonitorBaseUrl` / 队列 URL 支持多地址                     |
| `workflow.ts`                           | 工作流目录、baseUrl                                              |
| `nodePack/common.ts`                    | `detectCustomNodesRoot` 用 `customNodes`                         |
| `nodePack/list/install/update/recovery` | `.disabled` / 安装根                                             |
| `model.ts`                              | allowed roots、扫描根、reconcile                                 |
| `p1p2/output.ts` / `media.ts`           | 输出根                                                           |
| `backup.ts`                             | 恢复根                                                           |
| `diagnostics.ts`                        | 诊断内容                                                         |
| `doctor.ts`                             | custom_nodes / Manager                                           |
| `p1p2/market.ts`                        | 安装检测                                                         |

**安全**

- 路径审批统一走 WP10 的 `PathCapability`；WP1 只负责“解析成唯一有效值”，不重复实现一套 allow-list。
- `instance.save` 的 `launchProfile.*Directory` 必须消费 capability（实例根、picker 选择或已批准根）。
- 从磁盘加载的旧配置保持兼容；首次保存时提示并批准。
- 解析结果做 `isPathInside` / realpath 复核，防止 `..` 与符号链接逃逸。

**测试**

- `tests/unit/instanceLayout.test.ts`：
  - 默认路径。
  - 每个目录 flag 单独覆盖。
  - 相对/绝对路径。
  - `--port=9999`、重复 `--port` 取最后一个。
  - `--listen` 单地址/多地址/通配。
  - Windows 盘符与 POSIX 路径。
  - 反例：`..`、空值、非法 flag、未知目录、越界路径。
- `tests/integration/instancePaths.test.ts`：真实临时目录，节点/工作流/模型路径一致。
- 回归：现有 `instanceService` / `launchArgs` / `workflow` / `model` 测试全绿。

**工作量**：4–6 人日。

---

### WP2 健康模型与看门狗

**问题**：P0-1。

**新增**

- `src/main/services/instance/health.ts`。
- `src/shared/types/health.ts`：

```ts
export type HealthState =
  'unknown' | 'healthy' | 'busy' | 'suspect' | 'unresponsive' | 'crashed' | 'stopped'

export interface InstanceHealth {
  state: HealthState
  checkedAt: number
  since: number
  latencyMs?: number
  consecutiveFailures: number
  lastOkAt?: number
  lastLogAt?: number
  lastProgressAt?: number
  queueRunning: number
  queuePending: number
  portListening: boolean
  processAlive: boolean
  processCpu?: number
  gpuUtilization?: number
  evidence: string[]
  message?: string
}
```

**状态机**

```
unknown ── first ok ──► healthy
healthy ── http fail x3 ──► suspect
suspect ── http ok ──► healthy
suspect ── fail x6 + port listening + log stale + no progress ──► unresponsive
suspect ── port not listening + process alive ──► crashed
unresponsive ── http ok ──► healthy
* ── process exit ──► stopped
```

**判定证据**

- `http-timeout` / `http-error`
- `port-listening` / `port-not-listening`
- `process-alive` / `process-gone`
- `log-stale`（默认 180s，可配 60–1800s）
- `no-ws-progress`
- `queue-running`
- `gpu-idle`（可选，仅辅助）
- `process-cpu-low`（可选，辅助）

**关键规则**

- 队列有 running 且 30s 内有 WS/日志进度 → `busy`，即使 HTTP 短暂失败。
- 只有 HTTP 失败、端口仍监听、进程存活、日志/进度停滞同时成立才 `unresponsive`。
- 端口不监听但进程存活超过 10s → `crashed`，不是 `unresponsive`。
- WS 只在当前监控实例连接；未连接 WS 时，WS 证据只作辅助，不单独判死。
- 默认**只告警，不自动杀**；自动恢复由 WP3 的策略控制。
- adopted 外部实例永不自动杀。

**实现**

- 每实例一个定时器（默认 5s，带 ±20% jitter，避免同时打满）。
- 单飞：同一实例同时只有一个探测。
- HTTP 用 `AbortSignal.timeout(2000)`；TCP 用 `net.connect` + 1500ms。
- 订阅 `instanceService.on('log')` 更新 `lastLogAt`；订阅 `monitorService.on('ws')` 更新 `lastProgressAt`。
- 只对 managed / adopted 且 `running` 的实例轮询；`stopped/error` 停止。
- 状态变化写 `logs/health.log`（一行一个 transition），并广播 `instanceHealth`。
- 诊断包增加 `health.json`、`process.json`、`ports.json`、`gpu.json`、`manager.json`。

**UI**

- 新增 `HealthBadge.vue`：healthy 绿、busy 蓝、suspect 橙、unresponsive/crashed 红、stopped 灰。
- 实例卡、详情页、Dashboard、托盘 tooltip 统一使用。
- 详情页健康面板：最后心跳、HTTP 延迟、日志最后时间、队列、证据、操作按钮。
- 通知：“实例无响应” + 强制重启 / 安全模式 / 查看诊断。
- 设置 → 实例健康：轮询间隔、超时、日志停滞阈值、自动恢复开关。

**测试**

- 真实 `http.createServer`：正常响应、延迟响应、只 accept 不响应、直接关闭。
- 假定时器：3 次/6 次阈值、恢复、进程退出。
- 队列 running + WS 进度 → 不误判。
- adopted 外部实例 → 不自动杀。
- 负例：HTTP 一次失败、日志短暂安静、端口未监听、进程已退出、远端实例不参与。

**工作量**：4–5 人日。

---

### WP3 救援、安全模式与自动恢复

**问题**：P1-1、P1-2、P1-7、P1-8。

#### 3.1 单实例救援命令

**形态**：复用现有 `requestSingleInstanceLock` + `second-instance`。

```bat
ComfyPilot.exe --rescue <instanceId>
ComfyPilot.exe --safe-rescue <instanceId>
ComfyPilot.exe --stop <instanceId>
ComfyPilot.exe --start <instanceId>
ComfyPilot.exe --status
```

**行为**

- 第二个进程启动 → 拿不到锁 → 第一个实例收到 `second-instance(argv)`。
- 第一个实例解析命令，执行 `instanceService.forceKill(id)` → `launch(id)`。
- 结果写 `logs/control.log`；`--status` 写 `logs/control-status.json`。
- 如果第一个实例不存在，新进程正常启动，`whenReady` 后执行同一命令。
- 救援有 30s 冷却；同实例重复命令合并，不叠加。
- 未知 id / `remote:` / 正在启动 / adopted 外部实例 → 拒绝并记录原因。
- 应用主进程卡死时无法救援；文档明确给出 `taskkill` 兜底。

**新增文件**

- `src/main/control.ts`：argv 解析、命令执行、结果落盘。
- `src/main/index.ts`：`second-instance` 分发、启动后命令执行。
- IPC：`instance.exportRescueScript(id)` 生成 `.bat`。
- UI：命令面板“强制重启当前实例 / 安全模式启动 / 复制救援命令”；托盘每实例“强制重启”；详情页“救援”菜单。

#### 3.2 安全模式

- `LaunchOptions.safeMode?: boolean`。
- 只在本次 argv 追加 `--disable-all-custom-nodes`，不改配置、不删节点。
- 启动成功后 `ComfyInstanceInfo.safeMode = true`，UI 横幅 + “退出安全模式并重启”。
- 安全模式失败 → 诊断包标记 `safeMode=true`，帮助区分核心问题/节点问题。
- 自动恢复连续失败 2 次后，第三次尝试安全模式（可配）。

#### 3.3 自动恢复策略

```ts
export interface HealthRecoveryPolicy {
  enabled: boolean // 默认 false（只告警）
  action: 'restart' | 'safe-restart'
  afterMs: number // unresponsive 持续多久才动手，默认 60s
  maxAttempts: number // 10 分钟内最多 3 次
  cooldownMs: number // 两次尝试间隔，默认 5 分钟
  killRunningJobs: boolean // 队列在跑时是否允许杀，默认 false
}
```

- 默认关闭；用户显式开启才自动杀。
- 冷却 + 最大次数 + 熔断；触发熔断后只通知，不再重启。
- adopted 外部实例、remote 实例永不自动恢复。

**测试**

- argv 解析：合法/非法/缺 id/未知 flag/`--rescue=id`。
- `second-instance`：运行中、未运行、重复、冷却。
- 未知 id / remote / adopted → 不杀。
- 安全模式：argv 只加一次 flag、退出后清掉、失败诊断标记。
- 自动恢复：成功一次、连续失败熔断、队列在跑默认不杀。
- 负例：stop 返回 `exited:false` 时不 launch；端口仍占用时不误报成功。

**工作量**：4–5 人日。

---

### WP4 ComfyUI-Manager v4.4 对齐

**问题**：P0-4、P1-6。

**新增**

- `src/main/services/manager.ts`。
- `src/shared/types/manager.ts`：

```ts
export interface ManagerInfo {
  installed: boolean
  version?: string
  source: 'pip' | 'git' | 'none'
  configPath?: string
  configExists: boolean
  securityLevel?: 'strong' | 'normal' | 'normal-' | 'weak'
  networkMode?: 'public' | 'private' | 'offline' | 'personal_cloud'
  snapshotsDir?: string
  legacyBackup?: string
  legacyConfigPath?: string
  warnings: string[]
}
```

**路径**

```
userDir = resolved effective user dir
managerDir = userDir/__manager
config = managerDir/config.ini
legacy = userDir/default/ComfyUI-Manager
snapshots = managerDir/snapshots
```

- v3.38+ 优先 `__manager`；旧版回退 `default/ComfyUI-Manager`。
- pip 安装检测：`python -m pip show comfyui-manager` + `importlib.metadata`（缓存 60s）。
- git 安装检测：`custom_nodes/ComfyUI-Manager` + 版本文件。
- `--enable-manager` 判定改为最终 argv / 模板 / profile 的综合结果，不再只看 `extraArgs`。

**config.ini 读写**

- 行级解析，保留注释、未知键、其他 section。
- `%` 按普通文本处理（对齐 Manager 4.4.2 修复）。
- 只写 `[default]` 下明确允许的键：`security_level`、`network_mode`。
- 写前备份 `config.ini.bak-<ts>`；临时文件 + fsync + rename。
- 值非法 → 拒绝，不写。
- 默认只读；写操作需显式确认，提示“下次启动生效”。

**列表源**

- 顺序改为：
  1. `Comfy-Org/ComfyUI-Manager/manager-v4/custom-node-list.json`
  2. `Comfy-Org/ComfyUI-Manager/main/custom-node-list.json`
  3. `ltdrdata/ComfyUI-Manager/main/custom-node-list.json`（legacy fallback）
- 不再“第一个非空就 break”；合并去重，v4 优先。
- 缓存到 `userData/app-cache/manager-channel.json`，带 ETag / 时间戳；offline 模式不联网。
- 校验每条记录：id/name/repository 或 files；超过上限截断并记录。

**UI**

- 实例详情“管理器”卡：版本、路径、安全等级、网络模式、快照数、legacy backup 警告。
- “打开 config.ini / 打开 snapshots / 复制诊断”。
- Manager 未安装时显示“安装 ComfyUI-Manager v4.4（pip）”；显式确认、走代理/镜像、失败回滚，不静默安装。
- 设置页把 `securityLevel` 改名为“ComfyPilot 安装策略”，加说明“不是 Manager 的 security_level”。
- Doctor 增加：Manager 版本、路径、`comfyui_outdated`、legacy backup、策略不一致警告。

**测试**

- `tests/unit/managerConfig.test.ts`：
  - v4 path / legacy fallback。
  - 保留注释与未知键。
  - `%` 文本、CRLF、BOM。
  - 非法 security level 拒绝。
  - 原子写失败回滚。
  - 负例：缺 config、不可读、路径逃逸、注入换行。
- `tests/unit/managerInfo.test.ts`：pip/git/none、版本解析、缓存。
- `tests/unit/managerChannel.test.ts`：v4 优先、旧源遮蔽回归、404/非 JSON/空列表、离线。
- 回归：`managerEnabled` 模板用例。

**工作量**：3–4 人日。

---

### WP5 稳定更新通道与启动验证

**问题**：P0-3、P1-2、P1-11。

**新增**

- `src/main/services/updateChannel.ts`。
- `ComfyInstanceConfig.updateChannel?: 'stable' | 'nightly'`。
- `ComfyInstanceConfig.comfyChannel?: 'stable' | 'nightly'`（记录实际来源）。
- `UpdateInfo` 增加 `channel`、`releaseUrl`、`releaseNotes`。

**通道语义**

| 通道      | 来源                                            | 适用               |
| --------- | ----------------------------------------------- | ------------------ |
| `stable`  | GitHub Releases 最新正式 tag（跳过 prerelease） | 生产、默认新实例   |
| `nightly` | `master` archive / git master                   | 追新、现有实例保持 |

- 旧实例没有 `updateChannel`：按 zip/git 现状视为 nightly，UI 显示“当前跟踪 master”，提供切换。
- stable 下载 `https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/<tag>.zip`，走 GitHub 镜像。
- git 安装：`git fetch --tags` + checkout tag；保留用户改动检查；dirty 时拒绝并提示。
- 记录 `.comfypilot-env.json` 的 `comfyVersion` / `comfyCommit` / `comfyChannel`。

**更新安全**

1. 更新前：节点快照（name/version/path/source/gitRev）+ ComfyUI 版本 + launch profile。
2. 更新源码/依赖。
3. **真实启动自检**：`--quick-test-for-ci --cpu`（复用 selfcheck），超时 180s。
4. 通过 → done；失败 → 自动回滚源码（若用户未关闭），保留 journal + 节点快照。
5. 更新后节点兼容检查；失败提供“只回滚节点版本”。

**节点版本回滚 v1（0.2.5 范围）**

- git 节点：`git -C <path> checkout --detach <gitRev>`；dirty 则跳过并警告。
- registry 节点：有明确 version 时重装；无法解析 registry id 则标记“需手工处理”。
- local 节点：不自动改，标记 warned。
- 回滚前再建一个 pre-restore 快照；部分失败要逐项报告，不假装成功。

**UI**

- 实例详情更新卡：当前版本、通道、最新版本、release notes、检查/更新。
- 更新弹窗增加“验证启动”步骤；失败显示“已回滚/可回滚”。
- 旧 master 实例显示通道切换提示。

**测试**

- `tests/unit/updateChannel.test.ts`：
  - stable 新/旧/相同版本。
  - prerelease 跳过。
  - GitHub 403/429/离线。
  - tag 解析 `v0.46.0`。
- `tests/unit/updaterSafety.test.ts`：
  - 自检通过 → done。
  - 自检失败 → rollback + journal。
  - 取消在 verify 阶段 → cancelled。
  - dirty git → 拒绝。
  - zip 404 / 镜像失败。
- `tests/unit/nodeVersionRestore.test.ts`：
  - git 成功、dirty 跳过、缺路径、registry 失败、local 警告、部分失败汇总。
- 负例：不得在未验证时标记 done；不得在 rollback 失败时吞错。

**工作量**：5–6 人日。

---

### WP6 运行时矩阵与文案

**问题**：P1-3、P1-4、P1-10。

**torch 矩阵**

| 平台                 | 通道            | 说明                            |
| -------------------- | --------------- | ------------------------------- |
| Windows/Linux NVIDIA | `cu130`（默认） | 20 系及以上；CUDA 13 稳定线     |
| 旧 NVIDIA            | `cu126`         | 兼容保留                        |
| Linux AMD            | `rocm7.2`       | 官方推荐 ROCm 7.2               |
| Windows AMD          | `rocm10.0`      | 官方 Windows ROCm 10.0 多架构包 |
| Intel                | `xpu`           | 保持                            |
| macOS                | `mps`           | 保持 CPU 轮子 + MPS             |
| 无 GPU               | `cpu`           | 保持                            |

- `TorchChannel` 类型扩展；`TORCH_INDEX`、`TORCH_DISK_GB`、`expectedCudaForChannel` 同步。
- `detectGpu()`：RTX 20+ → cu130；AMD Windows → rocm10.0（不再默认 CPU）；Linux → rocm7.2。
- 安装前用索引探测 cp313 + 平台轮子是否存在；不存在则回退并明确提示。
- 允许用户手填 `torchIndexMirror`（已有）作为逃生口。

**Python 文案**

- 3.13 仍是**验证默认**；3.12 是官方回退；3.14 可用但有节点兼容风险。
- 0.2.5 不扩大自动迁移范围；只修正：
  - Doctor/安装器不再说“3.14 没有 torch 轮子”。
  - 3.12/3.14 实例显示“未验证，可用 3.13 运行时迁移”而不是笼统“unsupported”。
  - README/FAQ 明确支持矩阵。

**启动参数**

- `LaunchProfile` 增加常用结构化项：
  - `cacheRam?: number`（`--cache-ram`）
  - `cudaDevice?: string`（`--cuda-device`，`all` 或逗号 id）
  - `disableDynamicVram?: boolean`（`--disable-dynamic-vram`；0.39+ 排障高频）
  - `disableFastDisk?: boolean`（`--disable-fast-disk`）
  - `disableComfyCompiler?: boolean`
  - `forceNonBlocking?: boolean`
- 把已有的 `ComfyInstanceConfig.frontendVersion` 真正渲染为 `--front-end-version`（不是新增 profile 字段；该字段目前在保存/回填但从未生效）。
- 安全模式不放进持久化 `LaunchProfile`，只作为 `LaunchOptions.safeMode` 的一次性行为（见 WP3）。
- `validateLaunchArgs` 增加 `--cache-ram`、`--cuda-device` 的边界（已有部分）。
- TLS：检测到 `--tls-keyfile`/`--tls-certfile` 时，0.2.5 明确警告“探针暂不支持自签名 HTTPS”，避免静默假死；完整支持排后续版本。

**版本与文案**

- 版本 `0.2.5`，`check-version` / README / package.json 同步。
- README 增加“卡死救援”“健康状态”“Manager v4”“更新通道”“安全边界”五节。
- Release notes 明确：无数据迁移；新增可选字段；旧实例默认 nightly；自动恢复默认关闭。
- 手动验收按 §8.2 全部场景执行（发布门禁本身归 WP8）。

**工作量**：3–4 人日。

---

### WP7 渲染层作用域与反馈一致性

**问题**：P1-28 ～ P1-37。主进程修好“事实”后，UI 必须把事实正确地映射到当前目标，否则用户仍会被误导。

**7.1 统一目标作用域**

- 新增 `useActiveTarget()`：
  - 返回 `{ kind, localId, remoteId, url, ready, canLocalMutate }`。
  - 所有本地专属按钮（节点卸载/启停/锁定/更新/恢复、模型移动/删除、输出删除、实例迁移/回滚）统一 `disabled` + tooltip。
- `TargetBanner` 推广到 Workflows / Output / Batch / Dashboard。
- Workflows 入队门禁改为“本地 running 或 remote ready”，不再被 `activeInstance` 空值锁死。
- Batch 卡片显示 `job.instanceId` 对应实例名；远程任务隐藏“查看产物”或改为“复制远程输出路径/说明”。
- Nodes 深链切换实例时清 `activeRemoteId`；`onMounted` 先 `await refresh()` 再 `applyFocus()`。
- 远程 API Key 清除、全部忽略问题、清理全部残留、实例迁移/回滚/清日志统一二次确认。

**7.2 错误态与空态**

- `ListState` 推广到 Instances / Batch / IssueCenter；只有 `!loading && !error` 才显示空态。
- Instances 区分“真空”与“搜索无结果”，提供清除搜索。
- 所有 issue / backup / output 操作补 try/catch 与失败 toast，不再静默。

**7.3 请求竞态**

- Output：过滤变化只重置 page，由单一 watcher 触发 refresh；详情 `parsePngMeta` / assets 匹配加 request id。
- Workflows / Models：refresh 捕获 `forInstanceId` + seq，响应时校验；实例切换清空 reconcile/duplicates。
- Install：预检加 seq，watch 增加 `pythonPath`；预检未完成时禁用开始。
- Embed resize 用 `requestAnimationFrame` + 100ms 节流；Dashboard 轮询加 `visibilitychange` 暂停。

**7.4 反馈与 i18n**

- `describeNodeError` 增加 `TARGET_REQUIRED` / `REMOTE_NOT_SUPPORTED`。
- 修 `settings.testAllRemotes` 成功文案为在线/离线统计。
- 修 Market / Batch / Instances 硬编码英文与未本地化 label。
- 修 torch 重装默认 CPU：默认取当前探针通道；选择 CPU 时明确警告。
- 代理“测试”不再隐式保存全表单；如保留，按钮改为“保存并测试”。
- `/embed` 增加路由 meta 或独立 activeKey，避免侧栏高亮 Dashboard。

**7.5 壳层恢复与配置完整性**

- 新增 `instance.patch` / `instance.setPort`；端口冲突只改 port，保留 `pythonVersion/migrationState/migrationError`（P0-6）。
- ErrorBoundary 监听 `route.fullPath`，路由变化自动清 error / 重挂载。
- `data.migrationState` 区分“迁移失败”与“读取失败”：后者显示可关闭错误，不替换 router-view。
- TaskCenter 以主进程列表为准，不再复活已结束 op；running 行 1s tick，finished 行 10 分钟 prune。
- `pruneActiveInstance` 不再自动回退 `instances[0]`；目标消失时置 null 并提示重新选择。

**7.6 操作协调与错误 i18n**

- `useComfyUpdate` / `usePipOps` / TaskCenter 统一按 `kind + runId + instanceId` 维护操作；终态包含 `done/failed/cancelled/interrupted`。
- `startUpdate` / `repairEnv` 不再直接抢占全局槽；冲突时打开对应操作或提示“已有任务运行”。
- 新增 `translateIpcError()`：优先 `messageKey + params`，回退 `message`；所有 `message.error` / dialog 走它。
- `UpdateProgress` 增加 `messageKey/messageParams`，主进程写 key，渲染层翻译。
- 修 `doctor.suggestions.download-dir` 缺失、`settings.testAllRemotes` 文案、硬编码英文。

**7.7 安全与可访问性**

- 收紧 CSP `connect-src/frame-src`：至少限制为 dev server、ComfyUI 实例源、已配置远程；更新注释与实际策略一致。
- `document.documentElement.lang` 跟随 locale；CommandPalette 补 focus trap / 打开聚焦 / `aria-modal`。
- 修 reduced-motion 下 IndeterminateBar 静止；Output 卡片补键盘操作；icon-only 按钮补 aria-label。
- `createDiscreteApi` 抽单例并注入 `themeOverrides`，避免两套 toast/dialog 主题漂移。

**7.8 测试**

- 组件测试：远程上下文下本地按钮 disabled；Workflows 远程入队可用；Nodes 深链 refresh 后聚焦。
- 错误态：Instances/Batch/IssueCenter 的 IPC reject → 显示错误与重试，不显示空态。
- 竞态：Output 快速 A→B 详情、Workflows 切实例、Install 预检 A/B 路径，旧响应不得覆盖新状态。
- 配置：3.12 实例改端口后迁移状态保留；`instance.patch` 只改目标字段。
- 操作协调：并发 update/repair/node-op 不互相覆盖；`interrupted` 重载后不显示运行中。
- 壳层：页面崩溃后路由切换恢复；迁移 IPC 失败不阻断。
- 负例：无本地目标、未知 id、远程 key 清除取消、确认框取消、CSP 非白名单源。

**工作量**：4–5 人日。

---

### WP8 测试与发布可信度

**问题**：P0-7、P1-45 ～ P1-51。

**8.1 Release gate**

- `release.yml` 的 `gate` 增加：
  - `npm run build`
  - Linux xvfb `npm run test:e2e`
  - Windows `electron-builder --win --dir` + `release/win-unpacked/ComfyPilot.exe --e2e-smoke`
  - 真实 `check-asar`（传入 `app.asar`）
- `ci.yml` Windows 也跑 `test:coverage`；删除过时的 V8 注释。
- `build-other` 加 `check-version` / tag 一致性；README 明确 macOS 未打包、Linux 仅 artifact。
- 修复 `release.yml:138` 的 `<version>` 占位符。

**8.2 覆盖率门禁**

- `coverage-ratchet.cjs`：
  - baseline 中缺失的 lcov 文件 → **失败**（可配 `--allow-new` 白名单）。
  - 新文件 lines < 30% → 失败；0% 不允许。
  - baseline 单调性：新 baseline 不得低于旧 baseline（提交 `coverage-history.json` 或对比 git）。
  - `--update` 需显式 `--accept`，CI 拒绝 baseline 下降的 PR。
- 新增 `tests/unit/gates.test.ts`，用临时 lcov/baseline fixture 验证上述规则；给 `check-asar.cjs` 加正/反例。
- `@electron/asar` 加入 devDependencies，不再依赖传递依赖。

**8.3 高风险行为测试**

- `dataMigration`：快照失败、写入中途失败、回滚成功/失败、`.bad-*`、幂等。
- Python 3.12：构造 3.12 venv，断言 `start()` reject `PYTHON_MIGRATION_REQUIRED`、状态 `migration-required`、不 spawn。
- 深链 DOM：`NodesView` 的 `?focus&instanceId` 匹配、清过滤、高亮、未匹配空态、`router.replace`。
- IssueCenter DOM：动作调用 IPC、忽略/恢复、分组/过滤。
- `desktop` / `tray`：Windows `.lnk` 转义、macOS osascript、Linux `.desktop`、开机自启、托盘菜单/退出。
- E2E：packaged `--dir` 启动、preload/renderer、一次真实 IPC、无 console error。

**8.4 文档与门禁**

- 新增 `docs/TESTING.md`、`docs/RELEASE.md`、`CHANGELOG.md`、`SECURITY.md`；归档 `docs/PLAN-0.2.0.md`。
- 修 README `231/316/389/481/502` 的陈旧陈述。
- `format:check` 扩展到 `tests/`、`scripts/`、`docs/`、`*.yml`。
- `check-hardcoded-zh` 扩展到 renderer `.ts` / shared `.ts`（排除 locale）。
- `check-test-polarity` 支持 `it.each` / options；`test-behavior-ratio` 目标从 60 提到 90。
- `test:all` 改为真正全门禁，或改名 `test:quick` 并在 README 说明。

**8.5 测试**

- 门禁脚本自测：missing baseline、drop >1pp、new file 0%、baseline 下降、check-asar 正/反例。
- 迁移/3.12 生命周期、深链 DOM、IssueCenter DOM、desktop/tray。
- 负例：缺失 baseline 必须失败；新增 0% 文件必须失败；packaged smoke 失败必须红。

**8.6 Release note 必须写清楚**

- **无数据迁移**：`schemaVersion` 仍为 2；新增字段可选；0.2.4 数据直接可用。
- **旧实例默认 nightly**：只有新实例默认 stable；旧 master 实例显示提示，不强制切换。
- **自动恢复默认关闭**：0.2.5 默认只告警；用户可在设置/实例中显式开启。
- **救援命令**：`ComfyPilot.exe --rescue <id>`，锁屏可用；应用主进程卡死时仍需 `taskkill` 兜底。
- **TLS 限制**：0.2.5 对 `--tls-keyfile/--tls-certfile` 明确警告，不承诺探针支持自签名 HTTPS。
- **macOS/Linux**：仍只保证 Windows 10/11 实机；mac/Linux 配置保留但未认证。
- **节点版本回滚 v1**：git 节点可精确 checkout；registry 节点尽力而为；local 节点只警告。
- **Manager 写入**：默认只读；修改 `config.ini` 需确认，下次启动生效。

**工作量**：4–5 人日。

---

### WP9 资产域 P0 修复（0.2.5 快修）

**问题**：P0-8a ～ P0-8e、P1-52 ～ P1-62。

**9.1 模型下载**

- Civitai：`Content-Disposition` → API `files[].name` → 安全扩展名兜底；按 model-version id 下载；持久化 Civitai 元数据/预览/触发词（v1 只存 `metadata.civitai`，不做 UI 大改）。
- 下载写 `.part`，校验后 `rename`；取消删除 `.part`；扫描跳过 `.part`。
- 暂停排队任务时从 `pendingStarts` 移除；`scheduleDownload` 启动前检查 paused/cancelled。
- 下载完成只 hash 新文件；`scan({hash:true})` 单飞 + 2s 去抖，避免并发全库 rehash。
- `proxyFetch` 超时：调用方传 signal 时仍保留独立的总超时（不要被 signal 覆盖）。

**9.2 批跑**

- 空 history 早退前查 `/queue`：promptId 仍在 queue → 续期；只有 queue/history 都查不到才判丢失。
- deadline 可配置；长任务按 queue 续期，不再硬编码 30 分钟。
- `list()` 自愈逐条 emit 单 job，禁止数组混发。
- 单 item 取消/重试保留 outputPaths 语义写清楚；`markLostPrompts` 用 `execFailed` 而不是含 `submitFailed` 的 `failed`。

**9.3 备份**

- `buildPlan` 按 `sections` 作用域校验；只恢复 settings 时不再因模型路径失败。
- 模型/实例路径：warning + 跳过/重映射/清空选项；备份内 `modelScanRoots` 纳入候选根。
- 回滚末尾同步 OS 代理/开机项/托盘（与正向 restore 一致）。
- 创建备份加磁盘空间检查、进度/取消；`restore` 加阶段进度。

**9.4 产物**

- history 输出路径 `resolveInsideAnyRoot(base)`；拒绝绝对 `subfolder` / `..`。
- `output.remove` 删除前校验输出根；符号链接拒绝。
- `scanAsync` 末尾执行幽灵清理；不可达根不 prune。
- 未归属 PNG 的指纹负缓存（文件 mtime 不变则跳过）。
- root 过滤大小写不敏感（Windows）。

**9.5 节点/问题/市场**

- `list()` 合并持久化 `pip-failed` issues，包状态不再“刷新即好”。
- `issueHub.scan(instanceId)` 按实例分组，不误解决其他实例。
- Manager schema 真实解析（WP4 联动）；Market category 真正过滤；banned/flagged 包安装前查询状态（即使有 repository）。
- `workflow.list` 外部文件 `statSync` 包 try，单条 missing 不拖垮整页。
- IPv6 host 统一格式化 `[::1]`，监控/对账/模型 reconcile 复用。

**9.6 测试**

- Civitai fixture：无扩展名、Content-Disposition、model-version id、gated/404。
- 批跑：排队 >30s 后出图 → 不判超时；queue 中仍存在 → 续期；超时 → 明确失败。
- 备份：换机/换盘/仅 settings/模型路径缺失 → 预览 warning、可恢复或明确拒绝。
- 输出：恶意 `subfolder`/绝对路径/`..` → 拒绝；外部删除文件 → scanAsync 清幽灵。
- 下载：取消 → `.part` 删除；暂停排队 → 不启动；完成 → 只 hash 新文件。
- 负例：无扩展名不得落盘、queue 中仍存在不得判死、越界路径不得索引/删除。

**工作量**：5–6 人日。

---

### WP10 安全边界与能力化

**问题**：P0-9（S1–S11）。如果 0.2.5 只修健康/路径而不修这些链，等于在“渲染器不可信”的威胁模型下继续开放任意代码执行。

**10.1 路径能力化**

- 新增 main 进程 `PathCapability`：
  - `{ id, root, scope: 'read'|'write'|'exec', source: 'picker'|'discovery'|'instance', expiresAt }`。
  - `shell.pickDirectory` / `pickFile` / `instance.discover` 签发；`settings.set` / `instance.save` / `model.download` / `backup.restore` 消费。
- 替换全局 `approvedReadRoots/approvedWriteRoots/approvedExecutablePaths`；过期/撤销/按实例作用域。
- `modelScanRoots` 只能由 picker 追加，不能通过普通 `settings.set` 直接设为 `/`。

**10.2 实例/启动闭环**

- 新实例 `path` 必须来自 picker 或 `instance.discover` 候选；不再接受 home 下任意目录。
- `pythonPath` 必须 picker / 已验证 venv / 系统 Python；禁止实例内任意文件。
- `launchProfile` 所有路径字段、`listen`、`port`、`extraArgs` 白名单；`listen` 只允许 loopback/通配/明确 LAN IP。
- 启动前校验 `main.py` 存在且包含 ComfyUI 指纹（`comfy/`、`comfyui_version.py` 等）；解释器版本输出无法解析时拒绝，不再“pyMatch=null 放行”。

**10.3 下载/备份/文件操作**

- `model.download`：模型扩展名白名单；`destDir` 只允许明确模型根/picker；`flags:'wx'` 或显式覆盖；禁止 `.py/.exe/.bat/.sh/.desktop`。
- `model.move/symlink`：清洗 `rec.fileName`，`resolveInsideAnyRoot(destPath, [safeDest])`。
- `backup.restore`：字段白名单（instance/pythonPath/venvPath/launchProfile/node-pack path）、删除 `proxy.password`、restore mutex、workflow realpath、恢复后同步代理/登录项/托盘。
- `output.thumb/scan`、`exportLaunchScript` 的根做 realpath + lstat，拒绝符号链接根。

**10.4 IPC/更新/凭据**

- senderFrame fail-closed；dev URL 精确 `origin + pathname`，拒绝 userinfo。
- 高风险对象参数升级为 zod object schema（至少 `instance.save`、`model.download`、`backup.restore`、`settings.set`）。
- ComfyUI stable tag + sha256/签名 manifest；应用更新发布者校验；去掉默认 `autoInstallOnAppQuit`。
- Linux `basic_text` 检测与 `0600` 文件权限；明文回退显式警告。

**10.5 测试**

- 负例：`model.download` 写 `main.py`/`.bashrc`/Startup `.bat` → 拒绝；`settings.set modelScanRoots:['/']` → 拒绝；`instance.save` 任意 home 路径/实例内 `python.exe` → 拒绝；启动前无 `comfy/` 指纹 → 拒绝。
- 恶意备份：注入 `pythonPath`/`launchProfile.outputDirectory`/`proxy.password` → 预览拒绝或剥离。
- 符号链接：`output.thumb` 根、`output.scan` 根、`exportLaunchScript` 目录、`model.move` 目标 → 拒绝。
- dev URL：`localhost:5173.evil` / `localhost:5173@evil` → 拒绝。
- 正例：picker 路径、发现候选、合法 venv、模型扩展名、合法备份可正常工作。

> 如果工期只够做安全最小集：先堵 **10.2 + 10.3 的 model.download 扩展名/目标 + 启动 ComfyUI 指纹**，这四条直接切断 S1/S2/S3 的 RCE 链。

**工作量**：5–6 人日。

---

## 6. 数据与 IPC 变更

### 6.1 数据

**不升 `schemaVersion`。** 全部为可选新增字段：

| 文件               | 新增                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instances.jsonc`  | `updateChannel?`, `comfyChannel?`, `healthPolicy?`, `safeMode?`（仅运行时，不持久化）                                                                           |
| `settings.jsonc`   | `healthCheckEnabled?`, `healthCheckIntervalMs?`, `healthCheckTimeoutMs?`, `healthStaleMs?`, `autoRecover?`, `autoRecoverCooldownMs?`, `autoRecoverMaxAttempts?` |
| `node_packs.jsonc` | 无结构变更（已有 version/gitRev）                                                                                                                               |
| `backups.jsonc`    | 无结构变更                                                                                                                                                      |
| `pids.json`        | 无结构变更（改为原子写）                                                                                                                                        |

**需要同步的 allowlist**

- `src/main/services/db/settings.ts:38-61` `KNOWN_SETTINGS_KEYS`。
- `src/main/services/security.ts:524-541` `SETTINGS_ENUM_KEYS` / `SETTINGS_BOOLEAN_KEYS`。
- `src/shared/constants.ts` `DEFAULT_SETTINGS`。
- `src/shared/types/app.ts` `AppSettings`。
- i18n zh/en。

### 6.2 IPC

新增通道（均需 zod 严格 schema，禁止裸 `obj`）：

| 通道                          | 参数            | 返回                 |
| ----------------------------- | --------------- | -------------------- |
| `instance.health`             | `[id]`          | `InstanceHealth`     |
| `instance.patch`              | `[id, partial]` | `ComfyInstanceInfo`  |
| `instance.setPort`            | `[id, port]`    | `ComfyInstanceInfo`  |
| `instance.rescue`             | `[id, {safe?}]` | `InstanceStopResult` |
| `instance.exportRescueScript` | `[id]`          | `{path}`             |
| `instance.managerInfo`        | `[id]`          | `ManagerInfo`        |
| `instance.setManagerSecurity` | `[id, level]`   | `ManagerInfo`        |
| `instance.openManagerConfig`  | `[id]`          | `{path}`             |
| `instance.setUpdateChannel`   | `[id, channel]` | `ComfyInstanceInfo`  |
| `instance.checkHealth`        | `[id]`          | `InstanceHealth`     |

事件：

- `IPC_EVENTS.instanceHealth`：`{ instanceId, health }`。
- 复用 `IPC_EVENTS.notification` 做“无响应/救援结果”。

### 6.3 兼容

- 0.2.4 数据直接读；未知字段在旧版本会被忽略。
- 0.2.5 写出的新增字段，0.2.4 读取时被 `saveSettings`/`save` 剥离，不破坏旧版本（但不建议降级）。
- 备份 v2 格式不变；新增健康/Manager 信息只进诊断包，不进备份清单。

---

## 7. 测试矩阵

### 7.1 单元 / 集成

| 域       | 正向                                                 | 反例                                              |
| -------- | ---------------------------------------------------- | ------------------------------------------------- |
| 路径解析 | 默认、每个 dir flag、相对/绝对、多 listen、port 覆盖 | `..`、空值、非法 flag、越界、符号链接逃逸         |
| 健康     | healthy/busy/suspect/unresponsive/crashed/stopped    | 一次失败、短暂日志安静、端口未监听、远端、adopted |
| 救援     | `--rescue` 成功、`--safe-rescue`、`--status`         | 未知 id、remote、重复、冷却、adopted、stop 未退出 |
| 安全模式 | argv 只加一次、退出清除、失败诊断标记                | 已有 `--disable-all-custom-nodes`、启动失败       |
| Manager  | v4 path、pip/git、config 解析/写、列表 v4 优先       | 缺文件、不可读、`%`、注入、旧源遮蔽、offline      |
| 更新通道 | stable 新/旧/相同、prerelease、镜像                  | 403/429、非 JSON、tag 不存在、dirty git           |
| 更新安全 | 自检通过、自动回滚、节点版本回滚                     | 自检失败、rollback 失败、部分节点失败、取消       |
| 运行时   | cu130/rocm7.2/rocm10.0/xpu/cpu/mps                   | 轮子不存在、Python 非 3.13、检测失败              |
| IPC      | 新通道参数/返回                                      | 错误类型、缺参、非本应用 frame                    |

### 7.2 真实 HTTP 夹具

新增 `tests/helpers/fakeComfyServer.ts`：

- `/system_stats` 正常 JSON。
- `mode: 'hang'`：接受 TCP，不返回 HTTP。
- `mode: 'slow'`：延迟 3s 返回。
- `mode: 'close'`：直接关闭。
- `/queue` 可控 queue_running / queue_pending。
- `/api/jobs`、`/features`、`/api/assets` 可选。

用于健康、监控、更新验证；避免真实 ComfyUI 依赖。

### 7.3 覆盖率

- 新增文件必须单独列 baseline；先写行为测试，再 `coverage:accept`。
- 目标：全局不低于 0.2.4；新增 `health.ts`、`effective.ts`、`manager.ts`、`updateChannel.ts` 行覆盖 ≥ 70%（按实际可达性），分支 ≥ 60%。
- 反例门禁：每个含正向断言的测试文件至少一个失败/拒绝用例。
- 行为占比门禁：新增测试以行为断言为主，不靠快照凑数。

### 7.4 CI

- Ubuntu + Windows 双平台。
- `typecheck` / `typecheck:test` / `lint:check` / `format:check` / i18n / 硬编码 / 反例 / coverage / build / asar / E2E。
- Windows 增加一个“路径解析 + 健康夹具”测试，覆盖盘符与大小写。
- 发布 workflow 仍先跑完整 gate，再打包 NSIS + `SHA256SUMS.txt`。

---

## 8. 里程碑与实机验收

### 8.1 里程碑

| 里程碑          | 内容                                                        | 退出标准                                                                                     |
| --------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| M1（基础）      | WP0 生命周期/安装器根因 + WP1 路径/有效启动 + WP10 安全边界 | 所有资产操作路径一致；stop/start 无孤儿；安装器无跨轮污染；S1/S2/S3 链被负例测试锁死         |
| M2（可观测）    | WP2 健康 + WP3 救援/安全模式                                | 卡死夹具 3 分钟内变红；`--rescue` 可救回；安全模式可启动                                     |
| M3（上游/资产） | WP4 Manager + WP5 更新安全 + WP6 运行时矩阵 + WP9 资产 P0   | Manager v4 信息正确；stable 更新失败自动回滚；Civitai/批跑/备份/输出 P0 修复；torch 矩阵对齐 |
| M4（发布）      | WP7 渲染层反馈 + WP8 发布可信度 + 文档                      | CI 双平台绿；packaged smoke 通过；Windows 10 场景验收通过                                    |

> 按 1 人 + AI 辅助估算：**WP 合计 46–58 人日**；含集成、回归、Windows 实机与发布缓冲约 **50–64 人日**。
>
> M1 → `0.2.5-beta.1`，M2 → `0.2.5-beta.2`，M3 → `0.2.5-beta.3`，M4 → **`0.2.5` 正式版**。全部 11 个 WP 都属于 0.2.5，不顺延到 0.2.6/0.2.7；beta 只是交付节奏，不是范围裁剪。

### 8.2 Windows 实机验收

1. **卡死检测**
   - 启动一个假 ComfyUI（accept 不响应）或真实长任务卡死。
   - 3 分钟内 UI 显示“无响应”，证据含 HTTP 超时/端口监听/日志停滞。
2. **锁屏救援**
   - 锁定 Windows，在 `cmd` 执行 `ComfyPilot.exe --rescue <id>`。
   - 实例重启并 ready；`control.log` 有结果；UI 状态一致。
3. **安全模式**
   - 放一个会阻塞启动的自定义节点；安全模式可启动；普通模式失败。
4. **Manager v4**
   - 安装 Manager 4.4.2；确认 `user/__manager/config.ini`；修改安全等级后下次启动生效；legacy backup 提示。
5. **stable 更新**
   - 从 v0.45.x 升 v0.46.0；启动自检通过；注入坏节点后更新失败自动回滚。
6. **路径**
   - `--base-directory` / `--user-directory` / `--models-directory` 下节点/工作流/模型/诊断一致。
7. **端口覆盖**
   - `--port 9999` + `--listen 0.0.0.0,::`；探针、监控、批跑都指 9999。
8. **安全边界**
   - 尝试 `model.download` 写 `main.py`、`settings.set modelScanRoots:['/']`、`instance.save` 实例内 `python.exe`、恶意备份注入 `pythonPath` → 全部拒绝。
9. **资产抽检**
   - Civitai 下载落盘有扩展名并入库；批跑排队 >30s 不误判；备份换盘恢复预览给出重映射/跳过。
10. **打包产物**

- `electron-builder --win --dir` 后启动 `release/win-unpacked/ComfyPilot.exe --e2e-smoke`，preload/renderer/IPC 正常。

### 8.3 0.2.5 Definition of Done

- 11 个 WP 全部完成；没有任何 WP 被静默降级为“下个版本”。
- 新增/修改的 IPC 通道都有 zod schema；高风险对象通道不再是裸 `obj`。
- 新增文件有正向 + 反例测试；全局覆盖率不低于 0.2.4；逐文件 ratchet 不回退。
- `release.yml` gate 包含 build + E2E；Windows packaged `--dir` smoke 通过。
- Windows 实机完成 §8.2 全部 10 个场景。
- README / PLAN / Release notes 对版本、通道、数据迁移、安全边界的陈述一致。
- 数据 schema 仍为 2；0.2.4 数据可直接启动；未提交任何破坏性迁移。

---

## 9. 风险与缓解

| 风险              | 影响               | 缓解                                                                                                            |
| ----------------- | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| 健康误判          | 杀掉正在跑的长任务 | 证据组合；busy 状态；默认只告警；自动恢复默认关闭                                                               |
| 自动恢复循环      | 反复重启、显存抖动 | 冷却、最大次数、熔断、失败后只通知                                                                              |
| 救援命令被滥用    | 本地用户可杀实例   | 仅本地、精确 id、无任意命令、审计日志；与 `taskkill` 同等权限                                                   |
| Manager 配置写坏  | Manager 启动失败   | 备份、原子写、保留注释/未知键、默认只读                                                                         |
| stable 更新不兼容 | 起不来             | 真实启动自检 + 自动回滚 + 节点快照                                                                              |
| 路径重构回归      | 资产写错位置       | 先写纯函数测试，再逐模块替换；保留旧路径回退测试                                                                |
| 覆盖率下降        | 门禁红             | 新文件先补行为测试；不提前 accept baseline                                                                      |
| 范围膨胀          | 0.2.5 延期         | 11 WP 已锁定；按 M1–M4 分 beta、关键路径串行 + 其余并行；不得静默砍 WP；若延期，先保 M1/M2 质量，不改变最终范围 |
| Windows 锁屏/权限 | 救援命令不可用     | 文档给出 `taskkill` 兜底；应用主进程卡死时明确不支持                                                            |
| TLS 自签名        | 探针误判           | 0.2.5 明确警告；完整支持排后续版本                                                                              |

---

## 10. 待确认的实现选择

| #   | 决策                                          | 玥玥建议                                                                                 |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | 自动恢复默认开还是关？                        | **默认关，只告警**；用户显式开启。避免误杀长任务。                                       |
| 2   | 新实例默认 stable 还是 nightly？              | **stable**；旧实例保持 nightly 并提示切换。                                              |
| 3   | 0.2.5 是否扩到 Python 3.14？                  | **不扩**；保持 3.13 验证默认，只修正文案与迁移提示。                                     |
| 4   | 0.2.5 的节点版本回滚做到什么程度？            | **v1：git 精确 checkout + registry 尽力而为 + local 只警告**；完整实例快照仍放后续版本。 |
| 5   | 是否允许 ComfyPilot 写 Manager `config.ini`？ | **允许，但默认只读 + 显式确认 + 备份**。                                                 |
| 6   | 救援命令是否随安装包提供 `.bat`？             | **提供**；这是锁屏场景最实用的入口。                                                     |
| 7   | TLS 实例是否 0.2.5 支持？                     | **0.2.5 先警告，不静默假死**；完整支持排后续版本。                                       |
| 8   | 是否把工作流依赖清单放进 0.2.5？              | **不放进 0.2.5 的 11 个 WP**；排后续版本，避免范围失控。                                 |

---

## 11. 非目标与后续路线

### 11.1 0.2.5 非目标

- 不做 SQLite / DB v3。
- 不做完整 venv 字节级快照。
- 不做多实例 GPU 调度。
- 不做共享模型硬链接/去重存储。
- 不做完整 headless daemon / REST API。
- 不做 macOS / Linux 实机认证。
- 不做代码签名。
- 不做工作流零配置依赖包。

### 11.2 后续版本候选

1. **完整实例快照 v2**：ComfyUI 版本 + Python/torch 包清单 + 节点版本 + launch profile + 模型清单；导出/导入/差异预览。
2. **工作流可运行清单**：节点类型 → 包归属 → 模型文件 → 一键补齐；分享包。
3. **IPC schema 深化（WP10 未覆盖的通道）**：把剩余 `obj` 通道改成严格 zod；事件 payload schema 全覆盖。
4. **性能**：大模型库/产物库分页索引、日志批量写、`pids.json` 原子写。
5. **TLS 实例支持**：本机自签名证书 + 受控 CA。

### 11.3 更长期候选

- 多实例资源调度（显存/端口/队列）。
- 共享模型库（硬链接/符号链接 + 引用计数）。
- headless daemon + CLI + 本地 API。
- macOS Apple Silicon / Linux 实机认证。
- 迁移到 SQLite/WASM 索引（仅当规模证明必要）。

---

## 12. 证据索引

### 12.1 代码位

| 主题                            | 位置                                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 启动就绪一次性                  | `src/main/services/instance/lifecycle.ts:172-271`                                                                                              |
| 实例状态枚举                    | `src/shared/types/instance.ts:4-12`                                                                                                            |
| `toInfo` 无健康                 | `src/main/services/instance/runtime.ts:92-119`                                                                                                 |
| `managerEnabled` 只看 extraArgs | `src/main/services/instance/runtime.ts:114`                                                                                                    |
| 端口检查用 config.port          | `src/main/services/instance/lifecycle.ts:342`                                                                                                  |
| `baseUrlOf` 单值                | `src/main/services/instance/runtime.ts:85-90`                                                                                                  |
| 工作流固定 user 路径            | `src/main/services/workflow.ts:563,877,1000`                                                                                                   |
| 节点固定 custom_nodes           | `src/main/services/nodePack/common.ts:320-331`                                                                                                 |
| 模型固定 models                 | `src/main/services/model.ts:417-424,508-511`                                                                                                   |
| 输出只解析 output-directory     | `src/shared/outputDir.ts:25-45`                                                                                                                |
| Manager 列表顺序/break          | `src/main/services/nodePack/list.ts:405-411,466`                                                                                               |
| Manager 真实 schema 不匹配      | `src/main/services/nodePack/list.ts:431-465`                                                                                                   |
| Civitai 文件名无扩展名          | `src/main/services/model.ts:865-876`                                                                                                           |
| 批跑 30s 早退                   | `src/main/services/p1p2/batch.ts:756`                                                                                                          |
| 备份 invalidPaths 整体拒绝      | `src/main/services/backup.ts:552-556,872-876`                                                                                                  |
| history 输出路径无 containment  | `src/main/services/p1p2/batch.ts:770-789`                                                                                                      |
| 输出删除无根校验                | `src/main/services/p1p2/output.ts:447-453`                                                                                                     |
| 取消下载留半成品                | `src/main/services/model.ts:1227,1373-1389`                                                                                                    |
| 节点快照只切启用                | `src/main/services/nodePack/update.ts:971-1081`                                                                                                |
| 更新稳定版仅信息                | `src/main/services/updater.ts:621-652`                                                                                                         |
| 更新 verify 是 Doctor           | `src/main/services/updater.ts:1204-1236`                                                                                                       |
| verify 失败仍 done              | `src/main/services/updater.ts:1244-1292`                                                                                                       |
| master zip 固定                 | `src/main/services/updater.ts:1549`                                                                                                            |
| torch 矩阵 rocm6.2              | `src/main/services/installer.ts:59-66`                                                                                                         |
| AMD Windows 回退 CPU            | `src/main/services/installer.ts:639-645`                                                                                                       |
| Python 3.13 文案                | `src/main/services/doctor.ts:109-124`、`installer.ts:838-840`                                                                                  |
| 诊断包内容                      | `src/main/services/instance/diagnostics.ts:7-145`                                                                                              |
| 安装器 reset 跨轮污染           | `src/main/services/installer.ts:414-442,1574-1629`                                                                                             |
| `repairEnv` 伪造 3.13           | `src/main/services/env.ts:922-941,1087-1118`                                                                                                   |
| spawn 晚于 stop 的孤儿          | `src/main/services/instance/lifecycle.ts:436-570,1033-1039,654-671`                                                                            |
| 收养丢失所有权                  | `src/main/services/instance/lifecycle.ts:371-398`                                                                                              |
| ENV_MISMATCH 卡 starting        | `src/main/services/instance/lifecycle.ts:440-489`                                                                                              |
| ComfyUI zip 零校验/不可取消     | `src/main/services/installer.ts:444-485,1633-1672`                                                                                             |
| 端口冲突 save 丢迁移字段        | `src/renderer/src/composables/useLaunch.ts:154-170`、`src/main/services/instance/discovery.ts:147-166`                                         |
| 命令面板只有启动/停止           | `src/renderer/src/components/CommandPalette.vue:74-87`                                                                                         |
| 托盘只有启动/停止               | `src/main/services/tray.ts:113-144`                                                                                                            |
| ErrorBoundary 不随路由重置      | `src/renderer/src/App.vue:781-787`、`ErrorBoundary.vue:17-26`                                                                                  |
| 更新进度共享槽                  | `src/renderer/src/composables/useComfyUpdate.ts:94-106`                                                                                        |
| CSP 允许任意 http(s)            | `src/renderer/index.html:6-11`                                                                                                                 |
| 渲染器 → RCE 链 S1              | `src/main/ipc/domains/models.ts:53-55`、`model.ts:831-876,1227`、`context.ts:220-231`、`instance/discovery.ts:144-168`、`lifecycle.ts:490-565` |
| modelScanRoots 全盘扩权 S2      | `src/main/ipc/domains/settings.ts:124-144`、`security.ts:563-572`、`model.ts:416-432`                                                          |
| launchProfile 路径未校验 S3     | `src/main/ipc/domains/instances.ts:74-82`、`shared/outputDir.ts:25-46`                                                                         |
| 备份注入 S4                     | `src/main/services/backup.ts:811-846,582-597,789-806`                                                                                          |
| dev URL 前缀信任 S5             | `src/main/services/rendererEntry.ts:13-16`                                                                                                     |
| Linux 明文凭据 S6               | `src/main/services/secretStorage.ts:19-44`                                                                                                     |
| 更新无签名/固定 commit S7       | `src/main/services/updater.ts:1547-1569`、`appUpdate.ts:189-203`                                                                               |
| openPath 未阻止 .py/.sh S8      | `src/main/services/security.ts:235-279`                                                                                                        |
| output thumb/scan 符号链接 S9   | `src/main/ipc/domains/output.ts:138-146`、`p1p2/output.ts:240-265`                                                                             |
| release gate 不 build/E2E       | `.github/workflows/release.yml:20-42`                                                                                                          |
| Windows 不跑覆盖率              | `.github/workflows/ci.yml:74-78`                                                                                                               |
| ratchet 新文件豁免              | `scripts/coverage-ratchet.cjs:96-101`                                                                                                          |
| 迁移测试过薄                    | `tests/unit/dataMigration.test.ts`；`coverage-baseline.json` migration 48%                                                                     |
| desktop/tray 低覆盖             | `coverage-baseline.json` desktop 4.41%、tray 56.86%                                                                                            |
| README 陈旧陈述                 | `README.md:231,316,389,481,502`                                                                                                                |
| settings allowlist              | `src/main/services/db/settings.ts:38-61`                                                                                                       |
| 设置值校验                      | `src/main/services/security.ts:524-541`                                                                                                        |
| IPC 契约                        | `src/main/ipc/contract.ts:19-292`                                                                                                              |

### 12.2 外部事实

- ComfyUI v0.46.0 Release：https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.46.0
- ComfyUI 启动参数：https://docs.comfy.org/development/comfyui-server/startup-flags
- ComfyUI 系统要求：https://docs.comfy.org/installation/system_requirements
- ComfyUI-Manager 4.4.2 Changelog：https://github.com/Comfy-Org/ComfyUI-Manager/blob/manager-v4/CHANGELOG.md
- ComfyUI-Manager v3.38 安全迁移：https://github.com/Comfy-Org/ComfyUI-Manager/blob/main/docs/en/v3.38-userdata-security-migration.md
- ComfyUI-Manager 配置：https://docs.comfy.org/manager/configuration
- 官方 Comfy Desktop：https://github.com/Comfy-Org/Comfy-Desktop
- Comfy Desktop Manage：https://docs.comfy.org/installation/desktop/usage/manage
- Stability Matrix：https://github.com/LykosAI/StabilityMatrix
- ComfyUI-Launcher：https://github.com/ComfyWorkflows/comfyui-launcher
- ComfyLauncher：https://github.com/nondeletable/ComfyLauncher
- PyTorch wheel index：https://download.pytorch.org/whl/

---

## 13. 一句话总结

> **0.2.5 一次收口：把“运行中”从一句进程状态，变成可验证、可救援、可回滚的事实；把路径/端口/目录变成唯一真相；把渲染器可扩权的 RCE 链堵死；把 Civitai/批跑/备份/输出的 P0 修好；并让 ComfyPilot 跟得上 ComfyUI 0.46 与 Manager v4.4，而不是继续用 0.39 时代的世界观管理 2026 年的实例。**

---

## 14. 实施状态（2026-11-21 全量 review 后）

本计划已按 M1 → M4 全部落地，11 个 WP 均在 0.2.5 内完成，未拆分到后续版本。2026-11-21 又做了一轮全量 review，修复了“声称完成但实际半实现”的问题，并把对应反例测试补齐。

| WP                  | 状态 | 主要落点                                                                  |
| ------------------- | ---- | ------------------------------------------------------------------------- |
| WP0 生命周期/安装器 | ✅   | `instance/lifecycle.ts`、`installer.ts`、`env.ts`、`pythonMigration.ts`   |
| WP1 有效路径        | ✅   | `shared/instanceLayout.ts`、各资产服务与 IPC、Doctor/托盘/诊断有效端口    |
| WP2 健康模型        | ✅   | `instance/health.ts`、`HealthBadge.vue`、诊断包                           |
| WP3 救援/安全模式   | ✅   | `main/control.ts`、托盘/命令面板/详情页、恢复策略                         |
| WP4 Manager v4.4    | ✅   | `services/manager.ts`、Doctor Manager 检查、显式 pip 安装、实例详情       |
| WP5 稳定更新        | ✅   | `updater.ts` stable/nightly、真实启动自检、节点版本回滚/回滚前快照        |
| WP6 运行时矩阵      | ✅   | `installer.ts`、`shared/launchArgs.ts`、`LaunchProfileEditor.vue`         |
| WP7 渲染层反馈      | ✅   | `useActiveTarget`、ListState、操作协调、迁移读取错误、远程入队、CSP/aria  |
| WP8 测试/发布       | ✅   | release/ci gate、ratchet、CSP gate、迁移/desktop/深链 DOM 测试、文档      |
| WP9 资产 P0         | ✅   | `model.ts`、`p1p2/batch.ts`、`backup.ts`、`p1p2/output.ts`、`issueHub.ts` |
| WP10 安全边界       | ✅   | `pathCapability.ts`、IPC 契约、备份/下载/输出 containment                 |

本轮 review 额外修复：

- 端口冲突只调用 `instance.setPort`；整条 `instance.save` 对调用方不认识的迁移字段做保留。
- 3.12 实例拒绝启动后状态为 `migration-required`（不是泛化 `error`），且不 spawn。
- TaskCenter 将 `interrupted` 作为终态展示，不再标成 `done`。
- Instances / Batch / IssueCenter 加载失败显示错误与重试，不再渲染空数据。
- 迁移状态 **IPC 读取失败** 是可关闭警告，不再锁死整个壳层；真实迁移失败仍阻断。
- Nodes 深链先刷新再聚焦，并清除远程选择；Workflows 在远程 ready 时可入队；远程批跑卡片显示实例名并禁用本地“查看产物”。
- Manager 卡片支持显式确认的 4.4.2 pip 安装（镜像/代理复用，失败回滚旧版本），Doctor 增加 Manager 路径/等级/网络/legacy/策略不一致检查。
- 节点版本回滚前创建 `pre-restore-*` 快照。
- 选定实例持久化（`activeInstance`），重启不再静默落到第一个实例。
- 新增 CSP gate（白名单外 connect/frame 源失败）、`aria-modal`、`document.lang`、Output 卡片键盘操作与单一 discrete API 实例。

发布前第三轮回归又发现并修复：

- **Windows 数据安全**：JSONC 解析剥离 UTF-8 BOM，不再把 Notepad/PowerShell 写出的合法文件改名 `.bad-*`；`toV2` 的 envelope 版本不再被旧对象自带的 `schemaVersion: 1` 覆盖。
- **升级路径**：安装器遇到既有 3.12/3.14/损坏 venv 时先归档为 `*.pre-recreate-*`，再创建 3.13 venv，不再死在第 3 步或覆盖旧环境。
- **备份 S4 链**：恢复时 `pythonPath` 必须位于实例内/实例旁的合法解释器形状，或明确的系统 Python；任意 `.../python/python.exe` 不再放行。`listen` 与 `extraArgs --listen` 必须是本地/LAN 字面地址，并清掉被拒绝的独立 value token。workflow 恢复只允许 `.json/.jsonc`，恶意备份不能先写 `.exe` 再让 `pythonPath` 指向它。
- **批跑真相**：deadline 改为绝对上限（默认 30 分钟），每 12 次轮询查 `/queue`；history 非空不再阻止续期，`/queue` 探测失败按“未知”处理而不是判丢。
- **健康真相**：adopted 外部实例没有 PID，但仍以真实 HTTP 响应判 `healthy`，不再显示灰色 `stopped`。
- **节点数据安全**：git 节点在 `pull` 前拒绝 tracked 本地修改，避免失败后的 `reset --hard` 丢用户补丁。
- **安装策略闭环**：`pipOps` 的显式安装/spec/recipe/requirements 统一遵守 `networkMode=offline` 与 `allowPipInstall`，不再绕过节点安装门禁。
- **更新完整性**：stable tag archive 首次成功后记录 SHA-256 TOFU pin；同一 tag 的后续下载必须一致，拒绝镜像替换。nightly 跟随 master，明确不 pin。
- **输出 containment**：batch history 输出在 lexical containment 之后再 realpath 校验，符号链接子目录不能把索引引到输出根外。

验证记录（本机 WSL，2026-11-21，第三轮回归后）：

- `npm test`：161 文件 / 2130 用例通过。
- `npm run test:coverage`：全局 lines 70.83%、branches 58.06%、functions 54.60%、statements 68.47%；181 文件 ratchet 通过。
- `npm run test:behavior`：97.3%（目标 ≥90%）。
- `npm run lint:check` / `format:check` / `typecheck` / `typecheck:test` 通过。
- `npm run build`、`npm run test:e2e` 通过。
- `npx electron-builder --win --dir` 后 `release/win-unpacked/ComfyPilot.exe --e2e-smoke` 通过（renderer/preload/IPC），
  `check-asar` 对真实 `app.asar` 通过。
- Windows 10/11 实机 10 场景：**未验证**（需在真实 Windows 桌面执行 §8.2，不能以 WSL 代替）。
