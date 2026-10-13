# ComfyPilot 0.1.9 迭代方案 —「产物可见 · 更新可信 · 启动可控」

> 生成日期：2026-10-13 · 基于 v0.1.8（commit 33b6eb7）全量源码深读 + ComfyUI 0.39.0 源码对照分析
> 原则：根因修复、零半成品、每条链路带行为测试与门禁
> 状态：**已实施完成**（2026-10-13）— 实施结果与本文设计的差异见文末「实施记录」

---

## 0. 背景与分析方法

- ComfyPilot 全链路深读：`nodePack.ts`（2597 行）、`instance.ts`（1286 行）、`handlers.ts`（1412 行）、`media.ts`、`p1p2.ts`、`db.ts`、`security.ts`、`env.ts`、`NodesView.vue`、`MarketView.vue`、`OutputView.vue`、`ComfyUpdateProgressModal.vue`、`useComfyUpdate.ts`、preload、i18n、全部测试。
- ComfyUI 0.39.0 源码深读：`comfy/cli_args.py`（336 行全文）、`main.py`、`server.py`（`/view`）、`comfy_extras/nodes_video.py`、`folder_paths.py`；Comfy-Org/ComfyUI-Manager 的更新队列与终端日志交互。
- 真实用户数据核对：`%APPDATA%/comfy-pilot`（1860 条产物索引 = 1516 png + 344 mp4；54 条 thumbnail 全部指向已被清空的 `<userData>/cache/thumbs/output/*.png`）。

---

## WP1（P0）产物库：缩略图根治 + 视频预览

### 根因

- **R1 URL/目录回环断裂（主因，命中"全部"）**：生成写嵌套 `<userData>/cache/thumbs/output/<key>.png`（media.ts:130-147），URL 压扁为 `comfy-pilot-media:thumbs/<basename>`（media.ts:220-223），解析端拒绝含 `/` 的名字（media.ts:241-248）→ 协议层 403（main/index.ts:324-325）。`thumbnail` 一旦有值永不回退原图 URL（handlers.ts:1158），`<img>` 无 `onerror`（OutputView.vue:509）。
- **R2 缓存目录与 Chromium Cache 同目录**：`cacheDir() = <userData>/cache`（db.ts:134-136），Windows 大小写不敏感下即浏览器缓存目录，被整目录清空（生产数据实锤 thumbs 目录消失）。
- **R3 陈旧 DB 路径 + 无存在性校验**：merge 时旧 thumbnail 永不失效（db.ts:527-531）；`thumbnailDisplayUrl` 不查盘（media.ts:273-277）。

### 修复设计

1. thumbs URL 保留受控子路径（`thumbs/output/<key>.png`），解析端分段解码 + `..` 过滤 + `isPathInside` + `existsSync`，兼容旧扁平 URL。
2. `cacheDir()` 迁至 `<userData>/app-cache`；首次访问时 best-effort 迁移 `thumbs/`、`registry-index.json`。
3. 缩略图缓存键升级为 `sha1(path + ':' + mtimeMs + ':' + size)`；支持原地刷新；`.gif` 增加静态首帧缩略图。
4. handler 三级兜底：thumb 文件存在 → URL；缺失 → 重生 → 原图 URL → null；OutputView `<img>@error` 最终降级占位图。
5. 媒体 URL 白名单口径统一：`mediaOutputRoots()` 使用 `resolveOutputDir(instance)`（支持 `--output-directory`）。
6. 协议注册补 `bypassCSP: true, corsEnabled: true`（防未来 CSP 回归）。
7. 视频支持：`MEDIA_EXT` + `.mp4/.webm/.mkv/.mov`；`p1p2.walk` 视频扩展加 `.mkv`；
   - 网格卡：`<video muted playsinline preload="metadata" :src="mediaUrl + '#t=0.35'">` + 播放角标；`@error` 降级图标。
   - 灯箱：`<video controls autoplay loop>`；`@error` → "用系统播放器打开"。
   - mp4(H.264/AAC)、webm 由 Electron Chromium 原生解码；mkv 容器不支持 → 优雅降级。
8. 预防性清理：启动时删除 30 天前的孤儿缩略图（可再生产物）。

### 验收

