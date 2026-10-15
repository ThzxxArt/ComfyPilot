# ComfyPilot 0.1.15 迭代方案 —「运行可控 · 批量减负 · 上游就绪」

> 生成日期：2026-10-15 · 基于 v0.1.14（commit `90d7e2d`）**全量源码与文档逐文件深读**（84,211 行：shared 10 文件 / main 35 文件 / renderer 44 文件 / preload 2 / 测试 100 文件 / 文档 2,394 行）+ **ComfyUI 上游对照**（基座 v0.40.0 `3541246` + master（v0.41-dev）最新 60 提交）
> 原则：根因修复、零半成品、每条链路带行为测试与门禁
> 状态：**待爸爸批准**（决策点见 §5）

---

## 0. 背景与分析方法

### 0.1 本轮读取范围（全量、非截断）

- **shared 层**（3,411 行）：`types.ts`（1,724 行，全部 IPC 契约与领域模型）、`launchArgs.ts`、`mediaTypes.ts`、`nodeLoadReport.ts`、`execError.ts`、`pipRecipes.ts`、`pipVersion.ts`、`constants.ts`、`preflight.ts`、`version.ts` 全文。
- **main 层**（22,639 行）：`index.ts`（659）、`handlers.ts`（1,785）、`bootstrap.cjs` + 全部 31 个服务逐文件全文（含 3,347 行的 `nodePack.ts`、1,625 行 `instance.ts`、1,356 行 `updater.ts`、1,289 行 `p1p2.ts`、1,202 行 `workflow.ts` 等）。
- **renderer 层**（23,256 行）：`App.vue`（892）、全部 16 个视图逐文件（含 1,858 行 `InstanceDetailView`、1,629 行 `NodesView`、1,617 行 `InstallView`）、全部 8 个组件、7 个 composable、i18n/样式/router/store 全文。
- **preload / 测试 / 文档**：preload 2 文件；测试 100 文件结构全表；`README.md`（439）+ 全部 6 份历史 PLAN 全文。
- **ComfyUI 上游对照**：
  - 基座 **v0.40.0**（`3541246`，2026-10-13 发布，当前最新正式版）——0.1.14 已系统对照；
  - **master（v0.41-dev）**：最新 60 提交逐条审计；`cli_args.py` v0.40 → master **零差异**（实测 diff 为空）；`server.py` 新路由核查；`default_workflow.json` 内容实读；releases API 节奏确认（v0.37→v0.40 连续四周一，v0.41 预计 10-20）。

### 0.2 现状基线

v0.1.14 已发布：2447 用例 / 100 文件全绿；覆盖率 89.09 / 83.17 / 93.2；13 个功能域全部闭环；工作区干净（发布后零未提交改动）。历史审计发现的遗留（0.1.13 候选池 15 项 + 0.1.14 审计 9 项）**全部清零**——本轮的每个机会点均来自本轮全量阅读的**新实证**。

### 0.3 分析方法（为什么是这三个主题）

本轮阅读不是"再扫一遍"，而是带着三个问题读：

1. **「控制塔」的自检**：ComfyUI 前端能做的标准操作，ComfyPilot 还有哪些没入口？（发现：运行控制三件套全缺）
2. **「批量减负」的自检**：库管理类页面（产物/模型）的多选批量能力是否与"库"定位相称？（发现：产物只有批量导出、模型零多选）
3. **「引擎同频」的连续性**：v0.41 将带来什么、哪些现在就能预备？（发现：`/default_workflow` 新路由 + cli_args 冻结 + ARM64 新产物）

---

## 1. 本轮三个核心事实

### 事实一：ComfyUI 三大标准运行操作，ComfyPilot 监控页零入口

- **ComfyUI 前端标准操作**：Clear Queue（清空待执行队列）、Cancel Current / Interrupt（中断当前执行）、Free Model Memory（卸载模型释放显存/内存）——这是每个 ComfyUI 用户每天用的操作。
- **ComfyPilot 现状实锤**：
  - `MonitorView.vue:306-309`：页头只有一个「刷新队列」按钮——**三个操作全部没有 UI 入口**。
  - IPC 层 `handlers.ts:1030-1069`：monitor 域仅 6 个只读/连接通道（system/queue/history/jobs/connectWs/disconnectWs）——**无操作类通道**。
  - `ComfyApiClient`：`interrupt()`（comfyApi.ts:227-242）与 `freeMemory()`（comfyApi.ts:294-309）**方法已存在**（前者服务 batch 取消，后者服务远程维护**仅**设置页 remote 入口），但**本地实例对二者零入口**；`clearQueue()` 方法**连客户端都没有**（`deleteQueueItems(promptIds)` 只按 id 删除，无法清空全部）。
