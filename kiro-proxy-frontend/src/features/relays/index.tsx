import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  CircleAlert,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  checkRelayHealth,
  deleteRelay,
  getRelayProtocolDraftTest,
  listRelayTestModels,
  listRelays,
  saveRelay,
  startRelayProtocolDraftTest,
  testRelay,
  type RelayView,
  type ProtocolCode,
  type ProtocolStrategy,
  type SaveRelayProtocol,
  type SaveRelayBody,
  type RelayTestModel,
  type ProtocolTestResult,
} from '@/lib/api/admin'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'

const protocolNames: Record<ProtocolCode, string> = {
  OPENAI_CHAT_COMPLETIONS: 'Chat Completions',
  OPENAI_RESPONSES: 'Responses',
  ANTHROPIC_MESSAGES: 'Anthropic Messages',
}
const strategyNames: Record<ProtocolStrategy, string> = {
  AUTO: '自动混合协议',
  OPENAI_SMART: 'OpenAI 智能协议',
  ANTHROPIC_SMART: 'Claude 智能协议',
}
const protocol = (
  code: ProtocolCode,
  priority: number,
  pdfSupported: boolean
): SaveRelayProtocol => ({
  code,
  enabled: true,
  priority,
  pathOverride: null,
  textSupported: true,
  imageSupported: true,
  pdfSupported,
  toolUseSupported: true,
  toolResultSupported: true,
  streamingSupported: true,
  promptCacheSupported: true,
})
const protocolPreset = (strategy: ProtocolStrategy): SaveRelayProtocol[] => {
  if (strategy === 'OPENAI_SMART')
    return [
      protocol('OPENAI_RESPONSES', 10, true),
      protocol('OPENAI_CHAT_COMPLETIONS', 20, false),
    ]
  if (strategy === 'ANTHROPIC_SMART')
    return [
      protocol('ANTHROPIC_MESSAGES', 10, true),
      protocol('OPENAI_CHAT_COMPLETIONS', 20, false),
    ]
  return [
    protocol('ANTHROPIC_MESSAGES', 10, true),
    protocol('OPENAI_RESPONSES', 20, true),
    protocol('OPENAI_CHAT_COMPLETIONS', 30, false),
  ]
}
const editableProtocol = (value: RelayView['protocols'][number]) => ({
  code: value.code,
  enabled: value.enabled,
  priority: value.priority,
  pathOverride: value.pathOverride,
  textSupported: value.capabilities.includes('TEXT'),
  imageSupported: value.capabilities.includes('IMAGE'),
  pdfSupported: value.capabilities.includes('PDF'),
  toolUseSupported: value.capabilities.includes('TOOL_USE'),
  toolResultSupported: value.capabilities.includes('TOOL_RESULT'),
  streamingSupported: value.capabilities.includes('STREAMING'),
  promptCacheSupported: value.capabilities.includes('PROMPT_CACHE'),
})

const emptyRelay: SaveRelayBody = {
  name: '',
  baseUrl: '',
  apiKey: '',
  protocolStrategy: 'AUTO',
  protocols: protocolPreset('AUTO'),
  enabled: false,
  priority: 100,
  weight: 100,
  failureThreshold: 3,
  connectTimeoutMs: 5000,
  readTimeoutMs: 600000,
  maxConcurrency: 0,
}

