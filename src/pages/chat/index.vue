<template>
  <div class="chat-page">
    <section class="sidebar">
      <div class="sidebar-head">
        <el-input v-model="q" placeholder="搜索会话" clearable />
        <el-button type="primary" size="small" @click="newConversation"
          >新建会话</el-button
        >
      </div>
      <el-scrollbar class="sidebar-list">
        <ul class="conv-list">
          <li
            v-for="c in filteredConvs"
            :key="c.id"
            :class="['conv-item', { active: c.id === selectedId }]"
            @click="selectConv(c.id)"
          >
            <div class="title">{{ c.title }}</div>
            <div class="subtitle">{{ c.subtitle }}</div>
          </li>
        </ul>
      </el-scrollbar>
    </section>

    <section class="chat">
      <el-scrollbar ref="scrollRef" class="messages">
        <div class="message" v-for="m in messages" :key="m.id" :class="m.role">
          <div class="bubble">{{ m.text }}</div>
        </div>
      </el-scrollbar>
      <div class="composer">
        <el-input
          v-model="draft"
          type="textarea"
          :rows="3"
          placeholder="输入消息，Shift+Enter 换行"
          :disabled="isStreaming"
          @keydown.enter.prevent="onEnter"
        />
        <div class="composer-actions">
          <el-button :disabled="isStreaming" type="primary" @click="send"
            >发送</el-button
          >
          <el-button v-if="isStreaming" type="warning" plain @click="stop"
            >停止</el-button
          >
        </div>
      </div>
    </section>

    <section class="settings">
      <el-scrollbar class="settings-scroll">
        <div class="settings-panel">
          <el-form label-width="100px" :model="settings">
            <el-form-item label="开启高亮">
              <el-switch v-model="settings.highlight" />
            </el-form-item>
            <el-form-item label="会话标题">
              <el-input v-model="settings.title" />
            </el-form-item>
            <el-form-item label="风格">
              <el-select v-model="settings.style">
                <el-option
                  v-for="opt in styles"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="声优">
              <el-select v-model="settings.voice" placeholder="选择声优">
                <el-option
                  v-for="v in voices"
                  :key="v.value"
                  :label="v.label"
                  :value="v.value"
                />
              </el-select>
            </el-form-item>
            <el-divider />
            <el-form-item label="自动生成语音">
              <el-switch v-model="settings.tts" />
            </el-form-item>
            <el-form-item label="忽略括号内容">
              <el-switch v-model="settings.ignoreBrackets" />
            </el-form-item>
            <el-form-item label="只朗读引号">
              <el-switch v-model="settings.readQuotesOnly" />
            </el-form-item>
            <el-form-item label="忽略英文">
              <el-switch v-model="settings.ignoreEnglish" />
            </el-form-item>
            <el-form-item label="仅读星号">
              <el-switch v-model="settings.readAsteriskOnly" />
            </el-form-item>
            <el-divider />
            <el-button type="danger" plain>删除此会话</el-button>
          </el-form>
        </div>
      </el-scrollbar>
    </section>
  </div>
</template>