- **结论**：ComfyPilot 号称"控制塔"，但用户想清队列/中断任务/释放显存时，必须回到 ComfyUI 前端——这是控制塔定位的直接缺口。且服务端能力全都现成（`POST /queue {"clear": true}`、`POST /interrupt`、`POST /free`），纯属产品面遗漏。

### 事实二：库管理页的"多选"能力断档（产物只能导出、模型零多选）

- **产物库**（OutputView.vue:644-659）：多选后工具栏只有「批量导出 ZIP」——**批量删除缺失**（要删 20 张废图得点 20 次单删+20 次确认）。
  - 单删路径完备（`output.delete(id, deleteFile)` + 双态确认 dialog，OutputView.vue:444-475），批量只是缺一个聚合入口。
- **模型库**（ModelsView.vue:818-826）：`NDataTable` 无 selection 列，**零多选**——多删/多移只能逐个操作（模型文件动辄数 GB，批量整理是真实场景）。
  - 服务端 `model.remove(id, deleteFile)` / `model.move(id, destDir)` 均已就绪（model.ts:612-652），纯属 UI 层缺失 + 需要一个「顺序执行 + 部分失败汇总」的批量编排。
- **结论**：产物/模型是"库"类页面（文件会持续积累），批量操作与库定位不相称；服务端能力齐备，本轮是**产品面补齐**而非新架构。

### 事实三：v0.41 已可预备（新路由 `GET /default_workflow` + cli_args 冻结 + 上游新资产）

- **`GET /default_workflow`**（master `e0a32bce #16956`，**v0.40.0 无此路由——实测 tag 核查为空**）：返回 ComfyUI 的默认工作流 JSON（UI 格式 `{nodes, links}`，`Cache-Control: no-cache`）。对 ComfyPilot 的价值：**工作流库可从运行实例一键导入引擎默认工作流**（当前库只能靠用户导入文件）。
- **cli_args.py v0.40 → master 零差异**（实测 `diff` 为空）：v0.41 无新启动参数——**0.1.14 的参数 CATALOG 对 v0.41 已完整**，本轮无需参数工作。
- **上游新动态（记录，不做功能）**：
  - `d0ef06b` Windows **ARM64 + NVIDIA 便携包**（新发布资产；ComfyPilot 的 runtimes 目前 win32 一律 x64，ARM64 场景经模拟可用——登记边界，不动代码）；
  - `ccda037` assets **export API**（服务端写面；与 ComfyPilot 只读立场无关）；
  - `73c4868` assets 视频元数据提取 / `425f8b6` LoRA stack 节点启用（`DynamicGroup` 前端化）——均无需客户端动作。
- **节奏判断**：v0.41 预计 2026-10-20（下周一）发布。本轮 WP4 采用**探测式**设计：在 v0.40 实例上诚实降级（"该实例不提供默认工作流"），用户升级 v0.41 后自动生效——对小版本漂移免疫。

---

## 2. 迭代主线与 WP 设计

> 主题：**A 运行可控（P0）→ B 批量减负（P0）→ C 维护小闭环（P1）→ D 上游就绪与收口（P1/P2）**

### 主线 A：运行可控（P0）

#### WP1 监控页运行操作闭环（清队列 / 中断 / 释放内存）

**现状实锤**

| 位置 | 现状 | 问题 |
|---|---|---|
| `MonitorView.vue:306-309` | 页头仅「刷新队列」 | 三大标准操作零入口 |
| `handlers.ts:1030-1069` | monitor 6 通道全为只读/连接 | 无操作通道 |
| `comfyApi.ts:205-221` | `deleteQueueItems(ids)` | 只能按 id 删，无全清 |
| `comfyApi.ts:227-242` | `interrupt(promptId?)` | 已实现，仅 batch 内部消费 |
| `comfyApi.ts:294-309` | `freeMemory()` | 已实现，仅远程设置页入口 |

**服务端语义（ComfyUI 实测知识）**

