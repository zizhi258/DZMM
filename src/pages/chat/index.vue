<template>
  <div class="chat-page">
    <section class="sidebar">
      <div class="sidebar-head">
        <el-input v-model="q" placeholder="搜索会话" clearable>
          <template #append>
            <el-button :icon="Plus" @click="newConversation" />
          </template>
        </el-input>
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
      <div class="chat-header">
        <el-select v-model="model" placeholder="选择模型" style="width: 240px">
          <el-option
            v-for="item in models"
            :key="item.id"
            :label="item.name"
            :value="item.id"
          />
        </el-select>
      </div>
      <el-scrollbar ref="scrollRef" class="messages">
        <div
          class="message"
          v-for="m in messages"
          :key="m.id"
          :class="m.role"
          @mouseenter="hoveredMessageId = m.id"
          @mouseleave="hoveredMessageId = null"
        >
          <img
            :src="
              m.role === 'user'
                ? '/assets/user-avatar.svg'
                : '/assets/ai-avatar.svg'
            "
            class="avatar"
          />
          <div class="message-content">
            <div v-if="editingMessageId === m.id" class="edit-mode">
              <el-input type="textarea" v-model="editText" :rows="4" />
              <div class="edit-actions">
                <el-button size="small" type="primary" @click="saveEdit"
                  >保存</el-button
                >
                <el-button size="small" @click="cancelEdit">取消</el-button>
              </div>
            </div>
            <div v-else class="bubble-wrap">
              <div class="actions" v-if="hoveredMessageId === m.id">
                <el-icon @click="startEdit(m)"><Edit /></el-icon>
                <el-icon @click="deleteMessage(m.id)"><Delete /></el-icon>
              </div>
              <div
                class="bubble"
                v-if="m.role === 'assistant'"
                v-html="marked(m.text)"
              ></div>
              <div class="bubble" v-else>{{ m.text }}</div>
            </div>
          </div>
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
          <el-button
            :disabled="isStreaming"
            type="primary"
            circle
            @click="send"
            :icon="Promotion"
          />
          <el-button
            v-if="isStreaming"
            type="warning"
            plain
            @click="stop"
            circle
            :icon="VideoPause"
          />
        </div>
      </div>
    </section>

    <section class="settings">
      <el-scrollbar class="settings-scroll">
        <div class="settings-panel">
          <el-form label-position="top" :model="settings">
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
            <el-button type="danger" plain @click="deleteCurrentConversation"
              >删除此会话</el-button
            >
          </el-form>
        </div>
      </el-scrollbar>
    </section>
  </div>
</template>

