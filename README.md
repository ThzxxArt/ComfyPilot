# ComfyPilot

> **ComfyUI 全能管理器** — 本机 ComfyUI 生产线的控制塔。  
> TypeScript · Vue 3 · Electron · Naive UI · MIT · **v0.1.0**

[![License: MIT](https://img.shields.io/badge/License-MIT-4f6ef7)](./LICENSE)

ComfyPilot **不替代** ComfyUI 节点工作台，而是管理它的整套生产资产与运行状态：

| 模块 | 能力 |
|------|------|
| **总览 Dashboard** | 实例 / 模型 / 节点 / 负载一屏掌握 |
| **实例 Instances** | 发现、启停、重启、强杀、端口检测、参数模板、环境探测、诊断包 |
| **模型库 Models** | 扫描、safetensors 元数据、SHA256 去重、断点下载、存储分析 |
| **节点 Node Packs** | Registry 浏览安装、更新/锁定、冲突检测、冒烟、快照回滚 |
| **市场 Market** | Comfy Registry 精选安装 |
| **工作流 Workflows** | JSON/PNG 解析、标签、seed、一键排队 |
| **批跑 Batch** | 多工作流批量提交队列 |
| **产物 Output** | output 索引与 PNG 参数还原 |
| **监控 Monitor** | CPU/内存/GPU、队列、WebSocket 实时进度 |
| **诊断 Doctor** | 全项体检 + 一键修复 |
| **备份 Backup** | 配置/实例/节点/模型清单备份恢复 |
| **远程 Remote** | 局域网 ComfyUI 实例管理 |
| **内嵌 Frontend** | WebContentsView 内嵌 + 外链浏览器 |

---

## 快速开始

### 环境要求

- Node.js ≥ 20
- npm ≥ 10
- 本机已安装 ComfyUI（Desktop / Portable / 源码均可）

### 开发

```bash
npm install
npm run dev
```

### 类型检查

```bash
npm run typecheck
```

### 打包

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

---

## 工程结构

```text
ComfyPilot/
├── package.json
├── electron.vite.config.ts
├── electron-builder.yml
├── LICENSE                    # MIT
├── src/
│   ├── shared/                # 主进程 / 渲染进程共享类型与常量
│   │   ├── types.ts
│   │   └── constants.ts
│   ├── main/                  # Electron 主进程
│   │   ├── index.ts
│   │   ├── ipc/handlers.ts
│   │   └── services/
│   │       ├── store.ts       # 设置与实例注册表
│   │       ├── instance.ts    # 实例发现 / 启停 / 日志
│   │       ├── model.ts       # 模型扫描 / 下载
│   │       ├── nodePack.ts    # 节点包扫描 / 健康检查
│   │       ├── workflow.ts    # 工作流索引
│   │       ├── monitor.ts     # 系统与队列监控
│   │       ├── doctor.ts      # 一键体检
│   │       └── comfyApi.ts    # ComfyUI HTTP 客户端
│   ├── preload/               # contextBridge 安全桥
│   │   ├── index.ts
│   │   └── index.d.ts
│   └── renderer/              # Vue 3 界面
│       ├── index.html
│       └── src/
│           ├── main.ts
│           ├── App.vue
│           ├── router/
│           ├── stores/
│           ├── composables/
│           ├── components/
│           ├── styles/        # 亮色现代主题 token
│           └── views/
│               ├── dashboard/
│               ├── instances/
│               ├── models/
│               ├── nodes/
│               ├── workflows/
│               ├── monitor/
│               ├── doctor/
│               ├── embed/
│               └── settings/
└── resources/                 # 应用图标等打包资源
```

---

## 设计原则

1. **控制塔，不是编辑器** — 节点画布交给官方 Frontend（内嵌或外链）。
2. **读系统真相** — 扫描磁盘 / 进程 / Python 环境，不猜测。
3. **默认只读** — 模型与节点删除等危险操作需显式确认。
4. **离线可用** — 本地能力不依赖外网。
5. **不劫持环境** — 旁路管理，不强制重装已有 ComfyUI。

---

## 主题

默认 **亮色现代风**（浅色、渐变、微光、大圆角卡片），刻意不做深色/暗黑主题。

---

## 与 ComfyUI 的关系

ComfyPilot 通过 HTTP / WebSocket / 进程管理与 ComfyUI 交互，**不静态链接其源码**。  
ComfyUI 本身采用 GPL-3.0；本项目独立发布，采用 **MIT**。

---

## Roadmap

- [x] M0 工程脚手架与模块骨架
- [x] M1 实例管理（启动参数模板、端口冲突检测、环境探测、重启/强杀、诊断包）
- [x] M2 模型库（safetensors 元数据、SHA256 去重、断点下载、extra_model_paths、存储分析）
- [x] M3 节点管理（Comfy Registry、安装/更新/锁定、冲突、快照回滚）
- [x] M4 监控 WebSocket 进度 + 诊断一键修复
- [x] M5 工作流/批量/产物/备份/远程/市场 + 打包配置

---

## License

[MIT](./LICENSE) © ComfyPilot Contributors