- `POST /queue {"clear": true}`：清空**待执行**（pending）队列；运行中的任务不受影响。
- `POST /interrupt`：带 `prompt_id` body → 0.39+ 只中断该 running 任务（定向）；不带/旧版 → 全局中断标志。
- `POST /free {"unload_models": true, "free_memory": true}`：卸载模型 + 释放内存。**副作用**：下次生成需重新加载模型（首图变慢）。

**设计**

1. **`ComfyApiClient` 增 `clearQueue()`**（`POST /queue {"clear": true}`，5s 超时，返回 boolean）——补全客户端能力面。
2. **新 IPC（monitor 操作域，3 通道）**：
   - `monitor.clearQueue` → args `[baseUrl]` result `{ ok: boolean; error?: string }`
   - `monitor.interrupt` → args `[baseUrl, promptId?]` result 同上（**定向优先**：UI 传当前 running 第一条的 promptId；服务端旧版忽略 body 时自然降级为全局——与 batch cancel 的既有知识一致）
   - `monitor.freeMemory` → args `[baseUrl]` result 同上
   - 安全：全部复用 `assertMonitorBaseUrl` 同款校验（`isTrustedComfyUrl`：localhost 或已配置实例/远程 origin）+ 远程 auth headers（`remoteAuthHeadersForUrl` 既有模式）。
   - 实现走 `ComfyApiClient` + `monitorService` 持有的 auth 解析（与 queue/jobs 通道同层）。
3. **MonitorView「运行操作」组**（页头 refresh 旁）：
   - **清空队列**：确认 dialog（「将清空 N 个待执行任务」实时数字）→ 执行 → 刷新队列 + toast。
   - **中断当前**：确认 dialog（强提示：「将中断正在执行的任务 [promptId]，其结果为失败」；无 running 时按钮禁用）→ 定向中断 → 刷新。
   - **释放内存**：确认 dialog（提示「模型将被卸载，下次生成需重新加载」）→ 执行 → toast。本地/远程统一入口（远程同时可作维护动作）。
   - 三按钮 disabled 条件：`!targetUrl || !targetReady || 操作中`；操作结果 false/异常 → 可读错误 toast（不吞错）。
4. **诚实回执**：操作后立即 `refreshQueue()`，UI 状态与服务器真实状态对齐（不做乐观假成功）。

**验收与测试**

- `comfyApi.clearQueue/interrupt/freeMemory`：mock fetch 矩阵（2xx / 4xx / 网络异常 → boolean 语义；interrupt 的 body 带/不带 promptId 两种）。
- IPC 注册契约（`ipcRegistration` 自动覆盖 3 通道）。
- 操作-刷新编排纯函数（`runMonitorAction(action, refresh)` 类）：成功→刷新+toast、失败→错误 toast 不刷新（或刷新但提示）。
- 边界：未运行实例（按钮 disabled + tooltip）、远程 401（错误文案透传）。

### 主线 B：批量减负（P0）

#### WP2 产物批量删除 + 模型多选批量管理

**现状实锤**

- 产物：`OutputView.vue:644-659` 多选工具栏只有导出；单删双态确认完备（:444-475）。
- 模型：`ModelsView.vue:818-826` 无 selection；`model.remove`/`model.move` 服务端就绪。

**设计**

1. **产物批量删除**：
   - 新 IPC `output.batchDelete` → args `[ids: string[], deleteFile: boolean]` result `{ ok: number; failed: Array<{ id: string; error: string }> }`。
     - 服务层（p1p2 OutputService）：循环 `remove(id, deleteFile)`，异常收集为 failed（**部分失败必须显式报告**——绝不"全部成功"式假回执）。
   - OutputView：工具栏「删除选中（n）」→ 确认 dialog 三态（**删除文件与记录**（destructive 主按钮）/ **仅移除记录** / 取消），文案明示不可逆与 n；执行后：关闭可能打开着的详情/灯箱（若其 id 在删除集）、清选中、刷新列表、汇总 toast（成功 n / 失败 m + 首个失败原因）。
