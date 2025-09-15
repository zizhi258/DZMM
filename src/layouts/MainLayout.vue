<template>
  <div class="layout">
    <el-container class="layout-container">
      <el-header class="layout-header" height="64px">
        <el-tabs v-model="active">
          <el-tab-pane label="消息" name="chat" />
          <el-tab-pane label="探索" name="explore" />
          <el-tab-pane label="广场" name="square" />
        </el-tabs>
      </el-header>
      <el-main class="layout-main">
        <RouterView />
      </el-main>
    </el-container>
  </div>
</template>

<script setup lang="ts">
  import { computed } from 'vue'
  import { useRoute, useRouter, RouterView } from 'vue-router'

  defineOptions({ name: 'MainLayout' })

  const route = useRoute()
  const router = useRouter()

  const active = computed({
    get: () => (route.name as string) || 'chat',
    set: (name: string) => {
      if (name && name !== route.name) {
        router.push({ name })
      }
    },
  })
</script>

<style scoped>
  .layout-container {
    height: 100vh;
  }
  .layout-header {
    border-bottom: 1px solid #ebeef5;
    background-color: #fff;
  }
  .layout-main {
    padding: 0;
    background-color: #f5f7fa;
    height: calc(100vh - 64px);
    overflow: hidden;
  }
</style>
