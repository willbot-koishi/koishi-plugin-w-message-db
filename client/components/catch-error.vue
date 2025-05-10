<script setup lang="ts" generic="T extends object">
import { MdbRemoteError } from '../../src/types'

type Data = Exclude<T, MdbRemoteError>

defineProps<{
  data: T
}>()
</script>

<template>
  <slot
    v-if="'error' in data"
    name="error"
    :error="(data as MdbRemoteError)"
  >
    <p>{{ data.error }}</p>
  </slot>
  <slot
    v-else
    :data="(data as Data)"
  ></slot>
</template>