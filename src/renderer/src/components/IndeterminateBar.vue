<script setup lang="ts">
/**
 * 0.1.17 (WP2-4): honest progress for phases with no measurable total.
 *
 * pip output has no denominator, so the old UI invented one (`lines / 40`).
 * This bar shows "working" without claiming a percentage: an animated segment
 * over a muted track. It is shown whenever the active step has no real
 * fraction (git object % still renders as a determinate NProgress).
 */
const props = withDefaults(defineProps<{ height?: number; label?: string }>(), {
  height: 10,
  label: ''
})
</script>

<template>
  <div class="indet">
    <div
      :class="['indet-track', { 'has-label': Boolean(props.label) }]"
      :style="{ height: `${props.height}px` }"
    >
      <div class="indet-seg" />
    </div>
    <span v-if="props.label" class="indet-label">{{ props.label }}</span>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.indet {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}
.indet-track {
  position: relative;
  flex: 1;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(127, 127, 127, 0.22);
}
/* A short segment sweeping left→right — clearly "in progress", no number. */
.indet-seg {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 32%;
  border-radius: 999px;
  background: $color-primary;
  animation: indet-slide 1.25s ease-in-out infinite;
}
.indet-label {
  flex: 0 0 auto;
  font-size: 12px;
  opacity: 0.75;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@keyframes indet-slide {
  0% {
    left: -32%;
  }
  100% {
    left: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .indet-seg {
    animation-duration: 3s;
  }
}
</style>
