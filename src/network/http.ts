/**
 * 全局 HTTP 客户端（基于 fetch）
 * - 支持请求、响应拦截器
 * - 支持常规 JSON 请求
 * - 支持 SSE 流式请求（适配 OpenAI 兼容接口）
 *
 * 使用方式：
 *   import http from '@/network/http'
 *   const data = await http.get('/xxx', { params: { a: 1 } })
 *   const close = await http.sse('/v1/chat/completions', { method: 'POST', body: {...} }, event => {...})
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** JSON 值类型，用于需要序列化的对象 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue }

/** 请求体类型：原生 fetch BodyInit 或任意可序列化对象（在 json!==false 时自动 JSON.stringify） */
export type RequestBody = BodyInit | unknown

/** 统一的错误类型 */
export interface HttpError extends Error {
  status?: number
  data?: unknown
  request?: HttpRequestConfig
}

export interface HttpRequestConfig {
  url: string
  method?: HttpMethod
  baseURL?: string
  headers?: Record<string, string>
  params?: Record<string, unknown>
  body?: RequestBody
  timeoutMs?: number
  // 是否把 body 序列化为 JSON（默认 true，若传入 FormData/Blob/ArrayBuffer 等请置为 false）
  json?: boolean
  // 流式场景可自定义 fetch 的其它参数
  fetchOptions?: RequestInit
}

export interface HttpResponse<T = unknown> {
  status: number
  statusText: string
  headers: Headers
  data: T
  request: HttpRequestConfig
}

type RequestInterceptor = (
  config: HttpRequestConfig,
) => Promise<HttpRequestConfig> | HttpRequestConfig
type ResponseInterceptor<T = unknown> = (
  resp: HttpResponse<T>,
) => Promise<HttpResponse<T>> | HttpResponse<T>
type ErrorInterceptor = (
  error: unknown,
  request?: HttpRequestConfig,
) => Promise<never> | never

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Object.prototype.toString.call(v) === '[object Object]'
}

function buildURL(
  baseURL: string,
  url: string,
  params?: Record<string, unknown>,
) {
  // 将相对 baseURL（如 '/api'）提升为绝对地址
  const baseAbs =
    baseURL && !/^https?:/i.test(baseURL)
      ? new URL(baseURL, window.location.origin).toString()
      : baseURL || window.location.origin

  const baseObj = new URL(baseAbs, window.location.origin)

  // new URL('/v1', 'http://host/api') 会丢失 '/api' 前缀，这里手工拼接 pathname 以保留前缀
  const basePath = baseObj.pathname.replace(/\/$/, '')
  const urlPath = url.startsWith('/') ? url : `/${url}`
  const u = new URL(basePath + urlPath, baseObj.origin)

  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v === undefined || v === null) return
      if (Array.isArray(v)) {
        v.forEach(i => u.searchParams.append(k, String(i)))
      } else if (isPlainObject(v)) {
        u.searchParams.append(k, JSON.stringify(v))
      } else {
        u.searchParams.append(k, String(v))
      }
    })
  }
  return u.toString()
}

function abortAfter(timeoutMs?: number) {
  if (!timeoutMs || timeoutMs <= 0) return undefined
  const controller = new AbortController()
  // 超时后中断；无需持有 timer 变量
  setTimeout(() => controller.abort(), timeoutMs)
  return controller
}
/** 判断是否为可直接作为 fetch body 的 BodyInit */
function isBodyInit(v: unknown): v is BodyInit {
  if (typeof v === 'string') return true
  if (typeof ReadableStream !== 'undefined' && v instanceof ReadableStream)
    return true
  if (typeof Blob !== 'undefined' && v instanceof Blob) return true
  if (typeof FormData !== 'undefined' && v instanceof FormData) return true
  if (typeof URLSearchParams !== 'undefined' && v instanceof URLSearchParams)
    return true
  if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer)
    return true
  // 判断 ArrayBufferView（TypedArray/DataView）
  if (
    typeof ArrayBuffer !== 'undefined' &&
    ArrayBuffer.isView(v as ArrayBufferView)
  )
    return true
  return false
}

/** 将任意 RequestBody 转换为 fetch 可接受的 BodyInit | undefined */
function toBodyInit(
  body: RequestBody | undefined,
  asJson: boolean,
): BodyInit | undefined {
  if (body == null) return undefined
  if (asJson) {
    return typeof body === 'string' ? body : JSON.stringify(body)
  }
  return isBodyInit(body) ? body : String(body)
}

class HttpClient {
  private baseURL: string
  private requestInterceptors: RequestInterceptor[] = []
  private responseInterceptors: ResponseInterceptor<unknown>[] = []
  private errorInterceptors: ErrorInterceptor[] = []

  // 简单的 token 管理（放在 localStorage，可按需替换为 pinia/自定义方案）
  private tokenKey = 'access_token'

