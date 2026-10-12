<script setup lang="ts">
import { NSkeleton } from 'naive-ui'

withDefaults(defineProps<{ rows?: number; variant?: 'card' | 'row' }>(), {
  rows: 6,
  variant: 'row'
})
</script>

<template>
  <div class="list-skeleton" :class="`variant-${variant}`">
    <div v-for="i in rows" :key="i" class="sk-item">
      <NSkeleton
        circle
        :width="variant === 'card' ? 42 : 32"
        :height="variant === 'card' ? 42 : 32"
      />
      <div class="sk-lines">
        <NSkeleton text style="width: 42%" />
        <NSkeleton text style="width: 72%" />
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;

.list-skeleton {
  display: grid;
  gap: 12px;
  padding: 8px 0;
}

.variant-card {
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
}

.sk-item {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 14px 16px;
  border: 1px solid $color-border;
  border-radius: $radius-md;
  background: $color-surface;
}

.variant-card .sk-item {
  flex-direction: column;
  align-items: stretch;
}

.sk-lines {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
