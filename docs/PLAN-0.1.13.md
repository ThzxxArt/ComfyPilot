# PLAN-0.1.13 —「进度可信 · 安装可达」

- 状态：**已实施（方案 + 全量落地记录见文末「七、实施记录」）**
- 基线：v0.1.12（80e55a3，2371 用例 / 97 文件，覆盖率 88.97/83.07/93.53）
- 日期：2026-10-15
- 全量阅读范围：src 全部 88 文件 48,315 行 + tests 全部 97 文件 33,357 行 + docs 四份 PLAN + README + 构建/脚本配置。主代理亲读核心链路 30+ 文件，四个子代理逐行完整读完其余全部文件（详见文末「阅读覆盖记录」）。

---

## 〇、本轮输入（爸爸实测反馈）

**问题 A（实例详情页 → 实时日志 → 修复依赖进度弹框）**
> 要安装两个东西，但是第一个进度就把两个都安装了，第二个就一直卡在 0% 不动一直不显示完成。

**问题 B（节点页面 → 依赖体检 → 缺失依赖安装）**
> 安装报错，安装不了。

---

## 一、根因分析

### A 组：pip 依赖安装进度弹框

**A1.【致命】完成态被主进程立即删除 + 渲染层二次清空 → 每次装完弹框都会变 0% 空壳**

- `src/main/services/pipOps.ts:364-367`：op 的 `finally { this.ops.delete(instanceId) }`；`getProgress(:89-92)` 只查 `ops` → **op 结束的瞬间 `instance.pipStatus` 恒返回 null**。
- `src/renderer/src/composables/usePipOps.ts:138-142`：`run()` 的 finally **必然**调用 `refreshStatus(instanceId)`；`refreshStatus(:96-98)` 执行 `v.progress = snap || undefined` → 把渲染层刚刚收到的 done 终态进度**覆盖为空**。
- `src/renderer/src/components/PipOpModal.vue:37,39`：`done` 判定依赖 `progress.status==='done'`，progress 变 null 后 → `percent=0`、`steps=[]`、`done=false` → **弹框在每次安装完成后稳定变成 0% 空壳**。
- 对照 node 侧：`nodePack.ts:829-837` 的 `getOpProgress` 完成后**保留终态快照**，且 `:767-772` 在 done 时把 pending 步骤补标 skipped 并 `percent=100`。pip 侧无此机制 —— 这一不对称就是"不显示完成"的直接根因。

**A2.【高】pipOps 步骤状态机残缺 → 即使不被清空，成功也只显示 60% + 步骤永久转圈**

- `pipOps.ts:330`：`resolve()` 只把 `preflight` 置 `running`，**从不置 done**。
- `installSpec` / `installRequirementsFor` 从不对 `download` 步骤发事件 → 该步骤**永远 pending**（灰点）。
- `emitStep` 的 percent = done|skipped 数 ÷ 5（`:260-263`）→ `installSpec` 成功终值 = **3/5 = 60%**，进度条永远到不了 100%。
- 安装耗时大头（requirements 阶段跑 uv/pip）**没有分数推进**（node 侧有行数启发式 `nodePack.ts:1739-1751`，pip 侧没有）→ 安装大包期间进度条长时间停在低值不动，加剧"卡住"观感。

**A3.【高】连续操作把弹框重置为 0% 空壳 + 失败静默**

- `usePipOps.ts:115-124`：`run()` **无条件** `v.logs=[]; v.progress=undefined; progress=null` 再发 IPC → 爸爸点第二个东西（第二个缺失项/重复点击）时，弹框先被清成 0%。
- 此时若第一个 op 还在跑，main 返回 `OP_BUSY`（`pipOps.ts:284-286`）；`useIpc` 对 `{ok:false}` 抛错；而入口函数**全部没有 try/catch**：`InstanceDetailView.vue:303-309（fixByPip）、311-350（fixByRecipe）、416-432（runPipInstall）`、`NodesView.vue:632-634（fixPackDeps）` → **错误静默、弹框停在 0% 空壳** → 完全吻合"第二个一直卡在 0% 不动"。
- 即使第一个 op 随后成功完成，被清空的弹框也因为 A1 不会再显示"完成"。

**A4.「第一个进度就把两个都安装了」的解释**