真实 1860 条数据：png 全部出缩略图；mp4/webm 网格出首帧、灯箱可播放；mkv/mov 降级不裂；旧 DB 死链自动愈合。

---

## WP2（P0）检查更新：真·全量 + 状态可见

### 现状（问题回答）

- disabled 包**零结果行**（nodePack.ts:1865-1867）；git fetch 失败**静默降级** registry（1967-1970）；local 包无 registryId 永远 notUpdatable（1988-2007）；registry 只查第 1 页 + 本地索引（1840-1862）；git 结果**不持久化**（2008-2016）；类型无"检查失败"状态（types.ts:802-812）。

### 修复设计

1. `NodeUpdateCheckResult` 增加 `checkStatus: 'updatable'|'up-to-date'|'unsupported'|'check-failed'|'skipped-disabled'|'locked'` + `error?`；**所有包都产出结果行**（含 disabled）。
2. git fetch 失败/超时 → `check-failed`（携带错误），不再伪装"不可更新"。
3. registry 匹配三级：`registryId` → repository URL 对 registry index 的 repository 字段 → 名字唯一命中。
4. registry index 全量分页缓存（24h TTL，沿用 registry-index.json）。
5. git 检查结果持久化 `latestVersion/lastCheckedAt`。
6. 检查阶段有界并发（4）+ 进度事件（第 N/M 个包）。
7. UI：状态汇总条（可更新 X · 已最新 Y · 无法检查 Z · 检查失败 W）+ 卡片徽标 + tooltip 原因；"全部更新"只跑 updatable 集合。

### 验收

每类包有明确状态且可解释；fetch 失败不再显示"不可更新"；汇总与卡片一致。

---

## WP3（P0）更新弹框重构：顺序批量 + 实时进度 + 手动关闭

### 现状（问题回答）

- 进度条 0%→100%：`percent = 完成步骤/6`，`update()` 全程只发 start(0%) 与 done(100%) 两个事件（nodePack.ts:2069-2089、678-684）；git 阶段无流式事件；pip 有日志但 percent 不变；Modal `:processing` 恒 false（useComfyUpdate.ts:77）。
- 自动关闭点：NodesView.vue:192-198 watch done/failed；失败显式关闭 NodesView.vue:251/315、MarketView.vue:419/454/459/467。
- 批量：串行但无批次 UI；前端从不打开弹框（NodesView.vue:261-287）；无第 N/M、无聚合进度。
- 参考：ComfyUI-Manager 更新即打开实时终端日志、不自动关闭、任务期间按钮禁用（comfyui-manager.js:468-480/762-790、common.js:464-474）。

### 修复设计

**主进程**

1. `UpdateProgress` 扩展 `packName / batchIndex / batchTotal / aggregatePercent`。
2. 新增 `event:node-update-batch`：`{batchId, phase: 'start'|'pack-start'|'pack-done'|'batch-done'|'batch-error', index, total, packName, ok?, error?, summary?}`；`updateAll` 顺序队列（稳定排序）。
3. 细粒度进度：git 改流式（复用 `env.ts` `runStreaming`）解析 `Receiving objects: N%`；pip 解析 `Collecting/Installing (i/n)`；阶段权重（git 30 / requirements 50 / verify 10 / finalize 10）；percent 单调递增。
4. 新增增量日志通道 `event:node-op-log`：`{runId, packName, line, ts}`（不再重发整个 log 数组）。
5. 修复 install()/update() 批量下 progress 流互相清空（nodePack.ts:1005/2068）。

**前端**

1. 弹框支持 `mode: 'node' | 'comfy'`：node 模式**永不自动关**，成功/失败保持打开展示结果与日志；Close 始终可用；关闭=隐藏不清状态；顶部 banner 显示"批量更新 3/12"可重开。
2. 总进度条（批量聚合）+ 当前包 + 包状态清单 + 终端式实时日志（自动滚动/暂停/复制）。
3. 批量"取消"：停止剩余队列 + 可终止当前（复用 `node.cancelOp`）。
4. 删除所有自动关闭 watch/显式关闭；ComfyUI 本体更新保留原语义。
5. i18n + `IPC_EVENTS` 白名单同步 + 测试（事件序列、percent 单调、首个包 done 不发 batch-done、源码契约禁止自动关闭回归）。

