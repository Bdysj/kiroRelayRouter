import { useState } from 'react'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, History, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  getBillingRuleHistory,
  getCurrentBillingRule,
  updateBillingRule,
} from '@/lib/api/admin'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'
import { SalesSimulatorCard } from './sales-simulator-card'

const CURRENT_RULE_KEY = ['admin-billing-rule-current'] as const
const HISTORY_KEY = ['admin-billing-rule-history'] as const
const HISTORY_FETCH_SIZE = 5

export function BillingRulePage() {
  const queryClient = useQueryClient()
  const [editOpen, setEditOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [nextRate, setNextRate] = useState('')
  const current = useQuery({
    queryKey: CURRENT_RULE_KEY,
    queryFn: getCurrentBillingRule,
  })
  const history = useInfiniteQuery({
    queryKey: HISTORY_KEY,
    queryFn: ({ pageParam }) =>
      getBillingRuleHistory(pageParam, HISTORY_FETCH_SIZE),
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length < HISTORY_FETCH_SIZE ? undefined : pages.length + 1,
    enabled: historyOpen,
  })
  const save = useMutation({
    mutationFn: () => updateBillingRule(Number(nextRate)),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: CURRENT_RULE_KEY }),
        queryClient.invalidateQueries({ queryKey: HISTORY_KEY }),
      ])
      setConfirmOpen(false)
      setEditOpen(false)
      toast.success('新的积分计费规则已生效')
    },
    onError: (error) => toast.error(error.message || '计费规则修改失败'),
  })

  const currentRate = current.data?.pointsPerUsd ?? 0
  const historicalRules = (history.data?.pages.flat() ?? []).filter(
    (rule) => rule.id !== current.data?.id
  )
  const hasMoreHistory = history.hasNextPage
  const proposedRate = positive(nextRate)
  const changePct =
    currentRate > 0 && proposedRate !== null
      ? (proposedRate / currentRate - 1) * 100
      : null

  const openEditor = () => {
    setNextRate(decimal(currentRate, 8))
    setEditOpen(true)
  }

  const toggleHistory = () => {
    if (historyOpen) {
      setHistoryOpen(false)
      return
    }
    setHistoryOpen(true)
  }

  return (
    <>
      <Header>
        <div className='ms-auto flex items-center gap-2'>
          <ThemeSwitch />
          <ConfigDrawer />
        </div>
      </Header>
      <Main className='max-w-none'>
        <div className='mb-5'>
          <h1 className='text-2xl font-bold tracking-tight'>积分与计费规则</h1>
          <p className='text-muted-foreground'>
            管理平台积分的计费规则与销售方案，统一配置，实时测算。
          </p>
        </div>
        <nav className='mb-5 flex border-b' aria-label='页面内容导航'>
          <a
            href='#billing-rule'
            className='border-b-2 border-primary px-5 py-3 text-sm font-semibold text-primary'
          >
            计费规则
          </a>
          <a
            href='#sales-plan'
            className='px-5 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground'
          >
            积分销售方案
          </a>
        </nav>

        {current.isLoading ? (
          <Card>
            <CardContent className='flex h-56 items-center justify-center'>
              <Loader2 className='animate-spin' />
            </CardContent>
          </Card>
        ) : current.isError || !current.data ? (
          <Card className='border-destructive/50'>
            <CardContent className='flex h-40 items-center justify-center text-destructive'>
              当前计费规则不可用，模型计费请求将被安全拒绝。
            </CardContent>
          </Card>
        ) : (
          <>
            <div
              id='billing-rule'
              className='grid scroll-mt-20 gap-4 xl:grid-cols-[1.4fr_1fr]'
            >
              <Card>
                <CardHeader>
                  <CardTitle>基础积分换算</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className='flex flex-wrap items-center gap-4 rounded-xl border bg-muted/30 p-5'>
                    <div>
                      <div className='text-sm text-muted-foreground'>
                        上游模型成本
                      </div>
                      <div className='mt-1 text-xl font-semibold'>1 USD</div>
                    </div>
                    <span className='text-2xl text-muted-foreground'>=</span>
                    <div className='min-w-52 rounded-lg border bg-background px-4 py-3 font-mono text-2xl font-semibold'>
                      {decimal(currentRate, 8)}
                    </div>
                    <div>
                      <div className='text-sm text-muted-foreground'>
                        平台积分
                      </div>
                      <div className='mt-1 text-xl font-semibold'>Points</div>
                    </div>
                  </div>
                  <div className='mt-4 space-y-2 text-sm text-muted-foreground'>
                    <p>
                      该值用于将中转站产生的美元模型成本换算成平台基础积分。
                    </p>
                    <p>
                      最终用户实际扣费仍会乘以该访问分组为所用模型配置的
                      模型倍率。
                    </p>
                  </div>
                  <div className='mt-5 rounded-lg border p-4 text-sm'>
                    <div className='font-medium'>示例</div>
                    <div className='mt-3 grid gap-3 sm:grid-cols-3'>
                      <Formula label='上游成本' value='$0.50' />
                      <Formula
                        label='基础积分'
                        value={`${decimal(0.5 * currentRate, 6)} Points`}
                        detail={`0.50 × ${compact(currentRate)}`}
                      />
                      <Formula
                        label='模型倍率 2.5× 后'
                        value={`${decimal(0.5 * currentRate * 2.5, 6)} Points`}
                        detail={`${compact(0.5 * currentRate)} × 2.5`}
                      />
                    </div>
                  </div>
                  <Button className='mt-5' onClick={openEditor}>
                    修改规则
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>当前规则信息</CardTitle>
                </CardHeader>
                <CardContent className='space-y-4 text-sm'>
                  <Info
                    label='当前换算'
                    value={`1 USD = ${compact(currentRate)} Points`}
                  />
                  <Info label='规则版本' value={`V${current.data.version}`} />
                  <Info label='当前状态' value={<Badge>启用</Badge>} />
                  <Info
                    label='生效时间'
                    value={dateTime(current.data.effectiveFrom)}
                  />
                  <Info
                    label='最后修改时间'
                    value={dateTime(current.data.updatedAt)}
                  />
                  <Button
                    variant='outline'
                    className='w-full'
                    onClick={toggleHistory}
                  >
                    <History />
                    {historyOpen ? '收起历史版本' : '查看历史版本'}
                  </Button>
                  {historyOpen && (
                    <div className='overflow-hidden rounded-lg border bg-muted/15'>
                      <div className='border-b px-3 py-2 text-xs font-medium text-muted-foreground'>
                        历史版本
                      </div>
                      <div
                        className='max-h-40 overflow-y-auto overscroll-contain'
                        onScroll={(event) => {
                          const target = event.currentTarget
                          const reachedBottom =
                            target.scrollHeight - target.scrollTop <=
                            target.clientHeight + 8
                          if (reachedBottom && hasMoreHistory) {
                            void history.fetchNextPage()
                          }
                        }}
                      >
                        {history.isLoading ? (
                          <div className='flex h-20 items-center justify-center'>
                            <Loader2 className='size-4 animate-spin' />
                          </div>
                        ) : history.isError ? (
                          <div className='px-3 py-5 text-center text-xs text-destructive'>
                            历史版本加载失败，请稍后重试。
                          </div>
                        ) : historicalRules.length === 0 ? (
                          <div className='px-3 py-5 text-center text-xs text-muted-foreground'>
                            暂无历史版本
                          </div>
                        ) : (
                          <>
                            {historicalRules.map((rule) => (
                              <div
                                key={rule.id}
                                className='flex items-center justify-between gap-3 border-b px-3 py-2.5 last:border-b-0'
                              >
                                <span className='min-w-0 truncate text-xs text-muted-foreground'>
                                  {dateTime(rule.createdAt)}
                                </span>
                                <span className='shrink-0 font-mono text-xs font-semibold'>
                                  1 USD = {compact(rule.pointsPerUsd)} Points
                                </span>
                              </div>
                            ))}
                            {hasMoreHistory && (
                              <div className='px-3 py-2 text-center text-[11px] text-muted-foreground'>
                                {history.isFetchingNextPage
                                  ? '正在加载…'
                                  : `向下滚动加载更多 · 已加载 ${historicalRules.length} 条`}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className='mt-4'>
              <SalesSimulatorCard pointsPerUsd={currentRate} />
            </div>

            <Card className='mt-4'>
              <CardHeader>
                <CardTitle>计算逻辑说明</CardTitle>
              </CardHeader>
              <CardContent className='grid gap-6 xl:grid-cols-2'>
                <div className='rounded-xl border p-4'>
                  <h3 className='text-sm font-semibold'>用户积分扣费</h3>
                  <FormulaChain
                    parts={[
                      ['上游模型成本', 'Provider Cost USD'],
                      ['基础扣费率', `${compact(currentRate)} Points / USD`],
                      ['模型倍率', 'Model Multiplier'],
                      ['扣除积分', 'Charged Points'],
                    ]}
                    operators={['×', '×', '=']}
                  />
                </div>
                <div className='rounded-xl border p-4'>
                  <h3 className='text-sm font-semibold'>销售利润测算</h3>
                  <div className='mt-4 space-y-3'>
                    <FormulaText>
                      User Points ÷ (Points/USD × Model Multiplier) = Base Model
                      USD
                    </FormulaText>
                    <FormulaText>
                      Base Model USD × Upstream Cost Multiplier = Upstream USD
                      Used
                    </FormulaText>
                    <FormulaText>
                      Upstream USD Used × RMB Cost Per USD = Actual RMB Cost
                    </FormulaText>
                    <FormulaText>
                      User Payment − Actual RMB Cost = Estimated Profit
                    </FormulaText>
                  </div>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </Main>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>修改积分计费规则</DialogTitle>
            <DialogDescription>
              保存后将创建新版本，历史规则不会被覆盖。
            </DialogDescription>
          </DialogHeader>
          <LabeledInput
            label='新的 Points / USD'
            value={nextRate}
            onChange={setNextRate}
          />
          <div className='grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-lg border p-4 text-sm'>
            <Formula
              label='当前'
              value={`1 USD = ${compact(currentRate)} Points`}
            />
            <ArrowRight className='size-4 text-muted-foreground' />
            <Formula
              label='修改后'
              value={`1 USD = ${compact(proposedRate)} Points`}
            />
          </div>
          <div className='grid gap-3 rounded-lg bg-muted/40 p-4 text-sm sm:grid-cols-2'>
            <Formula label='积分消耗速度' value={percent(changePct)} />
            <Formula
              label='示例模型倍率 2.5×（$1 成本）'
              value={`${compact((proposedRate ?? 0) * 2.5)} Points`}
              detail={`当前 ${compact(currentRate * 2.5)} Points`}
            />
          </div>
          <div className='flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100'>
            <AlertTriangle className='mt-0.5 size-5 shrink-0' />
            <p>
              新规则只影响保存后开始的新模型请求。已经开始执行的请求，以及历史账单，继续使用请求开始时保存的
              points_per_usd 快照，不会根据新规则重新计算。
            </p>
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button
              disabled={proposedRate === null || proposedRate === currentRate}
              onClick={() => {
                setEditOpen(false)
                setConfirmOpen(true)
              }}
            >
              保存并确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>计费规则即将修改</AlertDialogTitle>
            <AlertDialogDescription>
              该操作会立即影响保存后开始的新请求。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className='space-y-3 rounded-lg border p-4 text-sm'>
            <Info
              label='当前'
              value={`1 USD = ${compact(currentRate)} Points`}
            />
            <Info
              label='修改后'
              value={`1 USD = ${compact(proposedRate)} Points`}
            />
            <Info label='变化' value={percent(changePct)} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={save.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={save.isPending}
              onClick={(event) => {
                event.preventDefault()
                save.mutate()
              }}
            >
              {save.isPending && <Loader2 className='animate-spin' />}
              确认生效
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function LabeledInput({
  label,
  value,
  onChange,
  prefix,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  prefix?: string
}) {
  return (
    <label className='grid gap-2 text-sm font-medium'>
      {label}
      <div className='relative'>
        {prefix && (
          <span className='absolute top-2 left-3 text-muted-foreground'>
            {prefix}
          </span>
        )}
        <Input
          className={prefix ? 'pl-7' : ''}
          type='number'
          min='0'
          step='any'
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </label>
  )
}

function Formula({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail?: string
}) {
  return (
    <div>
      <div className='text-xs text-muted-foreground'>{label}</div>
      <div className='mt-1 font-medium'>{value}</div>
      {detail && (
        <div className='mt-1 font-mono text-xs text-muted-foreground'>
          {detail}
        </div>
      )}
    </div>
  )
}

function FormulaChain({
  parts,
  operators,
}: {
  parts: [string, string][]
  operators: string[]
}) {
  return (
    <div className='mt-4 flex flex-wrap items-center gap-3 text-sm'>
      {parts.map(([label, value], index) => (
        <div key={label} className='contents'>
          {index > 0 && (
            <span className='font-medium text-muted-foreground'>
              {operators[index - 1]}
            </span>
          )}
          <Formula label={label} value={value} />
        </div>
      ))}
    </div>
  )
}

function FormulaText({ children }: { children: React.ReactNode }) {
  return (
    <div className='rounded-lg bg-muted/35 px-3 py-2 font-mono text-xs leading-5'>
      {children}
    </div>
  )
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className='flex items-center justify-between gap-4'>
      <span className='text-muted-foreground'>{label}</span>
      <span className='text-right font-medium'>{value}</span>
    </div>
  )
}

function positive(value: string | number | null | undefined) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}
function compact(value: number | null | undefined) {
  return value == null
    ? '—'
    : new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(value)
}
function decimal(value: number | null | undefined, minimum = 6) {
  return value == null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        minimumFractionDigits: minimum,
        maximumFractionDigits: 8,
      }).format(value)
}
function percent(value: number | null) {
  if (value == null) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}
function dateTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}
