import { createRouter, createWebHashHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: () => import('@/views/dashboard/DashboardView.vue') },
    { path: '/instances', name: 'instances', component: () => import('@/views/instances/InstancesView.vue') },
    {
      path: '/instances/:id',
      name: 'instance-detail',
      component: () => import('@/views/instances/InstanceDetailView.vue')
    },
    { path: '/models', name: 'models', component: () => import('@/views/models/ModelsView.vue') },
    { path: '/nodes', name: 'nodes', component: () => import('@/views/nodes/NodesView.vue') },
    { path: '/market', name: 'market', component: () => import('@/views/nodes/MarketView.vue') },
    { path: '/workflows', name: 'workflows', component: () => import('@/views/workflows/WorkflowsView.vue') },
    { path: '/batch', name: 'batch', component: () => import('@/views/workflows/BatchView.vue') },
    { path: '/output', name: 'output', component: () => import('@/views/output/OutputView.vue') },
    { path: '/monitor', name: 'monitor', component: () => import('@/views/monitor/MonitorView.vue') },
    { path: '/doctor', name: 'doctor', component: () => import('@/views/doctor/DoctorView.vue') },
    { path: '/install', name: 'install', component: () => import('@/views/install/InstallView.vue') },
    { path: '/backup', name: 'backup', component: () => import('@/views/backup/BackupView.vue') },
    { path: '/settings', name: 'settings', component: () => import('@/views/settings/SettingsView.vue') },
    { path: '/embed', name: 'embed', component: () => import('@/views/embed/EmbedView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})
