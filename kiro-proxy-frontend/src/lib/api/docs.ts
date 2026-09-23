import axios from 'axios'
import { useAuthStore } from '@/stores/auth-store'

const apiBase =
  import.meta.env.VITE_KIRO_API_BASE_URL ??
  import.meta.env.VITE_API_BASE_URL ??
  // 缺省指向本地后端；线上地址通过 .env.production / .env.local 注入，不写进仓库。
  'http://127.0.0.1:8080/api'

export type DocStatus = 'DRAFT' | 'PUBLISHED'
export type DocArticle = {
  id: number
  categoryId: number
  title: string
  slug: string
  contentHtml: string
  sortOrder: number
  status: DocStatus
  publishedAt: string | null
  createdAt: string
  updatedAt: string
}
export type DocCategory = {
  id: number
  title: string
  sortOrder: number
  enabled: boolean
  createdAt: string
  updatedAt: string
  children: DocArticle[]
}
export type DocsPayload = {
  title: string
  updatedAt: string | null
  sections: DocCategory[]
}
export type CategoryInput = Pick<DocCategory, 'title' | 'sortOrder' | 'enabled'>
export type ArticleInput = Pick<
  DocArticle,
  'categoryId' | 'title' | 'slug' | 'contentHtml' | 'sortOrder' | 'status'
> & { uploadSessionId?: string }

async function adminRequest<T>(
  url: string,
  options: { method?: string; data?: unknown } = {}
) {
  const token = useAuthStore.getState().auth.accessToken
  const response = await axios.request<T>({
    baseURL: apiBase,
    url,
    method: options.method ?? 'GET',
    data: options.data,
    timeout: 30_000,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  return response.data
}

export async function getPublicDocs() {
  const response = await axios.get<DocsPayload>(`${apiBase}/public/docs`, {
    timeout: 30_000,
  })
  return response.data
}
export function getAdminDocs() {
  return adminRequest<DocsPayload>('/admin/docs')
}
export function createDocCategory(data: CategoryInput) {
  return adminRequest<DocCategory>('/admin/docs/categories', {
    method: 'POST',
    data,
  })
}
export function updateDocCategory(id: number, data: CategoryInput) {
  return adminRequest<DocCategory>(`/admin/docs/categories/${id}`, {
    method: 'PUT',
    data,
  })
}
export function deleteDocCategory(id: number) {
  return adminRequest<void>(`/admin/docs/categories/${id}`, {
    method: 'DELETE',
  })
}
export function createDocArticle(data: ArticleInput) {
  return adminRequest<DocArticle>('/admin/docs/articles', {
    method: 'POST',
    data,
  })
}
export function updateDocArticle(id: number, data: ArticleInput) {
  return adminRequest<DocArticle>(`/admin/docs/articles/${id}`, {
    method: 'PUT',
    data,
  })
}
export function publishDocArticle(id: number) {
  return adminRequest<DocArticle>(`/admin/docs/articles/${id}/publish`, {
    method: 'POST',
  })
}
export function deleteDocArticle(id: number) {
  return adminRequest<void>(`/admin/docs/articles/${id}`, { method: 'DELETE' })
}
export async function uploadDocImage(
  file: File,
  articleId: number | undefined,
  uploadSessionId: string
) {
  const token = useAuthStore.getState().auth.accessToken
  const form = new FormData()
  form.append('file', file)
  if (articleId) form.append('articleId', String(articleId))
  form.append('uploadSessionId', uploadSessionId)
  const response = await axios.post<{ id: number; url: string; key: string }>(
    `${apiBase}/admin/docs/assets`,
    form,
    {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      timeout: 60_000,
    }
  )
  return response.data
}
