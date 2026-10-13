# ComfyPilot 0.1.10 迭代方案 —「引擎对齐 · 事实为真」

> 生成日期：2026-10-13 · 基于 v0.1.9（commit `579230b`）全量源码深读 + ComfyUI 0.39.0（`8010b48`，2026-10-13）四路源码深读 + 全量测试审计
> 原则：根因修复、零半成品、每条链路带行为测试与门禁
> 状态：**已实施完成**（2026-10-13）— 实施结果与本文设计的差异见文末「实施记录」

---

## 0. 背景与分析方法

- **ComfyPilot 全量读取**：src 39,541 行（main 28 文件 / renderer 36 文件 / shared / preload）逐文件亲读；README、PLAN-0.1.9、全部配置与脚本亲读；tests 26,000+ 行由两路审计子代理逐文件深读并回传用例计数、覆盖矩阵与缺口清单。
- **ComfyUI 0.39.0 深度分析**：四路子代理分别深读 HTTP/API 层（server.py 1568 行、main.py 670、cli_args.py 336、api_server/、protocol.py）、执行引擎（execution.py 1464、comfy_execution/、nodes.py 2629）、模型/路径/显存（folder_paths.py、model_management.py 2208、cuda_malloc.py）、扩展生态（custom_nodes 加载、comfy_config、comfy_api、tests）。
- **测试审计结论**：2112 用例全绿，但行为测试与契约测试显著分层——nodePack/updater/instance/p1p2/media 是强行为测试；v017 系列约 87% 为源码字符串断言（其中 IPC channel 用例是"从源码抽名字再断言源码含该名字"的自证循环）；`doctor.ts` 行为覆盖 0%、`backup.ts` 2%、`monitor.ts` 16%（vitest.config.ts:79-91 自认）；另有 10+ 处名不副实的假测试（清单见 WP7）。

0.1.10 的三条主线（对应三个真实缺口）：

| 主线 | 缺口 | 影响 |
|---|---|---|
| **A 引擎对齐** | ComfyUI 0.39 的 /api/jobs、feature_flags 协商、预览帧、progress_state、workflow_metadata 全部未接入 | 监控/取消/溯源停留在 2023 年的 /queue+/interrupt 语义 |
| **B 事实为真** | 节点「IMPORT FAILED」、实例在线版本、在线模型清单对 ComfyPilot 完全不可见 | 用户装了坏包、版本漂移、模型列表缺失都没有事实来源 |
| **C 质量清偿** | 假测试、自证契约测试、doctor/backup/monitor 行为空白 | 门禁部分虚高，回归防线有洞 |

---

## WP0（P0）实例能力探测层（Foundation）

### 现状

- 实例版本来自安装戳/`git describe`（instance.ts:245-289），**运行中的真实版本**不采集；`/system_stats` 仅用于就绪判定（instance.ts:967-984）。
- `launchArgs` 的 recent 标记只能给模糊警告（launchArgs.ts:299），无法按真实版本精确化。

### ComfyUI 0.39 事实

- `/system_stats`（server.py:752-803）system 字段含：`comfyui_version`、`required_frontend_version`、`installed_templates_version`、`required_templates_version`、`comfy_package_versions[]`、`python_version`、`pytorch_version`、`embedded_python`、`deploy_environment`、`argv`；devices[] 含 vram_total/free 与 torch 视角值。
- `GET /features`（server.py:805-811）返回 feature flags；WS 首条消息 `{"type":"feature_flags"}` 可协商（server.py:362-378，仅第一条消息生效）。
- assets 系统（`--enable-assets`，默认关）和 `/api/jobs` 均为"较新版本才可用"的能力面。

### 设计

1. 新增 `src/main/services/capabilities.ts`：
   - `probeCapabilities(baseUrl)`：并行拉 `/system_stats` + `/features`（各 2s 超时），返回结构化 `InstanceCapabilities`（version、frontend 期望/实际、packages、torch/python、argv、features map、`jobsApi/assets/previewMetadata` 探测位）。
   - `capabilityGate(caps, feature)`：**版本已知 → 精确判定；版本未知 → 端点探测；两者都没有 → 保守 false + reason**。（沿用 0.1.9"不虚构 minVersion"原则：minVersion 表只对 `jobsApi`/`workflowMetadata`/`previewMetadata` 等已被实测验证的端点登记，登记值必须来自真实对照，否则走探测。）
2. instance.ts：`toInfo` 增加 `onlineVersion`；新增 30s 缓存的能力探测（仅 running 时），失败静默（不影响实例状态机）。
3. IPC：`instance.capabilities(id)` → `InstanceCapabilities | null`；实例详情「基本信息」显示真实版本与前端包匹配状态（comfy_package_versions 有 installed≠required 时黄标）。
4. `warnLaunchArgs(args, { version? })`：版本已知时 recent 标记给出"当前 0.39.0 支持/不支持"的确定措辞；未知时保持现状。

### 验收与测试

