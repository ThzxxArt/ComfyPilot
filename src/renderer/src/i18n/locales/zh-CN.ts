export default {
  app: {
    name: 'ComfyPilot',
    tagline: 'ComfyUI 全能管理器'
  },
  nav: {
    dashboard: '总览',
    instances: '实例',
    models: '模型库',
    nodes: '节点',
    market: '市场',
    workflows: '工作流',
    batch: '批跑',
    output: '产物',
    monitor: '监控',
    doctor: '诊断',
    install: '装机',
    backup: '备份',
    settings: '设置'
  },
  common: {
    save: '保存',
    cancel: '取消',
    refresh: '刷新',
    delete: '删除',
    confirm: '确认',
    search: '搜索',
    open: '打开',
    running: '运行中',
    stopped: '已停止'
  },
  dashboard: {
    title: '生产线总览',
    subtitle: '实例、模型、节点与运行状态，一屏掌握。'
  },
  settings: {
    language: '界面语言',
    theme: '主题'
  },
  header: {
    embed: '内嵌 Frontend',
    embedTip: '在应用内嵌入官方 ComfyUI Frontend',
    openExternal: '外链打开',
    crumb: 'ComfyUI 全能管理器 · MIT',
    instancePlaceholder: '当前实例',
    launchAndOpen: '启动并打开',
    stop: '停止',
    start: '启动'
  },
  instance: {
    title: '实例管理',
    subtitle: '发现、启动、多实例并行管理，端口冲突检测与环境探测。',
    add: '添加实例',
    discover: '自动发现',
    launchOpen: '启动并打开',
    previewCmd: '启动命令',
    copyCmd: '复制命令',
    edit: '编辑配置',
    pinned: '置顶',
    pin: '置顶',
    unpin: '取消置顶',
    searchPlaceholder: '搜索实例名称或路径',
    candidates: '发现候选',
    importSelected: '导入选中',
    alreadyRegistered: '已注册',
    portBusy: '端口被占用',
    ready: '已就绪',
    starting: '启动中',
    openLogs: '查看日志',
    runDoctor: '运行诊断'
  },
  settingsNew: {
    launchOnBoot: '开机启动 ComfyPilot',
    minimizeToTray: '关闭窗口时最小化到托盘',
    autoStartInstances: '启动 App 后自动拉起标记实例',
    createShortcut: '创建桌面快捷方式'
  }
}