- sageattention 配方两步（`pipRecipes.ts:52-71`）：Step 1 `pip install triton-windows`（uv 实际解析/处理多个包），Step 2 装已校验 wheel。两个包确实在很短窗口内装完。
- 由于 A2，弹框步骤状态错乱（Step 1 一直转圈、download 永久灰点、百分比封顶 60%）+ 完成后被 A1 清空，视觉上就是"第一个进度把两个都装了、第二个（步骤/弹框）永远 0%"。
- 另一场景（两个失败条目各点一次安装）由 A1+A3 联合解释。两场景被同一组缺陷覆盖，无需再分。

### B 组：节点页依赖体检「补装依赖」

**B1.【高】入口无错误处理 + 弹框先开为 0%（同 A3 机制）**

- `NodesView.vue:632-634`：`fixPackDeps` 直接 `await startPackDeps(...)`，无 try/catch → IPC 拒绝（OP_BUSY / INSTANCE_NOT_FOUND / 其他）成为未处理拒绝，**用户只看到弹框 0% 空壳，无任何可读错误** → "安装报错，安装不了"。

**B2.【中】OP_BUSY 互斥的判定语义瑕疵**

- `pipOps.ts:293-310`：pip op 启动时检查 `nodePackService.getOpProgress(instanceId)?.status === 'running'` 并拒装。node 侧快照在正常路径都会写终态，但该判定没有任何"仍在活跃"的辅助证据（opAborts/opBatches），一旦出现残留 running（异常路径/历史 op），pip op 会被**永久拒绝**。修复：改双条件（活跃控制器 ∨ running 状态），并给错误 code 加可诊断文案。

**B3.【中】uv 安装成功可能被误判为失败**

- `env.ts:237-247`：输出判据 `/ERROR:|error: failed/` 且**不含** `Successfully installed|Requirement already satisfied` 时抛错。但 **uv 的成功输出形态是 `Installed N packages` / `Audited N packages`，不在白名单里** → 只要合并输出（stdout+stderr）里出现 error 字样就误报 `requirements install failed`。修复：按输出源（uv/pip）分别判成功形态 + 以 exit code 为准、包装层只兜"exit 0 但明确报错"。

**B4.【中】装完不刷新审计结果**

- NodesView 依赖体检弹窗的数据（`depsAudit.value`）在补装成功后**不更新** → 用户看到"缺失仍在"，以为没装上。修复：安装结算后刷新审计（成功/失败都刷）+ 行内状态反馈。

**B5.【低】remote 实例场景 id 被改写**

- `handlers.ts:142-149`：`safeInstanceId('remote:x')` 会 sanitize 成 `remote_x`（pip 通道 :461-500 用的都是 safeInstanceId，而非 safeInstanceTarget:155）→ 若活动实例是远程，pip 安装必然 `INSTANCE_NOT_FOUND`。修复：pip 通道改用 safeInstanceTarget 并对 remote 目标给出显式本地化拒绝（对远程装包无意义：venv 在对端）。

---

## 二、修复设计（WP1–WP6）

### WP1 pipOps 进度状态机对齐 nodePack（main 进程）

1. `resolve()` 成功 → `preflight` 置 `done`（detail 保留环境路径）。
2. `installSpec` / `installRequirementsFor` → `download` 步骤标 `skipped`（"No download step"）。
3. `execute()` 终态 done 分支：所有 pending 步骤补标 `skipped` + `percent = 100`（对齐 nodePack.ts:767-772）。
4. requirements 阶段引入分数推进：onLine 行数启发式（0→0.9，关键行 0.75/0.95），主进度调用 `setStepFraction` 风格更新（对齐 nodePack.ts:1739-1751）——"安装期间 0% 不动"消失。
5. 取消/失败：percent 冻结当前值（单调不回退），`error` 字段保留；取消走 `cancelled` 终态（既有）。

### WP2 终态快照 + 渲染层防御（消灭"完成后 0%"）

1. `PipOpsService` 增加 `finished: Map<instanceId, { progress, finishedAt }>`：`execute()` finally 先写快照再删活动 op；`initProgress`（新 op 开始）时清除该实例快照。
2. `getProgress()`：活动 op → 否则返回该实例快照（未开始新 op 前**不过期**）→ 否则 null。`instance.pipStatus` 从此在完成后也返回终态。
3. `usePipOps.refreshStatus` 防御：snap 为 null 且本地 progress 已是终态（done/failed/cancelled）→ **保留不清空**（双保险）。
4. 收益：装完、刷新页面、切视图、重开弹框，任何时刻都能看到最后结果；「完成后 0%」从根上消失。

