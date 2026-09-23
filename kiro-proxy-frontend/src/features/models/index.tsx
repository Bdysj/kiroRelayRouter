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
  type ModelPricing,
  type ModelView,
} from '@/lib/api/admin'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
      toast.success(model.enabled ? '模型已启用' : '模型已停用')
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
          <ThemeSwitch />
          <ConfigDrawer />
        </div>
      </Header>
      <Main>
        <div className='mb-6 flex items-start justify-between gap-3'>
          <div>
            <h1 className='text-2xl font-bold tracking-tight'>模型管理</h1>
            <p className='text-muted-foreground'>
              管理平台统一模型及官方参考价格
            </p>
            <p className='mt-1 text-sm text-muted-foreground'>
              拖动行首手柄调整模型顺序；手柄获得焦点后也可用 ↑ / ↓
              微调。顺序保存时会
              重新编号全部模型，因此存量的重复排序值不会影响结果。
            </p>
          </div>
          <Button onClick={() => setCreating(true)}>
            <Plus />
            新建模型
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
                ? `${enabledWithoutPrice.length} 个已启用模型缺少当前有效的官方参考价`
                : `${missingPrices.length} 个模型尚未配置当前有效的官方参考价`}
            </AlertTitle>
            <AlertDescription>
              <p>
                缺少价格的模型无法完成用量计费，请先配置输入、缓存和输出参考价，再启用模型。
              </p>
              <Button
                size='sm'
                variant='outline'
                className='mt-2'
                onClick={() => setDetails(missingPrices[0])}
              >
                <CircleDollarSign />
                配置官方参考价
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
                      <span className='sr-only'>排序</span>
                    </TableHead>
                    <TableHead>显示名称</TableHead>
                    <TableHead>Model ID</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>输入价</TableHead>
                    <TableHead>缓存读取</TableHead>
                    <TableHead>缓存写入</TableHead>
                    <TableHead>输出价</TableHead>
                    <TableHead>Pricing Unit</TableHead>
                    <TableHead>已关联中转站</TableHead>
                    <TableHead className='text-right'>操作</TableHead>
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
                          aria-label={`调整“${model.displayName}”的顺序，当前第 ${index + 1} 位，共 ${rows.length} 个`}
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
                            价格未配置
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
                          {model.enabled ? '启用' : '停用'}
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
                              未配置
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
                      <TableCell>{model.bindings.length} 个中转站</TableCell>
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
                            {currentPrice(model) ? '详情' : '配置价格'}
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
                                  '请先配置当前有效的官方参考价，再启用模型'
                                )
                                setDetails(model)
                                return
                              }
                              if (
                                enabled ||
                                window.confirm(
                                  `确定停用“${model.displayName}”吗？`
                                )
                              )
                                toggleEnabled.mutate({
                                  modelId: model.modelId,
                                  enabled,
                                })
                            }}
                          >
                            {model.enabled ? '停用' : '启用'}
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
  const client = useQueryClient()
  const [base, setBase] = useState({
    modelId: model.modelId,
    displayName: model.displayName,
    sortOrder: model.sortOrder,
    enabled: model.enabled,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
  })
  const [prices, setPrices] = useState<ModelPricing[]>(
    sortPrices(model.referencePrices)
  )
  const saveBase = useMutation({
    mutationFn: saveModel,
    onSuccess: () => {
      toast.success('基础信息已保存')
      void client.invalidateQueries({ queryKey: ['admin-models'] })
    },
    onError: showError,
  })
  const savePrice = useMutation({
    mutationFn: (value: ModelPricing) => saveModelPrice(model.modelId, value),
    onSuccess: (updated) => {
      toast.success('官方参考价已保存')
      setPrices(sortPrices(updated.referencePrices))
      void client.invalidateQueries({ queryKey: ['admin-models'] })
    },
    onError: showError,
  })
  const removePrice = useMutation({
    mutationFn: (id: number) => deleteModelPrice(model.modelId, id),
    onSuccess: (_, id) => {
      toast.success('价格阶梯已删除')
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
            {model.modelId} · 模型详情与官方参考价
          </SheetDescription>
        </SheetHeader>
        <div className='flex-1 space-y-6 overflow-y-auto px-4 pb-6'>
          <section className='space-y-3 rounded-lg border p-4'>
            <h3 className='font-semibold'>基础信息</h3>
            <div className='grid gap-3 sm:grid-cols-2'>
              <Field label='Model ID'>
                <Input disabled value={base.modelId} />
              </Field>
              <Field label='显示名称（可选）'>
                <Input
                  value={base.displayName}
                  placeholder='留空时使用 Model ID'
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
                    label='最大上下文窗口'
                    description='该模型可接收的最大上下文 Token 数。必须与实际上游模型能力一致，设置过大可能导致上游拒绝请求。'
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
                    description='单次回答允许的最大输出 Token 数，会传递到上游的 max_tokens 或 max_output_tokens。请勿超过上游限制。'
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
            </div>
            <Button
              size='sm'
              onClick={() => saveBase.mutate(base)}
              disabled={saveBase.isPending}
            >
              保存基础信息
            </Button>
          </section>
          <section className='space-y-3 rounded-lg border p-4'>
            <div>
              <h3 className='font-semibold'>官方价格</h3>
              <p className='text-xs text-muted-foreground'>
                仅写入 relay_model_pricing，不会修改中转站实际成本。
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
            关闭
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
  const update = (index: number, value: ModelPricing) =>
    onChange(prices.map((item, current) => (current === index ? value : item)))
  return (
    <div className='space-y-4'>
      {prices.map((item, index) => (
        <div key={item.id ?? `new-${index}`} className='rounded-lg border p-3'>
          <div className='mb-3 flex items-center justify-between gap-3'>
            <div className='text-sm font-medium'>
              阶梯 {index + 1}：{item.minInputTokens.toLocaleString()} –{' '}
              {item.maxInputTokens?.toLocaleString() ?? '无上限'} Tokens
            </div>
            <Button
              type='button'
              size='icon'
              variant='ghost'
              aria-label={`删除阶梯 ${index + 1}`}
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
            保存此阶梯
          </Button>
        </div>
      ))}
      <Button
        type='button'
        variant='outline'
        disabled={pending}
        onClick={() => onChange([...prices, nextPrice(prices, source)])}
      >
        <Plus /> 新增价格阶梯
      </Button>
      {prices.length === 0 && (
        <p className='text-sm text-muted-foreground'>
          尚未配置价格，请新增第一个阶梯。
        </p>
      )}
    </div>
  )
}

function ModelDialog({ close }: { close: () => void }) {
  const client = useQueryClient()
  const [form, setForm] = useState({
    modelId: '',
    displayName: '',
    sortOrder: 0,
    enabled: false,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
  })
  const mutation = useMutation({
    mutationFn: saveModel,
    onSuccess: () => {
      toast.success('模型已保存')
      void client.invalidateQueries({ queryKey: ['admin-models'] })
      close()
    },
    onError: showError,
  })
  return (
    <Dialog open onOpenChange={(v) => !v && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建模型</DialogTitle>
          <DialogDescription>
            模型 ID 是平台统一标识，创建后不可修改。
          </DialogDescription>
        </DialogHeader>
        <form
          className='grid gap-4'
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate(form)
          }}
        >
          <Field label='模型 ID'>
            <Input
              required
              value={form.modelId}
              onChange={(e) => setForm({ ...form, modelId: e.target.value })}
            />
          </Field>
          <Field label='显示名称（可选）'>
            <Input
              value={form.displayName}
              placeholder='留空时使用 Model ID'
              onChange={(e) =>
                setForm({ ...form, displayName: e.target.value })
              }
            />
          </Field>
          <Field label='排序值'>
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
                label='最大上下文窗口'
                description='默认 1,000,000 Tokens。该值会作为模型 metadata 返回给 Kiro，决定上下文占用率和自动压缩时机。'
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
                description='默认 128,000 Tokens。该值限制单次回答的最大输出长度，应与实际上游模型支持的最大输出一致。'
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
          <div className='rounded-md border border-dashed p-3 text-sm text-muted-foreground'>
            新模型将以停用状态创建。创建后请配置官方参考价，再从模型列表启用。
          </div>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={close}>
              取消
            </Button>
            <Button disabled={mutation.isPending}>保存</Button>
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
  const set = (key: keyof ModelPricing, v: unknown) =>
    change({ ...value, [key]: v })
  return (
    <div className='grid gap-3 sm:grid-cols-4'>
      <p className='text-xs text-muted-foreground sm:col-span-4'>
        价格按定价 Token 单位计算；例如 $3 / 1,000,000 Tokens 请填写 3。最多支持{' '}
        {PRICE_DECIMALS} 位小数。
      </p>
      {(
        [
          ['inputPrice', '输入价'],
          ['cacheInputPrice', '缓存读取价'],
          ['cacheWriteInputPrice', '缓存写入价'],
          ['outputPrice', '输出价'],
        ] as const
      ).map(([key, label]) => (
        <Field key={key} label={label}>
          <PriceInput
            value={value[key]}
            onValueChange={(next) => set(key, next)}
          />
        </Field>
      ))}
      <Field label='定价 Token 单位'>
        <Input
          type='number'
          min={1}
          value={value.pricingUnit}
          onChange={(e) => set('pricingUnit', Number(e.target.value))}
        />
      </Field>
      <Field label='价格来源'>
        <Input
          value={value.priceSource}
          onChange={(e) => set('priceSource', e.target.value)}
        />
      </Field>
      <Field label='Currency'>
        <Input disabled value='USD' />
      </Field>
      <Field label='最小输入 Tokens'>
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
      <Field label='最大输入 Tokens'>
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
        <Label>价格启用</Label>
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
  return (
    <span className='inline-flex items-center gap-1.5'>
      {label}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type='button'
            aria-label={`查看${label}说明`}
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
}: {
  label: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <Label className='mb-2'>{label}</Label>
      {children}
    </div>
  )
}
function message(error: unknown) {
  return error instanceof Error ? error.message : '请求失败'
}
function showError(error: unknown) {
  toast.error(message(error))
}
