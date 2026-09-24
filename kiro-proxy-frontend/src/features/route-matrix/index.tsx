import { useMemo, useState } from 'react'
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { CircleAlert, Layers3, Loader2, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  bulkUpdateRoutes,
  bulkRemoveRouteBindings,
  listReasoningAlerts,
  listRelayUpstreamModels,
  listModels,
  listRelays,
  removeRouteBinding,
  resolveReasoningAlert,
  saveRouteBinding,
  type ModelBinding,
  type ModelPricing,
  type ModelView,
  type RelayView,
} from '@/lib/api/admin'
import {
  t as translateOutsideComponent,
  useTranslation,
  type TranslationKey,
} from '@/lib/i18n'
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfigDrawer } from '@/components/config-drawer'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { LanguageSwitch } from '@/components/language-switch'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { PRICE_DECIMALS, PriceInput } from '@/components/price-input'
import { ThemeSwitch } from '@/components/theme-switch'
import { TokenInput } from '@/components/token-input'

type Cell = { model: ModelView; relay: RelayView; binding: ModelBinding | null }
type UpstreamCatalog = {
  loading: boolean
  error: boolean
  modelIds: Set<string>
}
const price = (): ModelPricing => ({
  inputPrice: 0,
  cacheInputPrice: 0,
  cacheWriteInputPrice: 0,
  outputPrice: 0,
  pricingUnit: 1_000_000,
  priceSource: 'relay',
  minInputTokens: 0,
  maxInputTokens: null,
  effectiveFrom: new Date().toISOString(),
  effectiveTo: null,
  enabled: true,
})

const sortPrices = (prices: ModelPricing[]) =>
  [...prices].sort(
    (left, right) =>
      left.minInputTokens - right.minInputTokens ||
      Date.parse(right.effectiveFrom) - Date.parse(left.effectiveFrom) ||
      (left.id ?? Number.MAX_SAFE_INTEGER) -
        (right.id ?? Number.MAX_SAFE_INTEGER)
  )

function nextPrice(prices: ModelPricing[]) {
  const highestMaximum = prices.reduce<number | null>(
    (highest, item) =>
      item.maxInputTokens === null
        ? highest
        : Math.max(highest ?? -1, item.maxInputTokens),
    null
  )
  return {
    ...price(),
    minInputTokens: highestMaximum === null ? 0 : highestMaximum + 1,
  }
}