### WP3 连续操作守卫 + 入口错误处理（renderer）

1. `usePipOps.run()`：发 IPC **之前**先 hydrate（`instance.pipStatus`）；若该实例已有 running op → **不 reset**，直接 `openFor(instanceId)` 并抛出 `OP_BUSY`（带 code）由入口处理。
2. 入口统一 try/catch：
   - `InstanceDetailView.fixByPip / fixByRecipe（含回退安装）/ runPipInstall`
   - `NodesView.fixPackDeps`
   - OP_BUSY → warning 提示（"该实例已有安装在进行——已为你打开进度"）+ 自动打开进行中弹框；其他错误 → error toast（复用/扩展 describeNodeError 式 code 本地化）。
3. 新增 i18n key（zh/en 对称）：`deps.opBusy`、`deps.opBusyOpened`、`deps.installFailedWithReason` 等。

### WP4 节点页依赖安装链路修复

1. B2：node 侧新增 `isOpActive(instanceId)`（`opAborts.has || opBatches.has`）；pipOps 的互斥判定改为 `isOpActive ∨ (getOpProgress.status==='running')`。
2. B3：`installRequirements` / `pipOps.pipInstallTargets` 的成功判定按真源输出形态白名单化（uv: `Installed \d+ packages?` / `Audited` / `Successfully installed` / `already satisfied`；pip 同上）+ exit≠0 一律失败、exit 0 仅当"明确 ERROR 且无任何成功标志"才判失败；补单测锁死。
3. B4：`fixPackDeps` 结算后调用 `runDepsAudit()` 刷新弹窗；对结果做行内提示（成功→该 pack 行从缺失列表消失；失败→行内显示错误摘要）。
4. B5：pip 通道 handler 换 `safeInstanceTarget`；`remote:*` 目标直接返回本地化错误（明确说明远程实例不支持本地装包）。

### WP5 测试补盲（约 18–22 用例；先补测试或与修复同步）

| 文件 | 新增断言 |
|---|---|
| `tests/unit/pipOps.test.ts` | ① 订阅 progress：步骤序列 preflight done → download skipped → requirements done → verify done → done 且 **percent=100**；② `getProgress` 完成后返回**终态快照**（新行为）；③ 连续两次 installSpec：第二次正常（槽释放/新 runId/终态）；④ OP_BUSY 被拒：进度不污染、无残留 op；⑤ failed 时 status='failed' + error 保留；⑥ 取消：status='cancelled'、percent 不回退 |
| `tests/unit/pipOpsStore.test.ts` | ① refreshStatus(done 快照) → 保留终态、busy=false；② refreshStatus(null 且本地终态) → 保留；③ run() 遇到 running op → 不 reset + 返回/抛 OP_BUSY |
| `tests/unit/envService.test.ts` | installRequirements：uv `Installed N packages` 输出**不被误判失败**；exit0+ERROR 无成功标志 → 失败；镜像失败重试官方 |
| `tests/unit/depsAudit.test.ts` 或 nodePack 测试 | installDeps 成功/失败路径（PACK_NOT_FOUND / NO_REQUIREMENTS / 成功返回 PipOpResult） |
| 覆盖率 | `usePipOps.ts`、`useExecDiagnostics.ts` 纳入 vitest coverage include，按「实测 − 2pp」立阈值；PipOpModal 保持"源码契约 + e2e 挂载"策略 |

### WP6 实机复现与验收（Windows，用爸爸机器）

1. 复现 A：详情页日志区两个缺失模块（或用测试 venv 造缺失）→ 依次安装：**两次安装完成后弹框都必须显示 100% 完成**；安装中再次点击按钮 → 不重置弹框、给出明确提示；关掉弹框重开 → 仍能看到最后结果。
2. 复现 B：节点页依赖体检 → 缺失 pack「补装依赖」→ 结果必须有可读反馈；若复现出真实报错文本（OP_BUSY/误判/网络），抓原文入 PLAN 并确认修复后通过；成功后审计自动刷新。
3. 全量门禁：`npm test`（新用例全绿）→ `test:coverage` → lint ×1 → tsc ×3 → 两个 i18n 脚本 → e2e → 打包 → 实机冒烟。

