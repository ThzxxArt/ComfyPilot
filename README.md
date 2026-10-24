# ComfyPilot

> **ComfyUI 全能管理器** — 本机 ComfyUI 生产线的控制塔  
> TypeScript · Vue 3 · Electron 45 · Naive UI · MIT · v0.1.18

[![License: MIT](https://img.shields.io/badge/License-MIT-4f6ef7)](./LICENSE)

ComfyPilot **不替代** ComfyUI 节点工作台，而是管理它的整套生产资产与运行状态：实例、Python 环境、模型库、自定义节点、工作流、批量任务、产物、监控、诊断、备份与**零门槛一键装机**。

---

## 目录

- [功能总览](#功能总览)
- [零门槛装机](#零门槛装机)
- [界面与主题](#界面与主题)
- [快速开始](#快速开始)
- [功能详解](#功能详解)
- [设置项说明](#设置项说明)
- [数据与存储](#数据与存储)
- [安全设计](#安全设计)
- [工程结构](#工程结构)
- [开发与测试](#开发与测试)
- [打包发布](#打包发布)
- [设计原则](#设计原则)
- [与 ComfyUI 的关系](#与-comfyui-的关系)
- [Roadmap](#roadmap)
- [License](#license)

---

## 功能总览

| 模块                 | 能力                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **总览 Dashboard**   | 空态三步引导、启动器大卡（一键启动并打开 Frontend）、启动中阶段与日志、实例 / 模型 / 节点 / CPU·内存·显存一屏掌握                                                              |
| **一键装机 Install** | **无需预装 Python / Git**：自动下载便携运行时、zip 获取 ComfyUI、按 GPU 推荐 torch、镜像测速、细粒度进度、完成后一键启动 + 推荐基础模型                                        |
| **实例 Instances**   | 发现候选、启动并打开、就绪探测、端口冲突自愈、**启动参数调优面板（9 组结构化参数 + 冲突校验 + 实时预览 + 按显存推荐 + 存储目录重定向 output/input/temp/previews）**、**在线版本/能力探测（/system_stats + /features + 资产系统状态）**、启动命令预览与导出脚本、热编辑、置顶/搜索、批量启停、环境探测（**含 pip 状态与一键补 pip**）、诊断包（含 system-stats/features）、**检查/更新 ComfyUI 本体（备份-回滚 + 上游最新正式版语义）**、**启动自检（--quick-test-for-ci）**、**一键修复环境**、**运行失败诊断（结构化错误卡：节点/包/缺模块/一键安装）**、**前端包版本一键对齐（mismatch → 复装 required 版本）** |
| **模型库 Models**    | 多根扫描、safetensors 元数据、SHA256 去重、断点下载与校验、推荐模型包一键下载、移动/软链/改名、存储分析、真缩略图、**与运行中实例在线对账（可见性差异解释 + 一键加入扫描根）**、**多选批量删除 / 批量移动（部分失败诚实报告）** |
| **节点 Node Packs**  | Registry / Manager / Git 安装、依赖真实安装、启用禁用、锁定、冲突检测、冒烟导入、快照对齐、**全量检查更新（每包显式状态）**、**一键/批量顺序更新（批量实时进度、第 N/M、终端日志、可停止剩余）**、失败回滚上报、**启动加载报告（IMPORT FAILED 包可见 + 原因 + 启动自检 + 组织策略拒绝可见）**、**依赖体检（requirements.txt vs 已装包对账 + 单包补装）**、issue 一键修复出口（如 torch 固定版本解除） |
| **市场 Market**      | Comfy Registry 精选浏览与一键安装                                                                                                                                              |
| **工作流 Workflows** | **真·工作流库**：JSON / PNG 元数据解析（PNG 抽出 .json）、导入拷贝入库、**一键导入引擎默认工作流（ComfyUI v0.41+，探测式）**、来源徽章、标签/收藏/改名/删除、ZIP 导出、同步到实例、Frontend 打开、按实例排队 |
| **批跑 Batch**       | 从工作流库**多选**多工作流 × 次数；种子策略（随机/递增/固定）+ 尺寸/steps/cfg 矩阵；入队后跟踪真实出图；取消可撤队；产物关联批次                                               |
| **产物 Output**      | output 目录索引、真缩略图、**全类型覆盖（图像 / 视频 / 音频 / 3D 模型 / EXR 原始图——索引、筛选与交互降级）**、**视频首帧卡片 + 灯箱内嵌播放（mp4/webm；mkv/mov 优雅降级系统播放器）**、**音频灯箱内嵌播放**、时间/大小/名称排序 + 分页、收藏、多选导出 + **多选批量删除（文件/仅记录双态）**、PNG 参数还原、**还原为工作流真正入库**、批次/工作流回溯、**实例资产库只读增强（0.40 assets：job_id 溯源 / 标签 / EXR 预览）** |
| **监控 Monitor**     | CPU / 内存 / 磁盘 / GPU（显存真实采样）、队列、WebSocket 实时进度、**实时采样预览（两代预览帧解码）**、**节点级进度（progress_state）**、**作业列表（/api/jobs）**、**运行操作（清空待执行队列 / 中断当前任务 / 释放显存内存——本地与远程统一）**、**远程实例监控**（运行操作 + 批跑；节点/模型安装仅本地） |
| **诊断 Doctor**      | 一键体检（Python / **pip 可用性** / torch·CUDA / 端口 / 节点 / 路径 / 磁盘 / 网络）+ 可修复项（含 **ensurepip 一键补 pip**）                                                                                                   |
| **备份 Backup**      | 配置 / 实例 / 节点清单 / 模型清单快照，原子恢复                                                                                                                                |
| **远程 Remote**      | 局域网 / 云端 ComfyUI 实例注册、连通测试、在线状态                                                                                                                             |
| **内嵌 Frontend**    | WebContentsView 内嵌官方 ComfyUI 前端，可关并改用系统浏览器                                                                                                                    |
| **网络**             | HTTP / HTTPS / SOCKS5 代理、PyPI / Torch / GitHub / HF 镜像、测速自动推荐                                                                                                      |

---

## 零门槛装机

**0.1.3 核心目标：装完 ComfyPilot 这一个包，就能在应用内把 ComfyUI 装好、启动、出图——不需要自己提前安装 Python、Git、uv 或任何前置软件。**

**0.1.4 核心目标：装完之后管得住升级——实例 ComfyUI 可检查/更新/回滚，节点包可检查/一键/批量更新，环境可一键修复。**

### 自动准备的运行时（下载到 `userData/runtimes/`）

| 运行时               | 用途                                  | 何时拉取                |
| -------------------- | ------------------------------------- | ----------------------- |
| **uv**               | 快速 venv / pip，可自动提供 Python    | 系统无 Python 或勾选 uv |
| **便携 Python 3.12** | 隔离解释器（python-build-standalone） | 系统无 Python 3.10+     |
| **MinGit**           | 节点包 git 安装 / 可选 clone 模式     | 需要 git 能力时         |

所有运行时下载带 **SHA256 校验**（官方 checksum 或首次钉定）、断点续传、走应用代理；失败自动重试。

### 装机流水线

1. **准备运行时** — 自动下载 uv / 便携 Python（可选 MinGit）
2. **检测 GPU** — 识别 NVIDIA / AMD / Intel / Apple，人话推荐 torch 通道
3. **预检** — 磁盘按通道估算、路径可写；缺运行时可一键修复
4. **创建隔离 venv** — 与系统 Python 完全隔离
5. **获取 ComfyUI** — 默认 **zip 源码包（无需 Git）**，可选 git clone
6. **安装 torch + requirements** — 支持 PyPI/清华/阿里云/中科大镜像，测速自动推荐
7. **注册实例** — 自动选端口、可选启动
8. **推荐基础模型** — SD1.5 / SDXL / Flux 一键下载到实例 `models/`，装完即可出图

中断或失败可直接重跑；不会误删非 ComfyPilot 的目录。

### 网络与镜像

- **测速推荐**：进入装机页自动探测 PyPI / Torch / GitHub 镜像延迟，预选最快源
- **PyPI**：官方 / 清华 TUNA / 阿里云 / 中科大 USTC
- **Torch 轮子**：官方 / 上海交大 / 阿里云
- **GitHub**：官方 / ghproxy 前缀
- **HuggingFace**：可配 `hf-mirror.com` 等 endpoint
- **代理**：HTTP / HTTPS / SOCKS5，作用于下载、git/pip/uv 子进程与内嵌页

---

## 界面与主题

- 默认 **亮色现代风**：浅色背景、渐变强调色、微光玻璃卡片、大圆角
- 主色：`#4F6EF7 → #7C5CFC → #22D3EE`
- Naive UI 主题与设计 token 对齐（themeOverrides）
- **刻意不做深色 / 暗黑主题**
- 界面语言：简体中文 / English（完整 i18n，含装机向导与启动器）
- **0.1.8 视觉规范**：名称单行省略 + 悬停全文、描述两行截断、卡片跨行等高；列表首屏骨架屏、
  空数据与筛选无结果区分；小字号统一 ink 对比度；支持 `prefers-reduced-motion`

---

## 快速开始

### 最终用户（安装包）

| 项                    | 要求                                                                   |
| --------------------- | ---------------------------------------------------------------------- |
| 操作系统              | Windows 10+（发布与验证）；macOS / Linux 仅有构建配置，未验证          |
| 磁盘                  | ≥ 20GB 可用（含 torch 与推荐模型）                                     |
| GPU 驱动              | 使用 N 卡 GPU 加速需自行安装 NVIDIA 驱动（应用可检测并提示，无法代装） |
| VC++ Redistributable  | Windows 运行 Electron 需要；缺失时启动会提示                           |
| **Python / Git / uv** | **无需预装** — 一键装机自动下载便携运行时                              |

下载安装包后：打开应用 → 空态三步引导 →「全自动安装」→ 完成后「立即启动并打开 Frontend」→ 下载基础模型 → 出图。

**安装包与签名（0.1.18）：** 目前发布产物**未做代码签名**。首次运行 Windows 会弹 SmartScreen，选择“更多信息 → 仍要运行”即可；发布页同时附 `SHA256SUMS.txt`，可用 `Get-FileHash` 或 `sha256sum` 核对后再安装。tag 触发的 release 流水线（`.github/workflows/release.yml`）会生成草稿 Release，人工确认安装/卸载无 Application Error 后再发布。

### 开发环境

| 依赖    | 版本 |
| ------- | ---- |
| Node.js | ≥ 22（开发/构建；发布不要求用户安装） |
| npm     | ≥ 10 |

```bash
npm install
# 若 Electron 二进制未就绪：
node node_modules/electron/install.js

npm run dev          # 开发模式
npm run typecheck    # vue-tsc + tsc
npm run typecheck:test # 测试源码 tsc（CI 门禁）
npm run test         # 单元 + 集成（1725 tests）
npm run test:coverage
npm run lint         # ESLint（含 --fix）
npm run lint:check   # ESLint 只检查（CI 门禁）
npm run test:e2e     # Electron 启动冒烟（需先 build）
npm run test:all
```

---

## 功能详解

### 实例

- **发现**：扫描 Desktop / Portable / 源码目录、自定义根、`extra_model_paths.yaml` 相关路径
- **生命周期**：启动并打开 / 停止 / 重启 / 强杀（二次确认）；全部启动 / 全部停止
- **启动参数模板**：默认本地、高质量预览（taesd）、启用 Manager、完全离线、局域网共享、低显存、省显存·新版、省内存、CPU 模式
- **启动参数调优**（0.1.9）：显存/预览/缓存/注意力/精度/IO/基础目录/网络/杂项 9 组结构化选项，互斥组单选 + 冲突即时校验 + 变更后的参数实时预览；存储目录组可重定向 output/input/temp/previews（0.1.14）；未知/仅新版参数只警告不阻断；实例详情页与编辑弹窗双入口；自由参数框保留为逃生通道
- **extra_model_paths**：检测到实例根下 `extra_model_paths.yaml` 时启动自动显式加载（自定义 cwd 也不会丢模型路径）
- **默认不抢浏览器**：未显式声明时自动追加 `--disable-auto-launch`（ComfyPilot 负责打开窗口；显式 `--auto-launch` 时跳过）
- **端口**：占用检测、空闲建议、冲突时确认换端口并持久化；已运行的外部 ComfyUI 可采用（不误杀）
- **就绪探测**：轮询 `/system_stats`，就绪后才打开 Frontend
- **启动脚本**：预览命令、一键导出 `.bat` / `.sh`（平台安全转义）
- **环境探测**：解释器、Python / Torch / CUDA、venv 完整性
- **诊断包**：配置与日志摘要导出

### 模型库

- 分类：checkpoint / diffusion_models / unet / loras / vae / clip / text_encoders / controlnet / upscale_models / embeddings / other
- safetensors header 元数据（不加载权重）
- SHA256 批量哈希与重复组
- 下载：http(s) 直链、Civitai / HuggingFace 智能展开；断点续传；完成长度/SHA256 校验；失败自动重试 3 次；全局并发上限 3
- **推荐模型包**：SD1.5 / SDXL / Flux 一键下载到当前实例 `models/`
- 批量改名、存储分析、真缩略图（`comfy-pilot-media:` 受控协议）

### 节点包

- 来源：Comfy Registry API、Manager channel、Git URL、本地扫描（支持指定 branch）
- Git 安装校验：仅 https / ssh / git@，拦截 `ext::`、注入型主机/分支；**自动使用便携 MinGit**
- 依赖安装：`pip install -r requirements.txt` **真实等待完成**，失败写入 issue
- 健康：requirements 提示、节点名冲突、`__init__.py` 真实导入冒烟
- **更新**：检查更新**全量覆盖每个已安装包**并给出显式状态（可更新 / 已最新 / 无法检查 / 检查失败 / 已禁用 / 已锁定）——检查失败不再伪装成「不支持自动更新」；Registry 匹配支持 registryId → 仓库 URL → 唯一名字三级，git 检查结果持久化
- **一键/批量更新**：批量按顺序逐个更新，弹框实时显示总进度、第 N/M 个包与终端日志；**弹框不会自动关闭**，成功失败都停留供查看，可「停止剩余」或手动关闭
- registry 包失败自动回滚到 `.bak`，回滚失败必报备份路径
- 快照：安装/更新/卸载前自动快照；恢复为**启用状态对齐**（不回滚版本，UI 已明示）

### 工作流与批跑

- **工作流库**：默认 `userData/data/workflows`（设置可改）。导入 = **拷贝入库**，可感知落点
- `.json` 工作流与 PNG 内嵌 workflow / prompt；PNG 导入同时抽出可排队的 `.json`
- UI 格式 → API prompt 转换（KSampler 动态 widget、ControlNetLoader 等）
- 标签 / 收藏 / 重命名 / 删除（库文件真删，实例侧只取消登记）/ ZIP 打包分享
- 同步到实例 `user/default/workflows` 并打开 Frontend
- 按实例提交队列，可注入 seed
- **批量任务**：从库多选工作流、次数、种子策略、尺寸/steps/cfg 矩阵；入队后等待真实出图；取消立即生效并尝试撤队

### 产物

- output 目录索引、类型筛选（图像 / 视频 / 音频 / **3D**）、真缩略图（自动愈合死链）、排序 + 分页
- **全类型覆盖（0.1.14）**：3D 模型（.glb/.gltf/.obj/.fbx/.ply/.stl——立方体卡片 + 系统程序打开）、音频（.wav/.mp3/.flac/.ogg/.m4a…——灯箱内嵌播放）、EXR/HDR/TIFF 原始图（图标卡片 + 系统程序打开，浏览器不可解码的诚实降级）；未知格式仍不入索引（防膨胀）
- **视频支持**：网格显示首帧 + 播放角标，双击/点击灯箱内嵌播放（mp4/webm 由 Chromium 原生解码；mkv/mov 优雅降级「用系统播放器打开」）
- PNG 参数面板（seed / 元数据）+ **还原为工作流（真入库）**
- 收藏、多选导出 ZIP、按批次 / 工作流过滤、回溯跳转
- **实例资产库只读增强（0.1.14）**：实例开启 ComfyUI 0.40 资产系统（`--enable-assets`）时，产物详情可查询对应的资产记录——promptId 溯源（自动解析工作流归属）、标签、服务端预览（EXR 等）；未启用时零侵入
- 扫描深度可调（设置 → 路径 → 产物扫描深度，默认 4）

### 监控

- 系统：CPU / 内存 / 磁盘；GPU 真实显存（systeminformation + Windows 性能计数器回退）
- ComfyUI 队列与历史；WebSocket 进度（断线无限重连）

### 诊断

Python 版本、Torch / CUDA、`extra_model_paths.yaml`、端口、磁盘、Registry、自定义节点冒烟；可修复项一键修复。

---

## 设置项说明

| 分组   | 项                                                                     | 说明                                                  |
| ------ | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| 路径   | 默认实例目录、模型扫描根、下载目录、产物索引根、extra_model_paths.yaml | 影响发现与下载落点                                    |
| 路径   | 产物扫描深度                                                            | output 目录递归层数（默认 4，2–10）                    |
| 网络   | GitHub 镜像 / HF Endpoint / Civitai Endpoint                           | 镜像与下载域名                                        |
| 网络   | **PyPI 镜像 / Torch 镜像**                                             | 装机与节点依赖加速                                    |
| 网络   | 网络模式                                                               | public / private / offline / personal_cloud           |
| 安全   | security_level                                                         | strong / normal / normal- / weak（对齐 Manager 语义） |
| 安全   | allow_git_url_install / allow_pip_install                              | 是否允许 git 装节点、装后自动 pip                     |
| 下载   | aria2 路径、启用 aria2                                                 | 大文件可选加速                                        |
| 代理   | 协议 / 主机 / 端口 / 账号 / 绕过列表                                   | 下载、Registry、git/pip/uv、内嵌页共用                |
| 行为   | 启动检查更新、优先内嵌 Frontend、语言、开机自启、托盘、autoStart       | 启动器体验                                            |
| 快捷键 | Ctrl+1…9 / Ctrl+Enter / Ctrl+,                                         | 设置页内置清单                                        |

---

## 数据与存储

- **存储格式：JSONC**（带注释的 JSON），无原生模块、无 SQLite
- 位置：`%APPDATA%/comfy-pilot/data/`（应用 userData；macOS/Linux 为对应 userData）
- 主要文件：`settings.jsonc`、`instances.jsonc`、`models.jsonc`、`node_packs.jsonc`、`workflows.jsonc`、`download_tasks.jsonc`、`batch_jobs.jsonc`、`backups.jsonc` 等
- **工作流落盘**：导入进当前实例的 `user/default/workflows/`（1 份 `.json`），ComfyUI Frontend 直接可见；`data/workflows/` 仅作旧版本遗留扫描
- 解析失败的文件改名为 `*.jsonc.bad-<时间戳>`，不覆盖用户数据
- 运行时：`userData/runtimes/`（便携 Python / uv / MinGit + `checksums.json`）
- 缩略图与缓存：`userData/app-cache/`（0.1.9 从 `userData/cache` 迁出——与 Chromium 浏览器缓存目录同名会被系统清理连坐）
- 日志：`%APPDATA%/comfy-pilot/logs/boot.log`（与应用/实例日志同目录；0.1.16 起统一，Settings「打开日志目录」指向此处）

---

## 安全设计

| 面             | 措施                                                                          |
| -------------- | ----------------------------------------------------------------------------- |
| 渲染进程       | `contextIsolation` + preload 白名单；IPC 参数 JSON 化防 structured-clone 崩溃 |
| 路径           | 分段规范化，拦截 `..`、尾随空格、保留设备名；Windows 大小写不敏感包含判断     |
| 下载 / 改名    | 文件名净化；目标目录必须落在允许根内；完整性校验                              |
| Zip 解压       | zip-slip、符号链接、自引用环、保留名一并拒绝                                  |
| Git            | 拦截 `ext::`、注入型主机/分支；argv 数组，无 shell                            |
| 启动脚本导出   | `.bat` / `.sh` 平台正确转义（防命令注入）                                     |
| 媒体 URL       | `comfy-pilot-media:` 仅放行 thumbs / output 根 + 图片/视频/音频扩展名         |
| URL / 打开文件 | 仅 http(s)/mailto；禁止打开可执行/脚本类扩展名                                |
| 网络请求       | 监控与内嵌页限制在 localhost 或已注册实例/远程                                |
| 删除保护       | 含 `models/` `custom_nodes/` `user/` `output/` 的旧目录**只归档不删除**（0.1.17）；装机清理仅删 ComfyPilot 痕迹或空残骸 |
| 读路径         | 仅「用户显式选择 + 应用自有根」；词法检查（`..`/尾随空格）之外，**存在目标再按 realpath 复核**，批准根内的软链也无法外指（0.1.17） |
| 凭据           | 代理密码与远程 API key 走 `safeStorage` 加密落盘；备份导出**脱敏**、恢复时保留本机密钥**并重新加密**；解密失败保留密文不覆盖 |
| 设置端点       | 镜像/索引等 URL 仅接受 http(s)，拒绝 `file:`/`javascript:`                     |
| 单实例         | `requestSingleInstanceLock`（`--allow-multiple-instances` 可显式绕过）        |

危险操作（强杀、删模型、删节点、恢复备份）均需二次确认。

---

## 工程结构

```text
ComfyPilot/
├── package.json                 # v0.1.18 · MIT · ThzxxArt
├── electron.vite.config.ts
├── electron-builder.yml         # Win NSIS（已发布）；macOS/Linux 目标存在但未验证
├── vitest.config.ts             # 覆盖率门禁（0.1.8 按实测定档，见文件内说明）
├── scripts/
│   ├── postbuild.cjs
│   ├── check-i18n.cjs           # zh/en 键对齐 + 动态域校验（不达标即失败）
│   ├── check-hardcoded-zh.cjs   # 零硬编码中文门禁
│   └── diag-*.cjs               # 排障探针
├── resources/                   # 应用图标
├── src/
│   ├── shared/                  # types.ts + constants.ts
│   ├── main/
│   │   ├── bootstrap.cjs
│   │   ├── index.ts
│   │   ├── ipc/handlers.ts
│   │   └── services/
│   │       ├── bootstrap.ts     # 零预装运行时自举
│   │       ├── installer.ts     # 一键装机
│   │       ├── instance.ts      # 实例生命周期
│   │       ├── netProbe.ts      # 镜像测速
│   │       ├── model.ts         # 模型扫描/下载/校验
│   │       ├── nodePack.ts      # 节点包
│   │       └── …
│   ├── preload/
│   └── renderer/
│       └── src/
│           ├── styles/tokens.ts # JS 侧设计 token
│           └── views/           # dashboard/instances/install/models/…
├── tests/
│   ├── unit/                    # 121 文件 · 1725 用例 · 含 DOM 组件测试
│   ├── integration/
│   └── e2e/
└── .github/workflows/ci.yml
```

---

## 开发与测试

```bash
npm run dev / typecheck / test / test:coverage / test:e2e / test:all
node scripts/check-version.cjs   # 版本号五处一致（CI + release 必跑）
```

**测试：** 1725 用例（121 文件，含 `@vue/test-utils` 组件测试；0.1.18 删除了约 1,050 条纯源码文本断言，行为占比从脚本口径 85% 提升到 97%）+ e2e 冒烟（真实 Electron 启动、preload 桥、一次真实 IPC、渲染层 console 错误置红）。覆盖率门禁分三层：**全局下限**（statements 82 / branches 74 / functions 83 / lines 84，实测值 −2pp）、**测试行为占比**（`npm run test:behavior`，纯源码文本断言占比 >40% 直接失败）与 **每文件下限**（`coverage-baseline.json` 的实测 −2pp，`scripts/coverage-ratchet.cjs` 对任一文件掉 >1pp 失败）；`handlers.ts`/`index.ts` 等装配层仍未纳入 include（覆盖率数字不代表全仓）。测试源码纳入 tsc 门禁（`typecheck:test`）。

**技术栈（0.1.18 升级）：** Electron **45** · electron-vite **6** · Vite **8** · Vitest **5** · Node **24**（CI/构建）。TypeScript 保持 **5.9**：TS 7（native）与 `vue-tsc` 2.x/3.x 均不兼容（`ERR_PACKAGE_PATH_NOT_EXPORTED`），已实测并记录，待 vue-tsc 支持后再升。

**门禁脚本：**

```bash
node scripts/check-i18n.cjs        # 键对齐 + 动态 key 域
node scripts/check-hardcoded-zh.cjs # 渲染层 + constants 零中文硬编码
```

**启动排障：**

1. 查看 `%APPDATA%\comfy-pilot\logs\boot.log`
2. 确认 `out/main/bootstrap.cjs`、`out/preload/index.js`、`out/renderer/index.html` 存在
3. 开发态设 `COMFYPILOT_BOOT_PROBE=1` 可加载极简页面排除渲染问题

---

## 打包发布

```bash
npm run build:win     # Windows NSIS 安装包
npm run build:mac     # macOS DMG
npm run build:linux   # AppImage + deb
```

Windows 注意：若 PowerShell 下 `electron-builder` 调用异常：

```bash
cmd /c "node node_modules\electron-builder\cli.js --win --config electron-builder.yml"
```

产物输出到 `release/`。

---

## 设计原则

1. **控制塔，不是编辑器** — 节点画布交给官方 Frontend
2. **读系统真相** — 扫描磁盘 / 进程 / Python 环境，不猜测
3. **默认只读** — 删除、强杀、恢复等危险操作显式确认
4. **离线可用** — 本地能力不依赖外网
5. **不劫持环境** — 旁路管理；装机产物隔离在安装根目录
6. **根因修复** — 问题从数据流与安全边界上修干净
7. **零门槛** — 用户不需要预装任何前置软件
8. **零遗留** — 不做半截功能；门禁锁住质量

---

## 与 ComfyUI 的关系

ComfyPilot 通过 HTTP / WebSocket / 进程管理与 ComfyUI 交互，**不静态链接其源码**。  
ComfyUI 本身采用 GPL-3.0；本项目独立发布，采用 **MIT**。

| 能力            | 途径                                    |
| --------------- | --------------------------------------- |
| 版本 / 节点信息 | 读安装目录、受控子进程探测              |
| 启停            | 主进程 spawn，记录 PID 与日志           |
| 队列 / 历史     | `GET /queue` `/history` `/system_stats` |
| 提交工作流      | `POST /prompt`                          |
| 实时进度        | `WS /ws`                                |
| 节点安装        | Registry API / Git / Manager channel    |

上游仓库为 **`Comfy-Org/ComfyUI`**（0.1.14 起全部引用直接指向官方组织，不依赖重定向）；检查更新会同时显示上游最新正式版（GitHub Releases）。

上游 v0.41（开发中）预备事实：`cli_args.py` 相对 v0.40 已冻结（启动参数目录完整）；新增 `GET /default_workflow` 路由（工作流页「导入默认工作流」为探测式接入，旧版实例诚实提示）；官方新增 Windows ARM64 + NVIDIA 便携包、assets 系统导出 API 与视频元数据提取（均为服务端面——本项目对资产系统保持只读立场）。

**注意 `--disable-metadata`**：该参数会停止 ComfyUI 写入 PNG 元数据，工作流指纹关联与产物参数还原将随之失效（医生体检会给出警告）——除非有隐私需求，不建议开启。

---

## Roadmap

- [x] 工程脚手架与模块骨架
- [x] 实例管理（参数模板、端口检测、环境探测、重启/强杀、诊断包）
- [x] 模型库（元数据、去重、断点下载、extra_model_paths、存储分析）
- [x] 节点管理（Registry / Git / Manager、冲突、快照）
- [x] 监控 WebSocket + 诊断一键修复
- [x] 工作流 / 批跑 / 产物 / 备份 / 远程 / 市场
- [x] 一键装机（隔离 venv + torch 通道）
- [x] 网络代理与镜像端点
- [x] JSONC 存储、完整测试矩阵、Windows 安装包
- [x] **0.1.1 启动器**：就绪探测、启动并打开、端口自愈、托盘、开机自启、桌面快捷方式、autoStart
- [x] **0.1.1 多实例上下文**：节点/市场/模型绑定当前实例
- [x] **0.1.3 零门槛装机**：便携 Python / uv / MinGit 自举，zip 装 ComfyUI，镜像测速，推荐基础模型
- [x] **0.1.3 启动器/管理器 UX**：三步引导、装机真一键、实例卡收敛、产物参数面板、完整 i18n、覆盖率 ≥85%
- [x] **0.1.4 实例 ComfyUI 更新**：版本探测（git describe / 安装戳）、备份-拉取-依赖-验证-回滚全管线、保留 custom_nodes/models/user
- [x] **0.1.4 节点安装/更新产品化**：检查更新、一键/批量更新、回滚上报、MinGit 便携链、嵌套残留清理
- [x] **0.1.4 环境修复**：实例级 repairEnv（补 venv / torch / requirements）
- [x] **0.1.4 质量门禁**：preflight i18n 键根治、CI 接 i18n/硬编码门禁、nodePack/updater 进覆盖率 ≥85%
- [x] **0.1.5 工作流真库**：导入拷贝入库、list 合并 DB、PNG 抽 JSON、来源徽章、缺失可见
- [x] **0.1.5 生产闭环**：批跑库选多工作流 + 参数矩阵 + 出图跟踪；产物排序分页收藏导出；批次/工作流回溯
- [x] **0.1.5 工作流操作**：标签/收藏/改名/删除/ZIP 导出/同步实例/Frontend 打开
- [x] **0.1.6 八域协同**：实例切换广播、通知总线、WS 归属、market?q 深链、batch?jobId、output?workflowId、instances?edit 深链
- [x] **0.1.6 数据正确性**：批跑 produced 真计数、重跑清零、超时不定 done、rename 保 id、openInFrontend 去重、getLogs 回读、node 更新保留 lock/tags
- [x] **0.1.6 UI/UX 完整**：模型删除真选项、下载取消/错误可见、产物 workflowId 筛选、灯箱翻页、批量过滤态可导出、节点空态去市场、op-modal 自动关
- [x] **0.1.7 全功能整合**：20 个死接口全部接 UI 或删除；远程实例接入选择器/监控；extra_model_paths 真解析；模型改名/软链/标签/Civitai 接线
- [x] **0.1.7 数据根治**：批跑四桶计数（submitFailed/execFailed 分离）、备份含工作流实体+原子恢复、DB 写串行、通知总线 seq 游标、WS 代际
- [x] **0.1.7 性能与体验**：step.log 上限、InstallView 镜像不覆盖显式选择、startFullAuto 尊重 useUv、modelScanRoots UI、节点体检/git branch、监控历史、运行时状态
- [x] **0.1.8 体验与美观收口**：节点卡溢出/等高根治、全局长文本截断规范、模型页滚动与日期筛选、骨架屏与筛选空态、i18n 原始枚举清零、设计令牌与对比度校准、键盘可达/焦点环/减弱动效
- [x] **0.1.8 正确性根治**：节点启用/禁用真实生效（Manager 同构 `.disabled/`）、更新会拒绝已禁用包而不是悄悄重新启用、远程实例的「打开/启动」不再落到本地实例、远程/本地实例选择互斥、ComfyUI 更新/修复进度槽释放、详情页 not-found 兜底
- [x] **0.1.8 ComfyUI 对齐**：秋叶/绘世整合包 Python 解析、模型分类对齐 ComfyUI 注册目录（25+2 legacy 别名）、extra_model_paths 全键集与多行值（扫描时剔除 custom_nodes/datasets）
- [x] **0.1.8 工程护栏**：`.gitattributes` 行尾归一、ESLint 配置修复（Vue SFC 解析 + Node globals）并接入 CI、i18n 门禁改为硬失败、覆盖率按实测定档、CI 增加 lint 与覆盖率产物
- [x] **0.1.9 产物可见**：缩略图 URL/目录回环断裂根治（全部产物裂图）、缓存目录迁出 Chromium Cache、死链自愈、孤儿清理；视频首帧卡片 + 灯箱内嵌播放与降级
- [x] **0.1.9 更新可信**：检查更新全量状态矩阵（含检查失败/已禁用显式行）、仓库 URL 三级匹配、git 结果持久化；批量顺序更新 + 实时聚合进度 + 终端日志弹框（永不自动关闭、可停止剩余）
- [x] **0.1.9 启动可控**：结构化启动参数调优面板（互斥组校验、实时预览、冲突拦截在 spawn 前）、产物扫描深度可配、`shell.reveal` 白名单、e2e 起真实 bootstrap 入口
- [x] **0.1.10 引擎对齐**：/system_stats + /features 在线能力探测（版本/前端包/argv/feature flags）；WS feature_flags 协商 + 两代采样预览帧解码 + 节点级进度（progress_state）
- [x] **0.1.10 事实为真**：节点启动加载报告（IMPORT FAILED 可见 + 原因 + 一键启动自检）；实例在线版本；/api/jobs 作业列表与原子取消（旧版自动回退）；workflow_metadata 溯源
- [x] **0.1.10 模型对账**：/experiment/models（回退 /models）与本地索引差异解释、一键加入扫描根
- [x] **0.1.10 质量清偿**：doctor/backup/monitor/pip 清理链行为测试补齐（0%/2%/16% → 全绿上调门禁）、10+ 假测试修复、IPC 注册双向契约、测试纳入 tsc、e2e 渲染挂载断言
- [x] **0.1.11 监控可用**：进度 WebSocket 生命周期根治（实例启动即自动连接）；监控队列去重（/queue + /api/jobs 按 promptId 精确合并，不再「运行中/执行中」双显）；预览定位诚实化（仅 ComfyPilot 提交的运行；ComfyUI 协议定向实锤）
- [x] **0.1.11 关联闭环**：工作流→产物**内容指纹反向匹配**（ComfyUI 前端执行的产物同样可关联）+ batch sidecar + 多 id 筛选 + 空态解释与重扫
- [x] **0.1.11 事实精修**：节点「全部更新」完整性（可选重试检查失败项）+ 版本方向修复（1.0 不再谎报高于 1.2）+ git 落后提交数徽标 + 0.39 `[INFO]` 前缀加载报告修复；最大信息量卡片 + 批量启停防护；实例详情三页签 + 终端日志（自动跟随/2000 行）；调优面板平铺去嵌套；模型库类别下拉+架构筛选+类别图标；Dashboard 内存已用/总值
- [x] **0.1.11 能力补齐**：远程实例批跑（远程历史产物语义诚实）+ 释放显存；运行中启动自检（独立端口）；工作流对比（字段差异+单侧节点类型）；GPU 多卡索引 + Windows 共享显存；应用自动更新检查可见化（设置页按钮+状态）
- [x] **0.1.18 发布工程**：tag 触发的 `.github/workflows/release.yml`（Windows 必跑、mac/linux 非阻断、draft + SHA256SUMS）；`scripts/check-version.cjs` 校验五处版本一致；AUMID；asar 去冗余并排除 `out/tsc-*`/`*.tsbuildinfo`。**代码签名仍未配置**（需要证书），发布说明明确告知 SmartScreen 处理方式
- [x] **0.1.12 运行可诊**：运行失败结构化诊断（WS `execution_error` 全载荷 + 日志 traceback 解析双通道；节点→包归属映射 object_info `python_module`；失败卡一键安装缺失包 / 配方修复 / 复制报告 / 跳转节点包）；失败通知（系统通知 + 站内）
- [x] **0.1.12 依赖可修**：实例 venv 通用 pip 安装通道（uv 优先 / ensurepip 兜底 / 镜像重试 / 流式日志 / 可取消）；Doctor pip 体检 + ensure-pip 一键修复；repairEnv/卸载链补 pip；节点依赖体检（requirements vs venv 对账 + 单包补装）；修复配方（triton-windows / SageAttention wheel / onnx，SHA256 钉验）
- [x] **0.1.12 预检与收口**：工作流/批跑提交前 object_info 节点预检（缺节点警告不阻断）；日志搜索与级别过滤；进度弹窗刷新后状态恢复（comfy-update/repair/node-op/pip 四路快照）；0.1.12 全量死代码清理（wsEvents、objectInfo、getLastSnapshot、isWsConnected、hashId）
- [x] **0.1.13 进度可信**：pip 安装进度弹框状态机根治（preflight/download 步骤终态化、成功后进度条 100%、长安装分数推进不再长时间 0%）；完成态快照（`instance.pipStatus` 完成后仍返回最终结果——「装完弹框变 0% 空壳」从根消失）；连续操作守卫（运行中再点击不再重置弹框，OP_BUSY 本地化提示并自动打开进行中进度）
- [x] **0.1.13 安装可达**：节点页依赖体检补装全链路（uv `Installed N packages` 成功输出不再被误判失败；node/pip 互斥判定加活跃性证据防误锁；补装完成自动刷新审计；remote 实例显式拒绝本地装包并本地化提示）
- [x] **0.1.13 遗留清零**：全量阅读审计 17 项历史缺陷全部修复（显式实例 id 未命中不再静默回退到首实例；bootstrap 断点续传读写同文件且 416 完成校验；updater torch 安装 uv 优先；远程实例执行失败纳入诊断；跨实例状态泄漏清理——Monitor/Output/Models/Batch/Workflows/Market 全视图；execError 双源去重 + lastNotify 上限；node-op 最新流按更新时间排序；main 进程 notify i18n key 纳入 CI 校验）
- [x] **0.1.13 更新通畅**：应用自更新链路根治（0.1.11 遗留的两套脱节实现合一）——下载进度实时可见（百分比/已传/速度）、启动检查延迟触发 + 失败自动重试 + 应用内通知（发现新版本 / 下载完成）、下载就绪后一键「重启并安装」；asar 内 `electron-updater` 与 `app-update.yml` 完整性经打包验证
- [x] **0.1.14 产物全类型**：`shared/mediaTypes.ts` 单一事实源（此前四处分类实现漂移：mkv 两处缺失、未知文件默认 image）；3D 模型 / 音频 / EXR 家族全面入索引；媒体协议扩展音频（灯箱内嵌播放）；未知格式仍不入索引防膨胀
- [x] **0.1.14 资产贯通**：ComfyUI 0.40 assets 系统只读接入——`assetsApi` 实时探测（503 disabled / 404 旧版均诚实降级）、实例能力区状态展示、产物详情资产记录查询（promptId 溯源 + 工作流归属 + 标签 + 服务端预览）
- [x] **0.1.14 引擎同频**：全项目仓库引用切换官方 `Comfy-Org/ComfyUI`（摆脱重定向依赖）；检查更新附「上游最新正式版」release 语义（tag + 日期 + 更新日志链接）；启动参数补 output/input/temp/previews 四个存储目录字段 + CATALOG 补 `--previews-directory`；doctor 新增 `--disable-metadata` 检测（指纹关联会失效的诚实提示）；节点加载报告可识别 ComfyUI 治理策略拒绝（governance）
- [x] **0.1.15 运行可控**：监控页补齐 ComfyUI 三大标准运行操作——清空待执行队列 / 中断当前任务（0.39+ 定向、旧版全局的诚实语义）/ 释放显存内存；本地与远程统一入口，操作确认流 + 完成后实时回读
- [x] **0.1.15 批量减负**：产物库多选批量删除（文件/仅记录双态 + 部分失败诚实报告）；模型库多选批量删除 / 批量移动；实例前端包版本一键对齐（mismatch 徽标 → 复用 pip-op 模态升级到 required 版本）
- [x] **0.1.15 上游就绪**：从运行实例一键导入引擎默认工作流（ComfyUI v0.41 `GET /default_workflow` 探测式接入，v0.40 及更早诚实提示）；上游事实档案更新（cli_args 对 v0.41 已冻结 / ARM64 便携包 / assets 导出 API）；遗留死代码清零 + 测试卫生根治（tmpdir 全量自清、磁盘门控与真实文件系统解耦）
- [x] **0.1.16 崩溃可证**：会话干净退出标记（`session.json`）+ 主进程 watchdog（堆/事件循环延迟采样）+ `child-process-gone` 落痕 + 未捕获异常持久化原因；下次启动若检测到上次未正常退出，弹窗提示并支持一键导出应用诊断
- [x] **0.1.16 日志可信**：实例日志**按行内 `[LEVEL]` 标记判定级别**（根治「stderr 一律 WARN」致使 INFO/DEBUG 满屏假警告）+ ANSI 转义码剥离 + `PYTHONUNBUFFERED` 改善双流时序 + 日志文件按大小轮转 + **尾部有界读取**（不再整读整解析）+ 调试噪声默认折叠（可切换）
- [x] **0.1.16 环境加固**：ComfyUI 子进程统一注入 `PYTHONUTF8`/`PYTHONIOENCODING`（根治中文 Windows 下 `pip` 构建 `UnicodeDecodeError: 'gbk'`，如 argos-translate）+ `NO_PROXY` 去除 `[::1]` 括号（消除第三方节点 `Invalid port ':1]'`）+ 节点启动导入失败解析与提示（缺依赖可修，插件自身 bug 如实呈现）
- [x] **0.1.16 性能与内存**：模型扫描由「逐文件整写」改为单次批量写（O(N²)→O(1)）；安装/下载进度写盘去抖合并（内存快照保证读写一致 + 退出 flush）；多类缓存（工作流分析/指纹/节点包元数据/输出映射/能力）统一 LRU 上限；模型表虚拟滚动、工作流列表改 computed、按实例状态 Map 淘汰
- [x] **0.1.16 安全与收口**：`isSafeReadPath` 收敛到「用户显式选择路径 + 应用自有根」（不再放行全盘任意数据文件）；`isSafeEmbedUrl` 语义对齐（信任判定单点收敛）；preload `invoke` 增加运行时通道白名单（与事件白名单对称）
- [x] **0.1.17 状态可信**：批跑 `start/resume/retry` 立即返回 + `batch.wait` 等终态（长批跑不再让窗口假死）；安装被中断后不再是永久“运行中”（持久化 `running` 在无活动 run 时落为 `interrupted`，可一键重置）；取消写入终态并等进程树真正退出后才 reject；取消不再污染预检（per-run epoch）；实例「启动中」取消后进程不会复活；批跑 / 更新中断后可续跑 / 重试失败 / 回滚
- [x] **0.1.17 冻结可归因**：每个 IPC 通道计时，>1s 记 `slow-ops.log`（含通道名与耗时，❌ 参数值），>5s 弹一次“主进程卡顿”提示；watchdog 与诊断包带上归因记录——下一次卡顿不再只有一个毫秒数字
- [x] **0.1.17 写放大收口**：`models`/`output_assets`/`node_packs`/`workflows` 四类热集合改为内存快照 + 400ms 合并写（外部手改按 mtime 失效）；产物列表与磁盘扫描解耦（`output.scan` 显式触发，翻页/筛选只查索引）；缩略图生成并发上限 8、失效缩略图单次批量清理；prompt→workflow 边车去抖
- [x] **0.1.17 数据保护**：安装重试遇到含 `models/` / `custom_nodes/` / `user/` / `output/` 的旧目录只归档（`.cp-old-<ts>`）绝不删除；torch 安装统一 `--upgrade` 并在装后校验 `torch.version.cuda` 与通道一致，不一致即失败并给建议
- [x] **0.1.17 安全边界**：单实例锁（`--allow-multiple-instances` 逃生）；读路径词法+realpath 双重复核（`..` 与软链都无法绕过）；启动脚本导出目录限白名单；`.desktop/.command/.app/.appimage` 拒绝打开；远程 API key 与代理密码走 `safeStorage` 加密（备份恢复同样重新加密，解密失败保留密文）；备份恢复的端点字段同样过 http(s) 校验；设置端点仅允许 http(s) 且拒绝携带凭据的 URL；运行时 zip/tar 解压统一校验（tar 先列表再解压）
- [x] **0.1.17 进度诚实**：pip/依赖安装不再用「输出行数/40」伪造百分比——无分母阶段显示不确定进度条（`IndeterminateBar`）+ 阶段文案，有真实总量（git 对象）才显示数字
- [x] **0.1.17 诚实回执**：请求的节点版本不可用时不写 `pinnedVersion`，改记 `installNote` 并作为可见 issue；离线检查更新返回 “unknown” 而非“有更新”；doctor 失败不再显示绿色；清空日志连轮转档一起删；批量改名只按成功计数；筛选隐藏的勾选行不再参与批量删除
- [x] **0.1.16 安装器崩溃根治**：定位到 electron-builder `multiUser.nsh` 的已知缺陷（全新单用户安装触发 NSIS `System.dll` 访问违规 `0xc0000005 @ +0x1581`，多版本复现），**升级 electron-builder `25.1.8 → 26.15.3`**（上游修复版模板）根治，并以 Windows 原生同配置打包验证
- [x] 工作流版本对照与打包分享：0.1.11 工作流对比视图（`workflow.compare`）；打包分享（ZIP 导出，0.1.5 已含）
- [x] 更细的 GPU 多卡 / 共享显存展示：0.1.11 多卡 `GPU n` 索引徽标 + Windows 共享显存（Shared Usage/Limit 计数器）

---

## License

[MIT](./LICENSE) © ThzxxArt
