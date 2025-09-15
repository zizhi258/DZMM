import http from '@/network/http'

export type OAIRole = 'system' | 'user' | 'assistant'

export interface OAIMessage {
  role: OAIRole
  content: string
}

export interface OAIChatCompletionRequest {
  model: string
  messages: OAIMessage[]
  temperature?: number
  top_p?: number
  presence_penalty?: number
  frequency_penalty?: number
  stream?: boolean
}

/** OpenAI 兼容的流式分片结构 */
export interface OAIChatCompletionChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: 'assistant'
      content?: string
    }
    finish_reason: 'stop' | 'length' | 'content_filter' | null
  }>
}

/** 非流式请求（仅演示，demo 主要使用 stream） */
export async function createChatCompletion<T = unknown>(
  payload: OAIChatCompletionRequest,
) {
  const { data } = await http.post<T>(
    '/v1/chat/completions',
    payload as unknown,
  )
  return data
}

export interface StreamCallbacks {
  onText?: (text: string) => void
  onRole?: (role: 'assistant') => void
  onError?: (err: unknown) => void
  onFinished?: (reason: 'stop' | 'length' | 'content_filter' | 'done') => void
}

/**
 * 发起 OpenAI 兼容的 Chat Completions 流式请求（SSE）
 * 返回关闭函数，可用于“停止生成”
 */
export async function streamChatCompletion(
  payload: OAIChatCompletionRequest,
  cb: StreamCallbacks,
): Promise<() => void> {
  const close = await http
    .sse('/v1/chat/completions', {
      method: 'POST',
      body: { ...payload, stream: true } as unknown,
      onEvent: (raw: string) => {
        try {
          const chunk: OAIChatCompletionChunk = JSON.parse(raw)
          const choice = chunk.choices?.[0]
          if (!choice) return

          const { delta, finish_reason } = choice
          if (delta?.role && cb.onRole) cb.onRole(delta.role)
          if (delta?.content && cb.onText) cb.onText(delta.content)

          if (finish_reason) {
            cb.onFinished?.(finish_reason)
          }
        } catch {
          // 某些实现可能穿插 keepalive 字符或非 JSON 行，忽略解析错误
        }
      },
    })
    .catch(err => {
      cb.onError?.(err)
      // 抛出一个可调用的空函数，避免上层崩溃
      return () => {}
    })

  return close
}

/** 简易的工具：将历史消息裁剪为不超过 tokens 的近似限制（仅预留，未启用精确估算） */
export function buildHistory(messages: OAIMessage[], max = 50): OAIMessage[] {
  if (messages.length <= max) return messages
  return messages.slice(-max)
}

/** 默认模型从环境变量读取（可在 UI 中覆盖） */
export function getDefaultModel() {
  return (import.meta.env.VITE_OPENAI_MODEL as string) || 'gpt-3.5-turbo'
}