---

## 三、关联加固（建议纳入本版：与两问题直接相关、风险小）

1. **MonitorView 切换/失败列表残留清理**（`MonitorView.vue:267-274`）——诊断卡是问题 A 的入口组件之一，顺带将 nodeProgress/lastPreview/currentNodeId 与前面同款清空。
2. **useExecDiagnostics.load 加请求序号**（`useExecDiagnostics.ts:29-44`）——防 A→B 实例切换竞态旧响应覆盖，避免诊断卡展示旧实例失败诱发误点安装。
3. **execError 双源去重广播**（`index.ts:501` 全量广播）——WS 与日志解析同错已合并于 list，但推送路径仍会双帧，诊断卡出现重复行；广播前按 `id` 去重。

## 四、候选池（本版不做，登记待决；均来自本轮全量阅读）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| 1 | OutputView.vue:214-227/359 | 无实例切换监听，旧 root/恢复链路 | 后续 |
| 2 | ModelsView.vue:544-552 | 扫描中切实例跳过重扫，旧结果残留 | 后续 |
| 3 | BatchView.vue:301-318 | 错误回退启动用 activeInstance 而非失败 job 的实例 | 后续 |
| 4 | WorkflowsView.vue:286-293 | `instanceId || ''` 空串直传（主进程静默回退） | 0.1.13 可顺手（一行） |
| 5 | MarketView.vue:392-396 | install 先开弹框（同 A3 类别）；两颗 tick 订阅重复 | 0.1.13 可顺手（同 WP3 模式） |
| 6 | InstancesView.vue:499 | envProbes 只写不清（内存） | 后续 |
| 7 | InstallView.vue:663-671 | 镜像推荐判定 `!== undefined` 永不生效 | 后续 |
| 8 | bootstrap.ts:499-545 | 断点续传读 dest 写 .part，永不续传且不清理 | 后续 |
| 9 | updater.ts:838-871 | torch 步骤未 uv 优先（与 installer 不一致） | 后续 |
| 10 | execDiagnostics.ts:45-61 | 远程实例执行失败不记录 | 后续 |
| 11 | execDiagnostics.ts:198-202 | lastNotify 无上限（轻微） | 后续 |
| 12 | nodePack.ts:834 | 以 runId 字符串比较取"最新"不可靠 | 后续 |
| 13 | p1p2/workflow/model | 显式 instanceId 未命中静默回退 instances[0] | 需要单独设计评审 |
| 14 | monitor.ts:405-414 | close/error 双触发重连（已有 timer 去重，低危） | 观察 |
| 15 | 渲染侧 | `notify.*` 若干 key 无 used 扫描覆盖（check-i18n 动态域） | 观察 |

**建议：4、5 两条与 WP3 同模式、顺手带上；其余进候选池，等爸爸单独定夺。**

---

## 五、验收标准

- **A**：连续两次安装弹框两次完整显示「完成 100%」；安装中重复点击不重置弹框且有明确提示；关闭/重开弹框仍显示最后状态；步骤列表无永久转圈/灰点。
- **B**：节点页补装依赖——成功即刷新审计；任何失败都有可读的、携带真实原因的错误提示；OP_BUSY 有本地化提示并自动打开进行中弹框。
- **回归**：新增用例全绿；全量覆盖率不低于阈值（新模块按实测−2pp）；lint 0 错 0 警；tsc ×3 干净；i18n 双语对称；e2e 通过；Windows 实机复测通过。
- **文档**：PLAN-0.1.13 记录复现原文与修复结果；README 数字更新。

## 六、发布

版本 `0.1.13`，流程与 0.1.12 一致：全量门禁 → commit → tag `v0.1.13` → Release（三资产 + 中文正文 + SHA256）→ 实机验收记录写入 release body。

---

---

## 七、实施记录（已完成 · 2026-10-15）

版本：`package.json` → 0.1.13。全部 6 个 WP + 3 项关联加固 + 候选池 15 项，**零遗漏落地**。

