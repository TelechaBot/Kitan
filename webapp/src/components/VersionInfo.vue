<script setup lang="ts">
import {computed} from 'vue';

const buildDate = import.meta.env.VITE_BUILD_DATE;
const version = computed(() => `Version: ${buildDate}`);
</script>

<template>
  <div class="version-info">
    {{ version }}
  </div>
</template>

<style scoped>
.version-info {
  position: fixed;
  bottom: 0;
  width: 100%;
  text-align: center;
  color: #999;
  padding: 10px 0;
  font-size: 0.8rem;
}
</style>