- 新单元测试：版本解析（1.2.3/0.39.0/带 sha）、gate 三态矩阵、探测失败回退、缓存 TTL。
- 实例详情显示在线版本；无侵入（探测失败不改变任何现有行为）。

---

## WP1（P0）节点加载状态可见（IMPORT FAILED 解析）

### 现状

节点页只反映文件系统（nodePack.ts list 读 pyproject/`__init__.py`），**ComfyUI 启动时真正加载失败的包完全不可见**——用户只能在实例日志里翻找。

### ComfyUI 0.39 事实

- 启动日志固定块：`Import times for custom nodes:`，每行 `<秒> seconds (IMPORT FAILED): <路径>`（nodes.py:2399-2407）；prestartup 同理（main.py:217-225，` (PRESTARTUP FAILED)`）。
- 逐包原因：`Cannot import <path> module for custom nodes: <e>`（nodes.py:2350-2351，前一行是完整 traceback）、`Skip ... lack of NODE_CLASS_MAPPINGS or comfy_entrypoint`（2346-2348）、`--quick-test-for-ci` 可让进程在加载完节点后立即退出（main.py:616-617）。
- 禁用约定：目录名以 `.disabled` 结尾跳过加载（nodes.py:2379）——ComfyPilot 的 `.disabled/` 语义与之兼容（nodePack.ts:2830-2877）。

### 设计

1. `nodePack.ts` 新增导出 `parseNodeLoadReport(logs: ComfyLogLine[])`：从 `instance.getLogs` 的结果解析 `{ modulePath, seconds, ok, prestartup }`；目录 basename → 匹配本地包（兼容 `.disabled` 后缀剥离）；无报告时返回 `null`（不猜）。
2. IPC `node.loadReport(instanceId)`：读取实例日志（含磁盘历史，instance.ts:537-549 已合并）→ 报告 + 逐包状态：`loaded | import-failed | prestartup-failed | not-in-last-boot（日志轮转）| unknown`。
3. NodesView 卡片徽标 + 筛选（"加载失败 N"）；失败包展示原因行（traceback 首行）与建议（补依赖 → 指向 repairEnv / allow_pip_install）。
4. P1 可选：实例详情「启动自检」按钮 → `runStartupSelfCheck`（回退 python 直接 `main.py --quick-test-for-ci --cpu`，60-180s，输出解析进日志）——仅在其能力被验证后启用，默认折叠在"高级"。

### 验收与测试

- 固定日志样本（含成功/失败/prestartup/无报告）→ 解析行为断言；`.disabled` 匹配、路径分隔符双平台。
- 重启实例后节点页直接显示"加载失败"包与原因。

---

## WP2（P0）实时监控真相（预览帧 + 节点级进度 + jobs 适配）

### 现状与硬伤

- `monitor.ts:261`：`if (buf.length > 0 && buf[0] === 0x00) return // binary preview frame`——**所有二进制预览帧被直接丢弃**，`ExecProgressEvent.image`（types.ts:442）从未被填充；监控页无任何生成画面。
- WS 无 feature_flags 协商；进度只有全局 `progress`（value/max）；队列/历史靠 `/queue`+`/history` 轮询（monitor.ts:196-235）；取消只有 `/queue delete`（**只删 pending，running 无效**）与全局 `/interrupt`。

### ComfyUI 0.39 事实

- 二进制帧两代：旧 `PREVIEW_IMAGE`（event=1/2）：`[4B event][4B format] + image`（server.py:1384-1406）；新 `PREVIEW_IMAGE_WITH_METADATA`（event=4）：`[4B event][4B metaLen][JSON meta][image]`（server.py:1408-1443），meta 含 `image_type/node_id/prompt_id`；**新格式需客户端在首条 WS 消息声明 `supports_preview_metadata`**（server.py:362-378）。
- 节点级进度：`progress_state` 事件（comfy_execution/progress.py:161-235，nodes 逐节点 value/max/state）。
- `/api/jobs`（server.py:887-1009）：统一 pending/in_progress/completed/failed/cancelled；**`limit` 不传会返回全部（含最多 1 万条 history），必须显式传**（jobs.py:453-514）；`/api/jobs/{id}/cancel` 原子（`interrupt_if_running`，execution.py:1376-1393）；`/api/jobs/cancel` 批量。
- `/interrupt` 带 `prompt_id` 仅在该任务确实 running 时生效（server.py:1240-1261）；`/queue delete` 永远只删 pending（execution.py:1404-1415）。

### 设计

