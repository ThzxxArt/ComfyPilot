# ComfyPilot

> **ComfyUI 全能管理器** — 本机 ComfyUI 生产线的控制塔  
> TypeScript · Vue 3 · Electron · Naive UI · MIT · v0.1.5

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

| 模块 | 能力 |
|------|------|
| **总览 Dashboard** | 空态三步引导、启动器大卡（一键启动并打开 Frontend）、启动中阶段与日志、实例 / 模型 / 节点 / CPU·内存·显存一屏掌握 |
| **一键装机 Install** | **无需预装 Python / Git**：自动下载便携运行时、zip 获取 ComfyUI、按 GPU 推荐 torch、镜像测速、细粒度进度、完成后一键启动 + 推荐基础模型 |
| **实例 Instances** | 发现候选、启动并打开、就绪探测、端口冲突自愈、启动命令预览与导出脚本、热编辑、置顶/搜索、批量启停、环境探测、诊断包、**检查/更新 ComfyUI 本体（备份-回滚）**、**一键修复环境** |
| **模型库 Models** | 多根扫描、safetensors 元数据、SHA256 去重、断点下载与校验、推荐模型包一键下载、移动/软链/改名、存储分析、真缩略图 |
| **节点 Node Packs** | Registry / Manager / Git 安装、依赖真实安装、启用禁用、锁定、冲突检测、冒烟导入、快照对齐、**检查更新、一键/批量更新、失败回滚上报** |
| **市场 Market** | Comfy Registry 精选浏览与一键安装 |
| **工作流 Workflows** | **真·工作流库**：JSON / PNG 元数据解析（PNG 抽出 .json）、导入拷贝入库、来源徽章、标签/收藏/改名/删除、ZIP 导出、同步到实例、Frontend 打开、按实例排队 |
| **批跑 Batch** | 从工作流库**多选**多工作流 × 次数；种子策略（随机/递增/固定）+ 尺寸/steps/cfg 矩阵；入队后跟踪真实出图；取消可撤队；产物关联批次 |
| **产物 Output** | output 目录索引、真缩略图、时间/大小/名称排序 + 分页、收藏、多选导出 PNG 参数还原、**还原为工作流真正入库**、批次/工作流回溯 |
| **监控 Monitor** | CPU / 内存 / 磁盘 / GPU（显存真实采样）、队列、WebSocket 实时进度 |
| **诊断 Doctor** | 一键体检（Python / torch·CUDA / 端口 / 节点 / 路径 / 磁盘 / 网络）+ 可修复项 |
| **备份 Backup** | 配置 / 实例 / 节点清单 / 模型清单快照，原子恢复 |
| **远程 Remote** | 局域网 / 云端 ComfyUI 实例注册、连通测试、在线状态 |
| **内嵌 Frontend** | WebContentsView 内嵌官方 ComfyUI 前端，可关并改用系统浏览器 |
| **网络** | HTTP / HTTPS / SOCKS5 代理、PyPI / Torch / GitHub / HF 镜像、测速自动推荐 |

---

## 零门槛装机

**0.1.3 核心目标：装完 ComfyPilot 这一个包，就能在应用内把 ComfyUI 装好、启动、出图——不需要自己提前安装 Python、Git、uv 或任何前置软件。**

**0.1.4 核心目标：装完之后管得住升级——实例 ComfyUI 可检查/更新/回滚，节点包可检查/一键/批量更新，环境可一键修复。**

### 自动准备的运行时（下载到 `userData/runtimes/`）

| 运行时 | 用途 | 何时拉取 |
|--------|------|----------|
| **uv** | 快速 venv / pip，可自动提供 Python | 系统无 Python 或勾选 uv |
| **便携 Python 3.12** | 隔离解释器（python-build-standalone） | 系统无 Python 3.10+ |
| **MinGit** | 节点包 git 安装 / 可选 clone 模式 | 需要 git 能力时 |

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

---

## 快速开始

### 最终用户（安装包）

| 项 | 要求 |
|----|------|
| 操作系统 | Windows 10+ / macOS / Linux |
| 磁盘 | ≥ 20GB 可用（含 torch 与推荐模型） |
| GPU 驱动 | 使用 N 卡 GPU 加速需自行安装 NVIDIA 驱动（应用可检测并提示，无法代装） |
| VC++ Redistributable | Windows 运行 Electron 需要；缺失时启动会提示 |
| **Python / Git / uv** | **无需预装** — 一键装机自动下载便携运行时 |

下载安装包后：打开应用 → 空态三步引导 →「全自动安装」→ 完成后「立即启动并打开 Frontend」→ 下载基础模型 → 出图。

### 开发环境

| 依赖 | 版本 |
|------|------|
| Node.js | ≥ 20 |
| npm | ≥ 10 |

```bash
npm install
# 若 Electron 二进制未就绪：
node node_modules/electron/install.js

npm run dev          # 开发模式
npm run typecheck    # vue-tsc + tsc
npm run test         # 单元 + 集成（257 tests）
npm run test:coverage
npm run test:e2e     # Electron 启动冒烟（需先 build）
npm run test:all
```

---

## 功能详解

### 实例

- **发现**：扫描 Desktop / Portable / 源码目录、自定义根、`extra_model_paths.yaml` 相关路径
- **生命周期**：启动并打开 / 停止 / 重启 / 强杀（二次确认）；全部启动 / 全部停止
- **启动参数模板**：默认本地、高质量预览（taesd）、启用 Manager、完全离线、局域网共享、低显存、CPU 模式
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
- **更新**：检查更新（Registry 版本 / git behind）、一键更新、批量更新；registry 包失败自动回滚到 `.bak`，回滚失败必报备份路径
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

