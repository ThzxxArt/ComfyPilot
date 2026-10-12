<script setup lang="ts">
import { computed } from 'vue'
import { NIcon } from 'naive-ui'
import type { Component } from 'vue'

const props = defineProps<{
  label: string
  value: string | number
  hint?: string
  icon?: Component
  tone?: 'primary' | 'success' | 'warning' | 'danger' | 'muted'
}>()

const toneClass = computed(() => `tone-${props.tone || 'primary'}`)
</script>

<template>
  <div class="stat card card-interactive" :class="toneClass">
    <div class="stat-top">
      <div class="icon-wrap">
        <NIcon v-if="icon" :size="20" :component="icon" />
      </div>
      <div class="stat-value">{{ value }}</div>
    </div>
    <div class="stat-label">{{ label }}</div>
    <div v-if="hint" class="stat-hint">{{ hint }}</div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;

.stat {
  padding: 18px 18px 16px;
  position: relative;
  overflow: hidden;
}

.stat::after {
  content: '';
  position: absolute;
  inset: auto -20% -40% auto;
  width: 120px;
  height: 120px;
  border-radius: 999px;
  background: $gradient-soft;
  opacity: 0.9;
  z-index: 0;
}

/* 装饰圆是绝对定位绘制在文本之上的，必须把内容抬到装饰层之上 */
.stat-top,
.stat-value,
.stat-label {
  position: relative;
  z-index: 1;
}

.stat-top {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.icon-wrap {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  background: rgba($color-primary, 0.12);
  color: $color-primary;
}

.tone-success .icon-wrap {
  background: rgba($color-success, 0.14);
  color: $color-success;
}
.tone-warning .icon-wrap {
  background: rgba($color-warning, 0.16);
  color: $color-warning;
}
.tone-danger .icon-wrap {
  background: rgba($color-danger, 0.12);
  color: $color-danger;
}
.tone-muted .icon-wrap {
  background: rgba($color-text-muted, 0.16);
  color: $color-text-muted;
}

.stat-hint {
  margin-top: 8px;
  font-size: 12px;
  color: $color-text-muted-ink;
  position: relative;
  z-index: 1;
}
</style>