1. **预览帧**：`connectWs` 成功后立即发送 `{"type":"feature_flags","data":{"supports_preview_metadata":true}}`；`monitor.ts` 解析两代帧 → emit `{type:'preview', image:<dataURL>, nodeId?, promptId?}`；节流（≥300ms，首帧立即）；electron 侧仅内存持有，不入 store 持久化。
2. **progress_state**：monitor.ts 解析并维护 `nodeProgress: Map<nodeId, {value,max,state}>`；MonitorView 增加「当前节点」与逐节点进度条（状态 pending/running/finished/error）。
3. **jobs 适配层**：`comfyApi.ts` 增 `jobsList(limit, status?)` / `jobCancel(id)` / `jobsCancel(ids)`；经 `capabilityGate('jobsApi')` 通过时，MonitorView「队列」tab 与 batch 取消优先使用；否则回退现有 /queue+/history+delete（回退路径保留测试）。
4. **batch 取消对齐**：`batchService.cancelItem/cancel` 在能力可用时先 `jobs cancel`（能真正中止 running），再走现有 dequeue；`tryDequeue` 语义不变。
5. i18n + 事件契约测试（帧解析：两代格式、截断帧、纯 JSON 帧不误判——`buf[0]===0x00` 的旧守卫改为按 event 号分派）。

### 验收

- 生成时监控页实时显示预览图与节点进度；对 0.39 实例取消 running 任务生效；对旧实例全回退。
- 新增行为测试：帧解码（手工构造 buffer）、协商消息、jobs 适配 gate 回退、批量取消调用序列。

---

## WP3（P0）提交对齐（workflow_metadata 溯源 + 定向 interrupt）

### ComfyUI 0.39 事实

- `/prompt` body 可带 `workflow_metadata`（≤256 字节，server.py:78-106）；此后所有含 `prompt_id` 的事件都会附带该元数据 id（server.py:1465-1483）——比现有 sidecar `prompt_links.jsonc`（workflow.ts:994-1042）更可靠的溯源通道。
- `client_id` 必须与 WS 会话一致才能收到私有事件（execution.py:738-741）；ComfyPilot 的 `COMFY_CLIENT_ID`（comfyApi.ts:2）在 WS 与 `/prompt` 双端一致（正确，需保持）。
- 校验失败响应形状：400 `{error:{type,message,details,extra_info}, node_errors:{...}}`（server.py:1209），ComfyPilot 已解析 message/node_errors（comfyApi.ts:41-57）。

### 设计

1. `queuePrompt` 增可选 `metadata`（首版仅 `{source:'comfypilot', workflowId?, batchJobId?}`，JSON 后 ≤256B；超限则截断/丢弃并仅记日志）；batchService 与 workflowService.queue 传入。
2. `batchService.cancelItem`：定向 `interrupt(promptId)`（每个未完成 prompt id）替代/补充全局 dequeue；配合 WP2 jobs 能力优先。
3. `comfyApi.interrupt(promptId?)` 签名扩展（现有 176-186 无参）。
4. sidecar 保留为旧版回退与离线解析；新增"溯源命中率"日志（诊断包可见）。

### 验收与测试

- 单元：metadata 构造（≤256B、逃生）、cancelItem 调用序列（jobs→interrupt→dequeue）、旧实例无 metadata 时行为不变。
- 实测（Windows 打包冒烟阶段）：0.39 实例上批跑产物能经事件元数据关联。

---

## WP4（P1）launch profile 补全与版本化警告

### 现状

`LaunchProfile` 25 字段（types.ts:64-97）+ CATALOG ~100 项（launchArgs.ts:170-279）；与 cli_args.py 实测对照后仍缺：

| 缺失参数 | ComfyUI 0.39 依据 | 用途 |
|---|---|---|
| `--base-directory` | cli_args.py:70；folder_paths.py:14-18 | 多实例共享源树、独立 user/output |
| `--user-directory` / `--models-directory` | cli_args.py:262-263 | 同上（合法目录校验） |
| `--default-device N` | cli_args.py:78；main.py:89-96 | 多卡默认设备 |
| `--enable-triton-backend` / `--disable-triton-backend` | cli_args.py:119-120 | 新加速后端 |
| `--disable-nvml-pressure` | cli_args.py:176 | DynamicVRAM 压力检测回退 |
| `--enable-assets` / `--enable-asset-hashing` | cli_args.py:278-280 | assets 库与内容哈希 |
| `--list-feature-flags` | cli_args.py:282 | 诊断只读 |

另：`--disable-dynamic-vram` 在 0.39 带"will be removed soon"警告（main.py:654-661）——CATALOG 标记为 recent 即可，不做推荐。

### 设计

1. `LaunchProfile` 增：`baseDirectory/userDirectory/modelsDirectory`（字符串）、`defaultDevice`（数字）、`tritonBackend?: 'default'|'on'|'off'`、`disableNvmlPressure/fastDiskOff?`、`assets/assetHashing`（布尔）；`renderLaunchProfile` 对应渲染（顺序规范追加于网络组后）。
2. CATALOG 补全上表（含 `recent` 标记）；`LaunchProfileEditor` 新增「基础目录」组（三路径 + 说明"留空=实例根"）。
3. `warnLaunchArgs(args, {version})`：版本已知时输出"当前版本支持/不支持"（WP0 提供）。
4. doctor 的 `write-extra-model-paths` 修复升级：生成含 `is_default` 与完整 key 注解的模板（doctor.ts:460-469），并与 launchArgs 的自动 `--extra-model-paths-config`（instance.ts:821-827）文档联动。