2. **模型多选批量管理**：
   - `ModelsView` 的 `NDataTable` 加 `type: 'selection'` 列（row-key 已有）+ 工具栏出现条件操作组（选中 >0 时）：
     - **批量删除**：确认 dialog 两态（删除文件与记录 / 仅移除记录）——逐项执行 `model.remove`，汇总报告。
     - **批量移动**：选目录（`shell.pickDirectory`）→ 逐项 `model.move`，汇总报告（跨盘 EXDEV 已有兜底）。
   - 编排收敛为一个共享纯函数 `runBatchOps(items, op)` → `{ ok, failed }`（**可测试**：部分失败、全失败、中断语义），产物/模型共用。
3. **不做的**（诚实边界）：产物批量导出已有不动；模型批量改名已有（按筛选批量改名）；不做批量软链/标签（低频）。

**验收与测试**

- `output.batchDelete` 服务层：全成功 / 部分失败（不存在 id、删文件异常）/ 空数组拒绝。
- `runBatchOps` 纯函数：顺序执行、失败收集、结果计数。
- UI 编排逻辑抽函数测试（选中集清理 + 详情/灯箱关闭联动）。
- e2e 冒烟不回归。

### 主线 C：维护小闭环（P1）

#### WP3 前端包版本一键对齐（frontend-package）

**现状实锤**

- 实例详情已展示前端包 installed vs required 徽标（`InstanceDetailView.vue:1033-1055`，mismatch 时 warning + tooltip「installed → required」）——**只诊断，无行动**。
- 0.39→0.40 期间 `comfyui-frontend-package` 连续多次 bump（1.55.14→1.55.17 可见于上游提交）；版本不匹配是真实高频态（用户更新 ComfyUI 源码后未同步前端包）。
- 行动路径全现有：`pipOpsService.installSpec(id, spec)` + pip-op 模态（进度/日志/取消全套）。

**设计**

1. **服务端零新增**：复用 `instance.pipInstall`（`isValidPipSpec` 白名单天然接受 `comfyui-frontend-package==1.55.17`）。
   - （若核对实施时发现 need：`comfyui-frontend-package` 的 required 值来自 capabilities 的 `packages[].required`——已是事实源。）
2. **UI**（InstanceDetailView 基本信息区，仅本地实例）：
   - `frontendPkg.mismatch` 为真时，徽标旁增「对齐到 required」按钮 → `startInstall(instanceId, 'comfyui-frontend-package==' + required)`（usePipOps 共享模态）。
   - 成功后 toast「前端包已更新，重启实例生效」+ 自动 `probeEnvNow()`/刷新 capabilities（重启后 badge 消除）；失败/OP_BUSY 走既有 `handlePipFailure`。
   - remote 实例：按钮不出现（远端 venv 不在本机；`requireLocalInstanceId` 语义一致）。
3. **诚实边界**：只做「升级到 required」（不提供任意版本选择）；required 缺失（老 ComfyUI 不报该字段）→ 按钮不出现。

**验收与测试**

- spec 构造纯函数（`comfyui-frontend-package==X`）+ 版本比对（installed!=required 且均非空）测试。
- 行为链路复用既有 pipOps 测试面（installSpec 已测）；新增 UI 条件逻辑纯函数断言。
- 边界：required 含非 semver 字符 → 不构造非法 spec（`isValidPipSpec` 兜底拒绝并提示）。

### 主线 D：上游就绪与收口（P1/P2）

#### WP4 从运行实例导入默认工作流（v0.41 探测式预备）

**上游事实**

- `GET /default_workflow`（master `e0a32bce`，**v0.40.0 实测无此路由**）→ 返回 `default_workflow.json`（UI 格式 `{nodes, links,…}`，实测内容为完整 SaveImage 流程图）。
- 现有 `workflowService.importFile` 的 `assertComfyWorkflow` **天然接受**该形状（`nodes` 数组即合法 UI graph）。
- v0.41 预计 2026-10-20 发布；0.1.15 采用探测式：对 v0.40 实例诚实降级，升级后自动生效。

**设计**

1. **服务**：`workflowService` 增 `importDefaultFromInstance(instanceId, target='instance')`：
   - `ComfyApiClient` 增 `defaultWorkflow()`（GET `/default_workflow`，5s 超时，解析失败/404 → null 区分）。
   - null（404 = 实例不支持 / 网络失败）→ 抛可读错误（i18n key）；合法 → `assertComfyWorkflow` 校验 → 复用 importFile 的落盘段（抽取私有 `writeGraphAsWorkflow`，避免经临时文件）→ 返回新记录。
   - 命名 `default-workflow`（走既有 `-N` 冲突链）；origin/tags 与普通导入一致（`defaultWorkflow: true` 标记进 params，供 UI 徽标）。