- output 目录索引、类型筛选、真缩略图、排序 + 分页
- PNG 参数面板（seed / 元数据）+ **还原为工作流（真入库）**
- 收藏、多选导出 ZIP、按批次 / 工作流过滤、回溯跳转

### 监控

- 系统：CPU / 内存 / 磁盘；GPU 真实显存（systeminformation + Windows 性能计数器回退）
- ComfyUI 队列与历史；WebSocket 进度（断线无限重连）

### 诊断

Python 版本、Torch / CUDA、`extra_model_paths.yaml`、端口、磁盘、Registry、自定义节点冒烟；可修复项一键修复。

---

## 设置项说明

| 分组 | 项 | 说明 |
|------|----|------|
| 路径 | 默认实例目录、模型扫描根、下载目录、产物索引根、extra_model_paths.yaml | 影响发现与下载落点 |
| 网络 | GitHub 镜像 / HF Endpoint / Civitai Endpoint | 镜像与下载域名 |
| 网络 | **PyPI 镜像 / Torch 镜像** | 装机与节点依赖加速 |
| 网络 | 网络模式 | public / private / offline / personal_cloud |
| 安全 | security_level | strong / normal / normal- / weak（对齐 Manager 语义） |
| 安全 | allow_git_url_install / allow_pip_install | 是否允许 git 装节点、装后自动 pip |
| 下载 | aria2 路径、启用 aria2 | 大文件可选加速 |
| 代理 | 协议 / 主机 / 端口 / 账号 / 绕过列表 | 下载、Registry、git/pip/uv、内嵌页共用 |
| 行为 | 启动检查更新、优先内嵌 Frontend、语言、开机自启、托盘、autoStart | 启动器体验 |
| 快捷键 | Ctrl+1…9 / Ctrl+Enter / Ctrl+, | 设置页内置清单 |

---

## 数据与存储

- **存储格式：JSONC**（带注释的 JSON），无原生模块、无 SQLite
- 位置：`%APPDATA%/ComfyPilot/data/`（macOS/Linux 为对应 userData）
- 主要文件：`settings.jsonc`、`instances.jsonc`、`models.jsonc`、`node_packs.jsonc`、`workflows.jsonc`、`download_tasks.jsonc`、`batch_jobs.jsonc`、`backups.jsonc` 等
- **工作流落盘**：导入进当前实例的 `user/default/workflows/`（1 份 `.json`），ComfyUI Frontend 直接可见；`data/workflows/` 仅作旧版本遗留扫描
- 解析失败的文件改名为 `*.jsonc.bad-<时间戳>`，不覆盖用户数据
- 运行时：`userData/runtimes/`（便携 Python / uv / MinGit + `checksums.json`）
- 缩略图与缓存：`userData/cache/`
- 日志：`%APPDATA%/ComfyPilot/logs/boot.log`

---

## 安全设计

| 面 | 措施 |
|----|------|
| 渲染进程 | `contextIsolation` + preload 白名单；IPC 参数 JSON 化防 structured-clone 崩溃 |
| 路径 | 分段规范化，拦截 `..`、尾随空格、保留设备名；Windows 大小写不敏感包含判断 |
| 下载 / 改名 | 文件名净化；目标目录必须落在允许根内；完整性校验 |
| Zip 解压 | zip-slip、符号链接、自引用环、保留名一并拒绝 |
| Git | 拦截 `ext::`、注入型主机/分支；argv 数组，无 shell |
| 启动脚本导出 | `.bat` / `.sh` 平台正确转义（防命令注入） |
| 媒体 URL | `comfy-pilot-media:` 仅放行 thumbs / output 根 + 图片扩展名 |
| URL / 打开文件 | 仅 http(s)/mailto；禁止打开可执行/脚本类扩展名 |
| 网络请求 | 监控与内嵌页限制在 localhost 或已注册实例/远程 |
| 删除保护 | 装机清理仅删除 ComfyPilot 痕迹或空残骸，拒绝误删用户目录 |

危险操作（强杀、删模型、删节点、恢复备份）均需二次确认。

---

## 工程结构

```text
ComfyPilot/
├── package.json                 # v0.1.4 · MIT · ThzxxArt
├── electron.vite.config.ts
├── electron-builder.yml         # Win NSIS / macOS DMG / Linux AppImage·deb
├── vitest.config.ts             # 覆盖率阈值 85%（逐文件）
├── scripts/
│   ├── postbuild.cjs
│   ├── check-i18n.cjs           # zh/en 键对齐 + 动态域校验
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
│   ├── unit/                    # 25 文件 · 覆盖率 ≥85%
│   ├── integration/
│   └── e2e/
└── .github/workflows/ci.yml
```

---

## 开发与测试

```bash
npm run dev / typecheck / test / test:coverage / test:e2e / test:all
```

**测试：** 257 用例（25 文件）+ e2e 冒烟。覆盖率阈值 **每文件** statements / branches / functions / lines ≥ **85%**（当前全局 96 / 93 / 98 / 96）。

**门禁脚本：**

```bash
node scripts/check-i18n.cjs        # 键对齐 + 动态 key 域
node scripts/check-hardcoded-zh.cjs # 渲染层 + constants 零中文硬编码
```

**启动排障：**

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
- [ ] 自动更新通道（GitHub Releases）
- [ ] 工作流版本对照与打包分享（0.1.5 已含 ZIP 分享）
- [ ] 更细的 GPU 多卡 / 共享显存展示

---

## License

[MIT](./LICENSE) © ThzxxArt