<script setup lang="ts">
  import { ref, reactive, computed, nextTick, watch, onMounted } from 'vue'
  import { ElMessage, ElScrollbar, ElMessageBox } from 'element-plus'
  import {
    Edit,
    Delete,
    Plus,
    Promotion,
    VideoPause,
  } from '@element-plus/icons-vue'
  import { marked } from 'marked'
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
  function removeMessages(convId: number) {
    localStorage.removeItem(LS_MSG_PREFIX + convId)
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
  const hoveredMessageId = ref<number | null>(null)
  const editingMessageId = ref<number | null>(null)
  const editText = ref('')
  const models = ref<{ id: string; name: string }[]>([])

  async function fetchModels() {
    try {
      const apiKey = import.meta.env.VITE_OPENAI_API_KEY
      const baseUrl = import.meta.env.VITE_OPENAI_BASE_URL
      const headers: Record<string, string> = {}
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`
      }
      const response = await fetch(`${baseUrl}/v1/models`, { headers })
      if (!response.ok) {
        throw new Error('Network response was not ok')
      }
      const data = await response.json()
      models.value = data.data.map((m: { id: string }) => ({
        id: m.id,
        name: m.id,
      }))
    } catch (error) {
      console.error('Failed to fetch models:', error)
      ElMessage.error('获取模型列表失败')
    }
  }

  onMounted(() => {
    fetchModels()
  })

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
    const text = draft.value.trim() || ''

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

  function deleteMessage(id: number) {
    const index = messages.value.findIndex(m => m.id === id)
    if (index !== -1) {
      messages.value.splice(index, 1)
    }
  }

  function startEdit(message: Message) {
    editingMessageId.value = message.id
    editText.value = message.text
  }

  function saveEdit() {
    if (editingMessageId.value === null) return
    const message = messages.value.find(m => m.id === editingMessageId.value)
    if (message) {
      message.text = editText.value
    }
    cancelEdit()
  }

  function cancelEdit() {
    editingMessageId.value = null
    editText.value = ''
  }

  async function deleteCurrentConversation() {
    try {
      await ElMessageBox.confirm(
        '确定要删除当前会话吗？此操作将无法撤销。',
        '警告',
        {
          confirmButtonText: '确定',
          cancelButtonText: '取消',
          type: 'warning',
        },
      )

      const idToDelete = selectedId.value
      const index = conversations.value.findIndex(c => c.id === idToDelete)

      if (index !== -1) {
        // 从数组中移除
        conversations.value.splice(index, 1)
        // 从 localStorage 移除消息
        removeMessages(idToDelete)
        // 更新会话列表存储
        saveConversations(conversations.value)

        // 切换到新会话
        if (conversations.value.length > 0) {
          // 优先切换到前一个，否则后一个
          const newIndex = Math.max(0, index - 1)
          selectedId.value = conversations.value[newIndex].id
        } else {
          // 如果没有会话了，则新建一个
          newConversation()
        }
        ElMessage.success('会话已删除')
      }
    } catch {
      // 用户点击了取消
      ElMessage.info('操作已取消')
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
    grid-template-columns: 280px 1fr 280px;
    background-color: #fff;
    color: #333;
  }

  /* Sidebar */
  .sidebar {
    background-color: #fff;
    display: flex;
    flex-direction: column;
    padding: 8px;
  }
  .sidebar-head {
    padding: 12px 8px;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .sidebar-head :deep(.el-input__wrapper) {
    border-radius: 8px;
    background-color: #f7f7f8;
    box-shadow: none;
  }
  .sidebar-head :deep(.el-button) {
    border-radius: 8px;
  }
  .sidebar-head :deep(.el-input-group__append) {
    background-color: transparent;
    box-shadow: none;
    border: none;
    padding: 0 0 0 8px;
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
    border-radius: 8px;
    margin-bottom: 4px;
    transition: background-color 0.2s;
  }
  .conv-item:hover {
    background: #f5f5f5;
  }
  .conv-item.active {
    background-color: #efe7fb;
    color: #6a2c9d;
  }
  .conv-item.active .title {
    color: #6a2c9d;
  }
  .conv-item.active .subtitle {
    color: #8b5fbf;
  }
  .conv-item .title {
    font-weight: 500;
    color: #303133;
    font-size: 14px;
  }
  .conv-item .subtitle {
    font-size: 12px;
    color: #909399;
    margin-top: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Chat Area */
  .chat {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .chat-header {
    padding: 12px 24px;
    border-bottom: 1px solid #f0f0f0;
    display: flex;
    align-items: center;
  }
  .messages {
    flex: 1;
    padding: 24px;
    min-height: 0;
    height: 0;
  }
  .messages :deep(.el-scrollbar__wrap) {
    overflow-x: hidden;
    height: 100%;
  }
  .messages :deep(.el-scrollbar__view) {
    display: flex;
    flex-direction: column;
    gap: 28px;
  }
  .message {
    display: flex;
    gap: 16px;
  }
  .message.user {
    flex-direction: row-reverse;
  }
  .avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    flex-shrink: 0;
    background: #f0f2f5;
    border: 1px solid rgba(0, 0, 0, 0.05);
  }
  .message-content {
    display: flex;
    flex-direction: column;
    max-width: 85%;
  }
  .bubble-wrap {
    position: relative;
  }
  .actions {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
    padding: 6px;
    display: flex;
    gap: 10px;
    z-index: 10;
    opacity: 0;
    transition: opacity 0.2s;
    pointer-events: none;
  }
  .message.user .actions {
    left: -48px;
  }
  .message.assistant .actions {
    right: -48px;
  }
  .bubble-wrap:hover .actions {
    opacity: 1;
    pointer-events: auto;
  }
  .actions .el-icon {
    cursor: pointer;
    color: #606266;
    font-size: 16px;
  }
  .actions .el-icon:hover {
    color: #6a2c9d;
  }
  .edit-mode {
    width: 100%;
  }
  .edit-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
  }
  .bubble {
    padding: 12px 16px;
    border-radius: 12px;
    background: #fff;
    color: #303133;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.6;
    border: 1px solid #e5e5e5;
  }
  .message.user .bubble {
    background: #f9f5fe;
    border-color: #e9d8ff;
  }

  /* Composer */
  .composer {
    background: #fff;
    padding: 12px 24px;
    border-top: 1px solid #f0f0f0;
    position: relative;
  }
  .composer :deep(.el-textarea__inner) {
    border-radius: 12px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
    padding: 12px 56px 12px 12px; /* 为按钮留出空间 */
  }
  .composer-actions {
    position: absolute;
    right: 40px;
    bottom: 30px;
    display: flex;
    gap: 8px;
  }

  /* Settings */
  .settings {
    background: #fff;
    height: 100%;
  }
  .settings-scroll {
    height: 100%;
    padding: 24px;
  }
  .settings-panel {
    padding-right: 8px;
  }
  .settings-panel :deep(.el-form-item__label) {
    font-weight: 500;
    color: #555;
    padding-bottom: 2px;
  }
  .settings-panel :deep(.el-form-item) {
    margin-bottom: 22px;
  }
  .settings-panel :deep(.el-select),
  .settings-panel :deep(.el-input-number) {
    width: 100%;
  }
  .settings-panel :deep(.el-divider) {
    margin: 24px 0;
  }
  .settings-panel :deep(.el-button--danger) {
    width: 100%;
  }

  /* Markdown Content */
  .bubble :deep(h1),
  .bubble :deep(h2),
  .bubble :deep(h3) {
    margin-top: 1.2em;
    margin-bottom: 0.6em;
    font-weight: 600;
  }
  .bubble :deep(p) {
    margin-bottom: 1em;
  }
  .bubble :deep(ul),
  .bubble :deep(ol) {
    padding-left: 1.5em;
    margin-bottom: 1em;
  }
  .bubble :deep(pre) {
    background-color: #f5f5f5;
    padding: 1em;
    border-radius: 8px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .bubble :deep(code) {
    font-family: Consolas, Monaco, 'Andale Mono', 'Ubuntu Mono', monospace;
    background-color: #f5f5f5;
    padding: 0.2em 0.4em;
    border-radius: 4px;
    font-size: 90%;
  }
  .bubble :deep(pre) > code {
    background-color: transparent;
    padding: 0;
  }
</style>
