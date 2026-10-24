# 0.1.18 全量功能回归 Review（2026-10-24）

> 结论：0.1.18 的 105 个未提交变更里发现 **8 个 P1 / 1 个 P0 / 约 30 个 P2**。
> 本轮已修 P0 + 全部 P1 + 大部分 P2，剩余项列在文末，下一轮继续。修复后门禁：
> 121 文件 / 1,719 用例全绿，覆盖率 84.86 / 75.96 / 85.94 / 87.17，ratchet 56 文件，
> test:behavior 97.6%，typecheck×3 / eslint / i18n / 硬编码 / version / build / e2e 全绿。
> 方法：6 路只读评审（主进程核心、实例/内容服务、数据/安全、IPC/契约、渲染层基建、视图/工具链）
> + 全量门禁复跑；每条发现都经二次读码确认后才修。

## 一、评审基线（修复前）

- `npx vitest run`：118 文件 / 1,701 用例全绿
- 覆盖率 84.69 / 75.99 / 85.87 / 86.95，ratchet 54 文件通过
- typecheck×3、eslint、i18n、硬编码、version、build、e2e：全部 exit 0

门禁全绿并不代表功能正确——下面的缺陷全部逃过了现有测试。

## 二、P0 / P1（本轮全部修复）

| 级别 | 位置 | 缺陷 | 修复 |
| --- | --- | --- | --- |
| P0 | `updater.ts:streamBodyToFile` | 下载失败时先 `destroy()`，`finally` 仍 `await file.end(cb)`；destroyed 流的回调永不触发 → 更新永久卡 running | 仅在 `!file.destroyed` 时 end，并监听 error；新增“body stream 中途报错必须收敛”回归测试 |
| P1 | `instance.ts:1823` | `Promise.race([prefix, Promise.resolve(exitCode!==null)])` 第二臂已 resolve，1.5s 等待是死代码 → 杀成功仍返回 exited:false，更新/回滚被拒 | 改为 kill 后先查 exitCode，再 `await prefix`；新增延迟 exit 回归测试 |
| P1 | `instance.ts:killAllForQuit` | 托盘 Quit 已 kill，quit 钩子再调一次会把 `quitting` 覆盖成已完成 Promise → 不等待进程树 | 仅当本轮有 tree 可杀时才替换 quitting |
| P1 | `env.ts` cancelRepair | 取消只到 runStreaming；运行时下载 / venv 创建阶段取消无效 | cancelRepair 同时 `bootstrapService.cancelAll()`；safeExec 支持 AbortSignal；各阶段 throwIfAborted |
| P1 | `nodePack.ts:detectCustomNodesRoot` | 显式实例解析失败时回退 `$COMFYUI_PATH` → 装/删/恢复到另一个 ComfyUI | 显式目标解析失败即返回 ''；仅无参调用保留 env 回退 |
| P1 | `backup.ts:516` | 工作流文件恢复目标 = `join(任意受信根, basename)` → 可覆盖 `<ComfyUI>/main.py`；且丢子目录 | 只允许 workflow 库 / `<instance>/user/default/workflows`，保留相对层级，冲突加 id 后缀 |
| P1 | `security.ts` proxy 校验 | `proxy.protocol` 未校验，原样拼进 Chromium proxyRules → 代理静默失效/被注入 | 枚举 http/https/socks5；启用时必须 host；applyProxy 统一归一化 |
| P1 | 渲染层四处 | 通知未读跨会话错乱（只持久化 readSeq）；命令面板切换实例不清 remote；App 选择器恢复 instances[0] 回退；NodesView 失败仍显示空库 | 通知 seq+items 一起持久化；切换清 remote；去掉回退；loadError 写入并渲染 |
| P1 | `settings.importConfig` | 保存了代理/语言/开机自启但从不应用 → UI 显示已开启、实际直连 | 导入后 syncProxyFromSettings + setLaunchOnBoot + refreshTray |

## 三、P2（本轮已修）

- 安全性：`aria2Path` 必须绝对路径且存在；备份恢复剥离 `allowUnverifiedRuntime`；恢复 remote 校验 URL 且不覆盖本机锁定的 key；恢复 instance 校验 port/listen；`model.parseExtraPaths` 补读路径门禁；`market.install` 改用 `requireLocalTarget`；空白实例 id 不再伪造 UUID。
- 数据/状态：更新成功先清 journal 再删备份；未动树的失败清 journal+备份；journal 绑定 instanceId/comfyDir 且运行中禁止回滚；cancel 在 verify 后仍生效；batch 400ms 合并写在退出前 flush；db 写失败自动重排重试；无 sidecar 的 Windows 运行时内置 SHA256 钉（uv/python 已与官方清单核对，MinGit 为构建时计算）。
- 功能：恢复中心 duplicate 行用 POSIX `.disabled/` 前缀（Windows 才能清理）；registry 取消后 worker 不再吐 progress（幽灵任务）；ops init 失败可重试；外部 cancel 记为 cancelled；monitor 失败保留上次真实数据、GPU 瞬时失败不缓存空值；long-ops.log 纳入轮转；`requireRunningInstance` 不再回退 instances[0]；导出脚本取消不再弹红错；市场页加 TargetBanner + 本地目标守卫；依赖检查不再把“没检查”显示成全绿；备份预览防串台；实例日志按时间戳增量合并。
- 工具链：`check-version` 在 release 打包后以 `CHECK_RELEASE_META=1` 校验 latest.yml；release 说明不再拼错文件名；coverage ratchet 基线缺失直接失败；`test:behavior --fail` 接入 CI；ListState/IndeterminateBar 纳入覆盖率统计；`useFeedback`（无人引用且 danger 无效）删除；zh `proTip` 翻译。

## 四、第二轮修复（2026-10-24 晚，已闭环）

| 位置 | 问题 | 建议 |
| --- | --- | --- |
| `backup.ts` restore | ✅ 已修 | 应用前创建 `pre-restore` 快照（失败即中止）；捕获 settings/五张列表/文件字节，任一步失败整体回滚；新增 4 条回滚测试 |
| `processTree.ts` POSIX | ✅ 已修 | SIGKILL 后轮询 `kill(pid,0)`/exit/超时（默认 3s）等待真实退出；grace 内每 100ms 补杀新生子孙；未做进程组（需改所有 spawn 点，风险大于收益，文档记录） |
| `index.ts` | ✅ 已修 | autoStart 先 await 孤儿 sweep；`before-quit` 始终 preventDefault，二次 quit 只等待，清理完成后 `app.exit(0)` 保留 flush |
| `p1p2.ts` retryFailed | ✅ 已修 | plan 下按 `runCount - i` 计算本轮剩余，不再把历史尝试计入失败 |
| `updater.ts` cancel | ✅ 已修 | 晚到取消（verify 后）不进入回滚路径，日志记录并以 done 收尾 |
| `useComfyUpdate` | ✅ 已修 | 新增独立 `nodeOpSnapshot`，槽位被占时节点弹窗仍显示步骤/日志/取消；有 composable 测试 |
| Windows 真机 | ⏳ 外部 | 需爸爸在 Windows 上执行安装/升级/停止/13GB 产物页清单 |
| `check-version` | ✅ 已完成 | release.yml 打包后以 `CHECK_RELEASE_META=1` 校验 latest.yml |

**第二轮门禁：** 121 文件 / 1,725 用例全绿；覆盖率 85.02 / 75.93 / 86.08 / 87.33；ratchet 56 文件；typecheck×3、eslint、i18n、硬编码、version、build、e2e 全部 exit 0。