export function RouteMatrixPage() {
  const { t } = useTranslation()
  const client = useQueryClient()
  const models = useQuery({ queryKey: ['admin-models'], queryFn: listModels })
  const relays = useQuery({
    queryKey: ['admin-relays'],
    queryFn: listRelays,
    refetchInterval: 30_000,
  })
  const upstreamQueries = useQueries({
    queries: (relays.data ?? []).map((relay) => ({
      queryKey: ['relay-upstream-models', relay.id],
      queryFn: () => listRelayUpstreamModels(relay.id),
      enabled: relay.enabled,
      staleTime: 60_000,
      retry: false,
    })),
  })
  const upstreamCatalogs = new Map<number, UpstreamCatalog>(
    (relays.data ?? []).map((relay, index) => {
      const query = upstreamQueries[index]
      return [
        relay.id,
        {
          loading: query?.isFetching ?? false,
          error: query?.isError ?? false,
          modelIds: new Set((query?.data ?? []).map((item) => item.modelId)),
        },
      ]
    })
  )
  const [search, setSearch] = useState('')
  const [protocolStrategy, setProtocolStrategy] = useState('')
  const [relayId, setRelayId] = useState('')
  const [status, setStatus] = useState('')
  const [boundOnly, setBoundOnly] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [cell, setCell] = useState<Cell | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const visibleRelays = (relays.data ?? []).filter(
    (r) =>
      (!protocolStrategy || r.protocolStrategy === protocolStrategy) &&
      (!relayId || r.id === Number(relayId))
  )
  const visibleModels = useMemo(
    () =>
      (models.data ?? []).filter((model) => {
        const text = `${model.modelId} ${model.displayName}`.toLowerCase()
        return (
          (!search || text.includes(search.toLowerCase())) &&
          (!status || String(model.enabled) === status) &&
          (!boundOnly ||
            visibleRelays.some((relay) =>
              model.bindings.some((b) => b.configurationId === relay.id)
            ))
        )
      }),
    [models.data, search, status, boundOnly, visibleRelays]
  )
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['admin-models'] })
    void client.invalidateQueries({ queryKey: ['admin-relays'] })
  }
  if (models.isLoading || relays.isLoading)
    return (
      <>
        <Header />
        <Main>
          <div className='flex h-64 items-center justify-center'>
            <Loader2 className='animate-spin' />
          </div>
        </Main>
      </>
    )
  return (
    <>
      <Header>
        <div className='ms-auto flex items-center gap-2'>
          <LanguageSwitch />
          <ThemeSwitch />
          <ConfigDrawer />
        </div>
      </Header>
      <Main className='max-w-none'>
        <div className='mb-6 flex flex-wrap items-start justify-between gap-3'>
          <div>
            <h1 className='text-2xl font-bold tracking-tight'>
              {t('routeMatrix.title')}
            </h1>
            <p className='text-muted-foreground'>
              {t('routeMatrix.description')}
            </p>
          </div>
          <Button disabled={!selected.length} onClick={() => setBulkOpen(true)}>
            <Layers3 />
            {t('routeMatrix.bulkAction')}
          </Button>
        </div>
        <ReasoningAlerts />
        <Card className='mb-4'>
          <CardContent className='flex flex-wrap items-center gap-3 p-4'>
            <div className='relative min-w-64 flex-1'>
              <Search className='absolute top-2.5 left-3 size-4 text-muted-foreground' />
              <Input
                className='pl-9'
                placeholder={t('routeMatrix.filter.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select
              value={protocolStrategy}
              change={setProtocolStrategy}
              label={t('routeMatrix.filter.allStrategies')}
              options={(
                ['AUTO', 'OPENAI_SMART', 'ANTHROPIC_SMART'] as const
              ).map((strategy) => [strategy, t(protocolStrategyKey(strategy))])}
            />
            <Select
              value={relayId}
              change={setRelayId}
              label={t('routeMatrix.filter.allRelays')}
              options={(relays.data ?? []).map((r) => [String(r.id), r.name])}
            />
            <Select
              value={status}
              change={setStatus}
              label={t('routeMatrix.filter.allModels')}
              options={[
                ['true', t('common.state.enabled')],
                ['false', t('common.state.disabled')],
              ]}
            />
            <label className='flex items-center gap-2 text-sm'>
              <Checkbox
                checked={boundOnly}
                onCheckedChange={(v) => setBoundOnly(v === true)}
              />
              {t('routeMatrix.filter.boundOnly')}
            </label>
          </CardContent>
        </Card>
        <Card>
          <CardContent className='overflow-x-auto p-0'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className='sticky left-0 z-10 min-w-64 bg-background'>
                    <Checkbox
                      checked={
                        visibleModels.length > 0 &&
                        selected.length === visibleModels.length
                      }
                      onCheckedChange={(v) =>
                        setSelected(
                          v === true ? visibleModels.map((m) => m.modelId) : []
                        )
                      }
                    />{' '}
                    <span className='ml-2'>{t('routeMatrix.table.model')}</span>
                  </TableHead>
                  <TableHead className='min-w-48'>
                    {t('routeMatrix.table.officialPrice')}
                  </TableHead>
                  {visibleRelays.map((relay) => (
                    <TableHead key={relay.id} className='min-w-56'>
                      <div>{relay.name}</div>
                      <div className='font-normal text-muted-foreground'>
                        {t(protocolStrategyKey(relay.protocolStrategy))} ·{' '}
                        <Health
                          enabled={relay.enabled}
                          status={relay.healthStatus}
                        />
                      </div>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleModels.map((model) => {
                  const official = activePrice(model)
                  return (
                    <TableRow key={model.modelId}>
                      <TableCell className='sticky left-0 z-10 bg-background'>
                        <div className='flex items-start gap-2'>
                          <Checkbox
                            checked={selected.includes(model.modelId)}
                            onCheckedChange={(v) =>
                              setSelected((s) =>
                                v === true
                                  ? [...new Set([...s, model.modelId])]
                                  : s.filter((id) => id !== model.modelId)
                              )
                            }
                          />
                          <div>
                            <div className='font-medium'>
                              {model.displayName}
                            </div>
                            <div className='font-mono text-xs text-muted-foreground'>
                              {model.modelId}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className='text-xs'>
                        {official ? (
                          <>
                            <div>Input ${official.inputPrice}</div>
                            <div>Cache ${official.cacheInputPrice}</div>
                            <div>Output ${official.outputPrice}</div>
                          </>
                        ) : (
                          t('routeMatrix.table.notConfigured')
                        )}
                      </TableCell>
                      {visibleRelays.map((relay) => {
                        const binding =
                          model.bindings.find(
                            (b) => b.configurationId === relay.id
                          ) ?? null
                        return (
                          <TableCell key={relay.id}>
                            <button
                              className='w-full rounded-md border p-3 text-left transition-colors hover:bg-muted/60'
                              onClick={() => setCell({ model, relay, binding })}
                            >
                              {binding ? (
                                <>
                                  <div className='mb-1 flex items-center gap-2 text-xs'>
                                    <Badge
                                      variant={
                                        binding.enabled
                                          ? 'default'
                                          : 'secondary'
                                      }
                                    >
                                      {binding.enabled
                                        ? t('common.state.enabled')
                                        : t('common.state.disabled')}
                                    </Badge>
                                    <RouteStatus
                                      model={model}
                                      relay={relay}
                                      binding={binding}
                                      catalog={upstreamCatalogs.get(relay.id)}
                                    />
                                  </div>
                                  <div className='text-xs'>
                                    P:{' '}
                                    {binding.priorityOverride ?? relay.priority}{' '}
                                    / W:{' '}
                                    {binding.weightOverride ?? relay.weight}
                                  </div>
                                  <div className='mt-1 text-xs text-muted-foreground'>
                                    {binding.costPrices.length > 1 && (
                                      <div>
                                        {t('routeMatrix.table.tiers', {
                                          count: binding.costPrices.length,
                                        })}
                                      </div>
                                    )}
                                    Input: $
                                    {currentTier(binding.costPrices)
                                      ?.inputPrice ?? '—'}
                                    <br />
                                    Cache: $
                                    {currentTier(binding.costPrices)
                                      ?.cacheInputPrice ?? '—'}
                                    <br />
                                    Output: $
                                    {currentTier(binding.costPrices)
                                      ?.outputPrice ?? '—'}
                                  </div>
                                </>
                              ) : (
                                <span className='text-sm text-muted-foreground'>
                                  {t('routeMatrix.table.unbound')}{' '}
                                  <b className='text-primary'>+</b>
                                </span>
                              )}
                            </button>
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </Main>
      {cell && (
        <RouteDrawer cell={cell} close={() => setCell(null)} saved={refresh} />
      )}
      {bulkOpen && (
        <BulkDialog
          models={(models.data ?? []).filter((model) =>
            selected.includes(model.modelId)
          )}
          relays={relays.data ?? []}
          upstreamCatalogs={upstreamCatalogs}
          close={() => setBulkOpen(false)}
          saved={() => {
            refresh()
            setSelected([])
          }}
        />
      )}
    </>
  )
}

function RouteDrawer({
  cell,
  close,
  saved,
}: {
  cell: Cell
  close: () => void
  saved: () => void
}) {
  const { t, localeTag } = useTranslation()
  const { model, relay } = cell
  const official = activePrice(model)
  const upstreamModels = useQuery({
    queryKey: ['relay-upstream-models', relay.id],
    queryFn: () => listRelayUpstreamModels(relay.id),
  })
  const [form, setForm] = useState<ModelBinding>(
    cell.binding
      ? {
          ...cell.binding,
          costPrices: sortPrices(cell.binding.costPrices),
          protocols: cell.binding.protocols?.length
            ? cell.binding.protocols
            : null,
        }
      : {
          configurationId: relay.id,
          configurationName: relay.name,
          upstreamModelId: model.modelId,
          enabled: true,
          priorityOverride: null,
          weightOverride: null,
          reasoningEnabled: null,
          costPrices: [price()],
          protocolStrategy: relay.protocolStrategy,
          protocols: null,
        }
  )
  const save = useMutation({
    mutationFn: () => saveRouteBinding(model.modelId, relay.id, form),
    onSuccess: () => {
      toast.success(t('routeMatrix.toast.saved'))
      saved()
      close()
    },
    onError: fail,
  })
  const remove = useMutation({
    mutationFn: () => removeRouteBinding(model.modelId, relay.id),
    onSuccess: () => {
      toast.success(t('routeMatrix.toast.removed'))
      saved()
      close()
    },
    onError: fail,
  })
  const ratio =
    official && currentTier(form.costPrices) && Number(official.inputPrice) > 0
      ? (Number(currentTier(form.costPrices)!.inputPrice) /
          Number(official.inputPrice)) *
        100
      : null
  return (
    <Sheet open onOpenChange={(v) => !v && close()}>
      <SheetContent className='w-full overflow-y-auto sm:max-w-2xl'>
        <SheetHeader>
          <SheetTitle>
            {model.displayName} → {relay.name}
          </SheetTitle>
          <SheetDescription>
            {t('routeMatrix.drawer.description')}
          </SheetDescription>
        </SheetHeader>
        <div className='flex-1 space-y-5 overflow-y-auto px-4 pb-6'>
          <Box title={t('routeMatrix.drawer.mapping')}>
            <Field label={t('routeMatrix.drawer.platformModelId')}>
              <Input disabled value={model.modelId} />
            </Field>
            <Field label='Upstream Model ID'>
              <Input
                list={`upstream-models-${relay.id}`}
                value={form.upstreamModelId}
                onChange={(e) =>
                  setForm({ ...form, upstreamModelId: e.target.value })
                }
              />
              <datalist id={`upstream-models-${relay.id}`}>
                {(upstreamModels.data ?? []).map((item) => (
                  <option key={item.modelId} value={item.modelId}>
                    {item.displayName}
                  </option>
                ))}
              </datalist>
            </Field>
            {upstreamModels.isLoading && (
              <p className='text-xs text-muted-foreground'>
                {t('routeMatrix.drawer.upstreamLoading')}
              </p>
            )}
            {upstreamModels.isError && (
              <p className='text-xs text-destructive'>
                {t('routeMatrix.drawer.upstreamError')}
              </p>
            )}
            {upstreamModels.data && (
              <Field label={t('routeMatrix.drawer.upstreamAvailable')}>
                <select
                  className='h-9 w-full rounded-md border border-input bg-background px-3 text-sm'
                  value={
                    upstreamModels.data.some(
                      (item) => item.modelId === form.upstreamModelId
                    )
                      ? form.upstreamModelId
                      : ''
                  }
                  onChange={(event) =>
                    event.target.value &&
                    setForm({ ...form, upstreamModelId: event.target.value })
                  }
                >
                  <option value=''>
                    {t('routeMatrix.drawer.upstreamSelect')}
                  </option>
                  {upstreamModels.data.map((item) => (
                    <option key={item.modelId} value={item.modelId}>
                      {item.modelId}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {upstreamModels.data &&
              !upstreamModels.data.some(
                (item) => item.modelId === form.upstreamModelId
              ) && (
                <p className='text-xs text-destructive'>
                  {t('routeMatrix.drawer.upstreamInvalid')}
                </p>
              )}
            <label className='flex items-center gap-2'>
              <Switch
                checked={form.enabled}
                onCheckedChange={(enabled) => setForm({ ...form, enabled })}
              />
              <Label>Enabled</Label>
            </label>
          </Box>
          <Box title={t('routeMatrix.drawer.scheduling')}>
            <div className='grid gap-3 sm:grid-cols-2'>
              <Field label='Priority Override'>
                <Input
                  type='number'
                  min={0}
                  placeholder={t('routeMatrix.drawer.inheritPlaceholder', {
                    value: relay.priority,
                  })}
                  value={form.priorityOverride ?? ''}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      priorityOverride:
                        e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                />
              </Field>
              <Field label='Weight Override'>
                <Input
                  type='number'
                  min={1}
                  placeholder={t('routeMatrix.drawer.inheritPlaceholder', {
                    value: relay.weight,
                  })}
                  value={form.weightOverride ?? ''}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      weightOverride:
                        e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                />
              </Field>
            </div>
            <p className='text-xs text-muted-foreground'>
              {t('routeMatrix.drawer.relayDefaults', {
                priority: relay.priority,
                weight: relay.weight,
              })}
            </p>
          </Box>
          <Box title={t('routeMatrix.reasoning.title')}>
            <Field label={t('routeMatrix.reasoning.decisionLabel')}>
              <select
                className='h-10 w-full rounded-md border border-input bg-background px-3 text-sm'
                value={
                  form.reasoningEnabled === null
                    ? 'auto'
                    : form.reasoningEnabled
                      ? 'supported'
                      : 'unsupported'
                }
                onChange={(event) =>
                  setForm({
                    ...form,
                    reasoningEnabled:
                      event.target.value === 'auto'
                        ? null
                        : event.target.value === 'supported',
                  })
                }
              >
                <option value='auto'>
                  {t('routeMatrix.reasoning.decisionAuto')}
                </option>
                <option value='supported'>
                  {t('routeMatrix.reasoning.decisionSupported')}
                </option>
                <option value='unsupported'>
                  {t('routeMatrix.reasoning.decisionUnsupported')}
                </option>
              </select>
            </Field>
            <p className='text-xs leading-relaxed text-muted-foreground'>
              {t(
                form.reasoningEnabled === null
                  ? 'routeMatrix.reasoning.hintAuto'
                  : form.reasoningEnabled
                    ? 'routeMatrix.reasoning.hintSupported'
                    : 'routeMatrix.reasoning.hintUnsupported'
              )}
            </p>
          </Box>
          <Box title={t('routeMatrix.drawer.protocolRouting')}>
            <div className='rounded-md bg-muted/40 p-3 text-sm'>
              <div>
                {t('routeMatrix.drawer.strategyLabel')}
                <b>{t(protocolStrategyKey(relay.protocolStrategy))}</b>
              </div>
              <div className='mt-1 text-xs text-muted-foreground'>
                {t('routeMatrix.drawer.availableProtocols')}
                {relay.protocols
                  .filter((item) => item.enabled)
                  .map((item) => protocolLabel(item.code))
                  .join(' · ') || t('common.state.none')}
              </div>
            </div>
            <label className='flex items-center gap-2'>
              <Switch
                checked={form.protocols !== null}
                onCheckedChange={(custom) =>
                  setForm({
                    ...form,
                    protocols: custom
                      ? relay.protocols
                          .filter((item) => item.enabled)
                          .map((item) => ({
                            code: item.code,
                            enabled: true,
                            priority: item.priority,
                            capabilities: null,
                          }))
                      : null,
                  })
                }
              />
              <Label>{t('routeMatrix.drawer.customProtocols')}</Label>
            </label>
            {form.protocols === null ? (
              <p className='text-xs text-muted-foreground'>
                {t('routeMatrix.drawer.inheritProtocols')}
              </p>
            ) : (
              <div className='space-y-2'>
                {form.protocols.map((item, index) => {
                  const inherited = relay.protocols.find(
                    (protocol) => protocol.code === item.code
                  )
                  return (
                    <div
                      key={item.code}
                      className='grid items-center gap-3 rounded-md border p-3 sm:grid-cols-[1fr_8rem]'
                    >
                      <label className='flex items-center gap-2 text-sm'>
                        <Checkbox
                          checked={item.enabled}
                          onCheckedChange={(checked) =>
                            setForm({
                              ...form,
                              protocols: form.protocols!.map(
                                (current, currentIndex) =>
                                  currentIndex === index
                                    ? { ...current, enabled: checked === true }
                                    : current
                              ),
                            })
                          }
                        />
                        <span>
                          <span className='block font-medium'>
                            {protocolLabel(item.code)}
                          </span>
                          <span className='text-xs text-muted-foreground'>
                            {(inherited?.capabilities ?? []).join(' · ')}
                          </span>
                        </span>
                      </label>
                      <Field label={t('routeMatrix.drawer.protocolPriority')}>
                        <Input
                          type='number'
                          min={0}
                          value={item.priority}
                          onChange={(event) =>
                            setForm({
                              ...form,
                              protocols: form.protocols!.map(
                                (current, currentIndex) =>
                                  currentIndex === index
                                    ? {
                                        ...current,
                                        priority: Number(event.target.value),
                                      }
                                    : current
                              ),
                            })
                          }
                        />
                      </Field>
                    </div>
                  )
                })}
              </div>
            )}
          </Box>
          <Box title={t('routeMatrix.drawer.costTitle')}>
            <label className='mb-3 flex items-center gap-2'>
              <Switch
                checked={form.costPrices.length > 0}
                onCheckedChange={(v) =>
                  setForm({ ...form, costPrices: v ? [price()] : [] })
                }
              />
              <Label>{t('routeMatrix.drawer.configureCost')}</Label>
            </label>
            {form.costPrices.length > 0 && (
              <TieredCostForm
                values={form.costPrices}
                change={(costPrices) => setForm({ ...form, costPrices })}
              />
            )}
          </Box>
          <Box title={t('routeMatrix.drawer.officialTitle')}>
            {official ? (
              <div className='grid grid-cols-2 gap-2 text-sm'>
                <div>Input ${official.inputPrice}</div>
                <div>Cache ${official.cacheInputPrice}</div>
                <div>Output ${official.outputPrice}</div>
                <div>
                  Unit /{official.pricingUnit.toLocaleString(localeTag)}
                </div>
                {ratio !== null && (
                  <>
                    <div>
                      {t('routeMatrix.drawer.ratio')}
                      <b>{ratio.toFixed(1)}%</b>
                    </div>
                    <div>
                      {t('routeMatrix.drawer.advantage')}
                      <b
                        className={
                          ratio <= 100 ? 'text-emerald-600' : 'text-destructive'
                        }
                      >
                        {(ratio - 100).toFixed(1)}%
                      </b>
                    </div>
                  </>
                )}
              </div>
            ) : (
              t('routeMatrix.drawer.noOfficial')
            )}
          </Box>
        </div>
        <SheetFooter>
          <div className='flex gap-2'>
            {cell.binding && (
              <Button variant='destructive' onClick={() => remove.mutate()}>
                {t('routeMatrix.drawer.removeBinding')}
              </Button>
            )}
            <Button variant='outline' onClick={close}>
              {t('common.action.cancel')}
            </Button>
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              {t('common.action.save')}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function BulkDialog({
  models,
  relays,
  upstreamCatalogs,
  close,
  saved,
}: {
  models: ModelView[]
  relays: RelayView[]
  upstreamCatalogs: Map<number, UpstreamCatalog>
  close: () => void
  saved: () => void
}) {
  const { t } = useTranslation()
  const [relay, setRelay] = useState(String(relays[0]?.id ?? ''))
  const [operation, setOperation] = useState<'update' | 'unbind'>('update')
  const [confirmUnbind, setConfirmUnbind] = useState(false)
  const [enabled, setEnabled] = useState('true')
  const [priority, setPriority] = useState('')
  const [weight, setWeight] = useState('')
  const [withPrice, setWithPrice] = useState(false)
  const [costs, setCosts] = useState<ModelPricing[]>([price()])
  const modelIds = models.map((model) => model.modelId)
  const boundCount = models.filter((model) =>
    model.bindings.some((binding) => binding.configurationId === Number(relay))
  ).length
  const mutation = useMutation({
    mutationFn: () =>
      bulkUpdateRoutes({
        modelIds,
        configurationId: Number(relay),
        enabled: enabled === '' ? null : enabled === 'true',
        setPriorityOverride: true,
        priorityOverride: priority === '' ? null : Number(priority),
        setWeightOverride: true,
        weightOverride: weight === '' ? null : Number(weight),
        costPrices: withPrice ? costs : null,
        clearCostPrice: false,
      }),
    onSuccess: () => {
      const catalog = upstreamCatalogs.get(Number(relay))
      const invalidCount =
        catalog && !catalog.loading && !catalog.error
          ? modelIds.filter((modelId) => !catalog.modelIds.has(modelId)).length
          : 0
      if (invalidCount > 0) {
        toast.warning(
          t('routeMatrix.toast.bulkUpdatedWithInvalid', {
            count: modelIds.length,
            invalid: invalidCount,
          })
        )
      } else {
        toast.success(
          t('routeMatrix.toast.bulkUpdated', { count: modelIds.length })
        )
      }
      saved()
      close()
    },
    onError: fail,
  })
  const unbind = useMutation({
    mutationFn: () =>
      bulkRemoveRouteBindings({
        modelIds,
        configurationId: Number(relay),
      }),
    onSuccess: ({ removed }) => {
      toast.success(t('routeMatrix.toast.bulkUnbound', { count: removed }))
      setConfirmUnbind(false)
      saved()
      close()
    },
    onError: fail,
  })
  const relayName = relays.find((item) => item.id === Number(relay))?.name ?? ''
  return (
    <>
      <Dialog open onOpenChange={(v) => !v && close()}>
        <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-3xl'>
          <DialogHeader>
            <DialogTitle>{t('routeMatrix.bulk.title')}</DialogTitle>
            <DialogDescription>
              {t('routeMatrix.bulk.description', { count: models.length })}
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-4 sm:grid-cols-2'>
            <Field label={t('routeMatrix.bulk.operation')}>
              <select
                className='h-9 w-full rounded-md border bg-background px-3 text-sm'
                value={operation}
                onChange={(e) =>
                  setOperation(e.target.value as 'update' | 'unbind')
                }
              >
                <option value='update'>
                  {t('routeMatrix.bulk.operationUpdate')}
                </option>
                <option value='unbind'>
                  {t('routeMatrix.bulk.operationUnbind')}
                </option>
              </select>
            </Field>
            <Field label={t('routeMatrix.bulk.targetRelay')}>
              <select
                className='h-9 w-full rounded-md border bg-background px-3 text-sm'
                value={relay}
                onChange={(e) => setRelay(e.target.value)}
              >
                {relays.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
            {operation === 'update' && (
              <Field label={t('routeMatrix.bulk.bindingStatus')}>
                <select
                  className='h-9 w-full rounded-md border bg-background px-3 text-sm'
                  value={enabled}
                  onChange={(e) => setEnabled(e.target.value)}
                >
                  <option value='true'>{t('common.action.enable')}</option>
                  <option value='false'>{t('common.action.disable')}</option>
                  <option value=''>
                    {t('routeMatrix.bulk.keepUnchanged')}
                  </option>
                </select>
              </Field>
            )}
            {operation === 'update' && (
              <Field label={t('routeMatrix.bulk.priorityOverride')}>
                <Input
                  type='number'
                  min={0}
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                />
              </Field>
            )}
            {operation === 'update' && (
              <Field label={t('routeMatrix.bulk.weightOverride')}>
                <Input
                  type='number'
                  min={1}
                  value={weight}
                  onChange={(e) => setWeight(e.target.value)}
                />
              </Field>
            )}
          </div>
          {operation === 'update' ? (
            <>
              <label className='flex items-center gap-2'>
                <Switch checked={withPrice} onCheckedChange={setWithPrice} />
                <Label>{t('routeMatrix.bulk.copyCost')}</Label>
              </label>
              {withPrice && <TieredCostForm values={costs} change={setCosts} />}
            </>
          ) : (
            <div className='rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm'>
              {t('routeMatrix.bulk.unbindNotice', {
                count: boundCount,
                relay: relayName,
              })}
            </div>
          )}
          <DialogFooter>
            <Button variant='outline' onClick={close}>
              {t('common.action.cancel')}
            </Button>
            <Button
              variant={operation === 'unbind' ? 'destructive' : 'default'}
              disabled={
                !relay ||
                mutation.isPending ||
                unbind.isPending ||
                (operation === 'unbind' && boundCount === 0)
              }
              onClick={() =>
                operation === 'unbind'
                  ? setConfirmUnbind(true)
                  : mutation.mutate()
              }
            >
              {operation === 'unbind' && <Trash2 />}
              {operation === 'unbind'
                ? t('routeMatrix.bulk.unbindWithCount', { count: boundCount })
                : t('routeMatrix.bulk.confirmUpdate')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmUnbind}
        onOpenChange={setConfirmUnbind}
        title={t('routeMatrix.bulk.confirmUnbindTitle')}
        desc={t('routeMatrix.bulk.confirmUnbindDesc', {
          relay: relayName,
          count: boundCount,
        })}
        cancelBtnText={t('common.action.cancel')}
        confirmText={
          unbind.isPending
            ? t('routeMatrix.bulk.unbinding')
            : t('routeMatrix.bulk.confirmUnbind')
        }
        destructive
        isLoading={unbind.isPending}
        handleConfirm={() => unbind.mutate()}
      />
    </>
  )
}

function TieredCostForm({
  values,
  change,
}: {
  values: ModelPricing[]
  change: (values: ModelPricing[]) => void
}) {
  const { t, localeTag } = useTranslation()
  const update = (index: number, value: ModelPricing) =>
    change(values.map((item, current) => (current === index ? value : item)))
  return (
    <div className='space-y-4'>
      {values.map((value, index) => (
        <div key={value.id ?? `new-${index}`} className='rounded-lg border p-3'>
          <div className='mb-3 flex items-center justify-between gap-3'>
            <div className='text-sm font-medium'>
              {t('routeMatrix.cost.tierTitle', {
                index: index + 1,
                min: value.minInputTokens.toLocaleString(localeTag),
                max:
                  value.maxInputTokens?.toLocaleString(localeTag) ??
                  t('routeMatrix.cost.noMaximum'),
              })}
            </div>
            <Button
              type='button'
              size='icon'
              variant='ghost'
              aria-label={t('routeMatrix.cost.removeTier', {
                index: index + 1,
              })}
              onClick={() =>
                change(values.filter((_, current) => current !== index))
              }
            >
              <Trash2 />
            </Button>
          </div>
          <CostForm value={value} change={(next) => update(index, next)} />
        </div>
      ))}
      <Button
        type='button'
        variant='outline'
        onClick={() => change([...values, nextPrice(values)])}
      >
        {t('routeMatrix.cost.addTier')}
      </Button>
    </div>
  )
}

function CostForm({
  value,
  change,
}: {
  value: ModelPricing
  change: (v: ModelPricing) => void
}) {
  const { t } = useTranslation()
  const set = (k: keyof ModelPricing, v: unknown) =>
    change({ ...value, [k]: v })
  return (
    <div className='grid gap-3 sm:grid-cols-4'>
      <p className='text-xs text-muted-foreground sm:col-span-4'>
        {t('routeMatrix.cost.hint', { decimals: PRICE_DECIMALS })}
      </p>
      {(
        [
          ['inputPrice', 'Input Price'],
          ['cacheInputPrice', 'Cache Read'],
          ['cacheWriteInputPrice', 'Cache Write'],
          ['outputPrice', 'Output Price'],
        ] as const
      ).map(([k, l]) => (
        <Field key={k} label={l}>
          <PriceInput value={value[k]} onValueChange={(next) => set(k, next)} />
        </Field>
      ))}
      <Field label='Pricing Unit'>
        <Input
          type='number'
          min={1}
          value={value.pricingUnit}
          onChange={(e) => set('pricingUnit', Number(e.target.value))}
        />
      </Field>
      <Field label='Currency'>
        <Input disabled value='USD' />
      </Field>
      <Field label='Price Source'>
        <Input
          value={value.priceSource}
          onChange={(e) => set('priceSource', e.target.value)}
        />
      </Field>
      <Field label='Min Input Tokens'>
        <TokenInput
          value={value.minInputTokens}
          onValueChange={(next) => set('minInputTokens', next ?? 0)}
        />
      </Field>
      <Field label='Max Input Tokens'>
        <TokenInput
          nullable
          value={value.maxInputTokens}
          onValueChange={(next) => set('maxInputTokens', next)}
        />
      </Field>
      <Field label='Effective From'>
        <Input
          type='datetime-local'
          value={local(value.effectiveFrom)}
          onChange={(e) =>
            set('effectiveFrom', new Date(e.target.value).toISOString())
          }
        />
      </Field>
      <Field label='Effective To'>
        <Input
          type='datetime-local'
          value={local(value.effectiveTo)}
          onChange={(e) =>
            set(
              'effectiveTo',
              e.target.value ? new Date(e.target.value).toISOString() : null
            )
          }
        />
      </Field>
    </div>
  )
}
function Box({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className='space-y-3 rounded-lg border p-4'>
      <h3 className='font-semibold'>{title}</h3>
      {children}
    </section>
  )
}
function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <Label className='mb-2'>{label}</Label>
      {children}
    </div>
  )
}
function Select({
  value,
  change,
  label,
  options,
}: {
  value: string
  change: (v: string) => void
  label: string
  options: string[][]
}) {
  return (
    <select
      className='h-9 rounded-md border bg-background px-3 text-sm'
      value={value}
      onChange={(e) => change(e.target.value)}
    >
      <option value=''>{label}</option>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  )
}
function Health({ enabled, status }: { enabled: boolean; status: string }) {
  const { t } = useTranslation()
  if (!enabled)
    return (
      <span className='text-muted-foreground'>
        {t('common.state.disabled')}
      </span>
    )
  return (
    <span
      className={
        status === 'UP'
          ? 'text-emerald-600'
          : status === 'DOWN'
            ? 'text-destructive'
            : 'text-muted-foreground'
      }
    >
      {status === 'UP'
        ? t('common.state.normal')
        : status === 'DOWN'
          ? t('common.state.abnormal')
          : t('common.state.unknown')}
    </span>
  )
}

function protocolStrategyKey(
  strategy: RelayView['protocolStrategy']
): TranslationKey {
  return `routeMatrix.strategy.${strategy}`
}

function protocolLabel(code: RelayView['protocols'][number]['code']) {
  return {
    OPENAI_CHAT_COMPLETIONS: 'Chat Completions',
    OPENAI_RESPONSES: 'Responses',
    ANTHROPIC_MESSAGES: 'Anthropic Messages',
  }[code]
}

/**
 * 推理强度不生效的路由告警。
 *
 * 两级严重度刻意用不同颜色和不同措辞：REJECTED 是已确认的事实（上游明确拒绝，请求
 * 已自动降级，用户无感知），IGNORED 只是怀疑（也可能是模型自己判断不需要思考）。
 * 混成一条会让管理员拿着不确定的信号去做确定的配置动作。
 */
function ReasoningAlerts() {
  const { t, localeTag } = useTranslation()
  const client = useQueryClient()
  const alerts = useQuery({
    queryKey: ['reasoning-alerts'],
    queryFn: () => listReasoningAlerts(true),
  })
  const resolve = useMutation({
    mutationFn: resolveReasoningAlert,
    onSuccess: () => {
      toast.success(t('routeMatrix.reasoning.alertResolved'))
      void client.invalidateQueries({ queryKey: ['reasoning-alerts'] })
    },
    onError: fail,
  })
  const rows = alerts.data ?? []
  if (!rows.length) return null

  return (
    <Card className='mb-4 border-amber-300 dark:border-amber-900'>
      <CardContent className='space-y-3 p-4'>
        <div className='flex items-center gap-2 text-sm font-semibold'>
          <CircleAlert className='size-4 text-amber-600' />
          {t('routeMatrix.reasoning.alertTitle', { count: rows.length })}
        </div>
        {rows.map((alert) => {
          const confirmed = alert.kind === 'REJECTED'
          return (
            <div
              key={alert.id}
              className={`flex flex-wrap items-start justify-between gap-3 rounded-md border p-3 text-sm ${
                confirmed
                  ? 'border-orange-200 bg-orange-50 dark:bg-orange-950/25'
                  : 'bg-muted/40'
              }`}
            >
              <div className='min-w-0'>
                <div className='font-medium'>
                  {t(
                    confirmed
                      ? 'routeMatrix.reasoning.alertRejected'
                      : 'routeMatrix.reasoning.alertIgnored',
                    {
                      model: alert.modelDisplayName ?? alert.modelId,
                      relay: alert.relayName ?? `#${alert.configurationId}`,
                      count: alert.sourceCount,
                    }
                  )}
                </div>
                <div className='mt-1 text-xs text-muted-foreground'>
                  {alert.protocolCode} · {alert.upstreamModelId} ·{' '}
                  {new Date(alert.lastSeenAt).toLocaleString(localeTag)}
                </div>
                <div className='mt-1 text-xs text-muted-foreground'>
                  {t(
                    confirmed
                      ? 'routeMatrix.reasoning.alertRejectedAdvice'
                      : 'routeMatrix.reasoning.alertIgnoredAdvice'
                  )}
                </div>
              </div>
              <Button
                size='sm'
                variant='outline'
                disabled={resolve.isPending}
                onClick={() => resolve.mutate(alert.id)}
              >
                {t('routeMatrix.reasoning.alertDismiss')}
              </Button>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

function RouteStatus({
  model,
  relay,
  binding,
  catalog,
}: {
  model: ModelView
  relay: RelayView
  binding: ModelBinding
  catalog?: UpstreamCatalog
}) {
  const { t } = useTranslation()
  let label: TranslationKey = 'common.state.normal'
  let className = 'text-emerald-600'
  if (!relay.enabled) {
    label = 'routeMatrix.status.relayDisabled'
    className = 'text-muted-foreground'
  } else if (!binding.enabled) {
    label = 'routeMatrix.status.routeDisabled'
    className = 'text-muted-foreground'
  } else if (!model.enabled) {
    label = 'routeMatrix.status.modelDisabled'
    className = 'text-muted-foreground'
  } else if (model.accessGroupCount === 0) {
    label = 'routeMatrix.status.noAccessGroup'
    className = 'text-amber-600'
  } else if (relay.healthStatus === 'DOWN') {
    label = 'routeMatrix.status.relayDown'
    className = 'text-destructive'
  } else if (catalog?.loading) {
    label = 'routeMatrix.status.catalogLoading'
    className = 'text-muted-foreground'
  } else if (!catalog || catalog.error) {
    label = 'routeMatrix.status.catalogError'
    className = 'text-destructive'
  } else if (!catalog.modelIds.has(binding.upstreamModelId)) {
    label = 'routeMatrix.status.modelMissing'
    className = 'text-destructive'
  }
  return <span className={className}>{t(label)}</span>
}
function activePrice(model: ModelView) {
  const now = Date.now()
  return model.referencePrices.find(
    (p) =>
      p.enabled &&
      Date.parse(p.effectiveFrom) <= now &&
      (!p.effectiveTo || Date.parse(p.effectiveTo) > now)
  )
}
function currentTier(prices: ModelPricing[]) {
  const now = Date.now()
  return prices.find(
    (price) =>
      price.enabled &&
      Date.parse(price.effectiveFrom) <= now &&
      (!price.effectiveTo || Date.parse(price.effectiveTo) > now) &&
      price.minInputTokens === 0
  )
}
function local(value: string | null) {
  if (!value) return ''
  const d = new Date(value)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16)
}
function fail(error: unknown) {
  toast.error(
    error instanceof Error
      ? error.message
      : translateOutsideComponent('routeMatrix.toast.actionFailed')
  )
}
