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
import { currentLocaleTag, t as translate, useTranslation } from '@/lib/i18n'
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
import { LanguageSwitch } from '@/components/language-switch'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'

const CURRENT_RULE_KEY = ['admin-billing-rule-current'] as const
const HISTORY_KEY = ['admin-billing-rule-history'] as const
const HISTORY_FETCH_SIZE = 5
const EXAMPLE_MULTIPLIER = 2.5

export function BillingRulePage() {
  const { t } = useTranslation()
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
      toast.success(translate('billingRule.toast.saved'))
    },
    onError: (error) =>
      toast.error(error.message || translate('billingRule.toast.saveFailed')),
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
          <LanguageSwitch />
          <ThemeSwitch />
          <ConfigDrawer />
        </div>
      </Header>
      <Main className='max-w-none'>
        <div className='mb-5'>
          <h1 className='text-2xl font-bold tracking-tight'>
            {t('billingRule.title')}
          </h1>
          <p className='text-muted-foreground'>
            {t('billingRule.description')}
          </p>
        </div>
        {current.isLoading ? (
          <Card>
            <CardContent className='flex h-56 items-center justify-center'>
              <Loader2 className='animate-spin' />
            </CardContent>
          </Card>
        ) : current.isError || !current.data ? (
          <Card className='border-destructive/50'>
            <CardContent className='flex h-40 items-center justify-center text-destructive'>
              {t('billingRule.unavailable')}
            </CardContent>
          </Card>
        ) : (
          <>
            <div className='grid gap-4 xl:grid-cols-[1.4fr_1fr]'>
              <Card>
                <CardHeader>
                  <CardTitle>{t('billingRule.conversion.title')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className='flex flex-wrap items-center gap-4 rounded-xl border bg-muted/30 p-5'>
                    <div>
                      <div className='text-sm text-muted-foreground'>
                        {t('billingRule.conversion.upstreamCost')}
                      </div>
                      <div className='mt-1 text-xl font-semibold'>1 USD</div>
                    </div>
                    <span className='text-2xl text-muted-foreground'>=</span>
                    <div className='min-w-52 rounded-lg border bg-background px-4 py-3 font-mono text-2xl font-semibold'>
                      {decimal(currentRate, 8)}
                    </div>
                    <div>
                      <div className='text-sm text-muted-foreground'>
                        {t('billingRule.conversion.platformPoints')}
                      </div>
                      <div className='mt-1 text-xl font-semibold'>Points</div>
                    </div>
                  </div>
                  <div className='mt-4 space-y-2 text-sm text-muted-foreground'>
                    <p>{t('billingRule.conversion.hint1')}</p>
                    <p>{t('billingRule.conversion.hint2')}</p>
                  </div>
                  <div className='mt-5 rounded-lg border p-4 text-sm'>
                    <div className='font-medium'>
                      {t('billingRule.example.title')}
                    </div>
                    <div className='mt-3 grid gap-3 sm:grid-cols-3'>
                      <Formula
                        label={t('billingRule.example.upstreamCost')}
                        value='$0.50'
                      />
                      <Formula
                        label={t('billingRule.example.basePoints')}
                        value={`${decimal(0.5 * currentRate, 6)} Points`}
                        detail={`0.50 × ${compact(currentRate)}`}
                      />
                      <Formula
                        label={t('billingRule.example.afterMultiplier', {
                          multiplier: EXAMPLE_MULTIPLIER,
                        })}
                        value={`${decimal(0.5 * currentRate * EXAMPLE_MULTIPLIER, 6)} Points`}
                        detail={`${compact(0.5 * currentRate)} × ${EXAMPLE_MULTIPLIER}`}
                      />
                    </div>
                  </div>
                  <Button className='mt-5' onClick={openEditor}>
                    {t('billingRule.conversion.editRule')}
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t('billingRule.info.title')}</CardTitle>
                </CardHeader>
                <CardContent className='space-y-4 text-sm'>
                  <Info
                    label={t('billingRule.info.currentRate')}
                    value={`1 USD = ${compact(currentRate)} Points`}
                  />
                  <Info
                    label={t('billingRule.info.version')}
                    value={`V${current.data.version}`}
                  />
                  <Info
                    label={t('billingRule.info.status')}
                    value={<Badge>{t('common.state.enabled')}</Badge>}
                  />
                  <Info
                    label={t('billingRule.info.effectiveFrom')}
                    value={dateTime(current.data.effectiveFrom)}
                  />
                  <Info
                    label={t('billingRule.info.updatedAt')}
                    value={dateTime(current.data.updatedAt)}
                  />
                  <Button
                    variant='outline'
                    className='w-full'
                    onClick={toggleHistory}
                  >
                    <History />
                    {historyOpen
                      ? t('billingRule.history.collapse')
                      : t('billingRule.history.show')}
                  </Button>
                  {historyOpen && (
                    <div className='overflow-hidden rounded-lg border bg-muted/15'>
                      <div className='border-b px-3 py-2 text-xs font-medium text-muted-foreground'>
                        {t('billingRule.history.title')}
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
                            {t('billingRule.history.loadFailed')}
                          </div>
                        ) : historicalRules.length === 0 ? (
                          <div className='px-3 py-5 text-center text-xs text-muted-foreground'>
                            {t('billingRule.history.empty')}
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
                                  ? t('common.state.loading')
                                  : t('billingRule.history.scrollMore', {
                                      count: historicalRules.length,
                                    })}
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

            <Card className='mt-4'>
              <CardHeader>
                <CardTitle>{t('billingRule.logic.title')}</CardTitle>
              </CardHeader>
              <CardContent className='grid gap-6 xl:grid-cols-2'>
                <div className='rounded-xl border p-4'>
                  <h3 className='text-sm font-semibold'>
                    {t('billingRule.logic.chargeTitle')}
                  </h3>
                  <FormulaChain
                    parts={[
                      [
                        t('billingRule.logic.upstreamCost'),
                        'Provider Cost USD',
                      ],
                      [
                        t('billingRule.logic.baseRate'),
                        `${compact(currentRate)} Points / USD`,
                      ],
                      [
                        t('billingRule.logic.modelMultiplier'),
                        'Model Multiplier',
                      ],
                      [t('billingRule.logic.chargedPoints'), 'Charged Points'],
                    ]}
                    operators={['×', '×', '=']}
                  />
                </div>
                <div className='rounded-xl border p-4'>
                  <h3 className='text-sm font-semibold'>
                    {t('billingRule.logic.profitTitle')}
                  </h3>
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
            <DialogTitle>{t('billingRule.dialog.title')}</DialogTitle>
            <DialogDescription>
              {t('billingRule.dialog.description')}
            </DialogDescription>
          </DialogHeader>
          <LabeledInput
            label={t('billingRule.dialog.newRate')}
            value={nextRate}
            onChange={setNextRate}
          />
          <div className='grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-lg border p-4 text-sm'>
            <Formula
              label={t('billingRule.dialog.current')}
              value={`1 USD = ${compact(currentRate)} Points`}
            />
            <ArrowRight className='size-4 text-muted-foreground' />
            <Formula
              label={t('billingRule.dialog.next')}
              value={`1 USD = ${compact(proposedRate)} Points`}
            />
          </div>
          <div className='grid gap-3 rounded-lg bg-muted/40 p-4 text-sm sm:grid-cols-2'>
            <Formula
              label={t('billingRule.dialog.consumptionSpeed')}
              value={percent(changePct)}
            />
            <Formula
              label={t('billingRule.dialog.exampleMultiplier', {
                multiplier: EXAMPLE_MULTIPLIER,
              })}
              value={`${compact((proposedRate ?? 0) * EXAMPLE_MULTIPLIER)} Points`}
              detail={t('billingRule.dialog.currentPoints', {
                points: compact(currentRate * EXAMPLE_MULTIPLIER),
              })}
            />
          </div>
          <div className='flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100'>
            <AlertTriangle className='mt-0.5 size-5 shrink-0' />
            <p>{t('billingRule.dialog.warning')}</p>
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => setEditOpen(false)}>
              {t('common.action.cancel')}
            </Button>
            <Button
              disabled={proposedRate === null || proposedRate === currentRate}
              onClick={() => {
                setEditOpen(false)
                setConfirmOpen(true)
              }}
            >
              {t('billingRule.dialog.saveAndConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('billingRule.confirm.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('billingRule.confirm.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className='space-y-3 rounded-lg border p-4 text-sm'>
            <Info
              label={t('billingRule.dialog.current')}
              value={`1 USD = ${compact(currentRate)} Points`}
            />
            <Info
              label={t('billingRule.dialog.next')}
              value={`1 USD = ${compact(proposedRate)} Points`}
            />
            <Info
              label={t('billingRule.confirm.change')}
              value={percent(changePct)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={save.isPending}>
              {t('common.action.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={save.isPending}
              onClick={(event) => {
                event.preventDefault()
                save.mutate()
              }}
            >
              {save.isPending && <Loader2 className='animate-spin' />}
              {t('billingRule.confirm.action')}
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
    : new Intl.NumberFormat(currentLocaleTag(), {
        maximumFractionDigits: 8,
      }).format(value)
}
function decimal(value: number | null | undefined, minimum = 6) {
  return value == null
    ? '—'
    : new Intl.NumberFormat(currentLocaleTag(), {
        minimumFractionDigits: minimum,
        maximumFractionDigits: 8,
      }).format(value)
}
function percent(value: number | null) {
  if (value == null) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}
function dateTime(value: string) {
  return new Date(value).toLocaleString(currentLocaleTag(), { hour12: false })
}