function waitForProtocolTestPoll(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('协议测试轮询已取消', 'AbortError'))
      return
    }
    const onAbort = () => {
      window.clearTimeout(timer)
      reject(new DOMException('协议测试轮询已取消', 'AbortError'))
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, 1000)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function RelaysPage() {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<RelayView | null | undefined>()
  const relays = useQuery({ queryKey: ['admin-relays'], queryFn: listRelays })

  const healthMutation = useMutation({
    mutationFn: checkRelayHealth,
    onSuccess: (result) => {
      toast.success(`健康检查完成：${result.up}/${result.configured} 可用`)
      void queryClient.invalidateQueries({ queryKey: ['admin-relays'] })
    },
    onError: showError,
  })
  const testMutation = useMutation({
    mutationFn: testRelay,
    onSuccess: (result) => {
      toast[result.up ? 'success' : 'error'](
        result.up ? `连通正常 · ${result.latencyMs ?? '-'}ms` : '连通测试失败'
      )
      void queryClient.invalidateQueries({ queryKey: ['admin-relays'] })
    },
    onError: showError,
  })

  return (
    <>
      <Header>
        <div className='ms-auto flex items-center gap-2'>
          <ThemeSwitch />
          <ConfigDrawer />
        </div>
      </Header>
      <Main>
        <div className='mb-6 flex flex-wrap items-start justify-between gap-3'>
          <div>
            <h1 className='text-2xl font-bold tracking-tight'>中转站管理</h1>
            <p className='text-muted-foreground'>
              管理上游 API、密钥、连接参数和健康状态
            </p>
          </div>
          <div className='flex gap-2'>
            <Button
              variant='outline'
              disabled={healthMutation.isPending}
              onClick={() => healthMutation.mutate()}
            >
              <RefreshCw
                className={healthMutation.isPending ? 'animate-spin' : ''}
              />
              健康检查
            </Button>
            <Button onClick={() => setEditing(null)}>
              <Plus /> 新建中转站
            </Button>
          </div>
        </div>

        <Card>
          <CardContent className='p-0'>
            {relays.isLoading ? (
              <div className='flex h-48 items-center justify-center'>
                <Loader2 className='animate-spin' />
              </div>
            ) : relays.isError ? (
              <div className='p-8 text-center text-destructive'>
                {errorMessage(relays.error)}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>协议策略</TableHead>
                    <TableHead>API 地址</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>模型</TableHead>
                    <TableHead>最近检查</TableHead>
                    <TableHead>最近成功</TableHead>
                    <TableHead className='text-right'>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {relays.data?.map((relay) => (
                    <TableRow key={relay.id}>
                      <TableCell>
                        <div className='font-medium'>{relay.name}</div>
                        <div className='text-xs text-muted-foreground'>
                          ID {relay.id}
                        </div>
                      </TableCell>
                      <TableCell
                        title={capabilitySummary(relay)}
                        className='whitespace-nowrap'
                      >
                        <div className='font-medium'>
                          {strategyNames[relay.protocolStrategy]}
                        </div>
                        <div className='text-xs text-muted-foreground'>
                          {
                            relay.protocols.filter((item) => item.enabled)
                              .length
                          }{' '}
                          个协议
                        </div>
                      </TableCell>
                      <TableCell className='max-w-72 truncate'>
                        {relay.baseUrl}
                      </TableCell>
                      <TableCell>
                        <HealthBadge relay={relay} />
                      </TableCell>
                      <TableCell>{relay.modelIds.length} 个</TableCell>
                      <TableCell>
                        {relay.lastHealthCheckAt
                          ? `${new Date(relay.lastHealthCheckAt).toLocaleString()}${relay.lastHealthLatencyMs == null ? '' : ` · ${relay.lastHealthLatencyMs}ms`}`
                          : '尚未检查'}
                      </TableCell>
                      <TableCell>
                        {relay.lastSuccessAt
                          ? new Date(relay.lastSuccessAt).toLocaleString()
                          : '尚无'}
                      </TableCell>
                      <TableCell>
                        <div className='flex justify-end gap-1'>
                          <Button
                            size='sm'
                            variant='ghost'
                            disabled={testMutation.isPending}
                            onClick={() => testMutation.mutate(relay.id)}
                          >
                            <Activity /> 测试
                          </Button>
                          <Button
                            size='sm'
                            variant='ghost'
                            onClick={() => setEditing(relay)}
                          >
                            <Pencil /> 编辑
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {relays.data?.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className='h-32 text-center'>
                        暂无中转站
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </Main>

      {editing !== undefined && (
        <RelayDialog relay={editing} onClose={() => setEditing(undefined)} />
      )}
    </>
  )
}

function RelayDialog({
  relay,
  onClose,
}: {
  relay: RelayView | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [advanced, setAdvanced] = useState(!relay)
  const [form, setForm] = useState<SaveRelayBody>(() =>
    relay
      ? {
          id: relay.id,
          name: relay.name,
          baseUrl: relay.baseUrl,
          apiKey: '',
          protocolStrategy: relay.protocolStrategy,
          protocols: relay.protocols.map(editableProtocol),
          enabled: relay.enabled,
          priority: relay.priority,
          weight: relay.weight,
          failureThreshold: relay.failureThreshold,
          connectTimeoutMs: relay.connectTimeoutMs,
          readTimeoutMs: relay.readTimeoutMs,
          maxConcurrency: relay.maxConcurrency,
          version: relay.version,
        }
      : { ...emptyRelay }
  )
  const models = useQuery({
    queryKey: ['relay-test-models', relay?.id],
    queryFn: () => listRelayTestModels(relay!.id),
    enabled: relay != null,
  })
  const [testModels, setTestModels] = useState<
    Partial<Record<ProtocolCode, string>>
  >({})
  const [testResults, setTestResults] = useState<
    Partial<Record<ProtocolCode, ProtocolTestResult>>
  >({})
  const [verifiedDrafts, setVerifiedDrafts] = useState<
    Partial<Record<ProtocolCode, { fingerprint: string; token: string }>>
  >({})
  const protocolTestAbort = useRef<AbortController | undefined>(undefined)
  useEffect(
    () => () => {
      protocolTestAbort.current?.abort()
    },
    []
  )
  const handleSaved = () => {
    toast.success(relay ? '中转站已更新' : '中转站已创建')
    void queryClient.invalidateQueries({ queryKey: ['admin-relays'] })
    onClose()
  }
  const mutation = useMutation({
    mutationFn: (data: SaveRelayBody) =>
      saveRelay({
        ...data,
        verificationTokens: Object.fromEntries(
          Object.entries(verifiedDrafts).map(([code, proof]) => [
            code,
            proof?.token,
          ])
        ),
      }),
    onSuccess: handleSaved,
    onError: showError,
  })
  const deleteMutation = useMutation({
    mutationFn: () => deleteRelay(relay!.id),
    onSuccess: () => {
      toast.success('中转站及其模型关联已删除')
      void queryClient.invalidateQueries({ queryKey: ['admin-relays'] })
      onClose()
    },
    onError: showError,
  })
  const protocolTestMutation = useMutation({
    mutationFn: async ({
      code,
      modelId,
      fingerprint,
    }: {
      code: ProtocolCode
      modelId: string
      fingerprint: string
    }) => {
      const protocol = form.protocols.find((item) => item.code === code)
      if (!protocol) throw new Error('协议配置不存在')
      const controller = new AbortController()
      protocolTestAbort.current?.abort()
      protocolTestAbort.current = controller
      try {
        let task = await startRelayProtocolDraftTest(
          form,
          protocol,
          modelId,
          controller.signal
        )
        while (task.status === 'QUEUED' || task.status === 'RUNNING') {
          await waitForProtocolTestPoll(controller.signal)
          task = await getRelayProtocolDraftTest(task.taskId, controller.signal)
        }
        if (task.status === 'FAILED')
          throw new Error(task.message ?? '协议测试任务执行失败')
        if (!task.result) throw new Error('协议测试任务未返回结果')
        return { result: task.result, fingerprint }
      } finally {
        if (protocolTestAbort.current === controller)
          protocolTestAbort.current = undefined
      }
    },
    onMutate: ({ code }) => {
      setTestResults((current) => {
        const next = { ...current }
        delete next[code]
        return next
      })
      setVerifiedDrafts((current) => {
        const next = { ...current }
        delete next[code]
        return next
      })
    },
    onSuccess: ({ result, fingerprint }) => {
      setTestResults((current) => ({ ...current, [result.protocol]: result }))
      if (result.verified && result.verificationToken)
        setVerifiedDrafts((current) => ({
          ...current,
          [result.protocol]: {
            fingerprint,
            token: result.verificationToken!,
          },
        }))
      toast[result.verified ? 'success' : 'error'](
        result.verified
          ? `${protocolNames[result.protocol]} 验证通过 · ${result.latencyMs}ms`
          : result.message
      )
    },
    onError: showError,
  })
  const update = <K extends keyof SaveRelayBody>(
    key: K,
    value: SaveRelayBody[K]
  ) => setForm((current) => ({ ...current, [key]: value }))
  const selectedModelId = (code: ProtocolCode) =>
    testModels[code] ??
    preferredTestModel(code, form.protocolStrategy, models.data ?? [])
  const clearProtocolTest = (code: ProtocolCode) => {
    setTestResults((current) => {
      const next = { ...current }
      delete next[code]
      return next
    })
    setVerifiedDrafts((current) => {
      const next = { ...current }
      delete next[code]
      return next
    })
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>{relay ? '编辑中转站' : '新建中转站'}</DialogTitle>
          <DialogDescription>
            API Key 在编辑时留空表示保留原值。
          </DialogDescription>
        </DialogHeader>
        <form
          className='grid gap-4 sm:grid-cols-2'
          onSubmit={(event) => {
            event.preventDefault()
            mutation.mutate(form)
          }}
        >
          <Field label='名称' className='sm:col-span-2'>
            <Input
              required
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
            />
          </Field>
          <Field label='API 基础地址' className='sm:col-span-2'>
            <Input
              required
              type='url'
              placeholder='https://example.com/v1'
              value={form.baseUrl}
              onChange={(e) => update('baseUrl', e.target.value)}
            />
          </Field>
          <Field
            label={`API Key${relay?.apiKeyConfigured ? '（已配置）' : ''}`}
            className='sm:col-span-2'
          >
            <Input
              required={!relay}
              type='password'
              value={form.apiKey}
              onChange={(e) => {
                update('apiKey', e.target.value)
                setTestResults({})
                setVerifiedDrafts({})
              }}
            />
          </Field>
          <Field label='协议策略' className='sm:col-span-2'>
            <select
              className='h-10 w-full rounded-md border border-input bg-background px-3 text-sm'
              value={form.protocolStrategy}
              onChange={(event) => {
                const strategy = event.target.value as ProtocolStrategy
                setTestModels({})
                setTestResults({})
                setVerifiedDrafts({})
                setForm((current) => ({
                  ...current,
                  protocolStrategy: strategy,
                  protocols: protocolPreset(strategy),
                }))
              }}
            >
              {Object.entries(strategyNames).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <p className='mt-2 text-xs text-muted-foreground'>
              {strategyDescription(form.protocolStrategy)}
            </p>
          </Field>
          {relay && (
            <section className='space-y-3 rounded-lg border p-4 sm:col-span-2'>
              <div className='flex flex-wrap items-center justify-between gap-2'>
                <div>
                  <div className='font-medium'>配置协议（测试可选）</div>
                  <div className='mt-1 flex flex-wrap gap-2'>
                    {form.protocols
                      .filter((item) => item.enabled)
                      .map((item) => (
                        <Badge key={item.code} variant='secondary'>
                          {protocolVerificationLabel(relay, item.code)}{' '}
                          {protocolNames[item.code]}
                        </Badge>
                      ))}
                  </div>
                </div>
                <Button
                  type='button'
                  size='sm'
                  variant='ghost'
                  onClick={() => setAdvanced((value) => !value)}
                >
                  <Settings2 /> {advanced ? '收起高级设置' : '高级协议设置'}
                </Button>
              </div>
              <p className='text-xs text-muted-foreground'>
                能力：
                {enabledCapabilityNames(form.protocols).join(' · ') || '无'}
              </p>
              <p className='text-xs leading-relaxed text-muted-foreground'>
                测试模型自动来自“路由与价格”中已绑定且启用的候选项。
              </p>
              {advanced && (
                <div className='space-y-3 border-t pt-3'>
                  {form.protocols.map((item, index) => (
                    <ProtocolEditor
                      key={item.code}
                      value={item}
                      testModels={eligibleTestModels(
                        models.data ?? [],
                        item.code,
                        form.protocolStrategy
                      )}
                      testModelId={selectedModelId(item.code)}
                      testResult={testResults[item.code]}
                      testVerified={Boolean(
                        verifiedDrafts[item.code]?.fingerprint ===
                          protocolTestFingerprint(
                            form,
                            item,
                            selectedModelId(item.code)
                          ) ||
                        (relay != null &&
                          form.baseUrl === relay.baseUrl &&
                          !form.apiKey &&
                          !hasUnsavedProtocolChanges(relay, item) &&
                          relay.protocols.find(
                            (saved) => saved.code === item.code
                          )?.verificationStatus === 'VERIFIED' &&
                          relay.protocols
                            .find((saved) => saved.code === item.code)
                            ?.lastVerificationMessage?.includes(
                              `模型：${selectedModelId(item.code)}`
                            ))
                      )}
                      testDisabled={
                        !item.enabled ||
                        !form.baseUrl ||
                        protocolTestMutation.isPending
                      }
                      onTestModelChange={(modelId) => {
                        clearProtocolTest(item.code)
                        setTestModels((current) => ({
                          ...current,
                          [item.code]: modelId,
                        }))
                      }}
                      onChange={(next) => {
                        clearProtocolTest(item.code)
                        update(
                          'protocols',
                          form.protocols.map((current, currentIndex) =>
                            currentIndex === index ? next : current
                          )
                        )
                      }}
                      onTest={() => {
                        const modelId = selectedModelId(item.code)
                        if (modelId)
                          protocolTestMutation.mutate({
                            code: item.code,
                            modelId,
                            fingerprint: protocolTestFingerprint(
                              form,
                              item,
                              modelId
                            ),
                          })
                      }}
                      testing={
                        protocolTestMutation.isPending &&
                        protocolTestMutation.variables?.code === item.code
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          )}
          <NumberField
            label='优先级'
            value={form.priority}
            min={0}
            onChange={(v) => update('priority', v)}
          />
          <NumberField
            label='权重'
            value={form.weight}
            min={1}
            onChange={(v) => update('weight', v)}
          />
          <NumberField
            label='失败阈值'
            value={form.failureThreshold}
            min={1}
            onChange={(v) => update('failureThreshold', v)}
          />
          <NumberField
            label='最大并发（0 不限制）'
            value={form.maxConcurrency}
            min={0}
            onChange={(v) => update('maxConcurrency', v)}
          />
          <NumberField
            label='连接超时（ms，每个探针）'
            value={form.connectTimeoutMs}
            min={100}
            max={1800000}
            onChange={(v) => update('connectTimeoutMs', v)}
          />
          <NumberField
            label='流空闲超时（ms）'
            value={form.readTimeoutMs}
            min={1000}
            max={1800000}
            onChange={(v) => update('readTimeoutMs', v)}
          />
          <p className='text-xs leading-relaxed text-muted-foreground sm:col-span-2'>
            聊天流在连续无任何 SSE
            数据时才会超时；协议测试仍对每个探针分别生效。最大 1,800,000ms（30
            分钟）。
          </p>
          <div className='flex items-center gap-3 sm:col-span-2'>
            <Switch
              checked={form.enabled}
              disabled={!relay}
              onCheckedChange={(value) => update('enabled', value)}
            />
            <Label>启用并参与调度</Label>
          </div>
          <DialogFooter className='sm:col-span-2 sm:justify-between'>
            {relay ? (
              <div className='flex gap-2'>
                <Button
                  type='button'
                  variant='destructive'
                  disabled={deleteMutation.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        `确定永久删除中转站“${relay.name}”吗？关联模型将先自动解绑。`
                      )
                    )
                      deleteMutation.mutate()
                  }}
                >
                  <Trash2 /> 删除中转站
                </Button>
              </div>
            ) : (
              <span />
            )}
            <div className='flex gap-2'>
              <Button type='button' variant='outline' onClick={onClose}>
                取消
              </Button>
              <Button
                type='submit'
                disabled={mutation.isPending || protocolTestMutation.isPending}
              >
                {mutation.isPending && <Loader2 className='animate-spin' />}{' '}
                保存
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  className,
  children,
}: {
  label: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={className}>
      <Label className='mb-2'>{label}</Label>
      {children}
    </div>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max?: number
  onChange: (value: number) => void
}) {
  return (
    <Field label={label}>
      <Input
        required
        type='number'
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </Field>
  )
}

const capabilityFields = [
  ['textSupported', '文本'],
  ['imageSupported', '图片'],
  ['pdfSupported', 'PDF'],
  ['streamingSupported', 'Streaming'],
] as const

function ProtocolEditor({
  value,
  onChange,
  onTest,
  testing,
  testModels,
  testModelId,
  onTestModelChange,
  testVerified,
  testDisabled,
  testResult,
}: {
  value: SaveRelayProtocol
  onChange: (value: SaveRelayProtocol) => void
  onTest?: () => void
  testing: boolean
  testModels: RelayTestModel[]
  testModelId: string
  onTestModelChange: (modelId: string) => void
  testVerified: boolean
  testDisabled: boolean
  testResult?: ProtocolTestResult
}) {
  const connectionStatus = testResult
    ? testResult.connection
      ? 'passed'
      : 'failed'
    : 'untested'
  return (
    <div className='space-y-3 rounded-md bg-muted/40 p-3'>
      <div className='grid items-end gap-3 sm:grid-cols-[1fr_7rem_8rem]'>
        <label
          className={`flex items-center gap-2 pb-2 text-sm font-medium ${verificationTextClass(connectionStatus)}`}
        >
          <Checkbox
            checked={value.enabled}
            className={verificationCheckboxClass(connectionStatus)}
            onCheckedChange={(checked) =>
              onChange({ ...value, enabled: checked === true })
            }
          />
          {protocolNames[value.code]}
        </label>
        <Field label='协议优先级'>
          <Input
            type='number'
            min={0}
            value={value.priority}
            onChange={(event) =>
              onChange({ ...value, priority: Number(event.target.value) })
            }
          />
        </Field>
        <Field
          label={
            <span className='inline-flex items-center gap-1.5'>
              路径覆盖
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type='button'
                    aria-label='查看路径覆盖说明'
                    className='text-amber-600 hover:text-amber-700'
                  >
                    <CircleAlert className='size-4' />
                  </button>
                </TooltipTrigger>
                <TooltipContent className='max-w-80 leading-relaxed'>
                  仅当上游接口不使用默认路径时填写。这是追加到 API
                  基础地址后的相对路径，必须以 / 开头；例如基础地址为
                  https://example.com/v1，填写 /anthropic/messages 后将请求
                  https://example.com/v1/anthropic/messages。
                </TooltipContent>
              </Tooltip>
            </span>
          }
        >
          <Input
            placeholder='使用默认路径'
            value={value.pathOverride ?? ''}
            onChange={(event) =>
              onChange({
                ...value,
                pathOverride: event.target.value || null,
              })
            }
          />
        </Field>
      </div>
      <Field label='抽样测试模型'>
        <select
          className='h-10 w-full rounded-md border border-input bg-background px-3 text-sm'
          value={testModelId}
          onChange={(event) => onTestModelChange(event.target.value)}
        >
          <option value=''>请选择与当前协议匹配的已挂载模型</option>
          {testModels.map((model) => (
            <option key={model.modelId} value={model.modelId}>
              {model.displayName} · {model.modelId}
            </option>
          ))}
        </select>
        {!testModels.length && (
          <p className='mt-1 text-xs text-amber-700'>
            已挂载模型中没有可用于此协议的模型。自动混合下未知别名需要在路由与价格中配置模型×协议映射。
          </p>
        )}
      </Field>
      <div className='flex flex-wrap gap-x-4 gap-y-2'>
        {capabilityFields.map(([key, label]) => {
          const status = capabilityTestStatus(key, value[key], testResult)
          return (
            <label
              key={key}
              className={`flex items-center gap-2 text-xs ${verificationTextClass(status)}`}
            >
              <Checkbox
                checked={value[key]}
                disabled={key === 'textSupported'}
                className={verificationCheckboxClass(status)}
                onCheckedChange={(checked) =>
                  onChange({ ...value, [key]: checked === true })
                }
              />
              {label}
            </label>
          )
        })}
      </div>
      {testResult && (
        <p className='text-xs text-muted-foreground'>
          <span className='text-emerald-700'>绿色：已通过</span>
          {' · '}
          <span className='text-red-700'>红色：测试失败</span>
          {' · '}
          默认色：本次未专项测试
        </p>
      )}
      {onTest && (
        <div className='space-y-2'>
          <Button
            type='button'
            size='sm'
            variant='outline'
            disabled={testing || testDisabled || !testModelId}
            onClick={onTest}
          >
            {testing && <Loader2 className='animate-spin' />}
            {testVerified ? '✓ 当前模型抽样通过' : '抽样测试当前模型'}
            {value.imageSupported || value.pdfSupported
              ? `（含${value.imageSupported ? '图片' : ''}${value.imageSupported && value.pdfSupported ? '、' : ''}${value.pdfSupported ? 'PDF' : ''}）`
              : ''}
          </Button>
          {value.imageSupported && (
            <p className='text-xs leading-relaxed text-muted-foreground'>
              测试会动态生成内含随机校验码的微型 PNG，OpenAI 协议使用 Base64
              Data URL，Anthropic 协议转换为原生 Base64
              source；只有模型正确回读才会通过。
            </p>
          )}
          {value.pdfSupported && (
            <p className='text-xs leading-relaxed text-muted-foreground'>
              测试会发送内置微型 PDF，只有模型正确返回 PDF
              内的随机校验码才会通过。
            </p>
          )}
          {testResult && (
            <p
              className={`text-xs ${testResult.verified ? 'text-emerald-700' : 'text-red-700'}`}
            >
              {testResult.message}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function hasUnsavedProtocolChanges(
  relay: RelayView | null,
  current: SaveRelayProtocol
) {
  const saved = relay?.protocols.find((item) => item.code === current.code)
  return (
    !saved ||
    JSON.stringify(editableProtocol(saved)) !== JSON.stringify(current)
  )
}

function modelFamily(modelId: string) {
  const value = modelId.trim().toLowerCase()
  if (value.includes('claude') || value.startsWith('anthropic/'))
    return 'ANTHROPIC'
  const leaf = value.slice(
    Math.max(value.lastIndexOf('/'), value.lastIndexOf(':')) + 1
  )
  if (
    value.startsWith('openai/') ||
    leaf.startsWith('gpt-') ||
    leaf.startsWith('chatgpt-') ||
    /^(o1|o3|o4)(-|$)/.test(leaf) ||
    leaf.includes('codex')
  )
    return 'OPENAI'
  return 'UNKNOWN'
}

function modelMatchesProtocol(
  modelId: string,
  code: ProtocolCode,
  strategy: ProtocolStrategy
) {
  const family = modelFamily(modelId)
  if (family === 'UNKNOWN') return true
  if (strategy === 'OPENAI_SMART') return family === 'OPENAI'
  if (strategy === 'ANTHROPIC_SMART') return family === 'ANTHROPIC'
  if (code === 'OPENAI_CHAT_COMPLETIONS') return true
  return code === 'ANTHROPIC_MESSAGES'
    ? family === 'ANTHROPIC'
    : family === 'OPENAI'
}

function eligibleTestModels(
  models: RelayTestModel[],
  code: ProtocolCode,
  strategy: ProtocolStrategy
) {
  return models.filter((model) =>
    modelMatchesProtocol(model.upstreamModelId, code, strategy)
  )
}

function preferredTestModel(
  code: ProtocolCode,
  strategy: ProtocolStrategy,
  models: RelayTestModel[]
) {
  return eligibleTestModels(models, code, strategy)[0]?.modelId ?? ''
}

type VerificationStatus = 'passed' | 'failed' | 'untested'

function capabilityTestStatus(
  key: (typeof capabilityFields)[number][0],
  selected: boolean,
  result?: ProtocolTestResult
): VerificationStatus {
  if (!selected || !result) return 'untested'
  if (key === 'textSupported') return result.text ? 'passed' : 'failed'
  if (key === 'imageSupported' && result.imageTested)
    return result.image === true ? 'passed' : 'failed'
  if (key === 'streamingSupported' && result.streamingTested)
    return result.streaming === true ? 'passed' : 'failed'
  if (key === 'pdfSupported' && result.pdfTested)
    return result.pdf === true ? 'passed' : 'failed'
  return 'untested'
}

function verificationTextClass(status: VerificationStatus) {
  if (status === 'passed') return 'text-emerald-700'
  if (status === 'failed') return 'text-red-700'
  return ''
}

function verificationCheckboxClass(status: VerificationStatus) {
  if (status === 'passed')
    return 'border-emerald-600 data-[state=checked]:border-emerald-600 data-[state=checked]:bg-emerald-600'
  if (status === 'failed')
    return 'border-red-600 data-[state=checked]:border-red-600 data-[state=checked]:bg-red-600'
  return ''
}

function protocolTestFingerprint(
  relay: SaveRelayBody,
  protocol: SaveRelayProtocol,
  modelId: string
) {
  return JSON.stringify({
    configurationId: relay.id ?? null,
    baseUrl: relay.baseUrl.replace(/\/+$/, ''),
    apiKey: relay.apiKey || '<stored>',
    protocolStrategy: relay.protocolStrategy,
    connectTimeoutMs: relay.connectTimeoutMs,
    readTimeoutMs: relay.readTimeoutMs,
    modelId,
    protocol,
  })
}

function strategyDescription(strategy: ProtocolStrategy) {
  if (strategy === 'OPENAI_SMART')
    return '优先在 Responses 与 Chat Completions 中根据请求能力选择。'
  if (strategy === 'ANTHROPIC_SMART')
    return '优先使用 Anthropic Messages，Chat Completions 作为兼容路径。'
  return '按已配置的模型×协议映射优先；未配置时识别 GPT/Claude 模型家族，再按请求能力和协议优先级选择。'
}

function enabledCapabilityNames(protocols: SaveRelayProtocol[]) {
  const labels = new Set<string>()
  for (const item of protocols.filter((protocol) => protocol.enabled))
    for (const [key, label] of capabilityFields)
      if (item[key]) labels.add(label)
  return [...labels]
}

function capabilitySummary(relay: RelayView) {
  const capabilities = new Set(
    relay.protocols
      .filter((protocol) => protocol.enabled)
      .flatMap((protocol) => protocol.capabilities)
  )
  return [
    `Text ${capabilities.has('TEXT') ? '✓' : '✗'}`,
    `Image ${capabilities.has('IMAGE') ? '✓' : '✗'}`,
    `PDF ${capabilities.has('PDF') ? '✓' : '✗'}`,
    `Stream ${capabilities.has('STREAMING') ? '✓' : '✗'}`,
  ].join('  ')
}

function protocolVerificationLabel(
  relay: RelayView | null,
  code: ProtocolCode
) {
  const protocol = relay?.protocols.find((item) => item.code === code)
  if (protocol?.verificationStatus === 'VERIFIED') return '✓ 最近抽样通过'
  if (protocol?.verificationStatus === 'FAILED') return '✗ 最近抽样失败'
  return '• 未抽样'
}

function HealthBadge({ relay }: { relay: RelayView }) {
  if (!relay.enabled) return <Badge variant='outline'>已停用</Badge>
  if (relay.healthStatus === 'UP')
    return <Badge className='bg-emerald-600 hover:bg-emerald-600'>正常</Badge>
  if (relay.healthStatus === 'DOWN')
    return <Badge variant='destructive'>异常</Badge>
  return <Badge variant='secondary'>未知</Badge>
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作失败'
}

function showError(error: unknown) {
  toast.error(errorMessage(error))
}