### 验收

批量 12 包顺序执行：进度实时前进、第 N/M 可见、日志滚动、成功/失败都不自动关、可取消剩余。

---

## WP4（P0）ComfyUI 启动参数调优面板

### 现状

`buildArgs` 仅 `main.py --port --listen + 模板 + extraArgs 自由文本`（instance.ts:757-774）；无结构化、无冲突校验；`lan` 模板与必带 `--listen` 重复；未显式传 `--extra-model-paths-config`；未传 `--disable-auto-launch`。

### ComfyUI 0.39 参数要点（cli_args.py）

- 互斥组：显存（gpu-only/highvram/lowvram/novram/cpu）、缓存（cache-ram/classic/lru/none/high-ram）、注意力（pytorch/sage/flash/split/quad/ck）、精度（unet/vae/text-enc 各系列）、upcast、cuda-malloc。传两个即 argparse 报错。
- 预览默认 `none`；`--preview-method taesd` + `--preview-size 512` 可显著改善采样预览。
- 动态显存已是默认；`--lowvram` 在动态显存下基本无效；调优改用 `--reserve-vram / --vram-headroom / --fast-disk`。
- `--extra-model-paths-config PATH...` 可显式加载；`--disable-auto-launch` 避免抢浏览器。

### 修复设计

1. `src/shared/launchArgs.ts`：参数目录（分组/类型/互斥组/取值域/风险级/i18n key/minComfyVersion）+ `validateLaunchArgs()`（互斥冲突、重复监听、数值域、路径存在性）。
2. `ComfyInstanceConfig.launchProfile?` 结构化字段（缺省向后兼容）：vram / reserveVram / vramHeadroom / cache / cacheLru / cacheRam / previewMethod / previewSize / attention / precision / asyncOffload / fastDisk / disablePinnedMemory / mmapTorchFiles / corsHeader / maxUploadSize / multiUser / offline / disableAutoLaunch / verbose。
3. `buildArgs` 渲染：`main.py → --port --listen → launchProfile → 旧模板（兼容） → extraArgs`；预览命令实时更新。
4. 默认行为：追加 `--disable-auto-launch`；检测到 `<instance>/extra_model_paths.yaml` 时显式 `--extra-model-paths-config`。
5. 预设重做：低显存改为「动态显存 + reserve-vram + fast-disk」，保留纯 lowvram 选项；新增省内存（cache-none）、预览开启（taesd）、性能进阶（cache-ram/async-offload）；修正 lan 重复。
6. UI：InstanceDetailView「启动参数调优」面板（分组折叠、推荐徽标、风险提示、实时命令预览、保存提示重启/一键重启）；InstancesView 编辑弹窗高级段。
7. 持久化护栏：`save()/toInfo()` 归一化、`useLaunch.ts:120-135` 与发现导入手写 config 补字段、`resolveOutputDir` 兼容。
8. 测试：buildArgs 矩阵、校验器冲突、旧配置迁移、预览命令、spawn argv 精确断言。

### 验收

面板改参数 → 命令预览即时更新 → 冲突有拦截 → 保存重启生效；旧实例配置无损启动。

---

## WP5（P1）顺手根治

- `walk()` 深度可配（默认 4，可在设置调 6/8）。
- e2e 入口漂移修复（冒烟改为 `bootstrap.cjs` 与真实入口一致）。
- `shell.reveal` 增加路径白名单。
- 协议 `bypassCSP/corsEnabled`（已并入 WP1）。
- 孤儿缩略图清理（并入 WP1）。

---

## 里程碑与全局验收

| 项 | 标准 |
|---|---|
| 测试 | 现有 2026 + 新增用例全绿（每个修复带行为测试） |
| 门禁 | typecheck · ESLint 0 · i18n 硬门禁 · 硬编码中文 0 · 覆盖率 · build |
| 平台 | Windows 打包 + 安装包冒烟 RUNNING |
| 文档 | README / release body / 本文件同步 |

### 风险与兼容

- `instances.jsonc` 旧配置无 `launchProfile` 必须照常启动；新字段仅在保存时写入。
- DB 死缩略图愈合须幂等；缓存迁移失败不阻断启动。
- ComfyUI CLI 随版本漂移：参数目录带 `minComfyVersion`，未知参数仅警告不阻断。