  constructor(baseURL?: string) {
    this.baseURL =
      baseURL || (import.meta.env.VITE_API_BASE_URL as string) || '/api'

    // 默认请求拦截器：附加默认 Header、基地址、Authorization
    this.useRequestInterceptor(async config => {
      const headers: Record<string, string> = {
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        ...(config.headers || {}),
      }

      const shouldJson =
        config.json !== false &&
        !(config.body instanceof FormData) &&
        !(config.body instanceof Blob) &&
        !(config.body instanceof ArrayBuffer)
      if (shouldJson) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json'
      }

      // Authorization
      const token = this.getToken()
      if (token && !headers.Authorization) {
        headers.Authorization = `Bearer ${token}`
      }

      // 先合并入参，再兜底 baseURL/timeout，避免被 undefined 覆盖
      return {
        ...config,
        baseURL: config.baseURL ?? this.baseURL,
        timeoutMs: config.timeoutMs ?? 30000,
        headers,
      }
    })

    // 默认响应拦截器：如果是 json 则解析，统一封装 HttpResponse
    this.useResponseInterceptor(async resp => resp)

    // 默认错误拦截器：直接抛出
    this.useErrorInterceptor(err => {
      throw err
    })
  }

  setBaseURL(v: string) {
    this.baseURL = v
  }

  setToken(token: string | null) {
    if (!token) {
      localStorage.removeItem(this.tokenKey)
    } else {
      localStorage.setItem(this.tokenKey, token)
    }
  }

  getToken() {
    return localStorage.getItem(this.tokenKey) || ''
  }

  useRequestInterceptor(fn: RequestInterceptor) {
    this.requestInterceptors.push(fn)
  }

  useResponseInterceptor(fn: ResponseInterceptor) {
    this.responseInterceptors.push(fn)
  }

  useErrorInterceptor(fn: ErrorInterceptor) {
    this.errorInterceptors.push(fn)
  }

  private async runRequestInterceptors(config: HttpRequestConfig) {
    let c = config
    for (const it of this.requestInterceptors) {
      c = await it(c)
    }
    return c
  }

  private async runResponseInterceptors<T>(
    resp: HttpResponse<T>,
  ): Promise<HttpResponse<T>> {
    let r: HttpResponse<T> = resp
    for (const it of this.responseInterceptors as ResponseInterceptor<T>[]) {
      r = await it(r)
    }
    return r
  }

  private async runErrorInterceptors(
    error: unknown,
    request?: HttpRequestConfig,
  ): Promise<never> {
    let err = error
    for (const it of this.errorInterceptors) {
      try {
        // 允许拦截器抛出或返回 rejected promise
        await it(err, request)
      } catch (e) {
        err = e
      }
    }
    throw err
  }

  async request<T = unknown>(
    config: HttpRequestConfig,
  ): Promise<HttpResponse<T>> {
    try {
      const final = await this.runRequestInterceptors({ ...config })
      const url = buildURL(
        final.baseURL || this.baseURL,
        final.url,
        final.params,
      )

      const controller = abortAfter(final.timeoutMs)
      const isJson =
        final.json !== false &&
        !(final.body instanceof FormData) &&
        !(final.body instanceof Blob) &&
        !(final.body instanceof ArrayBuffer)

      const init: RequestInit = {
        method: final.method || 'GET',
        headers: final.headers,
        body: toBodyInit(final.body as RequestBody | undefined, isJson),
        signal: controller?.signal,
        ...final.fetchOptions,
      }

      const res = await fetch(url, init)
      const contentType = res.headers.get('content-type') || ''

      let data: unknown
      if (contentType.includes('application/json')) {
        data = await res.json()
      } else if (contentType.includes('text/')) {
        data = await res.text()
      } else {
        data = await res.arrayBuffer()
      }

      if (!res.ok) {
        // 尝试从返回体中取 message
        const msg = isPlainObject(data)
          ? String(
              (data as Record<string, unknown>).message ??
                (data as Record<string, unknown>).error ??
                res.statusText,
            )
          : res.statusText
        const error: HttpError = new Error(`HTTP ${res.status} ${msg}`)
        error.status = res.status
        error.data = data
        error.request = final
        return this.runErrorInterceptors(error, final)
      }

      const wrapped: HttpResponse<T> = {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        data: data as T,
        request: final,
      }
      return await this.runResponseInterceptors(wrapped)
    } catch (e: unknown) {
      return this.runErrorInterceptors(e, config)
    }
  }

  get<T = unknown>(
    url: string,
    config?: Omit<HttpRequestConfig, 'url' | 'method'>,
  ) {
    return this.request<T>({ ...(config || {}), url, method: 'GET' })
  }

  post<T = unknown>(
    url: string,
    body?: RequestBody,
    config?: Omit<HttpRequestConfig, 'url' | 'method' | 'body'>,
  ) {
    return this.request<T>({ ...(config || {}), url, method: 'POST', body })
  }

  put<T = unknown>(
    url: string,
    body?: RequestBody,
    config?: Omit<HttpRequestConfig, 'url' | 'method' | 'body'>,
  ) {
    return this.request<T>({ ...(config || {}), url, method: 'PUT', body })
  }

  patch<T = unknown>(
    url: string,
    body?: RequestBody,
    config?: Omit<HttpRequestConfig, 'url' | 'method' | 'body'>,
  ) {
    return this.request<T>({ ...(config || {}), url, method: 'PATCH', body })
  }

  delete<T = unknown>(
    url: string,
    config?: Omit<HttpRequestConfig, 'url' | 'method'>,
  ) {
    return this.request<T>({ ...(config || {}), url, method: 'DELETE' })
  }

  /**
   * SSE 流式请求（适配 OpenAI 兼容接口返回的 text/event-stream）
   * - onEvent 接收每一行 data（已去除前缀 "data: "），当收到 "[DONE]" 时自动完成
   * - 返回一个关闭函数，可手动终止
   */
  async sse(
    url: string,
    init: Omit<HttpRequestConfig, 'url'> & {
      onEvent: (data: string) => void
      onDone?: () => void
    },
  ): Promise<() => void> {
    const { onEvent, onDone, ...rest } = init
    const final = await this.runRequestInterceptors({
      url,
      method: rest.method || 'POST',
      baseURL: rest.baseURL,
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        ...(rest.headers || {}),
      },
      params: rest.params,
      body: rest.body
        ? rest.json === false
          ? rest.body
          : typeof rest.body === 'string'
            ? rest.body
            : JSON.stringify(rest.body)
        : undefined,
      timeoutMs: rest.timeoutMs ?? 0, // SSE 一般不做强制超时
      fetchOptions: rest.fetchOptions,
    })

    const controller = new AbortController()
    const u = buildURL(final.baseURL || this.baseURL, final.url, final.params)

    const res = await fetch(u, {
      method: final.method || 'POST',
      headers: final.headers,
      body: toBodyInit(final.body as RequestBody | undefined, false),
      signal: controller.signal,
      ...final.fetchOptions,
    })

    if (!res.ok) {
      let errBody: unknown = null
      try {
        const ct = res.headers.get('content-type') || ''
        errBody = ct.includes('application/json')
          ? await res.json()
          : await res.text()
      } catch {}
      const error: HttpError = new Error(
        `SSE HTTP ${res.status} ${res.statusText}`,
      )
      error.status = res.status
      error.data = errBody
      error.request = final
      await this.runErrorInterceptors(error, final)
    }

    const reader = res.body?.getReader()
    if (!reader) {
      const error: HttpError = new Error('SSE reader not available')
      error.request = final
      await this.runErrorInterceptors(error, final)
    }

    const textDecoder = new TextDecoder('utf-8')
    let buffer = ''
    let doneNotified = false

    ;(async () => {
      try {
        while (true) {
          const { done, value } = await reader!.read()
          if (done) break
          buffer += textDecoder.decode(value, { stream: true })
          // 兼容 CRLF：统一为 \n 再按 \n\n 切分
          buffer = buffer.replace(/\r\n/g, '\n')
          let idx
          // 按照 \n\n 分包（eventsource 事件边界）
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, idx).trim()
            buffer = buffer.slice(idx + 2)
            // 解析每行 data: xxx（容忍空行与注释）
            chunk.split('\n').forEach(line => {
              const trimmed = line.trim()
              if (!trimmed || !trimmed.startsWith('data:')) return
              const data = trimmed.replace(/^data:\s?/, '')
              if (data === '[DONE]') {
                controller.abort()
                return
              }
              onEvent(data)
            })
          }
        }
        // 正常读取完成但未显式发送 [DONE]
        if (!doneNotified) {
          try {
            onDone?.()
          } catch {}
          doneNotified = true
        }
      } catch (e) {
        // 仅在未主动 abort 时走错误拦截
        if (!(e instanceof DOMException && e.name === 'AbortError')) {
          await this.runErrorInterceptors(e, final)
        }
      }
    })()

    return () => controller.abort()
  }
}

const http = new HttpClient(
  (import.meta.env.VITE_API_BASE_URL as string) || '/api',
)

// 示例：业务层可在此增加统一响应拦截（按需启用，避免强绑定业务协议）
// http.useResponseInterceptor(async resp => {
//   const d = resp.data as any
//   if (isPlainObject(d) && 'code' in d) {
//     if (d.code !== 0) {
//       const err = new Error(d.message || '请求失败')
//       ;(err as any).data = d
//       return http['runErrorInterceptors'](err, resp.request)
//     }
//     return { ...resp, data: d.data }
//   }
//   return resp
// })

export default http
