# ComfyPilot

> **ComfyUI 全能管理器** — 本机 ComfyUI 生产线的控制塔  
> TypeScript · Vue 3 · Electron · Naive UI · MIT · v0.1.0

[![License: MIT](https://img.shields.io/badge/License-MIT-4f6ef7)](./LICENSE)

ComfyPilot **不替代** ComfyUI 节点工作台，而是管理它的整套生产资产与运行状态：实例、Python 环境、模型库、自定义节点、工作流、批量任务、产物、监控、诊断、备份与一键装机。

---

## 目录

- [功能总览](#功能总览)
- [界面与主题](#界面与主题)
- [快速开始](#快速开始)
- [一键装机](#一键装机)
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

| 模块 | 能力 |
|------|------|
| **总览 Dashboard** | 实例 / 模型 / 节点 / CPU·内存·显存一屏掌握，快捷入口 |
| **一键装机 Install** | 独立 venv/uv、按 GPU 推荐 torch 通道、克隆 ComfyUI、安装依赖、注册实例 |
| **实例 Instances** | 发现、启停、重启、强杀、端口检测与建议、启动参数模板、环境探测、诊断包导出 |
| **模型库 Models** | 多根扫描、safetensors 元数据、SHA256 去重、断点下载、移动/软链/改名、存储分析、缩略图 |
| **节点 Node Packs** | Registry / Manager / Git 安装、更新、启用禁用、锁定、冲突检测、冒烟导入、快照回滚 |
| **市场 Market** | Comfy Registry 精选浏览与一键安装 |
| **工作流 Workflows** | JSON / PNG 元数据解析、标签、UI→API 转换、按实例排队 |
| **批跑 Batch** | 多工作流 × 多张批量提交队列，进度与失败统计 |
| **产物 Output** | output 目录索引、类型筛选、打开、从 PNG 参数还原工作流 |
| **监控 Monitor** | CPU / 内存 / 磁盘 / GPU（显存真实采样）、队列、WebSocket 实时进度 |
| **诊断 Doctor** | 一键体检（Python / torch·CUDA / 端口 / 节点 / 路径 / 磁盘 / 网络）+ 可修复项 |
| **备份 Backup** | 配置 / 实例 / 节点清单 / 模型清单快照，原子恢复 |
| **远程 Remote** | 局域网 / 云端 ComfyUI 实例注册、连通测试、在线状态 |
| **内嵌 Frontend** | WebContentsView 内嵌官方 ComfyUI 前端，可关并改用系统浏览器 |
| **网络代理** | HTTP / HTTPS / SOCKS5，作用于应用下载、Registry、git/pip 子进程与内嵌页 |

---

## 界面与主题

- 默认 **亮色现代风**：浅色背景、渐变强调色、微光玻璃卡片、大圆角
- 主色：`#4F6EF7 → #7C5CFC → #22D3EE`
- **刻意不做深色 / 暗黑主题**
- 界面语言：简体中文 / English（设置页可切换）

---

## 快速开始

### 环境要求

| 依赖 | 版本 |
|------|------|
| Node.js | ≥ 20 |
| npm | ≥ 10 |
| 操作系统 | Windows 10+ / macOS / Linux |
| ComfyUI | 可选；可用「一键装机」新建，或导入已有安装 |

### 安装依赖

```bash
npm install
```

若 Electron 二进制未就绪（部分 npm 配置会跳过 postinstall）：

```bash
node node_modules/electron/install.js
```

### 开发模式

```bash
npm run dev
```

### 类型检查

```bash
npm run typecheck
```

### 测试

```bash
npm run test            # 单元 + 集成
npm run test:coverage   # 带覆盖率
npm run test:e2e        # Electron 启动冒烟（需先 build；无显示环境设 SKIP_E2E=1）
npm run test:all        # typecheck + coverage + build + e2e
```

---

## 一键装机

「安装」页提供从零搭好一套隔离环境的流程：

1. **检测 GPU** — 识别 NVIDIA / AMD / Intel / Apple，给出推荐 torch 通道（cu130 / cu126 / cu124 / rocm / cpu / mps）
2. **预检** — 磁盘空间、路径可写、git / python / uv 是否可用
3. **创建安装目录与 venv**（或 uv 环境），与系统 Python 完全隔离
4. **克隆 ComfyUI** — 支持 GitHub 镜像前缀；半残目录会自动清理后重试
5. **安装 torch + requirements** — 走代理、可取消、失败会清理残留
6. **注册为 ComfyPilot 实例** — 自动选端口、可选启动

中断或失败可直接重跑，不会留下不可恢复的半成品目录。

---

## 功能详解

### 实例

- **发现**：扫描 Desktop / Portable / 源码目录、自定义根、`extra_model_paths.yaml` 相关路径
- **生命周期**：启动 / 停止 / 重启 / 强杀（二次确认）
- **启动参数模板**：默认本地、高质量预览（taesd）、启用 Manager、完全离线、局域网共享、低显存、CPU 模式
- **端口**：占用检测、空闲端口建议（8188 起）
- **环境探测**：解释器路径、Python / Torch / CUDA 版本、venv 完整性
- **诊断包**：导出配置与日志摘要，一键复制路径

### 模型库

- 分类：checkpoint / diffusion_models / unet / loras / vae / clip / text_encoders / controlnet / upscale_models / embeddings / other
- 读取 safetensors header（张量数、`__metadata__`），不加载权重
- SHA256 批量哈希与重复组
- 下载：http(s) 直链、Civitai / HuggingFace 链接智能展开；可选 aria2（`-c` 断点续传）；目标目录限制在允许根内
- 批量改名模式：`{name}` `{category}` `{index}` `{arch}`，支持预览
- 存储分析：按目录统计占用

### 节点包

- 来源：Comfy Registry API、Manager channel、Git URL、本地扫描
- Git 安装校验：仅允许 https / ssh / git@，拦截 `ext::`、以 `-` 开头的主机/分支
- 更新：Git 包 `git pull`，Registry 包走版本 API
- 健康：requirements 提示、节点名冲突、`__init__.py` 真实导入冒烟
- 快照：安装前自动快照，可恢复 / 删除
- `allow_pip_install` 关闭时不会静默 pip，只提示用户手动装依赖

### 工作流与批跑

- 支持 `.json` 工作流与 PNG 内嵌 workflow / prompt
- UI 格式 → API prompt 转换（含 KSampler 动态 widget、ControlNetLoader 等）
- 按实例提交队列，可注入 seed
- 批量任务：指定工作流、数量、实例；取消立即生效，迟到结果会被丢弃

### 监控

- 系统：CPU 负载、内存、磁盘余量
- GPU：型号、**真实显存占用**（systeminformation 优先；Windows 回退到 GPU Adapter Memory 性能计数器）、利用率、温度、功耗
- ComfyUI 队列（running / pending）与历史
- WebSocket 进度（`/ws`），断线无限重连（上限 60s 退避）
- 监控 URL 白名单：仅 localhost 或已配置的实例 / 远程 origin

### 诊断

检查项包括：

- Python 解释器与版本（3.9 警告，&lt;3.9 失败）
- Torch 版本 / CUDA 可用性（区分 CPU 构建与「有 CUDA 但不可用」）
- 端口占用；若端口上是 ComfyUI 则判定为正常运行
- `extra_model_paths.yaml` 路径有效性
- 磁盘空间
- Registry 连通性
- 自定义节点导入冒烟

可自动修复的项提供一键修复。

### 备份

- 备份对象：设置、实例配置、节点清单、模型清单、工作流清单等 JSONC（**不含模型大文件本体**）
- 恢复：先全量解析再原子写入，损坏文件不会写到一半；列表采用整表替换，与备份时刻一致

---

## 设置项说明

| 分组 | 项 | 说明 |
|------|----|------|
| 路径 | 默认实例目录、模型扫描根、下载目录、产物索引根、extra_model_paths.yaml | 影响发现与下载落点 |
| 网络 | GitHub 镜像前缀 | 克隆 github.com 时可走镜像（拼在 URL 前） |
| 网络 | HuggingFace Endpoint | 如 `https://hf-mirror.com`，自动重写 HF 下载域名 |
| 网络 | Civitai Endpoint | 默认 `https://civitai.com` |
| 网络 | 网络模式 | public / private / offline / personal_cloud |
| 安全 | security_level | strong / normal / normal- / weak（对齐 Manager 语义） |
| 安全 | allow_git_url_install | 是否允许 Git URL 装节点 |
| 安全 | allow_pip_install | 是否允许安装节点后自动 pip 其 requirements |
| 下载 | aria2 路径、启用 aria2 | 大文件可选加速与断点 |
| 代理 | 协议 / 主机 / 端口 / 账号 / 绕过列表 | 应用内下载、Registry、git/pip、内嵌页共用 |
| 行为 | 启动检查更新、优先内嵌 Frontend、语言 | |

数据目录可在设置页一键打开（`userData/data/*.jsonc`）。

---

## 数据与存储

- **存储格式：JSONC**（带注释的 JSON），无原生模块、无 SQLite 依赖
- 位置：`%APPDATA%/ComfyPilot/data/`（macOS/Linux 为对应 userData）
- 主要文件：`settings.jsonc`、`instances.jsonc`、`models.jsonc`、`node_packs.jsonc`、`workflows.jsonc`、`download_tasks.jsonc`、`batch_jobs.jsonc`、`backups.jsonc` 等
- 解析失败的文件会被改名为 `*.jsonc.bad-<时间戳>`，避免静默覆盖用户数据
- 缩略图与缓存：`userData/cache/`
- 日志：`%APPDATA%/ComfyPilot/logs/boot.log`（启动排障用）

---

## 安全设计

ComfyPilot 在主进程侧强制执行多层约束：

| 面 | 措施 |
|----|------|
| 渲染进程 | `contextIsolation` + preload 白名单，禁止任意 IPC 事件订阅 |
| 路径 | 分段规范化，拦截 `..`、`.. `（Win32 尾随空格）、保留设备名（CON/NUL/COM1…） |
| 下载 / 改名 | 文件名净化；目标目录必须落在允许根内 |
| Zip 解压 | zip-slip、符号链接、自引用环、保留名一并拒绝 |
| Git | 拦截 `ext::`、注入型主机/分支；argv 数组调用，无 shell |
| URL / 打开文件 | 仅 http(s)/mailto；禁止打开可执行/脚本类扩展名 |
| 网络请求 | 监控与内嵌页限制在 localhost 或已注册实例/远程 |
| 代理 | 主机与端口校验，非法配置不会写入子进程环境变量 |

危险操作（强杀、删模型、删节点、恢复备份）均需二次确认。

---

## 工程结构

```text
ComfyPilot/
├── package.json                 # v0.1.0 · MIT · ThzxxArt
├── electron.vite.config.ts
├── electron-builder.yml         # Win NSIS / macOS DMG / Linux AppImage·deb
├── vitest.config.ts
├── vitest.e2e.config.ts
├── scripts/
│   ├── postbuild.cjs            # 把 bootstrap.cjs 拷入 out/main
│   ├── diag-scroll.cjs          # 滚动/高度链诊断
│   └── diag-gpu.cjs             # 显存采样诊断
├── resources/                   # 应用图标（.ico/.icns/png）
├── src/
│   ├── shared/                  # 主进程 / 渲染共享
│   │   ├── types.ts             # 领域类型 + IpcChannelMap
│   │   └── constants.ts         # 默认设置、启动模板、Registry API
│   ├── main/
│   │   ├── bootstrap.cjs        # CJS 入口（打包后真实 main）
│   │   ├── index.ts             # 窗口、协议、生命周期、updater
│   │   ├── ipc/handlers.ts      # 全部 IPC 注册
│   │   └── services/
│   │       ├── db.ts            # JSONC 存储
│   │       ├── security.ts      # 路径/URL/ID 净化
│   │       ├── instance.ts      # 实例发现与进程
│   │       ├── model.ts         # 模型扫描与下载
│   │       ├── nodePack.ts      # 节点包
│   │       ├── installer.ts     # 一键装机
│   │       ├── workflow.ts      # 工作流索引
│   │       ├── workflowConvert.ts
│   │       ├── monitor.ts       # 系统/GPU/队列/WS
│   │       ├── doctor.ts
│   │       ├── backup.ts
│   │       ├── env.ts           # venv / torch
│   │       ├── media.ts         # 缩略图/改名/aria2
│   │       ├── p1p2.ts          # 批跑/产物/远程/市场
│   │       ├── proxy.ts
│   │       ├── comfyApi.ts
│   │       └── zipSafe.ts
│   ├── preload/
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── App.vue
│           ├── router/
│           ├── stores/
│           ├── composables/     # IPC 封装
│           ├── utils/format.ts  # 百分比/容量格式化
│           ├── styles/          # 亮色主题 token
│           └── views/           # dashboard/instances/models/nodes/
│                                # market/workflows/batch/output/
│                                # monitor/doctor/install/backup/
│                                # settings/embed
├── tests/
│   ├── unit/                    # 安全、zip、工作流转换、显存、格式化…
│   ├── integration/             # JSONC 存储、装机门控
│   └── e2e/                     # 真实 Electron 启动冒烟
└── .github/workflows/ci.yml     # Ubuntu + Windows 矩阵
```

---

## 开发与测试

### 常用命令

```bash
npm run dev          # 开发
npm run typecheck    # vue-tsc + tsc
npm run lint         # ESLint
npm run format       # Prettier
npm run build        # 产出 out/（含 postbuild）
npm run test         # vitest 单测 + 集成
npm run test:coverage
npm run test:e2e
npm run test:all
```

### 测试覆盖

| 文件 | 焦点 |
|------|------|
| `security.test.ts` | 路径穿越、保留名、URL 白名单 |
| `zipSafe.test.ts` / `zipSafeExec.test.ts` | zip-slip、符号链接、Windows 名 |
| `workflowConvert.test.ts` | UI→API 映射、动态 widget |
| `gpuMemory.test.ts` | 显存合并与回退 |
| `format.test.ts` | 百分比/容量无长小数 |
| `ipcContract.test.ts` | IpcChannelMap ↔ handlers ↔ renderer 三方一致 |
| `installerValidate.test.ts` | Git URL / 分支校验、clone argv |
| `db.test.ts` | JSONC 读写、损坏文件保护 |
| `app-smoke.e2e.ts` | 真实 Electron 主包能启动并干净退出 |

CI：`.github/workflows/ci.yml` 在 Ubuntu 与 Windows 上跑 typecheck + 单测；Windows 额外跑 e2e。

### 启动排障

1. 查看 `%APPDATA%\ComfyPilot\logs\boot.log`
2. 确认 `out/main/bootstrap.cjs`、`out/preload/index.js`、`out/renderer/index.html` 存在
3. 开发态设 `COMFYPILOT_BOOT_PROBE=1` 可加载极简页面排除渲染问题

---

## 打包发布

```bash
npm run build:win     # Windows NSIS 安装包
npm run build:mac     # macOS DMG
npm run build:linux   # AppImage + deb
```

Windows 注意：若 PowerShell 下 `electron-builder` 调用异常，可使用：

```bash
cmd /c "node node_modules\electron-builder\cli.js --win --config electron-builder.yml"
```

产物默认输出到 `release/`。`extraResources` 会附带 preload、renderer 与图标，保证打包后窗口图标与沙箱 preload 可用。

---

## 设计原则

1. **控制塔，不是编辑器** — 节点画布交给官方 Frontend（内嵌或外链）。
2. **读系统真相** — 扫描磁盘 / 进程 / Python 环境，不猜测。
3. **默认只读** — 删除、强杀、恢复等危险操作显式确认。
4. **离线可用** — 本地能力不依赖外网；Registry / HF / Civitai 可降级。
5. **不劫持环境** — 旁路管理，不强制重装已有 ComfyUI。
6. **根因修复** — 不做表面补丁，问题从数据流与安全边界上修干净。
7. **百分比与容量展示克制** — 整数百分比，容量最多一位小数。

---

## 与 ComfyUI 的关系

ComfyPilot 通过 HTTP / WebSocket / 进程管理与 ComfyUI 交互，**不静态链接其源码**。  
ComfyUI 本身采用 GPL-3.0；本项目独立发布，采用 **MIT**。

| 能力 | 途径 |
|------|------|
| 版本 / 节点信息 | 读安装目录、受控子进程探测 |
| 启停 | 主进程 spawn，记录 PID 与日志 |
| 队列 / 历史 | `GET /queue` `/history` `/system_stats` |
| 提交工作流 | `POST /prompt` |
| 实时进度 | `WS /ws` |
| 节点安装 | Registry API / Git / Manager channel |

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
- [ ] 自动更新通道（GitHub Releases）
- [ ] 工作流版本对照与打包分享
- [ ] 更细的 GPU 多卡 / 共享显存展示

---

## License

[MIT](./LICENSE) © ThzxxArt