---

## 实施记录（2026-10-13）

### WP1 产物库（完成）
- `media.ts`：thumbs URL 保留受控子路径（`thumbs/output/<key>.png`）+ 解析端分段校验（兼容旧扁平 URL）；`MEDIA_EXT` 扩展 mp4/webm/mkv/mov；缩略图键加入 `mtime+size`（原地覆盖自动失效）；`.gif` 静态首帧；新增 `pruneOldOutputThumbs()`（启动时清理 30 天前孤儿）。
- `db.ts`：`cacheDir()` 迁至 `<userData>/app-cache`，首访一次性迁移旧 `cache/thumbs` 与 registry 索引（Chromium `Cache` 连坐被清除的根因）。
- `handlers.ts` `output.list`：三级兜底（存在校验 → 重生 → 原图 URL）；`mediaOutputRoots()` 改用 `resolveOutputDir`（支持 `--output-directory`）。
- `main/index.ts`：媒体协议补 `corsEnabled: true, bypassCSP: true`；启动清理孤儿缩略图。
- `OutputView.vue`：图片 `@error` 降级占位；视频网格 `<video preload=metadata #t=0.35>` 首帧 + 播放角标，灯箱 `<video controls autoplay loop>`，mkv/mov 不支持时降级「用系统播放器打开」。
- `p1p2.ts`：视频扩展名加入 `.mkv`。
- 测试：mediaUrl（嵌套回环/视频/穿越）、mediaServices（mtime 失效、gif、清理、--output-directory）、p1p2（mkv 分类）。

### WP2 检查更新（完成）
- `NodeUpdateCheckResult` 新增 `checkStatus` + `error`；**所有包都有结果行**（含 disabled→`skipped-disabled`、locked→`locked`）。
- git fetch 失败 → `check-failed`（不再伪装成「不可更新」）；git 结果持久化 `latestVersion/lastCheckedAt`。
- registry 匹配三级：`registryId` → **repository URL**（新增 `registryIndex.findByRepository`，URL 归一化容忍 https/ssh/git+/.git）→ 名字唯一命中；本地全量索引离线可用（即使线上第 1 页失败也执行）。
- 检查有界并发 4 + `event:node-check-progress`（N/M）。
- UI：按钮显示「检查中 N/M」；结果汇总条（可更新/已最新/无法检查/检查失败/已禁用/已锁定）；卡片 `check-failed` 徽标 + reason tooltip。

### WP3 更新弹框（完成）
- `UpdateProgress` 增 `packName/batchIndex/batchTotal/aggregatePercent`；步骤 `progress` 分数 + 权重（15/25/15/35/5/5）实现**单调递增百分比**。
- git 命令改流式（复用 `env.runStreaming`），解析 `Receiving objects: N%` / `Resolving deltas`；pip 输出启发式推进 requirements 阶段。
- 新增 `event:node-op-log` 增量日志与 `event:node-update-batch` 批次事件（start/pack-start/pack-done/batch-done + summary）；`updateAll` 顺序队列 + 批次聚合进度；新增 `node.cancelBatch`（中止当前 + 跳过剩余）。
- 新组件 `NodeOpProgressModal.vue`：批量队列（第 N/M + 每包状态）、终端式实时日志（自动滚动/暂停/复制）、**永不自动关闭**、Close 始终可用、运行中可取消；关闭仅隐藏，banner 可重开。
- `NodesView`/`MarketView`：删除全部自动关闭 watch 与失败显式关闭；批量入口打开弹框；单个更新/安装同语义。ComfyUI 本体更新保留原语义（`ComfyUpdateProgressModal` 不变）。
- 契约测试 `v019NodeOpsContracts.test.ts` 锁死「永不自动关」。