### 验收与测试

- 渲染矩阵扩测（每新字段 → argv）；base-directory 场景集成测试（buildArgs cwd 与 yaml 路径仍正确）。
- 编辑面板截图级验收（参数预览实时更新）。

---

## WP5（P1）模型枚举在线对账

### 现状

模型库是纯本地扫描（model.ts:374-497 + settings.modelScanRoots + extra yaml 解析）；与实例实际可见的 combo 列表可能不一致，且用户无法解释"为什么某个模型不出现在加载器里"。

### ComfyUI 0.39 事实

- `GET /models`（folder 类型列表）与 `GET /models/{folder}`（文件名列表，server.py:403-415）；HTTP 层**不做 legacy 映射**（`/models/clip` 会 404，clip→text_encoders 仅内部 map_legacy，folder_paths.py:111-114）。
- `GET /experiment/models`（app/model_manager.py:28-43）：每类 `{name, folders:[绝对路径], extensions}`——**给管理器的最有用视图**；`/experiment/models/{folder}` 带 `pathIndex/size/modified`；`/experiment/models/preview/...` 返回 webp 预览。路由名带 "experiment" 标注，接口不稳定 → 必须探测回退。
- `output` 目录也被 registration 为模型搜索路径（main.py:155-161）——本地扫描缺失这里的解释。

### 设计

1. 模型页新增「与实例对账」（需 running）：拉 `/experiment/models`（失败回退 `/models` 列表）→ 对比本地索引：
   - **实例可见但本地没有**：文件未扫描（一键把 folders 加为扫描根 / 触发定向扫描）；
   - **本地有但实例不可见**：扩展名不在该 folder 的 extensions、或目录不在 folders（展示原因）；
   - legacy 别名（unet/clip）明确映射后再比较。
2. 预览复用（P2）：对账面板可直接用 `/experiment/models/preview` 生成缩略图（省本地 nativeImage），留作后续。

### 验收与测试

- mock fetch 的对比矩阵测试（可见/缺失/多余/别名/接口不可用回退）；对真实实例 smoke（Windows 打包冒烟阶段）。

---

## WP6（P1）远程上下文收口

### 现状（0.1.7 遗留）

- `store.activeTargetUrl`（stores/app.ts:65-68）**无任何消费方**：MonitorView/DashboardView 用 `store.activeInstance?.url`（本地），选择远程实例后监控仍显示本地数据；`remoteReady` 只用于打开 Frontend 的按钮门控。

### 设计

1. MonitorView / DashboardView：队列/历史/系统信息改读 `activeTargetUrl` + `isRemoteActive`；远程时隐藏本地专属操作（启停/更新/修复已有 `remoteNoControl` 语义）；queue/history 轮询走 `monitor.queue(activeTargetUrl)`（handlers 已校验 `isTrustedComfyUrl`，handlers.ts:851-877，远程 baseUrl 在 configuredComfyOrigins 内）。
2. 范围明确：**远程不做批跑提交/实例生命周期**（0.1.10 不做；在 UI 明示"远程为只读监控"）；WS 对远程由 `syncWs()` 已连接（stores/app.ts:129-150），预览帧复用 WP2。
3. i18n：`monitor.remoteReadonly` 等新键。

### 验收与测试

- composable/视图层行为：activeRemote 时请求 URL 断言为 baseUrl；store 单测补 `activeTargetUrl` 消费断言。

---

## WP7（P1）质量清偿（测试债）

### 审计发现的真实债务（子代理逐文件证据）

**A. 行为覆盖空白（vitest.config.ts 已自认）**

| 模块 | 现门禁 | 补测计划 |
|---|---|---|
| `doctor.ts` | 0% | run 矩阵（13 检查各自 pass/warn/fail/修复）、fix 四种（含 unpin-torch 真写文件）、非法实例 id |
| `backup.ts` | 2% | create（含 workflow-files 拷贝/缺失计数）、restore（解析失败=不应用、原子 tmp+rename、workflow 文件恢复失败计数）、delete/openFolder |
| `monitor.ts` | 16% | mergeGpuMemory 合并矩阵、ws generation 防串扰、reconnect 退避、queueSnapshot 解析 |
| `registryIndex.ts` | 53% | ensure 的磁盘缓存加载/过期、buildFull 分页与 skippedPages、findByRepository |
| `nodePack.ts`（pip 清理链） | 未覆盖 | `pipDeps`/`removePipDeps`（20 批次、AbortError 透传、单名回退）、`uninstall({removePipDeps:true})` |
| `env.ts`（venv/torch） | 部分 | `createVenv`/`installTorch`/`listPythons` 行为 |

补测完成 → 门禁按"实测−2pp"上调（doctor/backup/monitor/registryIndex/registry/comfyApi/db）。

**B. 假测试修复清单（点名到行）**

