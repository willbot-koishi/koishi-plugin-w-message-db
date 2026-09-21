<script setup lang="ts">
import { send, store } from '@koishijs/client'

import { getGid } from '../../../shared/utils'

import {
  computed, reactive, ref, onMounted, useTemplateRef,
} from 'vue'

import SelectGuild from '../select-guild.vue'
import WGuild from '../guild.vue'
import { useMessageStore } from '../../stores/message'

const gid = ref<string>(null)

const { guildMembers } = useMessageStore()
const loadingMemberGids = reactive(new Set<string>())
const membersLoading = computed(() => gid.value && loadingMemberGids.has(gid.value))

onMounted(async () => {
  await Promise.all(store.messageDb.savedGuilds.map(async guild => {
    const gid = getGid(guild)
    if (guildMembers[gid]) return
    loadingMemberGids.add(gid)
    try {
      const members = await send('message-db/getGuildMembers', {
        guildQuery: {
          platform: guild.platform,
          guildId: guild.guildId,
        }
      })
      if ('error' in members) return
      guildMembers[gid] = Object.fromEntries(members.map(member => [ member.user.id, member ]))
    }
    catch {}
    finally {
      loadingMemberGids.delete(gid)
    }
  }))
})

const toolbarEl = useTemplateRef('toolbar')
</script>

<template>
  <div class="tab-messages">
    <div class="toolbar group">
      <select-guild class="select-guild" v-model="gid" />
      <span v-if="membersLoading" class="members-loading">成员信息加载中……</span>

      <div ref="toolbar"></div>
    </div>

    <k-content>
      <KeepAlive>
        <w-guild
          v-if="gid"
          :key="gid"
          :gid="gid"
          :toolbar-el="toolbarEl"
          :members-loading="membersLoading"
        />
      </KeepAlive>
    </k-content>
  </div>
</template>

<style scoped>
.tab-messages {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.select-guild {
  max-width: 25rem;
  max-height: 40.45rem;
}

.toolbar {
  padding: 1rem;
  flex-wrap: wrap;
}

.members-loading {
  color: var(--fg2);
  font-size: .85rem;
}
</style>