2. **IPC**：`workflow.importDefault` → args `[{ instanceId: string; target?: 'instance' | 'library' }]` result `WorkflowRecord`。
   - 前置：实例必须运行（与 `workflow.openInFrontend` 同款 `requireRunningInstance` 门控——但此处只需要目标实例在线，不启动它）。
3. **UI**（WorkflowsView 页头）：`导入` 按钮旁增次级按钮「导入默认工作流」：
   - 实例未运行 → disabled + tooltip；
   - 成功 → 库列表刷新 + toast（含新记录名）；
   - 失败（404 老版本）→ 错误 toast「该实例不提供默认工作流（需 ComfyUI v0.41+）」。
4. **记录上游新事实（文档层）**：README「与 ComfyUI 的关系」补：ARM64 便携包的存在、assets export/视频元数据为服务端写面（ComfyPilot 只读立场不变）、cli_args 对 v0.41 已冻结。

**验收与测试**

- `ComfyApiClient.defaultWorkflow`：200 合法 JSON / 404 / 非法 JSON / 超时矩阵。
- `importDefaultFromInstance`：成功落盘 + record 形状（params.defaultWorkflow）；404 → 可读错误；图形非法 → `assertComfyWorkflow` 错误透传。
- IPC 契约（ipcRegistration 自动）。
- 与既有 importFile 目标目录/命名冲突链一致性断言。

#### WP5 打磨收口（三小项 + 文档）

1. **MonitorView 死 CSS 清理**：`.jobs-block`（MonitorView.vue:773-781）无任何模板消费（实测 grep 仅样式两处）——删除。
2. **doctor 进度计数诚实化**：`doctor.ts:73/135/351` 三处 `emitProgress(…, 14, …)` 硬编码，而实际检查项随条件浮动（15~17 项：disk-* 双项、requirements 条件项等）——改为**动态总数**（预计算本次将执行的检查数）或"已检查 N 项"式文案，进度条不再与事实错位。
3. **Settings「打开日志目录」**：about 卡新增按钮 → 新 IPC `settings.logsDir`（args `[]` result string）→ `shell.openPath`（与实例 exportLogs 的 exports 目录区分：这是全局 `userData/logs`）。
4. **README/Roadmap 回填**：0.1.15 四条记录 + 测试数字。

**验收与测试**

- doctor 进度：总数动态断言（不同条件实例的 total 计算纯函数测试）。
- `settings.logsDir`：IPC 契约自动 + 目录存在性。
- lint（无未使用样式告警回归）。

---

## 3. 里程碑与全局验收

| 项 | 标准 |
|---|---|
| 测试 | 基线 2447/100 → 新增约 26~34 用例（预计 ~2480/102+）；全部行为测试 |
| 门禁 | typecheck（web+node+tests）×3 · ESLint 0 错 0 警 · i18n 键对齐+动态域+main notify · 零硬编码中文 · 覆盖率按实测 −2pp 校准 · build |
| 平台 | Windows 打包 + 安装包冒烟 RUNNING；e2e 渲染挂载断言 |
| 实机 | ① 监控页清队列/中断/释放内存三操作对运行中实例生效、状态即时回读 ② 产物多选删除（两态）与模型多选删除/移动（部分失败汇总正确）③ frontend mismatch 徽标 → 一键对齐 → 重启后徽标消除 ④ v0.41 实例（或手工构造路由）导入默认工作流成功；v0.40 实例诚实提示不支持 |
| 文档 | README / release body / 本文件「实施记录」回填 |

---

## 4. 风险与边界（诚实清单）