1. `updaterPipeline.test.ts:1714/1726/1737/1758`：四个"分支测试"实际未构造失败（happy path 空转）；`1774` 注释与断言相反——确认语义后改名或修复。
2. `nodePackService.test.ts:3580`："statSync throws"未抛错；`:3660/3711` 向从未被读取的 `h.state.execHandler` 写值（死 mock，因测试不参与 tsc 永不被发现）。
3. `nodePackBranches.test.ts:495`：断言数组不含字符串 `'undefined'`（原始值断言不到）；`:441/932` 双值放行弱断言收紧。
4. `installerService.test.ts:494`：依赖前一个用例残留 `progress`（单独跑会失败）；`:622` 条件断言（环境依赖）。
5. `app-smoke.e2e.ts:55`：恒真（fallback 分支返回值天然以 electron 结尾）；e2e 补"渲染进程真实加载"断言（`executeJavaScript` 检查 `#app` 有子节点/标题），不再只测"能 spawn、能退出"。
6. `cacheMigration.test.ts:64-70`：符号链接失败静默 return → 改为显式 `it.skipIf`。

**C. 契约测试治理（v017 系列 ~87% grep）**

- **冻结新增**；新增契约必须带行为断言（mock `ipcMain` 断言 `handle` 注册形状，而不是"源码含字符串"）。
- 自证循环（TypeFields/TypeSystem 从 types.ts 抽 channel 再断言 types.ts 含该 channel）改双向行为验证：对 `IpcChannelMap` 的每个 key，用 `vi.mock('electron')` 捕获 `registerIpcHandlers` 注册集合做**集合相等**断言（真正防"类型里有、handler 没实现"）。
- "发布元数据"断言（README 版本、`257 tests` 反向断言、prettier/tsconfig 存在）从门禁移出 → 改为 release 脚本自检（不占测试数、不随版本改动而红）。

**D. 测试纳入 typecheck**

- 新 `tsconfig.test.json`（include tests/**，types: node + vitest globals），CI 增加 `tsc --noEmit -p tsconfig.test.json`；先修可暴露的死 mock 类错误。

### 验收

- 补测后全量 ≥2200 用例全绿；假测试清单逐条销账；覆盖率门禁按新实测上调并保持全绿。

---

## WP8（P2）杂项收口

1. `packStatusLabel` 补 `not-installed`/`installing` 映射（NodesView.vue:110-114 目前落到"已启用"）。
2. 硬件感知推荐 profile（0.1.9 遗留 P1）：基于 `store.system.gpus[].vramTotal` 推荐 LaunchProfile（≥12GB → 默认；8-12GB → `reserve-vram 1 + fast-disk`；≤6GB → `reserve-vram 2 + cache-none + fast-disk`），`LaunchProfileEditor` 顶部"按当前显存推荐"一键应用（需实例运行/系统快照）。
3. `walk()` 模型扫描深度与 `settings.outputScanDepth` 对齐配置化（model.ts:353-372 固定 10 层——评估后统一）。
4. 实例诊断包增补 `/system_stats` 摘要与 `/features`（离线诊断更完整）。

---

## 里程碑与全局验收

| 项 | 标准 |
|---|---|
| 测试 | 现有 2112 + 新增（预计 +120~180）全绿；WP7 假测试清单销账 |
| 门禁 | typecheck（含 tests）· ESLint 0 · i18n 硬门禁（含新动态域）· 硬编码中文 0 · 覆盖率（上调后的 floors）· build |
| 平台 | Windows 打包 + 安装包冒烟 RUNNING；e2e 新增渲染断言 |
| 兼容 | 未运行/旧版 ComfyUI：全部新能力经 capabilityGate 回退，行为与 0.1.9 一致（回退路径必须有测试） |
| 文档 | README / release body / 本文件同步；PLAN 记录与实现差异 |

### 风险与关注点

1. **/experiment/* 不稳定**（路由自身标注 experiment）：必须探测回退，UI 不暴露失败细节。
2. **/api/jobs 性能陷阱**：`limit` 必须显式；不拉全量 history。
3. **预览帧双代格式**：解析必须容错（截断/未知 event 号忽略），且遵守"仅首条消息协商"。
4. **实验范围控制**：远程只读；不做远程批跑/生命周期（防止范围爆炸）。
5. **与 0.1.9 链路的隔离**：不改动 nodePack 更新核心流（除 WP1 只读解析），降低回归面。
6. **workflow_metadata 旧版兼容**：无法验证的旧版若忽略 extra_data 属无害；发送前 ≤256B 校验。

---

## 附：ComfyUI 0.39.0 关键集成事实索引（本方案引用）