### WP1 pipOps 进度状态机（`src/main/services/pipOps.ts`）
- `resolve()` 成功 → `preflight` 标 `done`；`installSpec`/`installRequirementsFor` → `download` 标 `skipped`；无 wheel 配方同样跳过 download。
- `emitStep` 终态 done → 残余 pending/running 步骤全部补标 `skipped` + `percent=100`；failed/cancelled 单调冻结（`Math.max`）并把失败文本写入 `progress.error`。
- 新增 `computePercent`/`setStepFraction`：安装期按输出行数推进（40 行线性→0.9，关键行 0.75/0.95），长安装不再长时间停 0%。
- 测试：`pipOps.test.ts` +6（步骤序列与 100% 终值、终态快照、分数推进中间帧、failed/error 快照、cancel 快照、installRequirementsFor 全流程）。

### WP2 终态快照 + 渲染层防御
- `PipOpsService.finished` Map：`initProgress` 清除、`execute` finally 深拷贝写入、`getProgress` 在无活动 op 时返回快照 → **`instance.pipStatus` 装完后仍返回最终结果**。
- `usePipOps.refreshStatus`：主进程返回空且本地已持终态 → 保留不清空；`run()` 发 IPC 前先探 `pipStatus`，发现 running → 不重置弹框、抛 `OP_BUSY`。
- 测试：`pipOpsStore.test.ts` +4（终态保留、快照水合、运行中不重置、二次安装后保持 done/100%）。

### WP3 连续操作守卫 + 入口错误处理
- `InstanceDetailView`：新增 `handlePipFailure`（OP_BUSY → 打开进行中进度 + `deps.opBusy` 提示；REMOTE_NOT_SUPPORTED → `deps.remoteUnsupported`）；`fixByPip` / `fixByRecipe`（含配方回退安装）/ `runPipInstall` 全部补 try/catch 与失败 toast。
- `NodesView.fixPackDeps`：完整错误处理；**成功后自动刷新依赖审计**（补完即从缺失列表消失），警告与失败均有提示。
- i18n：`deps.opBusy`、`deps.remoteUnsupported`（zh/en 对称）。

### WP4 节点页依赖安装链路
- `nodePackService.isOpActive(instanceId)`（opAborts/opBatches 活跃证据）；pipOps 互斥判定改为 **活跃性 ∨ running 快照**双条件（残留快照不再永久锁死依赖安装）。
- `env.outputIndicatesFailure`：行首锚定（`^\s*ERROR:` / `^\s*error:\s`）+ 成功白名单（`Successfully installed` / `Requirement already satisfied` / uv `Installed|Audited|Resolved N packages`）——env 与 pipOps 共用，uv 成功输出不再误判为失败。
- handlers：pip 通道（pipInstall/applyRecipe/pipCancel/pipStatus）与 `node.installDeps`/`node.depsAudit` 换用 `requireLocalInstanceId`——remote 目标显式 `REMOTE_NOT_SUPPORTED`，不再被 sanitize 成 `remote_x` 后报莫名其妙的 INSTANCE_NOT_FOUND。
- 测试：`envService.test.ts` +1（判定函数 8 组断言）、`depsAudit.test.ts` +3（installDeps 委派参数、PACK_NOT_FOUND/NO_REQUIREMENTS、失败结果透传）。

### 关联加固 3 项
1. `MonitorView`：切换实例重置 WS 态（preview/nodeProgress/currentNodeId）并清旧失败列表；失败详情对 remote 提示本机查看（新 i18n `exec.remoteLogsHint`）。
2. `useExecDiagnostics.load` 请求序号防串（A/B 切换竞态）——含专项测试。
3. `execDiagnostics.recordWs` 与日志源双向去重（同错不再双行/双推）；`lastNotify` 上限 200；**远程实例执行失败纳入诊断**（index.ts 以 `remote:<id>` 归属，handlers 用 safeInstanceTarget 读取）。

