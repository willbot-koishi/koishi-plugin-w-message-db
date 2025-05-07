<script setup lang="ts">
import { store } from '@koishijs/client'

import { getGid } from '../shared/utils'
import { SavedGuild } from '../src/types'
import { computed } from 'vue'

const guildModel = defineModel<SavedGuild>('guild')

const props = defineProps<{
  withGlobal?: boolean
}>()

const guilds = computed(() => {
  const guilds_: Array<SavedGuild | 'global'> = [ ...store.messageDb.savedGuilds ]
  if (props.withGlobal) guilds_.unshift('global')
  return guilds_
})
</script>

<template>
  <el-select
    v-model="guildModel"
    placeholder="选择群"
  >
    <el-option
      v-for="guild of guilds"
      :key="guild === 'global' ? 'global' : getGid(guild)"
      :value="guild === 'global' ? 'global' : getGid(guild)"
      :label="guild === 'global' ? '所有群' : guild.name"
    />
  </el-select>
</template>