1. **interrupt 的版本语义**：0.39+ 带 promptId 定向、旧版忽略 body 全局中断——UI 文案按「中断当前任务」表述（定向优先，旧版行为等价且为既有知识），不做版本分叉 UI。
2. **中断与 batch 的交互**：若用户同时跑批，中断会波及 batch 的当前 prompt——确认弹窗明示；batch 自己的原子取消（`jobsCancel`）仍是批量场景的正确路径（本版不去重两者）。
3. **清队列只清 pending**：running 不受影响（服务端语义），文案如实（「清空 N 个待执行任务」）。
4. **freememory 副作用**：卸载模型 → 下次生成首图变慢；弹窗明示。远程实例可能因保护配置 401——错误透传不吞。
5. **批量删除不可逆**：`deleteFile` 强确认（三态/两态选择 + 数量）；服务端无回收站（与单删语义一致）。部分失败必须显式列出。
6. **前端包对齐仅本地实例**：remote 不出现按钮（venv 不在本机）；`required` 缺失（老 ComfyUI）→ 按钮不出现。
7. **/default_workflow 探测式**：v0.40 与更早实例返回 404 → 可读提示；不做版本表猜测（探测事实）。
8. **v0.41 时间窗**：预计 10-20 发布——WP4 的功能对发布时间不敏感（探测式），发布后自动生效；如有破坏性变更按既有「探测 + 回退」模式处理。
9. **上游新资产（ARM64 便携 / assets export）**：记录边界，不动代码（ARM64 经 x64 模拟可用；export 是服务端写面）。

---

## 5. 待爸爸决策

1. **WP1 范围**：三操作全做（**推荐**）/ 仅清队列+中断 / 仅释放内存。
2. **WP2 范围**：产物批量删除 + 模型多选批量（删除/移动）（**推荐**）/ 仅产物 / 仅模型。
3. **WP3 前端包一键对齐**：纳入（**推荐**，复用全部既有链路）/ 不做（仅徽标）。
4. **WP4 默认工作流导入**：现在做探测式（**推荐**，v0.41 发布后自动生效）/ 等 v0.41 发布后再做 / 不做。
5. **WP5 三小项**：全做（**推荐**）/ 部分（点名）。

---

## 附 A：ComfyUI 上游事实索引（本方案引用）

| 事实 | 出处 |
|---|---|
| `GET /default_workflow` 新路由（v0.40.0 无——实测 tag 核查为空） | master `server.py:832-834`；提交 `e0a32bce #16956` |
| `default_workflow.json` 为完整 UI 图（`{nodes, links}`，SaveImage 流程） | 实测 master raw 内容 |
| `cli_args.py` v0.40 → master 零差异 | 实测 `diff`（337 行对 337 行，空输出） |
| `POST /queue {"clear": true}` / `POST /interrupt`（0.39+ 定向）/ `POST /free` 语义 | v0.40 源码（0.1.10/0.1.11 已系统对照） |
| Windows ARM64 + NVIDIA 便携包（新发布资产） | 提交 `d0ef06b #16985` |
| assets export API（本地实现，服务端写面） | 提交 `ccda037 #16578` |
| assets 视频元数据提取 | 提交 `73c4868 #15180` |
| LoRA stack 节点启用（DynamicGroup 前端化） | 提交 `926d828 #16309` / `b60ae8e` / `425f8b6 #17054` |
| 每周一发版节奏（v0.37→v0.40 连续四周一；v0.41 预计 10-20） | releases API 时间戳 |
| frontend-package 高频 bump（1.55.14 → 1.55.17） | 提交 `7bf5df9` / `c9d8a6e` |

## 附 B：项目侧现状实锤索引（本方案引用）

| 事实 | 出处 |
|---|---|
| 监控页仅「刷新队列」，三操作零入口 | `MonitorView.vue:306-309` |
| monitor IPC 域 6 通道全只读/连接 | `handlers.ts:1030-1069` |
| `interrupt()` 已实现（batch 内部消费） | `comfyApi.ts:227-242` |
| `freeMemory()` 已实现（仅远程设置页入口） | `comfyApi.ts:294-309`；`handlers.ts:1518-1529` |
| `deleteQueueItems` 按 id 删，无全清 | `comfyApi.ts:205-221` |
| 产物多选工具栏仅导出 ZIP | `OutputView.vue:644-659` |
| 产物单删双态确认完备 | `OutputView.vue:444-475` |
| 模型表格无 selection 列 | `ModelsView.vue:818-826` |
| `model.remove` / `model.move` 服务端就绪 | `model.ts:612-652` |
| frontend mismatch 有徽标无行动 | `InstanceDetailView.vue:1033-1055` |
| pipOps `installSpec` + 共享模态现成 | `pipOps.ts:122-140`；`usePipOps.ts` |
| `assertComfyWorkflow` 接受 UI 图（nodes 数组） | `workflow.ts:301-331` |
| `requireRunningInstance` 门控模式 | `handlers.ts:916-941` |
| doctor emitProgress 硬编码 14（实际 15~17） | `doctor.ts:73/135/351` |
| MonitorView `.jobs-block` 死 CSS | `MonitorView.vue:773-781`（grep 无模板消费） |
| settings.* 域 4 通道，无 logsDir | `handlers.ts:254-294` |

