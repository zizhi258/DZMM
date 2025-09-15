import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import 'element-plus/dist/index.css'
import http from '@/network/http'

const app = createApp(App)

app.use(createPinia())
app.use(router)

// 从环境变量设置默认 Token，便于直连 OpenAI 兼容网关（开发期演示用途）
http.setToken((import.meta.env.VITE_OPENAI_API_KEY as string) || null)

app.mount('#app')