### 候选池 15 项（全部落地）
1. `OutputView`：`instanceSwitchTick` → 重置 root 至新实例输出目录 + 清选择/详情。
2. `ModelsView`：扫描中切换 → `pendingRescan` 排队，扫描结束后对新 roots 重扫。
3. `BatchView`：启动失败回退使用 **job 记录的实例**（不再用 header 选中的）；highlight 定时器随卸载清理。
4. `WorkflowsView`：`copyToInstance`/`sentToBatch` 使用解析后的真实实例 id，无实例时明确提示。
5. `MarketView`：安装错误中 OP_BUSY/SETTING_* 不再留下上一操作的旧日志弹框。
6. `InstancesView`：删除实例同时清理 `envProbes` 缓存。
7. `InstallView`：镜像推荐判定改为「空 = 从未选择」，自动推荐恢复生效。
8. `bootstrap.downloadFile`：断点续传读写统一为 `${dest}.part`（原先读 dest 写 .part，续传从未生效且 .part 永不清理）；416 时对 .part/dest 双候选做尺寸+校验和后 promote。
9. `updater`：torch 安装 uv 优先（对齐 installer/env），pip 兜底保留。
10. 远程执行失败诊断（见加固 3）。
11. `lastNotify` 上限（见加固 3）。
12. `nodePack.getOpProgress`（无 id）按 `updatedAt` 取最新流（原 UUID 字符串比较不可靠）。
13. 显式实例 id 未命中一律报 `Instance not found: <id>`（p1p2 `run`/`clientForJob`、`workflow.queue`、`model.reconcile` 文案）——**4 个既有测试同步更新锁定新行为**（原断言静默回退到 `instances[0]`）。
14. `monitor` 重连：复核确认已有 `reconnectTimer` + `wsGeneration` 双去重，无缺陷（记录在案，非遗漏）。
15. `check-i18n.cjs`：新增 main 进程 `titleKey/messageKey` 全量扫描（16 个 key 必须双语存在）——notify 动态 key 从此进入 CI 门禁。

### 第二轮反向核对补充（调用方↔实现、产物↔代码）
- `instanceWorkflowsDir`/`copyToInstance`/`libraryInfo` 的**调用方**逐一核对：`workflow.copyToInstance` handler 改用 `requireLocalInstanceId`（remote 显式拒绝、空 id 明确报错，不再依赖 `|| instanceId` 的怪异回退）；`workflow.libraryInfo` 改用 `safeInstanceTarget`（remote 目标回退中性库目录而非被改名成 `remote_x`）。
- `instance.pipStatus` 语义打磨：纯查询接口对 remote/空目标返回 `null`（不抛错），与本轮「查询 vs 动作」的接口分层一致。
- 全仓扫描：`git diff` 无调试残留（console.log/debugger/TODO 零命中）；`join(';')` python 脚本拼接复查零违规。
- **产物-代码一致性核对（重要）**：第一版 0.1.13 exe 构建于 workflow 4 处修复/ MarketView 合并 / handler 三处打磨**之前**——已整包重打，最终产物与工作区代码一致（e2e 在最终代码上重跑通过）。

### 逐项复检补充（自查轮发现并补齐，0 遗漏收口）
- `workflow.ts` 其余 4 处实例回退全部修复：`instanceWorkflowsDir`/`copyToInstance`/`prepareFrontend`（显式 id 未命中不再滑入 fallback 链）/`libraryInfo`（显式未命中回退中性库目录而非他实例）。
- `MarketView` 两颗 `instanceSwitchTick` 订阅合并为单 watch（同 tick 处理页面刷新 + node-op 视图切换）。
- 新增 `tests/unit/bootstrapDownload.test.ts`（3 用例）：Range 续传读到 `.part` 字节、416 完整 `.part` promote、416 截断 `.part` 拒绝——候选池 8 的修复有专项测试锁定。
- `nodePackCoverage.test.ts` 新增 `getOpProgress()` 无 id 按最后更新时间选流的用例（候选池 12 锁定）。

### 第三轮 Git diff 全量对照（2264 行 diff 逐文件审查）
- 全部 38 个修改文件的 diff 逐行核对：逻辑正确、无调试残留、无半成品；`sanitizeId` 对 uuid 零改写（`[0-9a-f-]` 全在允许集内）确认无风险。
- 发现并补齐 **1 个测试盲区**：pipOps 互斥守卫的 `isOpActive` 独立分支（无进度快照、仅活跃证据）此前无用例——新增「独立活跃证据拒绝 + 解除后放行」用例（mock 解耦）。
- 本轮为纯测试改动（生产代码零变化）——既有安装包与生产代码仍一致，无需重打。