## 与前版本的继承关系

- 0.1.13 修"**已做的事可信**"（进度/安装），0.1.14 做"**新事实进入控制塔**"（类型/资产/引擎），0.1.15 补"**控制塔的手**"——运行操作与批量管理是控制塔的动作面（此前只读/诊断完备、动作缺失）。
- 技术上零新架构：ComfyApiClient 已有 2/3 方法、pipOps 模态全复用、batchOps 只是一个顺序编排纯函数、`/default_workflow` 走既有导入链。
- 延续边界：不碰工作流编辑器、不接管环境（远程只读立场保持）、不虚构版本（探测式）。

---

# 实施记录（2026-10-15）

**终态声明**：WP1–WP5 全部实施完成，**零「留待后续」条目**；五项决策按推荐执行（运行操作三件套 / 批量双库 / 前端包对齐 / 默认工作流探测式 / 打磨三小项）；实施中发现的遗留问题（含 1 个隐藏已久的测试卫生缺陷）全部根治。

## 决策执行

1. **WP1 运行操作**：三操作全做——清空队列 / 中断当前（定向优先）/ 释放内存，本地与远程统一。
2. **WP2 批量管理**：产物多选批量删除 + 模型多选批量删除 / 批量移动，全做。
3. **WP3 前端包一键对齐**：纳入（复用 pipOps 共享模态，仅本地语义）。
4. **WP4 默认工作流导入**：现在做探测式（v0.40 诚实提示，v0.41 发布后自动生效）。
5. **WP5 打磨**：三小项全做（死 CSS / doctor 进度诚实化 / settings.logsDir）。

## WP 实施要点

- **WP1 运行控制闭环**：`ComfyApiClient.clearQueue()`（`POST /queue {"clear":true}`）；`MonitorService` 增 `clearQueue/interrupt/freeMemory` 三方法（复用 `assertMonitorBaseUrl` 信任校验 + `remoteAuthHeadersForUrl` 远程 auth + 诚实错误回执，绝不假成功）；新 IPC `monitor.clearQueue/interrupt/freeMemory`（`isTrustedComfyUrl` 双门控）；MonitorView 页头「运行操作」组——清队列（pending 计数确认）、中断当前（0.39+ 定向 / 旧版全局的诚实文案；无 running 时禁用 + tooltip）、释放内存（卸载副作用明示）；新 renderer util `utils/monitorOps.ts`（注入式 `runMonitorOp`：成功→先刷新后回执、失败→真实错误不刷新，可测试）。
- **WP2 批量减负**：`OutputService.batchRemove(ids, deleteFile)`（逐 id 收集失败，`{ok, failed[]}` 显式回执）+ IPC `output.batchDelete`；OutputView「删除选中（n）」三态确认（删文件/仅记录/取消）+ 详情/灯箱联动关闭 + 汇总 toast；ModelsView `NDataTable` selection 列 + 选中工具组（批量删除二态 / 批量移动）+ `utils/batchOps.ts` 共享顺序编排纯函数（单项失败不中断、结果计数、竞态前快照）。
- **WP3 前端包对齐**：新 util `utils/frontendAlign.ts`（`frontendPkgStatus` 提取 + `frontendAlignSpec` 构造，equal/缺失/畸形 token 全部静默）；InstanceDetailView frontend badge 旁「对齐」按钮（mismatch 时出现）→ `startInstall('comfyui-frontend-package==<required>')` 走共享 pip-op 模态 → 成功提示重启生效。
- **WP4 默认工作流导入**：`ComfyApiClient.defaultWorkflow()`（`GET /default_workflow`，404/非对象/网络错全 null）；`workflowService` 重构抽私有 `writeGraphAsWorkflow`（importFile 与之共用落盘/命名冲突链）+ `importDefaultFromInstance`（coded error `DEFAULT_WORKFLOW_UNSUPPORTED`、`assertComfyWorkflow` 同门、`params.defaultWorkflow` 标记）；IPC `workflow.importDefault`（本地实例 + `requireRunningInstance` 门控）；WorkflowsView「导入默认工作流」按钮（未运行禁用 + tooltip；404 → 本地化「需 ComfyUI v0.41+」提示）。
- **WP5 打磨**：MonitorView `.jobs-block` 死 CSS 删除；doctor 进度诚实化（移除虚构 total/百分比——payload 改 `{done, title, ts}`，UI 变不定进度条 + 「已检查 N 项」）；`settings.logsDir` IPC + Settings about 卡「打开日志目录」按钮。

