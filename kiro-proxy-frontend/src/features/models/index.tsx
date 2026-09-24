import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CircleAlert,
  CircleDollarSign,
  GripVertical,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  deleteModelPrice,
  listModels,
  reorderModels,
  saveModel,
  saveModelPrice,
  setModelEnabled,
  REASONING_LEVELS,
  REASONING_LEVEL_PRESETS,
  type ModelPricing,
  type ModelView,
  type ReasoningLevel,
} from '@/lib/api/admin'
import { t as translate, useTranslation, type TranslationKey } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ConfigDrawer } from '@/components/config-drawer'
import { LanguageSwitch } from '@/components/language-switch'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { PRICE_DECIMALS, PriceInput } from '@/components/price-input'
import { ThemeSwitch } from '@/components/theme-switch'
import { TokenInput } from '@/components/token-input'

const newPrice = (source = 'official'): ModelPricing => ({
  inputPrice: 0,
  cacheInputPrice: 0,
  cacheWriteInputPrice: 0,
  outputPrice: 0,
  pricingUnit: 1_000_000,
  priceSource: source,
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

function nextPrice(prices: ModelPricing[], source: string) {
  const highestMaximum = prices.reduce<number | null>(
    (highest, item) =>
      item.maxInputTokens === null
        ? highest
        : Math.max(highest ?? -1, item.maxInputTokens),
    null
  )
  return {
    ...newPrice(source),
    minInputTokens: highestMaximum === null ? 0 : highestMaximum + 1,
  }
}

export function ModelsPage() {
  const { t } = useTranslation()
  const client = useQueryClient()
  const models = useQuery({ queryKey: ['admin-models'], queryFn: listModels })
  const [creating, setCreating] = useState(false)
  const [details, setDetails] = useState<ModelView | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const missingPrices = (models.data ?? []).filter(
    (model) => !currentPrice(model)
  )
  const enabledWithoutPrice = missingPrices.filter((model) => model.enabled)
  const toggleEnabled = useMutation({
    mutationFn: ({ modelId, enabled }: { modelId: string; enabled: boolean }) =>
      setModelEnabled(modelId, enabled),
    onSuccess: (model) => {
      toast.success(
        t(model.enabled ? 'models.toast.enabled' : 'models.toast.disabled')
      )
      void client.invalidateQueries({ queryKey: ['admin-models'] })
    },
    onError: showError,
  })
  const reorder = useMutation({
    mutationFn: reorderModels,
    // 后端返回重排后的完整列表，直接覆盖缓存，避免乐观顺序和真实 sortOrder 漂移。
    onSuccess: (ordered) => client.setQueryData(['admin-models'], ordered),
    onError: (error) => {
      showError(error)
      void client.invalidateQueries({ queryKey: ['admin-models'] })
    },
  })
  const rows = models.data ?? []

  /** 把 modelId 移动到 targetIndex，先乐观渲染再提交整份顺序。 */
  const moveTo = (modelId: string, targetIndex: number) => {
    const from = rows.findIndex((model) => model.modelId === modelId)
    const to = Math.max(0, Math.min(rows.length - 1, targetIndex))
    if (from < 0 || from === to) return
    const next = [...rows]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    client.setQueryData(
      ['admin-models'],
      // 预填后端的编号规则（步长 10），让详情抽屉里的 Sort Order 立刻对得上。
      next.map((model, index) => ({ ...model, sortOrder: (index + 1) * 10 }))
    )
    reorder.mutate(next.map((model) => model.modelId))
  }
  const dropOn = (targetId: string) => {
    if (!draggingId || draggingId === targetId) return
    moveTo(
      draggingId,
      rows.findIndex((model) => model.modelId === targetId)
    )
  }
  const nudge = (modelId: string, delta: number) =>
    moveTo(
      modelId,
      rows.findIndex((model) => model.modelId === modelId) + delta
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
      <Main>
        <div className='mb-6 flex items-start justify-between gap-3'>
          <div>
            <h1 className='text-2xl font-bold tracking-tight'>
              {t('models.title')}
            </h1>
            <p className='text-muted-foreground'>{t('models.description')}</p>
            <p className='mt-1 text-sm text-muted-foreground'>
              {t('models.reorderHint')}
            </p>
          </div>
          <Button onClick={() => setCreating(true)}>
            <Plus />
            {t('models.create')}
          </Button>
        </div>
        {!!missingPrices.length && (
          <Alert
            variant={enabledWithoutPrice.length ? 'destructive' : 'default'}
            className='mb-4'
          >
            <AlertTriangle />
            <AlertTitle>
              {enabledWithoutPrice.length
                ? t('models.alert.enabledMissingPrice', {
                    count: enabledWithoutPrice.length,
                  })
                : t('models.alert.missingPrice', {
                    count: missingPrices.length,
                  })}
            </AlertTitle>
            <AlertDescription>
              <p>{t('models.alert.description')}</p>
              <Button
                size='sm'
                variant='outline'
                className='mt-2'
                onClick={() => setDetails(missingPrices[0])}
              >
                <CircleDollarSign />
                {t('models.alert.action')}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <Card>
          <CardContent className='p-0'>
            {models.isLoading ? (
              <div className='flex h-48 items-center justify-center'>
                <Loader2 className='animate-spin' />
              </div>
            ) : models.isError ? (
              <div className='p-8 text-center text-destructive'>
                {message(models.error)}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className='w-10'>
                      <span className='sr-only'>{t('models.table.sort')}</span>
                    </TableHead>
                    <TableHead>{t('models.table.displayName')}</TableHead>
                    <TableHead>Model ID</TableHead>
                    <TableHead>{t('models.table.status')}</TableHead>
                    <TableHead>{t('models.table.inputPrice')}</TableHead>
                    <TableHead>{t('models.table.cacheRead')}</TableHead>
                    <TableHead>{t('models.table.cacheWrite')}</TableHead>
                    <TableHead>{t('models.table.outputPrice')}</TableHead>
                    <TableHead>Pricing Unit</TableHead>
                    <TableHead>{t('models.table.boundRelays')}</TableHead>
                    <TableHead className='text-right'>
                      {t('models.table.actions')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((model, index) => (
                    <TableRow
                      key={model.modelId}
                      className={cn(
                        'cursor-pointer',
                        draggingId === model.modelId && 'opacity-40',
                        dropTargetId === model.modelId &&
                          draggingId !== model.modelId &&
                          'bg-muted'
                      )}
                      onClick={() => setDetails(model)}
                      onDragOver={(event) => {
                        if (!draggingId) return
                        event.preventDefault()
                        setDropTargetId(model.modelId)
                      }}
                      onDragLeave={() =>
                        setDropTargetId((current) =>
                          current === model.modelId ? null : current
                        )
                      }
                      onDrop={(event) => {
                        event.preventDefault()
                        dropOn(model.modelId)
                        setDraggingId(null)
                        setDropTargetId(null)
                      }}
                    >
                      <TableCell onClick={(event) => event.stopPropagation()}>
                        <button
                          type='button'
                          draggable
                          disabled={reorder.isPending}
                          aria-label={t('models.table.reorderHandle', {
                            name: model.displayName,
                            position: index + 1,
                            total: rows.length,
                          })}
                          className='cursor-grab rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50'
                          onDragStart={(event) => {
                            setDraggingId(model.modelId)
                            event.dataTransfer.effectAllowed = 'move'
                            event.dataTransfer.setData(
                              'text/plain',
                              model.modelId
                            )
                          }}
                          onDragEnd={() => {
                            setDraggingId(null)
                            setDropTargetId(null)
                          }}
                          onKeyDown={(event) => {
                            if (
                              event.key !== 'ArrowUp' &&
                              event.key !== 'ArrowDown'
                            )
                              return
                            event.preventDefault()
                            nudge(
                              model.modelId,
                              event.key === 'ArrowUp' ? -1 : 1
                            )
                          }}
                        >
                          <GripVertical className='size-4' />
                        </button>
                      </TableCell>
                      <TableCell>
                        <div className='font-medium'>{model.displayName}</div>
                        {!currentPrice(model) && (
                          <Badge variant='destructive' className='mt-1'>
                            {t('models.table.priceMissing')}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className='font-mono text-xs'>
                        {model.modelId}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={model.enabled ? 'default' : 'secondary'}
                        >
                          {t(
                            model.enabled
                              ? 'common.state.enabled'
                              : 'common.state.disabled'
                          )}
                        </Badge>
                      </TableCell>
                      {(
                        [
                          'inputPrice',
                          'cacheInputPrice',
                          'cacheWriteInputPrice',
                          'outputPrice',
                        ] as const
                      ).map((key) => (
                        <TableCell key={key}>
                          {currentPrice(model) ? (
                            `$${currentPrice(model)![key]}`
                          ) : (
                            <span className='font-medium text-destructive'>
                              {t('models.table.priceUnset')}
                            </span>
                          )}
                        </TableCell>
                      ))}
                      <TableCell>
                        {currentPrice(model) ? (
                          `/${formatUnit(currentPrice(model)!.pricingUnit)}`
                        ) : (
                          <span className='text-destructive'>—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {t('models.table.relayCount', {
                          count: model.bindings.length,
                        })}
                      </TableCell>
                      <TableCell>
                        <div className='flex justify-end gap-1'>
                          <Button
                            size='sm'
                            variant='ghost'
                            onClick={(event) => {
                              event.stopPropagation()
                              setDetails(model)
                            }}
                          >
                            {t(
                              currentPrice(model)
                                ? 'models.table.details'
                                : 'models.table.configurePrice'
                            )}
                          </Button>
                          <Button
                            size='sm'
                            variant='ghost'
                            className={model.enabled ? 'text-destructive' : ''}
                            disabled={toggleEnabled.isPending}
                            onClick={(event) => {
                              event.stopPropagation()
                              const enabled = !model.enabled
                              if (enabled && !currentPrice(model)) {
                                toast.error(
                                  t('models.toast.needPriceBeforeEnable')
                                )
                                setDetails(model)
                                return
                              }
                              if (
                                enabled ||
                                window.confirm(
                                  t('models.confirm.disable', {
                                    name: model.displayName,
                                  })
                                )
                              )
                                toggleEnabled.mutate({
                                  modelId: model.modelId,
                                  enabled,
                                })
                            }}
                          >
                            {t(
                              model.enabled
                                ? 'common.action.disable'
                                : 'common.action.enable'
                            )}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </Main>
      {creating && <ModelDialog close={() => setCreating(false)} />}
      {details && (
        <ModelDetailsDrawer model={details} close={() => setDetails(null)} />
      )}
    </>
  )
}

function currentPrice(model: ModelView) {
  const now = Date.now()
  return model.referencePrices.find(
    (price) =>
      price.enabled &&
      new Date(price.effectiveFrom).getTime() <= now &&
      (!price.effectiveTo || new Date(price.effectiveTo).getTime() > now)
  )
}

function formatUnit(value: number) {
  return value === 1_000_000 ? '1M' : value.toLocaleString()
}

function ModelDetailsDrawer({
  model,
  close,
}: {
  model: ModelView
  close: () => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [base, setBase] = useState({
    modelId: model.modelId,
    displayName: model.displayName,
    sortOrder: model.sortOrder,
    enabled: model.enabled,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    reasoningLevels: model.reasoningLevels,
    reasoningDefaultLevel: model.reasoningDefaultLevel,
  })
  const [prices, setPrices] = useState<ModelPricing[]>(
    sortPrices(model.referencePrices)
  )
  const saveBase = useMutation({
    mutationFn: saveModel,
    onSuccess: () => {
      toast.success(t('models.toast.basicSaved'))
      void client.invalidateQueries({ queryKey: ['admin-models'] })
    },
    onError: showError,
  })
  const savePrice = useMutation({
    mutationFn: (value: ModelPricing) => saveModelPrice(model.modelId, value),
    onSuccess: (updated) => {
      toast.success(t('models.toast.priceSaved'))
      setPrices(sortPrices(updated.referencePrices))
      void client.invalidateQueries({ queryKey: ['admin-models'] })
    },
    onError: showError,
  })
  const removePrice = useMutation({
    mutationFn: (id: number) => deleteModelPrice(model.modelId, id),
    onSuccess: (_, id) => {
      toast.success(t('models.toast.tierDeleted'))
      setPrices((current) => current.filter((item) => item.id !== id))
      void client.invalidateQueries({ queryKey: ['admin-models'] })
    },
    onError: showError,
  })
  return (
    <Sheet open onOpenChange={(open) => !open && close()}>
      <SheetContent className='w-full overflow-y-auto sm:max-w-2xl'>
        <SheetHeader>
          <SheetTitle>{model.displayName}</SheetTitle>
          <SheetDescription>
            {t('models.detail.subtitle', { modelId: model.modelId })}
          </SheetDescription>
        </SheetHeader>
        <div className='flex-1 space-y-6 overflow-y-auto px-4 pb-6'>
          <section className='space-y-3 rounded-lg border p-4'>
            <h3 className='font-semibold'>{t('models.detail.basic')}</h3>
            <div className='grid gap-3 sm:grid-cols-2'>
              <Field label='Model ID'>
                <Input disabled value={base.modelId} />
              </Field>
              <Field label={t('models.field.displayNameOptional')}>
                <Input
                  value={base.displayName}
                  placeholder={t('models.field.displayNamePlaceholder')}
                  onChange={(e) =>
                    setBase({ ...base, displayName: e.target.value })
                  }
                />
              </Field>
              <Field label='Sort Order'>
                <Input
                  type='number'
                  min={0}
                  value={base.sortOrder}
                  onChange={(e) =>
                    setBase({ ...base, sortOrder: Number(e.target.value) })
                  }
                />
              </Field>
              <Field
                label={
                  <LimitLabel
                    label={t('models.field.maxContextWindow')}
                    description={t('models.field.maxContextWindowHelp')}
                  />
                }
              >
                <TokenInput
                  value={base.maxInputTokens}
                  onValueChange={(value) =>
                    setBase({ ...base, maxInputTokens: value ?? 1_000_000 })
                  }
                />
              </Field>
              <Field
                label={
                  <LimitLabel
                    label='maxOutputTokens'
                    description={t('models.field.maxOutputTokensHelp')}
                  />
                }
              >
                <TokenInput
                  value={base.maxOutputTokens}
                  onValueChange={(value) =>
                    setBase({ ...base, maxOutputTokens: value ?? 128_000 })
                  }
                />
              </Field>
              <ReasoningLevelsField
                className='sm:col-span-2'
                value={base}
                onChange={(next) => setBase({ ...base, ...next })}
              />
            </div>
            <Button
              size='sm'
              onClick={() => saveBase.mutate(base)}
              disabled={saveBase.isPending}
            >
              {t('models.detail.saveBasic')}
            </Button>
          </section>
          <section className='space-y-3 rounded-lg border p-4'>
            <div>
              <h3 className='font-semibold'>
                {t('models.detail.officialPricing')}
              </h3>
              <p className='text-xs text-muted-foreground'>
                {t('models.detail.officialPricingHint')}
              </p>
            </div>
            <TieredPriceEditor
              prices={prices}
              source='official'
              onChange={setPrices}
              onSave={(value) => savePrice.mutate(value)}
              onDelete={(id) => removePrice.mutate(id)}
              pending={savePrice.isPending || removePrice.isPending}
            />
          </section>
        </div>
        <SheetFooter>
          <Button variant='outline' onClick={close}>
            {t('common.action.close')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function TieredPriceEditor({
  prices,
  source,
  onChange,
  onSave,
  onDelete,
  pending,
}: {
  prices: ModelPricing[]
  source: string
  onChange: (prices: ModelPricing[]) => void
  onSave: (price: ModelPricing) => void
  onDelete: (id: number) => void
  pending: boolean
}) {
  const { t, localeTag } = useTranslation()
  const update = (index: number, value: ModelPricing) =>
    onChange(prices.map((item, current) => (current === index ? value : item)))
  return (
    <div className='space-y-4'>
      {prices.map((item, index) => (
        <div key={item.id ?? `new-${index}`} className='rounded-lg border p-3'>
          <div className='mb-3 flex items-center justify-between gap-3'>
            <div className='text-sm font-medium'>
              {t('models.pricing.tier', {
                index: index + 1,
                min: item.minInputTokens.toLocaleString(localeTag),
                max:
                  item.maxInputTokens?.toLocaleString(localeTag) ??
                  t('models.pricing.noUpperLimit'),
              })}
            </div>
            <Button
              type='button'
              size='icon'
              variant='ghost'
              aria-label={t('models.pricing.deleteTier', { index: index + 1 })}
              disabled={pending}
              onClick={() =>
                item.id
                  ? onDelete(item.id)
                  : onChange(prices.filter((_, current) => current !== index))
              }
            >
              <Trash2 />
            </Button>
          </div>
          <PriceForm
            value={item}
            change={(value) => update(index, value)}
            showDates
          />
          <Button
            type='button'
            size='sm'
            className='mt-3'
            disabled={pending}
            onClick={() => onSave(item)}
          >
            {t('models.pricing.saveTier')}
          </Button>
        </div>
      ))}
      <Button
        type='button'
        variant='outline'
        disabled={pending}
        onClick={() => onChange([...prices, nextPrice(prices, source)])}
      >
        <Plus /> {t('models.pricing.addTier')}
      </Button>
      {prices.length === 0 && (
        <p className='text-sm text-muted-foreground'>
          {t('models.pricing.emptyTiers')}
        </p>
      )}
    </div>
  )
}

function ModelDialog({ close }: { close: () => void }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [form, setForm] = useState<
    Parameters<typeof saveModel>[0] & ReasoningSelection
  >({
    modelId: '',
    displayName: '',
    sortOrder: 0,
    enabled: false,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    reasoningLevels: [],
    reasoningDefaultLevel: null,
  })
  const mutation = useMutation({
    mutationFn: saveModel,
    onSuccess: () => {
      toast.success(t('models.toast.saved'))
      void client.invalidateQueries({ queryKey: ['admin-models'] })
      close()
    },
    onError: showError,
  })
  return (
    <Dialog open onOpenChange={(v) => !v && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('models.create')}</DialogTitle>
          <DialogDescription>
            {t('models.createDialog.description')}
          </DialogDescription>
        </DialogHeader>
        <form
          className='grid gap-4'
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate(form)
          }}
        >
          <Field label={t('models.field.modelId')}>
            <Input
              required
              value={form.modelId}
              onChange={(e) => setForm({ ...form, modelId: e.target.value })}
            />
          </Field>
          <Field label={t('models.field.displayNameOptional')}>
            <Input
              value={form.displayName}
              placeholder={t('models.field.displayNamePlaceholder')}
              onChange={(e) =>
                setForm({ ...form, displayName: e.target.value })
              }
            />
          </Field>
          <Field label={t('models.field.sortOrder')}>
            <Input
              required
              type='number'
              min={0}
              value={form.sortOrder}
              onChange={(e) =>
                setForm({ ...form, sortOrder: Number(e.target.value) })
              }
            />
          </Field>
          <Field
            label={
              <LimitLabel
                label={t('models.field.maxContextWindow')}
                description={t('models.field.maxContextWindowCreateHelp')}
              />
            }
          >
            <TokenInput
              value={form.maxInputTokens}
              onValueChange={(value) =>
                setForm({ ...form, maxInputTokens: value ?? 1_000_000 })
              }
            />
          </Field>
          <Field
            label={
              <LimitLabel
                label='maxOutputTokens'
                description={t('models.field.maxOutputTokensCreateHelp')}
              />
            }
          >
            <TokenInput
              value={form.maxOutputTokens}
              onValueChange={(value) =>
                setForm({ ...form, maxOutputTokens: value ?? 128_000 })
              }
            />
          </Field>
          <ReasoningLevelsField
            value={form}
            onChange={(next) => setForm({ ...form, ...next })}
          />
          <div className='rounded-md border border-dashed p-3 text-sm text-muted-foreground'>
            {t('models.createDialog.hint')}
          </div>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={close}>
              {t('common.action.cancel')}
            </Button>
            <Button disabled={mutation.isPending}>
              {t('common.action.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PriceForm({
  value,
  change,
  showDates = false,
}: {
  value: ModelPricing
  change: (v: ModelPricing) => void
  showDates?: boolean
}) {
  const { t } = useTranslation()
  const set = (key: keyof ModelPricing, v: unknown) =>
    change({ ...value, [key]: v })
  return (
    <div className='grid gap-3 sm:grid-cols-4'>
      <p className='text-xs text-muted-foreground sm:col-span-4'>
        {t('models.pricing.hint', { decimals: PRICE_DECIMALS })}
      </p>
      {(
        [
          ['inputPrice', 'models.pricing.inputPrice'],
          ['cacheInputPrice', 'models.pricing.cacheReadPrice'],
          ['cacheWriteInputPrice', 'models.pricing.cacheWritePrice'],
          ['outputPrice', 'models.pricing.outputPrice'],
        ] as const satisfies readonly (readonly [
          keyof ModelPricing,
          TranslationKey,
        ])[]
      ).map(([key, labelKey]) => (
        <Field key={key} label={t(labelKey)}>
          <PriceInput
            value={value[key]}
            onValueChange={(next) => set(key, next)}
          />
        </Field>
      ))}
      <Field label={t('models.pricing.pricingUnit')}>
        <Input
          type='number'
          min={1}
          value={value.pricingUnit}
          onChange={(e) => set('pricingUnit', Number(e.target.value))}
        />
      </Field>
      <Field label={t('models.pricing.priceSource')}>
        <Input
          value={value.priceSource}
          onChange={(e) => set('priceSource', e.target.value)}
        />
      </Field>
      <Field label='Currency'>
        <Input disabled value='USD' />
      </Field>
      <Field label={t('models.pricing.minInputTokens')}>
        <TokenInput
          value={value.minInputTokens}
          onValueChange={(next) => set('minInputTokens', next ?? 0)}
        />
      </Field>
      {showDates && (
        <>
          <Field label='Effective From'>
            <Input
              type='datetime-local'
              value={toLocalInput(value.effectiveFrom)}
              onChange={(e) =>
                set('effectiveFrom', new Date(e.target.value).toISOString())
              }
            />
          </Field>
          <Field label='Effective To'>
            <Input
              type='datetime-local'
              value={toLocalInput(value.effectiveTo)}
              onChange={(e) =>
                set(
                  'effectiveTo',
                  e.target.value ? new Date(e.target.value).toISOString() : null
                )
              }
            />
          </Field>
        </>
      )}
      <Field label={t('models.pricing.maxInputTokens')}>
        <TokenInput
          nullable
          value={value.maxInputTokens}
          onValueChange={(next) => set('maxInputTokens', next)}
        />
      </Field>
      <div className='flex items-center gap-2'>
        <Switch
          checked={value.enabled}
          onCheckedChange={(v) => set('enabled', v)}
        />
        <Label>{t('models.pricing.priceEnabled')}</Label>
      </div>
    </div>
  )
}

function toLocalInput(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function LimitLabel({
  label,
  description,
}: {
  label: string
  description: string
}) {
  const { t } = useTranslation()
  return (
    <span className='inline-flex items-center gap-1.5'>
      {label}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type='button'
            aria-label={t('models.field.viewHelp', { label })}
            className='text-amber-600 hover:text-amber-700'
          >
            <CircleAlert className='size-4' />
          </button>
        </TooltipTrigger>
        <TooltipContent className='max-w-80 leading-relaxed'>
          {description}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}

function Field({
  label,
  children,
  className,
}: {
  label: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <Label className='mb-2'>{label}</Label>
      {children}
    </div>
  )
}

/** 档位的显示文案与 Kiro 自身一致：xhigh → xHigh，其余首字母大写。 */
function reasoningLabel(level: ReasoningLevel) {
  return level === 'xhigh'
    ? 'xHigh'
    : level.charAt(0).toUpperCase() + level.slice(1)
}

type ReasoningSelection = {
  reasoningLevels: ReasoningLevel[]
  reasoningDefaultLevel: ReasoningLevel | null
}

/**
 * 推理强度档位配置。
 *
 * 全不选 = 该模型不支持思考强度，Kiro 输入框右下角那个下拉框就不会出现。
 * 预设按钮只是省一次查文档，不构成运行时约束 —— 上游到底认不认由请求链路自动兜底。
 */
function ReasoningLevelsField({
  value,
  onChange,
  className,
}: {
  value: ReasoningSelection
  onChange: (next: ReasoningSelection) => void
  className?: string
}) {
  const { t } = useTranslation()
  const { reasoningLevels: levels, reasoningDefaultLevel: defaultLevel } = value

  const apply = (next: ReasoningLevel[]) => {
    const ordered = REASONING_LEVELS.filter((level) => next.includes(level))
    onChange({
      reasoningLevels: ordered,
      // 默认档位必须留在已选集合里，否则后端会直接拒绝这次保存。
      reasoningDefaultLevel:
        defaultLevel && ordered.includes(defaultLevel) ? defaultLevel : null,
    })
  }

  return (
    <div className={className}>
      <Label className='mb-2'>{t('models.reasoning.label')}</Label>
      <div className='space-y-3 rounded-md border p-3'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-xs text-muted-foreground'>
            {t('models.reasoning.preset')}
          </span>
          {(['openai', 'claude', 'all'] as const).map((preset) => (
            <Button
              key={preset}
              type='button'
              size='sm'
              variant='outline'
              onClick={() => apply([...REASONING_LEVEL_PRESETS[preset]])}
            >
              {t(`models.reasoning.preset_${preset}`)}
            </Button>
          ))}
          <Button
            type='button'
            size='sm'
            variant='ghost'
            onClick={() =>
              onChange({ reasoningLevels: [], reasoningDefaultLevel: null })
            }
          >
            {t('models.reasoning.presetClear')}
          </Button>
        </div>
        <div className='flex flex-wrap gap-x-4 gap-y-2'>
          {REASONING_LEVELS.map((level) => (
            <label key={level} className='flex items-center gap-2 text-sm'>
              <Checkbox
                checked={levels.includes(level)}
                onCheckedChange={() =>
                  apply(
                    levels.includes(level)
                      ? levels.filter((item) => item !== level)
                      : [...levels, level]
                  )
                }
              />
              {reasoningLabel(level)}
            </label>
          ))}
        </div>
        {levels.length > 0 && (
          <div>
            <Label className='mb-2 text-xs text-muted-foreground'>
              {t('models.reasoning.defaultLabel')}
            </Label>
            <select
              className='h-10 w-full rounded-md border border-input bg-background px-3 text-sm'
              value={defaultLevel ?? ''}
              onChange={(event) =>
                onChange({
                  reasoningLevels: levels,
                  reasoningDefaultLevel:
                    (event.target.value as ReasoningLevel) || null,
                })
              }
            >
              <option value=''>
                {t('models.reasoning.defaultAuto', {
                  level: reasoningLabel(levels[0]),
                })}
              </option>
              {levels.map((level) => (
                <option key={level} value={level}>
                  {reasoningLabel(level)}
                </option>
              ))}
            </select>
          </div>
        )}
        <p className='text-xs leading-relaxed text-muted-foreground'>
          {levels.length === 0
            ? t('models.reasoning.helpDisabled')
            : t('models.reasoning.help')}
        </p>
      </div>
    </div>
  )
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : translate('common.error.requestFailed')
}
function showError(error: unknown) {
  toast.error(message(error))
}