### WP4 启动参数调优（完成）
- 新增 `src/shared/launchArgs.ts`：`renderLaunchProfile()`（互斥组单选→规范 argv）、`validateLaunchArgs()`（显存/缓存/注意力/精度/upcast 互斥、数值域）、**参数目录 `CATALOG` + `warnLaunchArgs()`**（未知参数与“仅新版本支持”参数只警告不阻断；不虚构精确 minVersion 号，警告文案说明处置方式）。
- `ComfyInstanceConfig.launchProfile?` 结构化字段（25 项，向后兼容）；`save()` 归一化剥离默认值；`buildArgs` 渲染顺序：main.py → port → listen（模板自带 --listen 时去重）→ 模板 → profile → **自动显式传 `--extra-model-paths-config`（检测到实例根下的 yaml 且未声明时）** → **默认追加 `--disable-auto-launch`（用户声明 `--auto-launch`/`--disable-auto-launch` 时跳过）** → extraArgs。
- `start()` 在 spawn 前校验，冲突抛 `LAUNCH_ARGS_INVALID`；警告写入实例日志（不阻断）；`previewLaunch` 返回 `validationErrors + validationWarnings`。
- 新组件 `LaunchProfileEditor.vue`（8 组折叠 + 实时参数预览 + 冲突提示 + 警告提示），接入**实例创建/编辑弹窗 + InstanceDetailView 详情页「启动参数调优」面板**（保存 + 重启按钮 + 重启生效提示）；启动命令预览弹窗同步显示冲突与警告。
- 预设：保留全部旧模板（兼容旧 ComfyUI），**新增 `vram-save`（预留 1GB + 快速磁盘，desc 注明需较新版本）与 `cache-none`（省内存）**；`lan` 重复 `--listen` 由渲染端去重。
- 测试：`launchArgs.test.ts`（渲染矩阵 + 10 类冲突 + 数值 + 未知/新版参数警告）；instanceService（profile 渲染、去重、校验拒绝、归一化、**spawn argv/cwd 精确断言**、extra_model_paths 自动传参与防重复、未知参数警告不阻断）。

### WP5 顺手项（完成）
- 产物扫描深度可配：`AppSettings.outputScanDepth`（默认 4，范围 2-10）+ 设置页输入 + `walk()` 使用。
- e2e 冒烟改起真实入口 `out/main/bootstrap.cjs`。
- `shell.reveal` 路径白名单（userData/工作流库/实例根/output/workflows/modelScanRoots）。

### 补充收口（二次对账后）
- WP1：新增 `pruneDeadOutputThumbRows()`（启动时清理 thumb 与源文件双缺失的 DB 行；源仍在的行由 list 懒愈合）。
- WP3：批量下进度流改为**同 runId 就地重置步骤**（`resetOpSteps`），registry 更新调用 `install({reuseStream:true})`——整个批次的终端日志连续、不被中途 runId 切换清空；卸载也接入统一弹框语义（NodesView 打开 op 弹框）。
- WP5/其他：`shell.reveal` 白名单、扫描深度（前述）。

### 独立审计收口（三次对账后）
- **e2e 硬伤修复**：此前常量指向 `bootstrap.cjs` 但 spawn 仍是 `out/main/index.js`；现已真正启动 bootstrap，契约测试改为断言 spawn 目标（双重空转消除）。
- `updateAll` 前置检查异常 → 发射 `batch-error` 并 rethrow；`checkOnePack` 意外崩溃 → 兜底 `check-failed` 行（任何包不丢结果行）。
- op-progress 快照裁剪 step 日志（增量行走 op-log，不再重发整段缓冲）；移除死代码（`resetNodeOpState`、`RegistryIndexRow`、`void runStreaming`、`nodes.batchSummary` 键）。
- 校验器补 `--cuda-malloc` 互斥；警告补重复 `--listen`；启动时对路径型参数做存在性告警；详情页命令面板补 validationErrors 展示。
- 新增测试：缓存迁移（3 例：迁移/不覆盖新数据/无旧目录）、git 流式百分比与 op-log 与快照裁剪、pip 分数推进、reuseStream 连续、batch-error、单包崩溃兜底、重复 listen 警告、cuda 冲突、死链清理幂等、路径告警；`launchArgs.ts` 纳入覆盖率统计。
- 文档对账：README 文件/用例数、本文件 25 项字段、release body 测试数。