## 遗留根治（"任何之前遗留的问题也都必须解决掉"）

| # | 遗留 | 根治 |
|---|---|---|
| 1 | **测试 tmpdir 卫生缺陷（隐藏已久）**：7 个测试文件 `mkdtempSync` 零清理，`cp-boot-dl-*` 等残留单文件 16MB 持续累积在 /tmp（tmpfs）——本轮全量测试时 /tmp 剩余跌破 installer 磁盘门控阈值（7GB），**19 个无关测试连锁变红**（含 HEAD 纯 0.1.14 版本复现） | ① 清理 500MB+ 历史残留；② 7 个文件全部加「迭代间清理 + afterAll 回收」（backupService / bootstrapDownload / depsAudit×2 / envService / ipcRegistration / modelReconcile(try-finally) / registryIndexService） |
| 2 | **磁盘门控与真实文件系统耦合**：installerService / installerRunPlan 测试的 preflight disk 检查读真实 statfs——环境磁盘波动即误红 | 两文件加 `fs` partial mock（statfsSync 固定 ~40GB free，其余真实）；disk 分支逻辑仍由断言覆盖 |
| 3 | installer.ts 死代码（`void spawn/basename/TORCH_INDEX_PRESETS` + 未用 import） | 全部删除（含 import） |
| 4 | handlers.ts `void upsertInstanceConfig/deleteInstanceConfig`（"keep unused imports"假引用） | 删除（含 import） |
| 5 | updater.ts `const sha = ''; void sha`（0.1.4 残留死代码） | 删除 |
| 6 | instance.ts `export { dirname, rmSync }`（零外部消费） | 删除 |
| 7 | model.ts `storageAnalysis()`（零消费的死方法） | 删除 |

**过程注记**：v016Collaboration 的源码窗口契约测试因新注释含 `copyToInstancePath` 字样抢占 `indexOf` 首命中而红——修正注释措辞（不改测试语义）；这是一次真实的「字符串契约测试脆弱性」遭遇，最终以最小正确修改解决。

## 测试与门禁（终态）

- 单元 + 集成：**2492 用例 / 104 文件全绿**（0.1.15 新增：monitorOps 12、batchOps 5、frontendAlign 7、workflowDefaultImport 6、outputService.batchRemove 1、doctor progress 1、db logsDir 1，另有既有断言随行为更新）。
- 覆盖率：全局 **89.3 / 83.26 / 93.63**；新模块按「实测 − 2pp」立档（monitorOps 98/83/98/98、batchOps 与 frontendAlign 98×4）。
- `lint:check` 0 错 0 警 · `typecheck`（web+node）与 `typecheck:test` 干净 · i18n（PARITY 1384/1384 + 动态域 + main notify 20 键）· 零硬编码中文 · **覆盖率门禁含新模块阈值全绿（exit 0）** · `npm run build` 成功。
- 版本号 0.1.15（package.json / package-lock / constants / README）；README 功能表 6 行 + Roadmap 3 条 0.1.15 记录回填。

## 与设计稿的差异（最终）

1. WP1 的「追问编排纯函数」实现为注入式 `runMonitorOp`（成功先刷新后回执的顺序也进了断言）——比设计稿更强。
2. WP2 的模型侧批量采用渲染层 `runBatchOps` 顺序编排（服务端 remove/move 原样复用）；产物侧走新的服务端 `batchRemove` 聚合 IPC——两库各取最适合的层，均带部分失败回执。
3. WP4 的落盘逻辑与 `importFile` 完全同链（抽出 `writeGraphAsWorkflow` 共享），命名冲突链/记录形状零分叉。
4. WP5 的 doctor 进度从「动态预估总数」进一步简化为**不定进度条 + 已检查计数**——预估总数本身也会漂移，不如直接不承诺百分比。
5. 新增第 7 项遗留根治（model.ts 死方法）为实施中扩展发现。