| 事实 | 位置 |
|---|---|
| `/system_stats` 全字段（版本/前端包/argv/deploy_environment） | server.py:752-803 |
| `/features` + WS 首消息 feature_flags 协商 | server.py:805-811、362-378 |
| 预览帧两代（event 1/2 与 event 4 metadata） | server.py:1384-1443；protocol.py |
| `progress` 与 `progress_state` | main.py:444-473；comfy_execution/progress.py:161-235 |
| `/api/jobs` 列表/详情/单个取消/批量取消（limit 陷阱） | server.py:887-1109；comfy_execution/jobs.py:453-582 |
| `/queue delete` 只删 pending；`/interrupt` 定向语义 | execution.py:1404-1415；server.py:1240-1261 |
| `workflow_metadata` ≤256B 并入事件 | server.py:78-106、1465-1483 |
| `client_id` 事件订阅语义 | execution.py:738-741 |
| IMPORT FAILED 日志块 / prestartup / quick-test-for-ci | nodes.py:2399-2407；main.py:217-225、616-617 |
| `.disabled` 加载跳过 | nodes.py:2379 |
| `/models`、`/experiment/models`（folders/extensions/pathIndex/preview） | server.py:403-415；app/model_manager.py:28-103 |
| output 目录也被注册为模型路径 | main.py:155-161 |
| CLI：base/user/models-directory、default-device、triton、nvml-pressure、assets、list-feature-flags | cli_args.py:70、262-263、78、119-120、176、278-282 |
| 动态显存默认开启、lowvram 语义变化、`--disable-dynamic-vram` 将移除 | cli_args.py:333-336；main.py:654-661 |
| extra_model_paths 多文件加载与前缀顺序 | main.py:133-139；utils/extra_config.py:6-34 |

---

## 与 0.1.9 的继承关系

- WP0/WP4 是 0.1.9「启动可控」的自然延伸（能力真相 → 精确警告）；
- WP2/WP3 是「更新可信」之外的**运行期可信**补全（进度、取消、溯源）；
- WP1 与 0.1.9「更新可信」互补：更新把包装对，WP1 让"装对了但加载失败"可见；
- WP7 清偿 0.1.8/0.1.9 遗留的测试虚高与门禁水分。

---

## 实施记录（2026-10-13）

### WP0 能力探测层（完成）
- 新增 `src/main/services/capabilities.ts`：`probe()` 并行采集 `/system_stats` + `/features` + `/api/jobs?limit=1`（jobsApi 为**探测事实**，不做版本猜测）；`workflowMetadata` 以 `WORKFLOW_METADATA_SINCE='0.39.0'`（开发对照版本）为界；30s 缓存 + `cachedForUrl()`（instance.toInfo 在线版本）。
- `versionAtLeast` 上移 `@shared/launchArgs`（main/renderer 共用），capabilities 复用。
- IPC `instance.capabilities`；`instance.onlineVersion`。
- 行为测试 7 例（字段解析/离线/jobs 探测/缓存 TTL/版本比较）。

### WP1 节点加载状态（完成）
- `src/shared/nodeLoadReport.ts`：`parseNodeLoadReport`（取最后一次 Import/Prestartup 块、按日志顺序输出、`.disabled` 归一、`Cannot import`/`Skip` 原因关联）、`packLoadStatusOf`/`packLoadFailureOf`；`nodePack.loadReport()` 经实例日志（内存+磁盘合并）解析。
- IPC `node.loadReport`；NodesView 汇总条（"上次启动 N 加载成功 M 失败"）+ 失败/启动脚本失败徽标（置标签行前部防裁切）+ tooltip 原因；无报告显示提示。
- `instance.runStartupSelfCheck`（`main.py --quick-test-for-ci --cpu`，输出回灌实例日志）+ IPC；NodesView 顶部与实例详情诊断区双入口（需停止实例）。
- 测试 8 例（真实日志样本矩阵）。

### WP2 监控真相（完成）
- `monitor.ts`：WS open 即发 `feature_flags` 协商；**删除 `buf[0]===0x00` 丢弃逻辑**，按事件号分派；解码两代预览帧（event1/2 8 字节头、event4 metadata+图片、event3 忽略）、截断帧安全丢弃、预览 300ms 节流；`progress_state` → 节点级进度；`execution_cached`；`jobsSnapshot(baseUrl)`（/api/jobs，404 → null）。
- comfyApi：`jobsList`（**必带 limit**，1..500 夹取）/`jobCancel`/`jobsCancel`/`interrupt(promptId)`。
- batchService：`cancelItem`/`cancel` 优先原子 `/api/jobs/cancel`，旧版回退 dequeue。
- MonitorView：实时预览面板（dataURL 图片 + 空态）、运行中节点进度条与完成计数、作业列表小节（jobs 可用时）；IPC `monitor.jobs`。
- 行为测试：`monitorWs.test.ts` 7 例（协商/两代帧/node-id/节流/progress_state/截断安全）+ monitorGpu jobs 2 例 + p1p2 取消优先/回退 2 例。

### WP3 提交对齐（完成）
- `queuePrompt` 支持 `workflow_metadata`（本地 ≤256B 校验，超限丢弃）；workflow.queue 与 batchService 均携带（source/workflowId/batchJobId/截断 name）。
- 侧车映射保留为旧版回退；测试断言 metadata 随 /prompt 发送。