<script setup lang="ts">
  import { ref, reactive, computed, nextTick, watch } from 'vue'
  import { ElMessage, ElScrollbar } from 'element-plus'
  import {
    streamChatCompletion,
    buildHistory,
    getDefaultModel,
  } from '@/network/openai'

  // 本地存储键与类型
  const LS_CONVS = 'dzmm_chat_convs'
  const LS_MSG_PREFIX = 'dzmm_chat_msgs_'

  type Conversation = {
    id: number
    title: string
    subtitle: string
    createdAt: number
  }
  type Message = { id: number; role: 'user' | 'assistant'; text: string }

  function safeParse<T>(raw: string | null, fallback: T): T {
    try {
      return raw ? (JSON.parse(raw) as T) : fallback
    } catch {
      return fallback
    }
  }
  function loadConversations(): Conversation[] {
    return safeParse<Conversation[]>(localStorage.getItem(LS_CONVS), [])
  }
  function saveConversations(list: Conversation[]) {
    localStorage.setItem(LS_CONVS, JSON.stringify(list))
  }
  function loadMessages(convId: number): Message[] {
    return safeParse<Message[]>(
      localStorage.getItem(LS_MSG_PREFIX + convId),
      [],
    )
  }
  function saveMessages(convId: number, msgs: Message[]) {
    localStorage.setItem(LS_MSG_PREFIX + convId, JSON.stringify(msgs))
  }

  // 消息列表滚动容器
  const scrollRef = ref<InstanceType<typeof ElScrollbar> | null>(null)
  function scrollToBottom() {
    nextTick(() => {
      const s = scrollRef.value
      if (!s) return
      if (typeof s.setScrollTop === 'function') s.setScrollTop(1e9)
      else if (s.wrapRef) s.wrapRef.scrollTop = s.wrapRef.scrollHeight
    })
  }

  defineOptions({ name: 'ChatIndexPage' })

  const conversations = ref<Conversation[]>(loadConversations())
  if (conversations.value.length === 0) {
    const firstId = Date.now()
    conversations.value.push({
      id: firstId,
      title: '默认会话',
      subtitle: '会话',
      createdAt: Date.now(),
    })
    saveConversations(conversations.value)
  }

  const selectedId = ref<number>(conversations.value[0]?.id ?? Date.now())
  const q = ref('')

  const filteredConvs = computed(() =>
    conversations.value.filter((c: Conversation) =>
      c.title.toLowerCase().includes(q.value.trim().toLowerCase()),
    ),
  )

  const messages = ref<Message[]>(loadMessages(selectedId.value))
  if (messages.value.length === 0) {
    messages.value.push({
      id: 1,
      role: 'assistant',
      text: '你好，这是示例消息。',
    })
    saveMessages(selectedId.value, messages.value)
  }
  // 递增 ID，避免 Date.now() 同毫秒导致的重复或渲染延迟
  const nextId = ref<number>(
    (messages.value[messages.value.length - 1]?.id ?? 0) + 1,
  )

  const draft = ref('')
  const isStreaming = ref(false)
  let stopCurrent: (() => void) | null = null
  const model = ref(getDefaultModel())

  function selectConv(id: number) {
    selectedId.value = id
  }

  // 新建会话
  function newConversation() {
    // 停止可能的流式
    if (stopCurrent) {
      stopCurrent()
      stopCurrent = null
      isStreaming.value = false
    }
    const id = Date.now()
    const conv: Conversation = {
      id,
      title: '新会话',
      subtitle: '会话',
      createdAt: Date.now(),
    }
    conversations.value.unshift(conv)
    saveConversations(conversations.value)
    selectedId.value = id
    messages.value = []
    nextId.value = 1
    settings.title = conv.title
    saveMessages(id, messages.value)
    scrollToBottom()
  }

  // 切换会话时加载消息并同步标题
  watch(selectedId, (id: number) => {
    messages.value = loadMessages(id)
    nextId.value = (messages.value[messages.value.length - 1]?.id ?? 0) + 1
    const conv = conversations.value.find((c: Conversation) => c.id === id)
    if (conv) settings.title = conv.title
    scrollToBottom()
  })

  // 持久化当前会话消息
  watch(messages, (val: Message[]) => saveMessages(selectedId.value, val), {
    deep: true,
  })

  function onEnter(e: KeyboardEvent) {
    if (e.shiftKey) {
      draft.value += '\n'
      return
    }
    send()
  }

  function toOAIHistory(withUser?: { role: 'user'; text: string }) {
    const base = messages.value.map(m => ({ role: m.role, content: m.text }))
    if (withUser) base.push({ role: 'user', content: withUser.text })
    return buildHistory(base, 50)
  }

  async function send() {
    if (isStreaming.value) return
    const text = draft.value.trim()
    if (!text) return

    // 在推入 assistant 占位前构建历史（仅包含已存在消息 + 本次 user）
    const history = toOAIHistory({ role: 'user', text })

    // 推入用户消息
    const user: Message = { id: nextId.value++, role: 'user', text }
    messages.value.push(user)
    draft.value = ''
    scrollToBottom()

    // 预置 assistant 占位
    const assistant: Message = {
      id: nextId.value++,
      role: 'assistant',
      text: '',
    }
    messages.value.push(assistant)
    // 从响应式数组中获取对 assistant 消息的实际引用，以确保更新能够被侦测到
    const reactiveAssistant = messages.value[messages.value.length - 1]
    scrollToBottom()

    isStreaming.value = true
    try {
      stopCurrent = await streamChatCompletion(
        {
          model: model.value,
          messages: history,
          stream: true,
        },
        {
          onText: chunk => {
            // 实时流式渲染
            reactiveAssistant.text += chunk
            scrollToBottom()
          },
          onFinished: () => {
            isStreaming.value = false
            stopCurrent = null
          },
          onError: (err: unknown) => {
            isStreaming.value = false
            stopCurrent = null
            console.error('Chat streaming error:', err)
            if (!assistant.text) {
              assistant.text =
                '对话请求失败，请检查服务地址与密钥配置，或稍后重试。'
            }
            ElMessage.error(
              '请求失败，请检查配置或网络（需要重启服务以应用 .env.local）',
            )
          },
        },
      )
    } catch (e) {
      console.error('Chat send failed:', e)
      isStreaming.value = false
      stopCurrent = null
      ElMessage.error('发送失败，请稍后重试')
    }
  }

  function stop() {
    if (stopCurrent) {
      stopCurrent()
      stopCurrent = null
      isStreaming.value = false
    }
  }

  const settings = reactive({
    highlight: false,
    title:
      conversations.value.find(c => c.id === selectedId.value)?.title || '会话',
    style: 'standard',
    voice: '',
    tts: false,
    ignoreBrackets: false,
    readQuotesOnly: false,
    ignoreEnglish: false,
    readAsteriskOnly: false,
  })

  // 标题改名时更新会话列表与存储
  watch(
    () => settings.title,
    t => {
      const conv = conversations.value.find(c => c.id === selectedId.value)
      if (conv && conv.title !== t) {
        conv.title = t
        saveConversations(conversations.value)
      }
    },
  )

  const styles = [
    { label: '标准', value: 'standard' },
    { label: '活泼', value: 'lively' },
    { label: '严肃', value: 'serious' },
  ]

  const voices = [
    { label: '默认', value: '' },
    { label: '女声A', value: 'female-a' },
    { label: '男声B', value: 'male-b' },
  ]