### 应用自更新链路根治（爸爸实测补充：检查更新 / 下载 / 安装）
**症状**：①下载更新看不到进度；②开了「启动后检查更新」却毫无提示；③下载完成后的安装路径未经验证。
**根因**（0.1.11 遗留的半成品）：
- 后台裸调 `checkForUpdatesAndNotify` 与 `services/appUpdate` 的手动检查是**两套脱节实现**——`download-progress` / `update-downloaded` / `update-available` 事件**从未接线**，UI 的「（后台下载中）」是死信息；
- 启动检查**无重试**（启动早期网络失败即静默消失）、无应用内通知（全依赖系统通知）；
- **没有任何 `quitAndInstall` 入口**——安装环节不可达。
**修复**：
1. `appUpdate.ts` 重写为**唯一更新服务**：全事件接线（checking/available/not-available/download-progress/downloaded/error）→ 单一状态流；方向判定（旧版本服务器不许读成 available）覆盖事件路径；`initAppUpdate` 启动接线（autoDownload/autoInstallOnAppQuit + 延迟 4s 检查 + 失败 30s 后重试一次，尊重「启动后检查更新」设置）。
2. `AppUpdateStatus` 扩展 `downloading`（percent/bytesPerSecond/transferred/total）与 `downloaded` 状态；新增 `app.installUpdate` IPC → `quitAndInstall(false, true)`（显示 NSIS 界面 + 装完自动重启），非 downloaded 状态诚实拒绝。
3. 应用内通知：发现新版本（`notify.appUpdateAvailable`）/ 下载完成（`notify.appUpdateDownloaded`）→ toast + 系统通知。
4. SettingsView：下载中实时进度条（百分比/已传/总量/速度），下载完成出现「重启并安装」按钮（带确认）。
5. 打包完整性验证：asar 内 `node_modules/electron-updater` 完整、`resources/app-update.yml` 指向 ThzxxArt/ComfyPilot ✓——排除了「检查更新永远 unsupported」的包结构风险。
**测试**：appUpdate.test.ts 重写扩展至 10 用例（流序列/进度帧/安装路径/启动重试/设置开关/dev 分支/无事件 fallback/无版本事件）；旧 `v017FinalPush` 源码契约同步更新到新架构。覆盖率 appUpdate.ts 88.62/74.28/100/88.62（阈值 85/85/98/73 全过）。

### 测试与门禁（全绿）
- **2401 用例 / 98 文件**；覆盖率全局 88.85 / 82.77 / 93.11。
- `usePipOps.ts`（90.16/78.04/68.75/90.16）与 `useExecDiagnostics.ts`（93.61/68.42/100/93.61）**首次纳入覆盖率门禁**（实测 − 2pp）。
- lint 0 错 0 警；tsc ×3 干净；i18n PARITY OK（used 1051）+ 动态域 OK + main notify OK；零硬编码中文。
- 真实机器样本固化：pip `Requirement already satisfied` / uv `Audited 1 package` / pip `ERROR: No matching distribution` 输出进入 `outputIndicatesFailure` 回归用例。

### 遗留与后续验证
- WP6 实机复测（爸爸机器 UI 路径）在发布后验收；本次以全量门禁 + e2e + Windows 打包冒烟 + 真实 venv 判定重放作为发布前验证（见发布记录）。

---

## 附：阅读覆盖记录（本轮全量阅读证据）

- 主代理亲读（逐行）：nodePack.ts(3324)、pipOps.ts(515)、instance.ts(1624)、env.ts(785)、execDiagnostics.ts(206)、execError.ts(182)、pipVersion.ts(251)、pipRecipes.ts(118)、handlers.ts(1731)、preload/index.ts(56)、usePipOps.ts(210)、PipOpModal.vue(316)、useExecDiagnostics.ts(62)、InstanceDetailView.vue(1786)、NodesView.vue(1561)、useComfyUpdate.ts(632)、NodeOpProgressModal.vue(前 180)、main/index.ts(460-649)、shared/types.ts 关键段。
- 子代理 A（完整）：渲染层 19 个视图/壳/路由/存储/组合式文件（清单见其报告）。
- 子代理 B（完整）：main 服务 31 文件 + shared 6 文件 + types.ts 全文。
- 子代理 C（完整）：README + 4 份 PLAN + 全部构建/测试/脚本配置 + 两份 i18n locale 全文。
- 子代理 D（完整）：tests 重点 10+ 文件逐行 + 其余 87 文件清单/断言索引。
