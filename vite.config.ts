import { fileURLToPath, URL } from 'node:url'

import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target =
    env.VITE_OPENAI_BASE_URL || 'https://jimiround-latest.onrender.com/ '
  const headers: Record<string, string> = {}
  if (env.VITE_OPENAI_API_KEY) {
    headers.Authorization = `Bearer ${env.VITE_OPENAI_API_KEY}`
  }

  return {
    plugins: [
      vue(),
      vueDevTools(),
      AutoImport({
        resolvers: [ElementPlusResolver()],
      }),
      Components({
        resolvers: [ElementPlusResolver()],
      }),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      proxy: {
        // 前端以 /api 为基地址，请求如 /api/v1/chat/completions
        '/api': {
          target,
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api/, ''),
          headers,
        },
      },
    },
  }
})
