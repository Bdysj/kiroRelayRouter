import axios, { type AxiosRequestConfig } from 'axios'
import { useAuthStore } from '@/stores/auth-store'
import { t } from '@/lib/i18n'

const adminHttp = axios.create({
  baseURL:
    import.meta.env.VITE_KIRO_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    // 缺省指向本地后端；线上地址通过 .env.production / .env.local 注入，不写进仓库。
    'http://127.0.0.1:8080/api',
  timeout: 30_000,
})

class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message)
    this.name = 'AdminApiError'
  }
}

async function adminRequest<T>(config: AxiosRequestConfig): Promise<T> {
  const token = useAuthStore.getState().auth.accessToken
  try {
    const response = await adminHttp.request<T>({
      ...config,
      headers: {
        ...config.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
    return response.data
  } catch (error) {
    if (!axios.isAxiosError(error)) {
      throw new AdminApiError(t('common.error.requestFailed'), null)
    }
    const status = error.response?.status ?? null
    const body = error.response?.data as
      | { message?: string; error?: string }
      | undefined
    if (status === 401 && config.url !== '/admin/auth/login') {
      useAuthStore.getState().auth.reset()
      if (
        typeof window !== 'undefined' &&
        window.location.pathname !== '/adminLogin'
      ) {
        const redirect = `${window.location.pathname}${window.location.search}`
        window.location.assign(
          `/adminLogin?redirect=${encodeURIComponent(redirect)}`
        )
      }
    }
    throw new AdminApiError(
      body?.message ??
        body?.error ??
        (status
          ? t('common.error.requestFailedWithStatus', { status })
          : t('common.error.timeoutOrNetwork')),
      status
    )
  }
}

type AdminLoginResponse = {
  token: string
  tokenType: string
  expiresAt: string
  username: string
}

export type RelayView = {
  id: number
  name: string
  baseUrl: string
  apiKeyConfigured: boolean
  protocolStrategy: ProtocolStrategy
  protocols: RelayProtocol[]
  enabled: boolean
  priority: number
  weight: number
  healthStatus: 'UNKNOWN' | 'UP' | 'DOWN'
  failureCount: number
  failureThreshold: number
  connectTimeoutMs: number
  readTimeoutMs: number
  maxConcurrency: number
  version: number
  lastHealthCheckAt: string | null
  lastHealthLatencyMs: number | null
  lastSuccessAt: string | null
  modelIds: string[]
}

export type ProtocolStrategy = 'AUTO' | 'OPENAI_SMART' | 'ANTHROPIC_SMART'

export type ProtocolCode =
  | 'OPENAI_CHAT_COMPLETIONS'
  | 'OPENAI_RESPONSES'
  | 'ANTHROPIC_MESSAGES'

export type RelayProtocol = {
  code: ProtocolCode
  enabled: boolean
  priority: number
  pathOverride: string | null
  capabilities: string[]
  verificationStatus: 'UNVERIFIED' | 'VERIFIED' | 'FAILED'
  lastVerifiedAt: string | null
  lastVerificationMessage: string | null
}

export type SaveRelayProtocol = {
  code: ProtocolCode
  enabled: boolean
  priority: number
  pathOverride: string | null
  textSupported: boolean
  imageSupported: boolean
  pdfSupported: boolean
  toolUseSupported: boolean
  toolResultSupported: boolean
  streamingSupported: boolean
  promptCacheSupported: boolean
}

export type SaveRelayBody = {
  id?: number
  name: string
  baseUrl: string
  apiKey?: string
  protocolStrategy: ProtocolStrategy
  protocols: SaveRelayProtocol[]
  verificationTokens?: Partial<Record<ProtocolCode, string>>
  enabled: boolean
  priority: number
  weight: number
  failureThreshold: number
  connectTimeoutMs: number
  readTimeoutMs: number
  maxConcurrency: number
  version?: number
}

export function loginAdmin(username: string, password: string) {
  return adminRequest<AdminLoginResponse>({
    method: 'POST',
    url: '/admin/auth/login',
    data: { username, password },
  })
}

export function listRelays() {
  return adminRequest<RelayView[]>({ method: 'GET', url: '/admin/relays' })
}

export function saveRelay(data: SaveRelayBody) {
  return adminRequest<RelayView>({
    method: 'POST',
    url: '/admin/relays/save',
    data,
  })
}

export type RelayTestModel = {
  modelId: string
  displayName: string
  upstreamModelId: string
}

export function listRelayTestModels(id: number) {
  return adminRequest<RelayTestModel[]>({
    method: 'GET',
    url: `/admin/relays/${id}/test-models`,
  })
}

type UpstreamModel = { modelId: string; displayName: string }

export function listRelayUpstreamModels(id: number) {
  return adminRequest<UpstreamModel[]>({
    method: 'GET',
    url: `/admin/relays/${id}/upstream-models`,
  })
}

export function checkRelayHealth() {
  return adminRequest<{ configured: number; up: number }>({
    method: 'POST',
    url: '/admin/relays/health-check',
  })
}

export function testRelay(id: number) {
  return adminRequest<{
    configurationId: number
    up: boolean
    healthStatus: string
    latencyMs: number | null
    checkedAt: string
  }>({
    method: 'POST',
    url: `/admin/relays/${id}/test`,
  })
}

export type ProtocolTestResult = {
  configurationId: number
  protocol: ProtocolCode
  modelId: string
  connection: boolean
  text: boolean
  streamingTested: boolean
  streaming: boolean | null
  imageTested: boolean
  image: boolean | null
  pdfTested: boolean
  pdf: boolean | null
  verified: boolean
  verificationToken: string | null
  latencyMs: number
  checkedAt: string
  message: string
}

export type ProtocolTestTask = {
  taskId: string
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  result: ProtocolTestResult | null
  message: string | null
  createdAt: string
  completedAt: string | null
}

export function startRelayProtocolDraftTest(
  relay: SaveRelayBody,
  protocol: SaveRelayProtocol,
  modelId: string,
  signal?: AbortSignal
) {
  return adminRequest<ProtocolTestTask>({
    method: 'POST',
    url: '/admin/relays/protocol-test',
    signal,
    data: {
      configurationId: relay.id,
      baseUrl: relay.baseUrl,
      apiKey: relay.apiKey,
      modelId,
      protocolStrategy: relay.protocolStrategy,
      connectTimeoutMs: relay.connectTimeoutMs,
      readTimeoutMs: relay.readTimeoutMs,
      protocol,
    },
  })
}

export function getRelayProtocolDraftTest(
  taskId: string,
  signal?: AbortSignal
) {
  return adminRequest<ProtocolTestTask>({
    method: 'GET',
    url: `/admin/relays/protocol-test/${encodeURIComponent(taskId)}`,
    signal,
  })
}

export function deleteRelay(id: number) {
  return adminRequest<void>({
    method: 'DELETE',
    url: `/admin/relays/${id}`,
  })
}

export type ModelPricing = {
  id?: number
  inputPrice: number
  cacheInputPrice: number
  cacheWriteInputPrice: number
  outputPrice: number
  pricingUnit: number
  currency?: string
  priceSource: string
  minInputTokens: number
  maxInputTokens: number | null
  effectiveFrom: string
  effectiveTo: string | null
  enabled: boolean
}

export type ModelBinding = {
  configurationId: number
  configurationName?: string
  provider?: string
  healthStatus?: RelayView['healthStatus']
  relayPriority?: number
  relayWeight?: number
  upstreamModelId: string
  enabled: boolean
  priorityOverride: number | null
  weightOverride: number | null
  /**
   * 这条路由是否支持推理强度。三态：
   * null = 自动（跟随运行期学到的结果）、false = 确认不支持（永不下发）、
   * true = 确认支持（忽略自动标记，用于纠正误判）。
   */
  reasoningEnabled: boolean | null
  costPrices: ModelPricing[]
  protocolStrategy?: ProtocolStrategy
  protocols: ModelProtocolBinding[] | null
}

export type ModelProtocolBinding = {
  code: ProtocolCode
  enabled: boolean
  priority: number
  capabilities: Record<string, boolean> | null
}

/**
 * 推理强度档位。线上值必须小写：Kiro 自己做显示层转换（xhigh → xHigh，其余首字母大写），
 * 顺序即强度顺序，后端的降级阶梯依赖这个次序。
 */
export const REASONING_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

/**
 * 新建/配置模型时的档位预设，纯粹是省一次查文档，不构成运行时约束 ——
 * 上游到底认不认，由请求链路的自动兜底来兜。
 */
export const REASONING_LEVEL_PRESETS: Record<
  'openai' | 'claude' | 'all',
  ReasoningLevel[]
> = {
  openai: ['low', 'medium', 'high', 'xhigh'],
  claude: ['low', 'medium', 'high', 'max'],
  all: ['low', 'medium', 'high', 'xhigh', 'max'],
}

export type ModelView = {
  modelId: string
  displayName: string
  sortOrder: number
  enabled: boolean
  maxInputTokens: number
  maxOutputTokens: number
  /** 向 Kiro 声明的推理强度档位；为空表示该模型不显示档位下拉框。 */
  reasoningLevels: ReasoningLevel[]
  /** 档位下拉框的默认选中项，必须在 reasoningLevels 里；留空则取最低档。 */
  reasoningDefaultLevel: ReasoningLevel | null
  accessGroupCount: number
  referencePrices: ModelPricing[]
  bindings: ModelBinding[]
}

export function listModels() {
  return adminRequest<ModelView[]>({ method: 'GET', url: '/admin/models' })
}

export function saveModel(
  data: Pick<
    ModelView,
    | 'modelId'
    | 'displayName'
    | 'sortOrder'
    | 'enabled'
    | 'maxInputTokens'
    | 'maxOutputTokens'
    | 'reasoningLevels'
    | 'reasoningDefaultLevel'
  >
) {
  return adminRequest<ModelView>({
    method: 'POST',
    url: '/admin/models/save',
    data,
  })
}

/**
 * 按拖拽后的顺序整体重排模型。
 *
 * 后端会给全部模型重新编号（步长 10），所以存量 `sortOrder` 全是 0 也能得到稳定次序。
 * 返回值是重排后的完整列表，可以直接写回 `['admin-models']` 缓存。
 */
export function reorderModels(modelIds: string[]) {
  return adminRequest<ModelView[]>({
    method: 'PUT',
    url: '/admin/models/sort',
    data: { modelIds },
  })
}

export function setModelEnabled(modelId: string, enabled: boolean) {
  return adminRequest<ModelView>({
    method: 'PUT',
    url: `/admin/models/${encodeURIComponent(modelId)}/enabled`,
    data: { enabled },
  })
}

export function saveModelPrice(modelId: string, data: ModelPricing) {
  return adminRequest<ModelView>({
    method: 'PUT',
    url: `/admin/models/${encodeURIComponent(modelId)}/pricing`,
    data,
  })
}

export function deleteModelPrice(modelId: string, priceId: number) {
  return adminRequest<void>({
    method: 'DELETE',
    url: `/admin/models/${encodeURIComponent(modelId)}/pricing/${priceId}`,
  })
}

type BulkRouteBody = {
  modelIds: string[]
  configurationId: number
  enabled: boolean | null
  setPriorityOverride: boolean
  priorityOverride: number | null
  setWeightOverride: boolean
  weightOverride: number | null
  costPrices: ModelPricing[] | null
  clearCostPrice: boolean
}

export function bulkUpdateRoutes(data: BulkRouteBody) {
  return adminRequest<void>({ method: 'POST', url: '/admin/routes/bulk', data })
}

export function bulkRemoveRouteBindings(data: {
  modelIds: string[]
  configurationId: number
}) {
  return adminRequest<{ removed: number }>({
    method: 'POST',
    url: '/admin/routes/bulk/unbind',
    data,
  })
}

export function saveRouteBinding(
  modelId: string,
  configurationId: number,
  data: ModelBinding
) {
  return adminRequest<ModelView>({
    method: 'PUT',
    url: `/admin/routes/${configurationId}/${encodeURIComponent(modelId)}`,
    data,
  })
}

export function removeRouteBinding(modelId: string, configurationId: number) {
  return adminRequest<void>({
    method: 'DELETE',
    url: `/admin/routes/${configurationId}/${encodeURIComponent(modelId)}`,
  })
}

/**
 * 推理强度不生效的路由告警。
 *
 * `REJECTED` 是已确认的事实（上游明确拒绝、请求已自动降级），
 * `IGNORED` 只是怀疑（请求了中高档位却没产生 reasoning token，也可能是模型自己判断
 * 不需要思考）。两级严重度必须在界面上分开，否则管理员会拿不确定的信号做确定的动作。
 */
export type ReasoningAlertKind = 'REJECTED' | 'IGNORED'

export type ReasoningAlertView = {
  id: number
  configurationId: number
  relayName: string | null
  modelId: string
  modelDisplayName: string | null
  protocolCode: ProtocolCode
  upstreamModelId: string
  kind: ReasoningAlertKind
  /** 触发该告警的独立 Token 数，用于区分单用户异常与普遍现象。 */
  sourceCount: number
  firstSeenAt: string
  lastSeenAt: string
  resolvedAt: string | null
  routeReasoningEnabled: boolean | null
}

export function listReasoningAlerts(openOnly = true) {
  return adminRequest<ReasoningAlertView[]>({
    method: 'GET',
    url: '/admin/routes/reasoning-alerts',
    params: { openOnly },
  })
}

export function resolveReasoningAlert(id: number) {
  return adminRequest<void>({
    method: 'POST',
    url: `/admin/routes/reasoning-alerts/${id}/resolve`,
  })
}

type BillingSummary = {
  requestCount: number
  totalTokens: number
  providerCostUsd: number
  chargedPoints: number
  settledCount: number
  exceptionCount: number
}

export type BillingGroupTotal = {
  groupId: number
  groupDisplayName: string
  requestCount: number
  totalTokens: number
  providerCostUsd: number
  chargedPoints: number
  tokenCount: number
}

export type BillingTokenTotal = {
  tokenId: number
  tokenLabel: string
  groupId: number
  groupDisplayName: string
  status: string
  requestCount: number
  totalTokens: number
  providerCostUsd: number
  chargedPoints: number
}

export type BillingDailyPoint = {
  day: string
  requestCount: number
  totalTokens: number
  providerCostUsd: number
  chargedPoints: number
  groupId?: number
  groupDisplayName?: string
  tokenId?: number
  tokenLabel?: string
  modelId?: string
}

export type BillingModelTotal = {
  modelId: string
  requestCount: number
  totalTokens: number
  providerCostUsd: number
  chargedPoints: number
}

export type BillingAnalytics = {
  from: string
  to: string
  summary: BillingSummary
  groupTotals: BillingGroupTotal[]
  groupDaily: BillingDailyPoint[]
  tokenTotals: BillingTokenTotal[]
  tokenDaily: BillingDailyPoint[]
  modelTotals: BillingModelTotal[]
  modelDaily: BillingDailyPoint[]
}

export type BillingRecord = {
  id: number
  requestId: string
  accessTokenId: number
  tokenLabel: string
  groupId: number
  groupDisplayName: string
  modelId: string
  requestedModelId: string | null
  upstreamModelId: string | null
  reportedModelId: string | null
  upstreamModelSource: 'RESPONSE' | 'CONFIG' | 'UNKNOWN'
  protocolCode: ProtocolCode | null
  relayConfigurationId: number | null
  relayName: string | null
  provider: string | null
  inputTokens: number
  cacheInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  totalTokens: number
  providerCostUsd: number
  toolCostUsd: number
  chargedPoints: number
  currency: string
  priceSource: string
  status: string
  errorCode: string | null
  createdAt: string
  completedAt: string | null
}

type BillingReport = {
  from: string
  to: string
  summary: BillingSummary
  items: BillingRecord[]
  total: number
  page: number
  pageSize: number
}

type BillingFilters = {
  from: string
  to: string
  modelId?: string
  status?: string
  relayId?: number
  keyword?: string
  page: number
  pageSize: number
}

export function getBillingReport(filters: BillingFilters) {
  return adminRequest<BillingReport>({
    method: 'GET',
    url: '/admin/billing',
    params: filters,
  })
}

export function getBillingAnalytics(filters: {
  from: string
  to: string
  relayId?: number
  groupId?: number
  tokenId?: number
}) {
  return adminRequest<BillingAnalytics>({
    method: 'GET',
    url: '/admin/billing/analytics',
    params: filters,
  })
}

type BillingRule = {
  id: number
  version: number
  pointsPerUsd: number
  effectiveFrom: string
  effectiveTo: string | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export function getCurrentBillingRule() {
  return adminRequest<BillingRule>({
    method: 'GET',
    url: '/admin/billing-rule/current',
  })
}

export function getBillingRuleHistory(page: number, pageSize: number) {
  return adminRequest<BillingRule[]>({
    method: 'GET',
    url: '/admin/billing-rule/history',
    params: { page, pageSize },
  })
}

export function updateBillingRule(pointsPerUsd: number) {
  return adminRequest<BillingRule>({
    method: 'POST',
    url: '/admin/billing-rule',
    data: { pointsPerUsd },
  })
}

export type AccessGroup = {
  id: number
  displayName: string
  enabled: boolean
  modelCount: number
  models: string[]
  modelIds: string[]
  modelMultipliers: Record<string, number>
  createdAt: string
  updatedAt: string
}

export type SaveAccessGroupBody = {
  id?: number
  displayName: string
  enabled: boolean
  models: string[]
  modelMultipliers: Record<string, number>
}

export type PageResult<T> = {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export function listAccessGroups(
  page = 1,
  pageSize = 5,
  keyword?: string,
  enabled?: boolean
) {
  return adminRequest<PageResult<AccessGroup>>({
    method: 'GET',
    url: '/admin/access/groups',
    params: { page, pageSize, keyword, enabled },
  })
}

export type AccessSummary = {
  groupTotal: number
  enabledGroupTotal: number
  tokenTotal: number
  activeTokenTotal: number
}

export function getAccessSummary() {
  return adminRequest<AccessSummary>({
    method: 'GET',
    url: '/admin/access/summary',
  })
}

export function listAccessGroupOptions() {
  return adminRequest<AccessGroup[]>({
    method: 'GET',
    url: '/admin/access/groups/options',
  })
}

export function saveAccessGroup(data: SaveAccessGroupBody) {
  return adminRequest<AccessGroup>({
    method: data.id ? 'PUT' : 'POST',
    url: data.id ? `/admin/access/groups/${data.id}` : '/admin/access/groups',
    data: {
      displayName: data.displayName,
      enabled: data.enabled,
      models: data.models,
      modelMultipliers: data.modelMultipliers,
    },
  })
}

/**
 * 只改分组名称。
 *
 * 走窄接口而不是 `saveAccessGroup`：后者是全量覆盖，会连带重建模型权限与倍率，
 * 仅为改名而提交整份权限有覆盖他人修改的风险。
 */
export function renameAccessGroup(id: number, displayName: string) {
  return adminRequest<{ id: number; displayName: string }>({
    method: 'PUT',
    url: `/admin/access/groups/${id}/name`,
    data: { displayName },
  })
}

export function setAccessGroupEnabled(id: number, enabled: boolean) {
  return adminRequest<{ id: number; enabled: boolean }>({
    method: 'PUT',
    url: `/admin/access/groups/${id}/enabled`,
    data: { enabled },
  })
}

export function deleteAccessGroup(id: number) {
  return adminRequest<void>({
    method: 'DELETE',
    url: `/admin/access/groups/${id}`,
  })
}

export type IssueAccessTokenBody = {
  label: string
  groupId: number
  enabled: boolean
  expiresAt: string | null
  initialPoints: number
  maxMachineBindings: number
  maxUnbindCount: number
}

export type IssuedAccessToken = IssueAccessTokenBody & {
  token: string
  prefix: string
}

export type BatchIssueAccessTokenBody = Omit<IssueAccessTokenBody, 'label'> & {
  labelPrefix: string
  quantity: number
}

export type BatchIssuedAccessTokens = {
  quantity: number
  groupId: number
  items: IssuedAccessToken[]
}

export function issueAccessToken(data: IssueAccessTokenBody) {
  return adminRequest<IssuedAccessToken>({
    method: 'POST',
    url: '/admin/access/tokens',
    data,
  })
}

export function issueAccessTokensBatch(data: BatchIssueAccessTokenBody) {
  return adminRequest<BatchIssuedAccessTokens>({
    method: 'POST',
    url: '/admin/access/tokens/batch',
    data,
  })
}

export type AccessTokenView = {
  id: number
  prefix: string
  label: string
  groupId: number
  groupDisplayName: string
  groupModelCount: number
  enabled: boolean
  status: 'ACTIVE' | 'DISABLED' | 'REVOKED' | 'ARCHIVED'
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  archivedAt: string | null
  canHardDelete: boolean
  maxMachineBindings: number
  boundMachineCount: number
  maxUnbindCount: number
  unbindCount: number
  remainingUnbindCount: number
  createdAt: string
}

export type AccessTokenFilters = {
  page?: number
  pageSize?: number
  keyword?: string
  groupId?: number
  enabled?: boolean
  status?: 'all' | 'ACTIVE' | 'DISABLED' | 'REVOKED' | 'ARCHIVED'
  deviceStatus?: 'all' | 'unbound' | 'bound' | 'limit'
}

export function listAccessTokens(filters: AccessTokenFilters = {}) {
  return adminRequest<PageResult<AccessTokenView>>({
    method: 'GET',
    url: '/admin/access/tokens',
    params: { page: 1, pageSize: 10, ...filters },
  })
}

export type AccessTokenSecret = {
  id: number
  token: string | null
  requiresReissue: boolean
}

export function getAccessTokenSecret(id: number) {
  return adminRequest<AccessTokenSecret>({
    method: 'GET',
    url: `/admin/access/tokens/${id}/secret`,
  })
}

export function updateTokenMachineLimits(
  id: number,
  maxMachineBindings: number,
  maxUnbindCount: number
) {
  return adminRequest<void>({
    method: 'PUT',
    url: `/admin/access/tokens/${id}/machine-limits`,
    data: { maxMachineBindings, maxUnbindCount },
  })
}

export function updateTokenMachineLimitsBulk(
  tokenIds: number[],
  maxMachineBindings: number,
  maxUnbindCount: number
) {
  return adminRequest<{ updated: number }>({
    method: 'PUT',
    url: '/admin/access/tokens/machine-limits',
    data: { tokenIds, maxMachineBindings, maxUnbindCount },
  })
}

export function setAccessTokenStatus(
  id: number,
  status: 'ACTIVE' | 'DISABLED' | 'REVOKED'
) {
  return adminRequest<{ id: number; status: AccessTokenView['status'] }>({
    method: 'PUT',
    url: `/admin/access/tokens/${id}/status`,
    data: { status },
  })
}

export function archiveAccessToken(id: number) {
  return adminRequest<{ id: number; status: 'ARCHIVED' }>({
    method: 'POST',
    url: `/admin/access/tokens/${id}/archive`,
  })
}

export function hardDeleteAccessToken(id: number) {
  return adminRequest<void>({
    method: 'DELETE',
    url: `/admin/access/tokens/${id}`,
  })
}
