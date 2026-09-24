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
import { t as translate, useTranslation, type TranslationKey } from '@/lib/i18n'
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
import { LanguageSwitch } from '@/components/language-switch'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'

const protocolNames: Record<ProtocolCode, string> = {
  OPENAI_CHAT_COMPLETIONS: 'Chat Completions',
  OPENAI_RESPONSES: 'Responses',
  ANTHROPIC_MESSAGES: 'Anthropic Messages',
}
const strategyNames: Record<ProtocolStrategy, TranslationKey> = {
  AUTO: 'relays.strategy.auto',
  OPENAI_SMART: 'relays.strategy.openaiSmart',
  ANTHROPIC_SMART: 'relays.strategy.anthropicSmart',
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
      reject(
        new DOMException(
          translate('relays.error.protocolTestCancelled'),
          'AbortError'
        )
      )
      return
    }
    const onAbort = () => {
      window.clearTimeout(timer)
      reject(
        new DOMException(
          translate('relays.error.protocolTestCancelled'),
          'AbortError'
        )
      )
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, 1000)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function RelaysPage() {
  const { t, localeTag } = useTranslation()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<RelayView | null | undefined>()
  const relays = useQuery({ queryKey: ['admin-relays'], queryFn: listRelays })

  const healthMutation = useMutation({
    mutationFn: checkRelayHealth,
    onSuccess: (result) => {
      toast.success(
        t('relays.toast.healthDone', {
          up: result.up,
          total: result.configured,
        })
      )
      void queryClient.invalidateQueries({ queryKey: ['admin-relays'] })
    },
    onError: showError,
  })
  const testMutation = useMutation({
    mutationFn: testRelay,
    onSuccess: (result) => {
      toast[result.up ? 'success' : 'error'](
        result.up
          ? t('relays.toast.testOk', { latency: result.latencyMs ?? '-' })
          : t('relays.toast.testFailed')
      )
      void queryClient.invalidateQueries({ queryKey: ['admin-relays'] })
    },
    onError: showError,
  })

  return (
    <>
      <Header>
        <div className='ms-auto flex items-center gap-2'>
          <LanguageSwitch />
          <ThemeSwitch />
          <ConfigDrawer />
        </div>
      </Header>
      <Main>
        <div className='mb-6 flex flex-wrap items-start justify-between gap-3'>
          <div>
            <h1 className='text-2xl font-bold tracking-tight'>
              {t('relays.title')}
            </h1>
            <p className='text-muted-foreground'>{t('relays.desc')}</p>
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
              {t('relays.action.healthCheck')}
            </Button>
            <Button onClick={() => setEditing(null)}>
              <Plus /> {t('relays.action.create')}
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
                    <TableHead>{t('relays.table.name')}</TableHead>
                    <TableHead>{t('relays.table.strategy')}</TableHead>
                    <TableHead>{t('relays.table.baseUrl')}</TableHead>
                    <TableHead>{t('relays.table.status')}</TableHead>
                    <TableHead>{t('relays.table.models')}</TableHead>
                    <TableHead>{t('relays.table.lastCheck')}</TableHead>
                    <TableHead>{t('relays.table.lastSuccess')}</TableHead>
                    <TableHead className='text-right'>
                      {t('relays.table.actions')}
                    </TableHead>
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
                          {t(strategyNames[relay.protocolStrategy])}
                        </div>
                        <div className='text-xs text-muted-foreground'>
                          {t('relays.table.protocolCount', {
                            count: relay.protocols.filter(
                              (item) => item.enabled
                            ).length,
                          })}
                        </div>
                      </TableCell>
                      <TableCell className='max-w-72 truncate'>
                        {relay.baseUrl}
                      </TableCell>
                      <TableCell>
                        <HealthBadge relay={relay} />
                      </TableCell>
                      <TableCell>
                        {t('relays.table.modelCount', {
                          count: relay.modelIds.length,
                        })}
                      </TableCell>
                      <TableCell>
                        {relay.lastHealthCheckAt
                          ? `${new Date(relay.lastHealthCheckAt).toLocaleString(localeTag)}${relay.lastHealthLatencyMs == null ? '' : ` · ${relay.lastHealthLatencyMs}ms`}`
                          : t('common.state.notChecked')}
                      </TableCell>
                      <TableCell>
                        {relay.lastSuccessAt
                          ? new Date(relay.lastSuccessAt).toLocaleString(
                              localeTag
                            )
                          : t('common.state.never')}
                      </TableCell>
                      <TableCell>
                        <div className='flex justify-end gap-1'>
                          <Button
                            size='sm'
                            variant='ghost'
                            disabled={testMutation.isPending}
                            onClick={() => testMutation.mutate(relay.id)}
                          >
                            <Activity /> {t('common.action.test')}
                          </Button>
                          <Button
                            size='sm'
                            variant='ghost'
                            onClick={() => setEditing(relay)}
                          >
                            <Pencil /> {t('common.action.edit')}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {relays.data?.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className='h-32 text-center'>
                        {t('relays.table.empty')}
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
  const { t } = useTranslation()
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
    toast.success(t(relay ? 'relays.toast.updated' : 'relays.toast.created'))
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
      toast.success(t('relays.toast.deleted'))
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
      if (!protocol) throw new Error(t('relays.error.protocolMissing'))
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
          throw new Error(task.message ?? t('relays.error.protocolTestFailed'))
        if (!task.result)
          throw new Error(t('relays.error.protocolTestNoResult'))
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
          ? t('relays.toast.protocolVerified', {
              protocol: protocolNames[result.protocol],
              latency: result.latencyMs ?? '-',
            })
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
          <DialogTitle>
            {t(relay ? 'relays.dialog.editTitle' : 'relays.dialog.createTitle')}
          </DialogTitle>
          <DialogDescription>{t('relays.dialog.desc')}</DialogDescription>
        </DialogHeader>
        <form
          className='grid gap-4 sm:grid-cols-2'
          onSubmit={(event) => {
            event.preventDefault()
            mutation.mutate(form)
          }}
        >
          <Field label={t('relays.dialog.name')} className='sm:col-span-2'>
            <Input
              required
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
            />
          </Field>
          <Field label={t('relays.dialog.baseUrl')} className='sm:col-span-2'>
            <Input
              required
              type='url'
              placeholder='https://example.com/v1'
              value={form.baseUrl}
              onChange={(e) => update('baseUrl', e.target.value)}
            />
          </Field>
          <Field
            label={t(
              relay?.apiKeyConfigured
                ? 'relays.dialog.apiKeyConfigured'
                : 'relays.dialog.apiKey'
            )}
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
          <Field label={t('relays.dialog.strategy')} className='sm:col-span-2'>
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
                  {t(label)}
                </option>
              ))}
            </select>
            <p className='mt-2 text-xs text-muted-foreground'>
              {t(strategyDescription(form.protocolStrategy))}
            </p>
          </Field>
          {relay && (
            <section className='space-y-3 rounded-lg border p-4 sm:col-span-2'>
              <div className='flex flex-wrap items-center justify-between gap-2'>
                <div>
                  <div className='font-medium'>
                    {t('relays.dialog.protocolSection')}
                  </div>
                  <div className='mt-1 flex flex-wrap gap-2'>
                    {form.protocols
                      .filter((item) => item.enabled)
                      .map((item) => (
                        <Badge key={item.code} variant='secondary'>
                          {t(protocolVerificationLabel(relay, item.code))}{' '}
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
                  <Settings2 />{' '}
                  {t(
                    advanced
                      ? 'relays.dialog.advancedCollapse'
                      : 'relays.dialog.advancedExpand'
                  )}
                </Button>
              </div>
              <p className='text-xs text-muted-foreground'>
                {t('relays.dialog.capabilities', {
                  list:
                    enabledCapabilityNames(form.protocols)
                      .map((key) => t(key))
                      .join(' · ') || t('common.state.none'),
                })}
              </p>
              <p className='text-xs leading-relaxed text-muted-foreground'>
                {t('relays.dialog.testModelSource')}
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
            label={t('relays.dialog.priority')}
            value={form.priority}
            min={0}
            onChange={(v) => update('priority', v)}
          />
          <NumberField
            label={t('relays.dialog.weight')}
            value={form.weight}
            min={1}
            onChange={(v) => update('weight', v)}
          />
          <NumberField
            label={t('relays.dialog.failureThreshold')}
            value={form.failureThreshold}
            min={1}
            onChange={(v) => update('failureThreshold', v)}
          />
          <NumberField
            label={t('relays.dialog.maxConcurrency')}
            value={form.maxConcurrency}
            min={0}
            onChange={(v) => update('maxConcurrency', v)}
          />
          <NumberField
            label={t('relays.dialog.connectTimeout')}
            value={form.connectTimeoutMs}
            min={100}
            max={1800000}
            onChange={(v) => update('connectTimeoutMs', v)}
          />
          <NumberField
            label={t('relays.dialog.readTimeout')}
            value={form.readTimeoutMs}
            min={1000}
            max={1800000}
            onChange={(v) => update('readTimeoutMs', v)}
          />
          <p className='text-xs leading-relaxed text-muted-foreground sm:col-span-2'>
            {t('relays.dialog.timeoutHint')}
          </p>
          <div className='flex items-center gap-3 sm:col-span-2'>
            <Switch
              checked={form.enabled}
              disabled={!relay}
              onCheckedChange={(value) => update('enabled', value)}
            />
            <Label>{t('relays.dialog.enabled')}</Label>
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
                        t('relays.dialog.deleteConfirm', { name: relay.name })
                      )
                    )
                      deleteMutation.mutate()
                  }}
                >
                  <Trash2 /> {t('relays.dialog.delete')}
                </Button>
              </div>
            ) : (
              <span />
            )}
            <div className='flex gap-2'>
              <Button type='button' variant='outline' onClick={onClose}>
                {t('common.action.cancel')}
              </Button>
              <Button
                type='submit'
                disabled={mutation.isPending || protocolTestMutation.isPending}
              >
                {mutation.isPending && <Loader2 className='animate-spin' />}{' '}
                {t('common.action.save')}
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
  ['textSupported', 'relays.capability.text'],
  ['imageSupported', 'relays.capability.image'],
  ['pdfSupported', 'relays.capability.pdf'],
  ['streamingSupported', 'relays.capability.streaming'],
] as const satisfies readonly (readonly [string, TranslationKey])[]

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
  const { t } = useTranslation()
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
        <Field label={t('relays.protocol.priority')}>
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
              {t('relays.protocol.pathOverride')}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type='button'
                    aria-label={t('relays.protocol.pathOverrideHelpLabel')}
                    className='text-amber-600 hover:text-amber-700'
                  >
                    <CircleAlert className='size-4' />
                  </button>
                </TooltipTrigger>
                <TooltipContent className='max-w-80 leading-relaxed'>
                  {t('relays.protocol.pathOverrideHelp')}
                </TooltipContent>
              </Tooltip>
            </span>
          }
        >
          <Input
            placeholder={t('relays.protocol.pathOverridePlaceholder')}
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
      <Field label={t('relays.protocol.testModel')}>
        <select
          className='h-10 w-full rounded-md border border-input bg-background px-3 text-sm'
          value={testModelId}
          onChange={(event) => onTestModelChange(event.target.value)}
        >
          <option value=''>{t('relays.protocol.testModelPlaceholder')}</option>
          {testModels.map((model) => (
            <option key={model.modelId} value={model.modelId}>
              {model.displayName} · {model.modelId}
            </option>
          ))}
        </select>
        {!testModels.length && (
          <p className='mt-1 text-xs text-amber-700'>
            {t('relays.protocol.noEligibleModels')}
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
              {t(label)}
            </label>
          )
        })}
      </div>
      {testResult && (
        <p className='text-xs text-muted-foreground'>
          <span className='text-emerald-700'>
            {t('relays.protocol.legendPassed')}
          </span>
          {' · '}
          <span className='text-red-700'>
            {t('relays.protocol.legendFailed')}
          </span>
          {' · '}
          {t('relays.protocol.legendUntested')}
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
            {t(
              testVerified
                ? 'relays.protocol.sampleVerified'
                : 'relays.protocol.sampleTest'
            )}
            {value.imageSupported && value.pdfSupported
              ? t('relays.protocol.sampleIncludesBoth')
              : value.imageSupported
                ? t('relays.protocol.sampleIncludesImage')
                : value.pdfSupported
                  ? t('relays.protocol.sampleIncludesPdf')
                  : ''}
          </Button>
          {value.imageSupported && (
            <p className='text-xs leading-relaxed text-muted-foreground'>
              {t('relays.protocol.imageHint')}
            </p>
          )}
          {value.pdfSupported && (
            <p className='text-xs leading-relaxed text-muted-foreground'>
              {t('relays.protocol.pdfHint')}
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

function strategyDescription(strategy: ProtocolStrategy): TranslationKey {
  if (strategy === 'OPENAI_SMART') return 'relays.strategy.openaiSmartDesc'
  if (strategy === 'ANTHROPIC_SMART')
    return 'relays.strategy.anthropicSmartDesc'
  return 'relays.strategy.autoDesc'
}

function enabledCapabilityNames(protocols: SaveRelayProtocol[]) {
  const labels = new Set<TranslationKey>()
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
): TranslationKey {
  const protocol = relay?.protocols.find((item) => item.code === code)
  if (protocol?.verificationStatus === 'VERIFIED')
    return 'relays.protocol.verified'
  if (protocol?.verificationStatus === 'FAILED') return 'relays.protocol.failed'
  return 'relays.protocol.notSampled'
}

function HealthBadge({ relay }: { relay: RelayView }) {
  const { t } = useTranslation()
  if (!relay.enabled)
    return <Badge variant='outline'>{t('common.state.disabled')}</Badge>
  if (relay.healthStatus === 'UP')
    return (
      <Badge className='bg-emerald-600 hover:bg-emerald-600'>
        {t('common.state.normal')}
      </Badge>
    )
  if (relay.healthStatus === 'DOWN')
    return <Badge variant='destructive'>{t('common.state.abnormal')}</Badge>
  return <Badge variant='secondary'>{t('common.state.unknown')}</Badge>
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : translate('relays.error.actionFailed')
}

function showError(error: unknown) {
  toast.error(errorMessage(error))
}