### WP4 启动参数补全（完成）
- LaunchProfile 增 8 字段（baseDirectory/userDirectory/modelsDirectory/defaultDevice/tritonBackend/disableNvmlPressure/assets/assetHashing）；渲染顺序锁测；CATALOG 补 4 个 flag；`--default-device` 数值校验；`warnLaunchArgs(args,{version})` 版本化（0.39+ 静默已确认项，旧版显式 warning，未知保持 info）；pathFlags 补 user/models-directory。
- `LaunchProfileEditor` 新增「基础目录」组 + Triton/NVML/Assets 控件 + **按显存推荐**按钮（`recommendLaunchProfile`：≥16GB 不推荐 / ≥8GB reserve+fast-disk / ≥6GB +LRU / 其余 +cache-none；三处调用方传入 store.system.gpus）。
- doctor `write-extra-model-paths` 升级为完整 key 模板（含 is_default、block scalar、legacy 别名）。
- 测试：渲染矩阵 + 版本化警告 + 推荐分档 + doctor 模板断言。

### WP5 模型在线对账（完成）
- `modelService.reconcile()`：优先 `/experiment/models`（folders/extensions/逐目录 name 列表），回退 `/models`；legacy clip/unet 归一到 canonical；输出 missingLocally/extraLocally(格式不可见单列)/uncoveredRoots。
- IPC `model.reconcile`；ModelsView 对账卡片（差异行 + 明细 + 「添加 N 个扫描根」一键写 settings 并重扫）。
- 测试 4 例（experiment 全矩阵/legacy 回退/无端点/无实例）。

### WP6 远程上下文（完成）
- MonitorView/DashboardView 队列/历史/作业改读 `activeTargetUrl`（远程 baseUrl 或本地实例 URL）；远程只读提示条；BatchView 远程提交显式拒绝提示（范围限定：远程只读）；targetReady 门控替代本地状态判断。
- i18n `monitor.remoteReadonly*`、`batch.remoteNotSupported`；`activeTargetUrl` 首次获得真实消费。

### WP7 质量清偿（完成）
- 假测试修复（点名销账）：updaterPipeline 4 个空转分支改为 **fs 故障注入**（failCopyOnce/failRmPrefix）真实触发 + 注释反转修正；nodePackService `statSync throws`（statFail 注入）与两处死 mock（改用 `cpMock.__setExecHandler` 并修复 clone 建目录）；nodePackBranches `'undefined'` 断言收紧、双值放行改确定值、GitPack 用例去掉 try/catch 吞错、GitFail 用例改用**流式 spawn 真实失败流**（并修复 spawn mock 缺失的 on/stdout，消除"因 mock 崩溃而假通过"）；installerService 顺序依赖改显式 setup、条件断言改确定性清空实例；cacheMigration symlink 改 `it.skipIf`（显式跳过而非静默 return）；e2e 恒真断言改真实存在性 + **渲染挂载标记**（main 在 did-finish-load 后 executeJavaScript 探 #app 并打 `[e2e] renderer-mounted`，e2e 强断言）。
- 行为补测：doctor 10 例（全检查矩阵/CPU torch 警告/损坏目录/Registry 不可达/4 种 fix + 模板完整断言）、backup 5 例（workflow 文件拷贝与缺失计数/原子恢复/损坏中止不应用/删除）、monitor GPU 7 例、registryIndex 6 例（构建/缓存 TTL/磁盘加载/skippedPages 通知/搜索/离线）、pipDeps & removePipDeps 4 例（解析/20 批次/AbortError 透传/单名回退）、env 3 例（venv 守卫/torch 结果/解释器汇总）、comfyApi jobs 6 例、capabilities/nodeLoadReport/modelReconcile/ipcRegistration 见上。
- 契约治理：新增 `ipcRegistration.test.ts`——**真实执行 registerIpcHandlers** 并与 types.ts 声明的 channel 集合做双向集合相等断言（150+ channel，杜绝"类型有、handler 无"）；v017 三处版本硬编码改为**动态读取 package.json**（版本一致性检查保留、不再随发版变红）；README 版本断言动态化。
- 测试纳入 tsc：新增 `tsconfig.test.json` + `typecheck:test` 脚本 + CI 步骤，清零全部 139 个存量测试类型错误（含本仓库历史遗留的 mock 类型问题）。
- 覆盖率：新文件（capabilities/nodeLoadReport）纳入 include；全量实测后按「实测−2pp」重校准（doctor 82/backup 88/monitor 59/registryIndex 87 等，全局 88/90/81），门禁全绿。

### WP8 杂项（完成）
- `packStatusLabel` 补 not-installed/installing；硬件推荐 profile（上述 WP4）；诊断包增补 `system-stats.json` + `features.json`（离线亦可诊断版本/argv/feature flags）。
- 模型扫描深度统一评估：`model.walk` 已有 depth>10 与 50000 文件上限，模型目录层级普遍较浅；本次**不引入新设置项**（保持 10 层上限），产物目录深度已由 `outputScanDepth` 独立可配。