### 交叉审查收口（四次对账后）
- **取消彻底贯通**：registry→git 递归传输继承 signal（此前会被当作 git 失败回落 zip 并"成功"）；ensurePip/installRequirements 全程透传 AbortError；tag 固定安装发布前检查 abort，杜绝"取消后留下无记录幽灵包"。
- **批次排他窗口全覆盖**：updateAll 先占批次槽再跑检查阶段（单操作无法在检查期插入并被误杀）；uninstall 纳入 busy 槽；cancelOp 不再提前删控制器（中止→回滚窗口仍算忙）。
- **渲染层按实例隔离补全**：批量队列也按实例分桶（切走再切回不丢队列/终态）；取消目标改为 kind-aware 的流属主（comfy/repair 占槽时不再取消错实例）；MarketView 引入 selectNodeOpInstance；op-log 先于 progress 到达时自建桶；取消不再显示 100%/失败。
- **安全与校验修正**：`normalizePathEverySegment` 只把"纯点/空格段"视为父跳（`a..b.png` 这类合法名不再被拒）；`resolveInsideAnyRoot` 改用 resolve（保留 UNC、折叠真实跳转）；`output.reveal` 复用同一 allow-list；数值校验放宽到上游类型（preview-size≥1、cache-lru≥0、reserve-vram≤4096）；重复出现位置的数值校验。
- **可见性**：批量汇总单列"检查失败 N 个包"；验证错误统一走共享 i18n 映射（不再显示 raw code）。
- 新增行为测试：按实例流隔离（onIpc 模拟三实例交叉）、每出现位置数值校验、`a..b` 路径放行与真实跳转拦截、pip 阶段取消、updateAll 单操作互斥、单包崩溃定位、同名包双行等。

### 五次对账收口（重建验证 + 交叉复检）
- **重建保真验证**：误截断区域与 HEAD 逐字 diff 一致；`update/gitRunStreaming/gitPullOrMerge/updateInner` 与删除前构建快照语义零差异；方法清单 45/45 无缺无重。
- **安全回归修复**：`resolveInsideAnyRoot` 恢复 `hasParentHop` 前置（Windows `.. `/`... ` 尾随点空格变体不再绕过白名单）；`workflow.exportZip`/`output.exportZip` 两处词法前缀检查迁移到同一解析器。
- **取消与中止补全**：uninstall 可取消（removePipDeps 全程 signal，AbortError 透传）；zip 解压后补 abort 检查（不再"取消仍成功"）；`gitPullOrMerge` fallback `rev-parse` 带 signal；`runStreaming` timeout 分支补 cleanup。
- **批次检查阶段可取消**：新增 `checking` 相位（检查期间即可取消/显示"正在检查可用更新"）；空批次/已取消不再写快照；`check-progress` 事件携带 instanceId。
- **渲染层再收口**：install/update 横幅按实例分桶（15 个主进程发射点补 instanceId）；模态显示 strict kind 门控（comfy/repair 流不再串入节点弹框）；mode 由批次状态推导（重挂载后批量面板/取消分支不失效）；取消批次不再显示绿色成功条；单包新 run 清该实例日志；MarketView OP_BUSY 关闭+横幅重开+实例切换竞态守卫；OutputView 灯箱 prev/next 重置失败标志；`a..b` 文件名全链路放行（media/zip/reveal 语义一致）。
- 新增/更新测试：`.. ` 绕过拦截、`a..b` 放行、导出目录守卫、checking 相位事件序列、同 key 缩略图过期重生、三实例并发流隔离、取消目标实例化断言。

### 与原计划的差异（最终）
- **minComfyVersion 精确版本号不落表**：ComfyUI CLI 随版本漂移且无法在离线环境可靠钉版本，改为“已知参数目录 + recent 标记”的警告机制（未知/新版参数只警告不阻断），避免虚构版本号误导。
- 旧 `LAUNCH_TEMPLATES` 全保留并新增两个现代模板（而非替换 lowvram），保证旧版本 ComfyUI 可用。
- **进度阶段权重**按实现定为 download 15 / clone 25 / unpack 15 / requirements 35 / verify 5 / done 5（设计章曾写 30/50/10/10）；pip 进度采用“行数+关键标记”启发式（设计章写 `(i/n)` 解析，pip/uv 实际输出无稳定 i/n）。
- `launchProfile` 实际 25 个字段（设计章写 21 项）。
- 硬件感知推荐 profile（P1 可选）未纳入本次。
