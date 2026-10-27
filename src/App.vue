<script setup lang="ts">
import { call } from './call'
import Toasts from './components/Toasts.vue'
import Home from './screens/Home.vue'
import Room from './screens/Room.vue'
</script>

<template>
  <Room v-if="call.phase === 'room'" />
  <Home v-else />
  <Toasts />
</template>