### 与设计稿的差异（最终）
- **不引入 `gate()` 三态方法**：实现中选择"**探测 + 尝试回退**"（jobsCancel 失败即回退；jobsApi 为探测字段），比版本表 gate 更可靠且无死代码；能力事实仍由 `probe()` 提供（WP0 验收的三态语义落在探测字段与回退路径测试中）。
- 启动自检入口落在 **NodesView 顶部 + 实例详情诊断区**（设计稿仅写详情页），节点页更贴近"哪些包加载失败"的语境。
- `/api/jobs` 在监控页以**作业列表小节**落地（设计稿为"队列 tab 优先 jobs"），保留原 /queue 视图与远程场景兼容。
- 测试纳入 tsc 的任务实际规模较大（139 个存量错误），已随本次全部清零；CI 增加 `Typecheck (tests)` 步骤。
- 版本化警告不虚构 minVersion：`RECENT_FLAGS_SINCE='0.39.0'` 仅表达"该版本实测确认"，旧版本→warning、未知→info 的语义写进注释与测试。

### 事故与恢复（如实记录）
- 在收敛无消费 `gate()` 方法时，一次 edit 的 oldString 覆盖范围过大，**误删了 `capabilities.probe()` 方法体**；随即 read 确认损伤范围，并用同一 edit 工具完整恢复 probe（含 jobsApi 探测与缓存写入），随后 `typecheck` + capabilities 7 例测试全绿验证恢复正确。教训：跨方法的大段替换必须先读回精确边界。

### 逐项对账审计（实施完成后，逐条核验设计条目）
对本文每个 WP 的设计条目做代码级核验后，**发现 4 项设计条目未完全落地 + 3 处死代码**，已全部补齐：

| # | 条目 | 审计发现 | 修复 |
|---|---|---|---|
| 1 | WP0-P3「实例详情显示真实版本与前端包匹配」 | `instance.capabilities` IPC 已注册但**渲染层零消费**（死接口风险） | InstanceDetailView 拉取 capabilities：版本行显示在线版本+「在线」徽标、新增「运行时」（Python/torch）与「前端包」（installed≠required 黄标 + tooltip）；InstancesView 卡片优先显示 `onlineVersion` |
| 2 | WP1-P3「卡片徽标 + 筛选」 | 只有汇总 tag，无筛选 | 新增「仅看加载失败（N）」筛选按钮（filteredPacks 接入），i18n 双语 |
| 3 | WP3-P2「定向 interrupt（每个未完成 prompt id）」 | `comfyApi.interrupt(promptId)` 无任何消费（死代码） | 接入 batchService：整 job 取消的旧版回退路径 = dequeue + 对最近 5 个未完成 id 定向 `interrupt(pid,1500)`（0.39 仅命中 running；旧版全局语义仅用于整任务取消）；**单腿取消显式不 interrupt**（防误伤兄弟腿，注释+测试锁定）；新增 3 条行为测试（cancel 回退断言 interrupt body、cancelItem 原子优先且零 /queue+零 /interrupt、cancelItem 回退零 interrupt） |
| 4 | WP3-P4「溯源数据诊断包可见」 | 诊断包无 provenance 数据 | 诊断包新增 `prompt-links.json`（侧车副本）+ `attribution.json`（promptLinks/batchJobs/batchOutputLinks 统计） |
| 5 | 死代码清理 | `CapabilityGateResult`、`CapabilityFeature`、`resetCapabilityCacheForTest` 无消费 | 全部删除（类型/函数均无常量引用） |
| 6 | WP7 验收线「≥2200 用例」 | 审计时 2198，差 2 | 补 3 条（cancelItem ×2 + capabilities 缓存过期 TTL）→ 2201 |
| 7 | WP6 验收「store 单测补 activeTargetUrl 消费断言」 | 仅有源码 grep 契约，无行为断言 | 新增 `appStoreTarget.test.ts` 3 例：无远程→本地 URL、远程激活→remote baseUrl 优先、双空→null → **最终 2204 用例 / 77 文件** |

补充差异记录：
- `LaunchProfileEditor` 的实时警告无法版本化（渲染层不持有运行版本），保持 info 级默认行为；实例启动日志与启动预览（main 侧，持有能力缓存）使用版本化警告。
- v017「发布元数据」断言采用**动态读取 package.json**（保留在测试内、不再随发版变红），未迁移为独立 release 脚本——目标（消除版本硬编码）已达成且少一个脚本入口。
- WP5 验收中的「对真实实例 smoke」未在打包链路执行（冒烟环境不挂真实 ComfyUI）；对账逻辑由 mock fetch 对比矩阵覆盖（experiment 全矩阵/legacy 回退/接口不可用/无实例），真实实例对账留作手工验收项。
- WP6 的「视图层请求 URL 断言」以 store 行为测试覆盖目标解析事实（MonitorView 直接消费 `store.activeTargetUrl`，代码引用可审计），未新建组件测试基建。