</script>

<style scoped>
  .chat-page {
    height: 100%;
    display: grid;
    grid-template-columns: 260px 1fr 320px;
    background: #fff;
  }
  .sidebar {
    border-right: 1px solid #ebeef5;
    display: flex;
    flex-direction: column;
  }
  .sidebar-head {
    padding: 12px;
    border-bottom: 1px solid #ebeef5;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .sidebar-list {
    flex: 1;
  }
  .conv-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .conv-item {
    padding: 12px 12px;
    cursor: pointer;
    border-bottom: 1px solid #f2f3f5;
  }
  .conv-item:hover {
    background: #f5f7fa;
  }
  .conv-item.active {
    background: #ecf5ff;
  }
  .conv-item .title {
    font-weight: 500;
    color: #303133;
  }
  .conv-item .subtitle {
    font-size: 12px;
    color: #909399;
    margin-top: 4px;
  }

  .chat {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0; /* 允许子项 .messages 在 flex 容器中正确收缩产生内部滚动 */
    background: #f5f7fa;
  }
  .messages {
    flex: 1;
    padding: 16px;
    min-height: 0; /* 关键：允许内容区域在列布局中可滚动 */
    height: 0;
  }
  .messages :deep(.el-scrollbar__wrap) {
    overflow-x: hidden;
    height: 100%;
  }
  .messages :deep(.el-scrollbar__view) {
    display: flex;
    flex-direction: column;
  }
  .message {
    display: flex;
    margin-bottom: 12px;
  }
  .message.user {
    justify-content: flex-end;
  }
  .bubble {
    max-width: 70%;
    padding: 10px 12px;
    border-radius: 8px;
    background: #fff;
    color: #303133;
    white-space: pre-wrap;
    word-break: break-word;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  }
  .message.user .bubble {
    background: #409eff;
    color: #fff;
  }

  .composer {
    border-top: 1px solid #e4e7ed;
    background: #fff;
    padding: 12px;
    /* 确保输入区固定高度，不被挤压 */
    flex-shrink: 0;
  }
  .composer-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 8px;
  }

  .settings {
    border-left: 1px solid #ebeef5;
    background: #fff;
    height: 100%;
  }
  .settings-scroll {
    height: 100%;
    padding: 16px;
  }
  .settings-panel {
    padding-right: 8px;
  }
</style>
