import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  Coins,
  Cpu,
  DollarSign,
  Loader2,
  Search,
} from 'lucide-react'
import {
  getBillingAnalytics,
  getBillingReport,
  listModels,
  listRelays,
  type BillingAnalytics,
  type BillingDailyPoint,
  type BillingRecord,
} from '@/lib/api/admin'
import {
  currentLocaleTag,
  t as translate,
  useTranslation,
  type TranslationKey,
} from '@/lib/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
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

const PAGE_SIZE = 20
const COLORS = [
  '#2563eb',
  '#10b981',
  '#f97316',
  '#8b5cf6',
  '#ef4444',
  '#06b6d4',
  '#84cc16',
  '#ec4899',
]
type Tab = 'groups' | 'tokens' | 'records'

const dateValue = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
const initialFrom = () => {
  const value = new Date()
  value.setDate(value.getDate() - 29)
  return dateValue(value)
}
const nextDayIso = (value: string) => {
  const date = new Date(`${value}T00:00:00`)
  date.setDate(date.getDate() + 1)
  return date.toISOString()
}

export function BillingPage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('groups')
  const [from, setFrom] = useState(initialFrom)
  const [to, setTo] = useState(() => dateValue(new Date()))
  const [relayId, setRelayId] = useState('')
  const [groupId, setGroupId] = useState('')
  const [tokenId, setTokenId] = useState('')
  const [modelId, setModelId] = useState('')
  const [status, setStatus] = useState('')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const models = useQuery({ queryKey: ['admin-models'], queryFn: listModels })
  const relays = useQuery({ queryKey: ['admin-relays'], queryFn: listRelays })
  const range = useMemo(
    () => ({
      from: new Date(`${from}T00:00:00`).toISOString(),
      to: nextDayIso(to),
    }),
    [from, to]
  )
  const analyticsFilters = useMemo(
    () => ({
      ...range,
      ...(relayId ? { relayId: Number(relayId) } : {}),
      ...(groupId ? { groupId: Number(groupId) } : {}),
      ...(tokenId ? { tokenId: Number(tokenId) } : {}),
    }),
    [range, relayId, groupId, tokenId]
  )
  const analytics = useQuery({
    queryKey: ['admin-billing-analytics', analyticsFilters],
    queryFn: () => getBillingAnalytics(analyticsFilters),
    enabled: tab !== 'records' && Boolean(from && to && from <= to),
  })
  const reportFilters = useMemo(
    () => ({
      ...range,
      ...(modelId ? { modelId } : {}),
      ...(relayId ? { relayId: Number(relayId) } : {}),
      ...(status ? { status } : {}),
      ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
      page,
      pageSize: PAGE_SIZE,
    }),
    [range, modelId, relayId, status, keyword, page]
  )
  const report = useQuery({
    queryKey: ['admin-billing', reportFilters],
    queryFn: () => getBillingReport(reportFilters),
    enabled: tab === 'records' && Boolean(from && to && from <= to),
  })
  const summary =
    tab === 'records' ? report.data?.summary : analytics.data?.summary
  const totalPages = Math.max(
    1,
    Math.ceil((report.data?.total ?? 0) / PAGE_SIZE)
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
        <div className='mb-4 flex flex-wrap items-start justify-between gap-3'>
          <div>
            <h1 className='text-2xl font-bold tracking-tight'>
              {t('billing.title')}
            </h1>
            <p className='text-muted-foreground'>{t('billing.description')}</p>
          </div>
          <div className='flex flex-wrap items-end gap-2'>
            <Field label={t('billing.filter.from')}>
              <Input
                type='date'
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value)
                  setPage(1)
                }}
              />
            </Field>
            <Field label={t('billing.filter.to')}>
              <Input
                type='date'
                value={to}
                onChange={(e) => {
                  setTo(e.target.value)
                  setPage(1)
                }}
              />
            </Field>
            <Field label={t('billing.filter.relay')}>
              <NativeSelect
                value={relayId}
                onChange={(value) => {
                  setRelayId(value)
                  setPage(1)
                }}
              >
                <option value=''>{t('billing.filter.allRelays')}</option>
                {(relays.data ?? []).map((relay) => (
                  <option key={relay.id} value={relay.id}>
                    {relay.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
        </div>
        <div className='mb-4 flex gap-1 border-b'>
          <TabButton active={tab === 'groups'} onClick={() => setTab('groups')}>
            {t('billing.tab.groups')}
          </TabButton>
          <TabButton
            active={tab === 'tokens'}
            onClick={() => {
              setTab('tokens')
              if (!tokenId && analytics.data?.tokenTotals[0])
                setTokenId(String(analytics.data.tokenTotals[0].tokenId))
            }}
          >
            {t('billing.tab.tokens')}
          </TabButton>
          <TabButton
            active={tab === 'records'}
            onClick={() => setTab('records')}
          >
            {t('billing.tab.records')}
          </TabButton>
        </div>
        <div className='mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
          <Metric
            title={t('billing.metric.requests')}
            value={formatInt(summary?.requestCount)}
            icon={<Cpu />}
            detail={t('billing.metric.settled', {
              count: formatInt(summary?.settledCount),
            })}
          />
          <Metric
            title={t('billing.metric.tokens')}
            value={formatInt(summary?.totalTokens)}
            icon={<Coins />}
            detail={t('billing.metric.tokensDetail')}
          />
          <Metric
            title={t('billing.metric.providerCost')}
            value={`$${money(summary?.providerCostUsd)}`}
            icon={<DollarSign />}
            detail='USD'
          />
          <Metric
            title={t('billing.metric.chargedPoints')}
            value={money(summary?.chargedPoints)}
            icon={<AlertCircle />}
            detail={t('billing.metric.exceptions', {
              count: formatInt(summary?.exceptionCount),
            })}
          />
        </div>
        {tab === 'groups' && (
          <GroupAnalytics
            loading={analytics.isLoading}
            data={analytics.data}
            groupId={groupId}
            selectGroup={(id) => {
              setGroupId(id)
              setTokenId('')
            }}
          />
        )}
        {tab === 'tokens' && (
          <TokenAnalytics
            loading={analytics.isLoading}
            data={analytics.data}
            groupId={groupId}
            tokenId={tokenId}
            selectGroup={(id) => {
              setGroupId(id)
              setTokenId('')
            }}
            selectToken={setTokenId}
          />
        )}
        {tab === 'records' && (
          <Records
            report={report}
            models={models.data ?? []}
            modelId={modelId}
            setModelId={(value) => {
              setModelId(value)
              setPage(1)
            }}
            status={status}
            setStatus={(value) => {
              setStatus(value)
              setPage(1)
            }}
            keyword={keyword}
            setKeyword={(value) => {
              setKeyword(value)
              setPage(1)
            }}
            page={page}
            totalPages={totalPages}
            setPage={setPage}
          />
        )}
      </Main>
    </>
  )
}

function GroupAnalytics({
  loading,
  data,
  groupId,
  selectGroup,
}: {
  loading: boolean
  data?: BillingAnalytics
  groupId: string
  selectGroup: (id: string) => void
}) {
  const { t } = useTranslation()
  const [granularity, setGranularity] = useState<Granularity>('day')
  const selectedGroup = (data?.groupTotals ?? []).find(
    (item) => String(item.groupId) === groupId
  )
  const trend = aggregateTrend(
    (data?.groupDaily ?? []).filter(
      (point) => !groupId || String(point.groupId) === groupId
    ),
    granularity,
    'requestCount'
  )
  if (loading) return <LoadingCard />
  return (
    <div className='space-y-4'>
      <Card>
        <CardHeader className='flex-row flex-wrap items-center justify-between gap-3'>
          <CardTitle className='text-base'>
            {t(GROUP_TREND_TITLE_KEYS[granularity])}
          </CardTitle>
          <div className='flex flex-wrap items-center gap-2'>
            <NativeSelect value={groupId} onChange={selectGroup} compact>
              <option value=''>{t('billing.filter.allGroups')}</option>
              {(data?.groupTotals ?? []).map((item) => (
                <option key={item.groupId} value={item.groupId}>
                  {item.groupDisplayName}
                </option>
              ))}
            </NativeSelect>
            <GranularitySwitch value={granularity} onChange={setGranularity} />
          </div>
        </CardHeader>
        <CardContent>
          <SmoothAreaChart points={trend} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>
            {t('billing.group.totalsTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent className='overflow-x-auto p-0'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('billing.table.group')}</TableHead>
                <TableHead>{t('billing.table.requests')}</TableHead>
                <TableHead>{t('billing.table.tokens')}</TableHead>
                <TableHead>{t('billing.table.providerCost')}</TableHead>
                <TableHead>{t('billing.table.chargedPoints')}</TableHead>
                <TableHead>{t('billing.table.activeTokens')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.groupTotals ?? []).map((item) => (
                <TableRow
                  key={item.groupId}
                  className={`cursor-pointer transition-colors ${String(item.groupId) === groupId ? 'bg-primary/5' : ''}`}
                  role='button'
                  tabIndex={0}
                  onClick={() => selectGroup(String(item.groupId))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      selectGroup(String(item.groupId))
                    }
                  }}
                >
                  <TableCell className='font-medium'>
                    {item.groupDisplayName}
                  </TableCell>
                  <TableCell>{formatInt(item.requestCount)}</TableCell>
                  <TableCell>{formatInt(item.totalTokens)}</TableCell>
                  <TableCell>${money(item.providerCostUsd)}</TableCell>
                  <TableCell>{money(item.chargedPoints)}</TableCell>
                  <TableCell>{item.tokenCount}</TableCell>
                  <TableCell className='text-right text-lg text-muted-foreground'>
                    ›
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {groupId ? (
        <div className='grid gap-4 xl:grid-cols-2'>
          <Card>
            <CardHeader>
              <CardTitle className='text-base'>
                {t('billing.group.detailTitle')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className='mb-5 flex items-center gap-2 text-sm'>
                <span className='text-muted-foreground'>
                  {t('billing.group.currentGroup')}
                </span>
                <Badge variant='secondary'>
                  {selectedGroup?.groupDisplayName ?? '—'}
                </Badge>
              </div>
              <div className='grid grid-cols-2 gap-y-5 sm:grid-cols-4'>
                <CompactMetric
                  label={t('billing.table.requests')}
                  value={formatInt(selectedGroup?.requestCount)}
                />
                <CompactMetric
                  label={t('billing.table.tokens')}
                  value={formatInt(selectedGroup?.totalTokens)}
                />
                <CompactMetric
                  label={t('billing.table.providerCost')}
                  value={`$${money(selectedGroup?.providerCostUsd)}`}
                />
                <CompactMetric
                  label={t('billing.table.chargedPoints')}
                  value={money(selectedGroup?.chargedPoints)}
                />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className='flex-row items-center justify-between gap-3'>
              <CardTitle className='text-base'>
                {t('billing.group.distributionTitle')}
              </CardTitle>
              <Badge variant='outline'>{t('billing.table.tokens')}</Badge>
            </CardHeader>
            <CardContent>
              <HorizontalDistribution items={data?.tokenTotals ?? []} />
            </CardContent>
          </Card>
        </div>
      ) : (
        <Hint>{t('billing.group.hint')}</Hint>
      )}
    </div>
  )
}

function TokenAnalytics({
  loading,
  data,
  groupId,
  tokenId,
  selectGroup,
  selectToken,
}: {
  loading: boolean
  data?: BillingAnalytics
  groupId: string
  tokenId: string
  selectGroup: (id: string) => void
  selectToken: (id: string) => void
}) {
  const { t } = useTranslation()
  const [granularity, setGranularity] = useState<Granularity>('day')
  const modelSeries = (data?.modelTotals ?? [])
    .slice(0, 8)
    .map((item, index) => ({
      key: item.modelId,
      label: item.modelId,
      color: COLORS[index],
    }))
  if (loading) return <LoadingCard />
  return (
    <div className='space-y-4'>
      <Card>
        <CardHeader className='flex-row flex-wrap items-start justify-between gap-3'>
          <div>
            <CardTitle className='text-base'>
              {t(TOKEN_CHART_TITLE_KEYS[granularity])}
            </CardTitle>
            <p className='mt-1 text-xs text-muted-foreground'>
              {t('billing.token.archivedHint')}
            </p>
          </div>
          <div className='flex flex-wrap items-end gap-2'>
            <Field label={t('billing.filter.group')} compact>
              <NativeSelect value={groupId} onChange={selectGroup} compact>
                <option value=''>{t('billing.filter.allGroups')}</option>
                {(data?.groupTotals ?? []).map((item) => (
                  <option key={item.groupId} value={item.groupId}>
                    {item.groupDisplayName}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label='Token' compact>
              <NativeSelect value={tokenId} onChange={selectToken} compact>
                <option value=''>{t('billing.filter.selectToken')}</option>
                {(data?.tokenTotals ?? []).map((item) => (
                  <option key={item.tokenId} value={item.tokenId}>
                    {item.tokenLabel} · {item.groupDisplayName}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <GranularitySwitch value={granularity} onChange={setGranularity} />
          </div>
        </CardHeader>
        <CardContent>
          <StackedBarChart
            points={data?.modelDaily ?? []}
            series={modelSeries}
            granularity={granularity}
          />
        </CardContent>
      </Card>
      <div className='grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]'>
        <Card>
          <CardHeader>
            <CardTitle className='text-base'>
              {t('billing.token.modelSummaryTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className='overflow-x-auto p-0'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('billing.table.model')}</TableHead>
                  <TableHead>{t('billing.table.requests')}</TableHead>
                  <TableHead>{t('billing.table.tokens')}</TableHead>
                  <TableHead>{t('billing.table.providerCost')}</TableHead>
                  <TableHead>{t('billing.table.chargedPoints')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.modelTotals ?? []).map((item) => (
                  <TableRow key={item.modelId}>
                    <TableCell className='font-mono'>{item.modelId}</TableCell>
                    <TableCell>{formatInt(item.requestCount)}</TableCell>
                    <TableCell>{formatInt(item.totalTokens)}</TableCell>
                    <TableCell>${money(item.providerCostUsd)}</TableCell>
                    <TableCell>{money(item.chargedPoints)}</TableCell>
                  </TableRow>
                ))}
                {!data?.modelTotals.length && (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className='h-24 text-center text-muted-foreground'
                    >
                      {tokenId
                        ? t('billing.token.noUsage')
                        : t('billing.token.pickToken')}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className='text-base'>
              {t('billing.token.shareTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DonutChart items={data?.modelTotals ?? []} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

type Granularity = 'day' | 'week' | 'month'

const GRANULARITY_LABEL_KEYS: Record<Granularity, TranslationKey> = {
  day: 'billing.granularity.day',
  week: 'billing.granularity.week',
  month: 'billing.granularity.month',
}
const GROUP_TREND_TITLE_KEYS: Record<Granularity, TranslationKey> = {
  day: 'billing.group.trendTitle.day',
  week: 'billing.group.trendTitle.week',
  month: 'billing.group.trendTitle.month',
}
const TOKEN_CHART_TITLE_KEYS: Record<Granularity, TranslationKey> = {
  day: 'billing.token.chartTitle.day',
  week: 'billing.token.chartTitle.week',
  month: 'billing.token.chartTitle.month',
}

function GranularitySwitch({
  value,
  onChange,
}: {
  value: Granularity
  onChange: (value: Granularity) => void
}) {
  const { t } = useTranslation()
  return (
    <div className='flex h-9 items-center rounded-md bg-muted p-1'>
      {(['day', 'week', 'month'] as const).map((key) => (
        <button
          key={key}
          type='button'
          className={`h-7 min-w-9 rounded px-2 text-xs transition-colors ${value === key ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          aria-pressed={value === key}
          onClick={() => onChange(key)}
        >
          {t(GRANULARITY_LABEL_KEYS[key])}
        </button>
      ))}
    </div>
  )
}

function bucketDay(day: string, granularity: Granularity) {
  if (granularity === 'day') return day
  if (granularity === 'month') return day.slice(0, 7)
  const date = new Date(`${day}T00:00:00Z`)
  const offset = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - offset)
  return date.toISOString().slice(0, 10)
}

function bucketLabel(day: string, granularity: Granularity) {
  if (granularity === 'month') return day
  return `${day.slice(5)}${granularity === 'week' ? translate('billing.chart.weekSuffix') : ''}`
}

function aggregateTrend(
  points: BillingDailyPoint[],
  granularity: Granularity,
  valueKey: 'requestCount' | 'totalTokens'
) {
  const totals = new Map<string, number>()
  points.forEach((point) => {
    const bucket = bucketDay(point.day, granularity)
    totals.set(bucket, (totals.get(bucket) ?? 0) + point[valueKey])
  })
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, value]) => ({
      day,
      label: bucketLabel(day, granularity),
      value,
    }))
}

function smoothPath(points: { x: number; y: number }[]) {
  if (!points.length) return ''
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
  let path = `M ${points[0].x} ${points[0].y}`
  for (let index = 0; index < points.length - 1; index++) {
    const current = points[index]
    const next = points[index + 1]
    const middle = (current.x + next.x) / 2
    path += ` C ${middle} ${current.y}, ${middle} ${next.y}, ${next.x} ${next.y}`
  }
  return path
}

export function SmoothAreaChart({
  points,
}: {
  points: { day: string; label: string; value: number }[]
}) {
  const { t } = useTranslation()
  if (!points.length) return <EmptyChart />
  const max = Math.max(1, ...points.map((point) => point.value))
  const x = (index: number) =>
    points.length === 1 ? 415 : 55 + index * (720 / (points.length - 1))
  const y = (value: number) => 185 - (value / max) * 145
  const coordinates = points.map((point, index) => ({
    ...point,
    x: x(index),
    y: y(point.value),
  }))
  const line = smoothPath(coordinates)
  const area = `${line} L ${coordinates[coordinates.length - 1].x} 185 L ${coordinates[0].x} 185 Z`
  return (
    <svg
      viewBox='0 0 800 225'
      className='h-64 w-full min-w-[640px]'
      role='img'
      aria-label={t('billing.chart.groupTrendAria')}
    >
      <defs>
        <linearGradient id='billing-area' x1='0' x2='0' y1='0' y2='1'>
          <stop offset='0%' stopColor='#2563eb' stopOpacity='.22' />
          <stop offset='100%' stopColor='#2563eb' stopOpacity='.02' />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
        <g key={ratio}>
          <line
            x1='55'
            x2='775'
            y1={185 - ratio * 145}
            y2={185 - ratio * 145}
            stroke='currentColor'
            opacity='.08'
            strokeDasharray='2 3'
          />
          <text
            x='47'
            y={189 - ratio * 145}
            textAnchor='end'
            fontSize='10'
            fill='currentColor'
            opacity='.55'
          >
            {formatCompact(max * ratio)}
          </text>
        </g>
      ))}
      <path d={area} fill='url(#billing-area)' />
      <path
        d={line}
        fill='none'
        stroke='#2563eb'
        strokeWidth='2.5'
        strokeLinecap='round'
      />
      {coordinates.map((point, index) => (
        <g key={point.day}>
          <circle
            cx={point.x}
            cy={point.y}
            r='3.5'
            fill='var(--background)'
            stroke='#2563eb'
            strokeWidth='2'
          >
            <title>
              {point.day}: {formatInt(point.value)}
            </title>
          </circle>
          {(index % Math.max(1, Math.ceil(points.length / 9)) === 0 ||
            index === points.length - 1) && (
            <text
              x={point.x}
              y='207'
              textAnchor='middle'
              fontSize='10'
              fill='currentColor'
              opacity='.55'
            >
              {point.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  )
}

export function StackedBarChart({
  points,
  series,
  granularity,
}: {
  points: BillingDailyPoint[]
  series: { key: string; label: string; color: string }[]
  granularity: Granularity
}) {
  const { t } = useTranslation()
  if (!points.length || !series.length) return <EmptyChart />
  const buckets = new Map<string, Map<string, number>>()
  points.forEach((point) => {
    const day = bucketDay(point.day, granularity)
    const model = String(point.modelId)
    const values = buckets.get(day) ?? new Map<string, number>()
    values.set(model, (values.get(model) ?? 0) + point.totalTokens)
    buckets.set(day, values)
  })
  const days = [...buckets.keys()].sort()
  const max = Math.max(
    1,
    ...days.map((day) =>
      series.reduce(
        (sum, item) => sum + (buckets.get(day)?.get(item.key) ?? 0),
        0
      )
    )
  )
  const x = (index: number) =>
    days.length === 1 ? 415 : 60 + index * (710 / (days.length - 1))
  const width = Math.min(24, Math.max(7, 560 / Math.max(days.length, 1)))
  const y = (value: number) => (value / max) * 145
  return (
    <div>
      <div className='mb-3 flex flex-wrap gap-x-4 gap-y-2 text-xs'>
        {series.map((item) => (
          <span key={item.key} className='flex items-center gap-1.5'>
            <i
              className='size-2.5 rounded-full'
              style={{ background: item.color }}
            />
            {item.label}
          </span>
        ))}
      </div>
      <div className='overflow-x-auto'>
        <svg
          viewBox='0 0 800 225'
          className='h-64 w-full min-w-[640px]'
          role='img'
          aria-label={t('billing.chart.modelStackAria')}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
            <g key={ratio}>
              <line
                x1='55'
                x2='780'
                y1={185 - ratio * 145}
                y2={185 - ratio * 145}
                stroke='currentColor'
                opacity='.09'
              />
              <text
                x='47'
                y={189 - ratio * 145}
                textAnchor='end'
                fontSize='10'
                fill='currentColor'
                opacity='.55'
              >
                {formatCompact(max * ratio)}
              </text>
            </g>
          ))}
          {days.map((day, dayIndex) => {
            let used = 0
            return (
              <g key={day}>
                {series.map((item) => {
                  const value = buckets.get(day)?.get(item.key) ?? 0
                  const height = y(value)
                  const top = 185 - used - height
                  used += height
                  return value ? (
                    <rect
                      key={item.key}
                      x={x(dayIndex) - width / 2}
                      y={top}
                      width={width}
                      height={height}
                      rx='1.5'
                      fill={item.color}
                      opacity='.82'
                    >
                      <title>
                        {item.label} · {day}: {formatInt(value)}
                      </title>
                    </rect>
                  ) : null
                })}
                {(dayIndex % Math.max(1, Math.ceil(days.length / 10)) === 0 ||
                  dayIndex === days.length - 1) && (
                  <text
                    x={x(dayIndex)}
                    y='207'
                    textAnchor='middle'
                    fontSize='10'
                    fill='currentColor'
                    opacity='.55'
                  >
                    {bucketLabel(day, granularity)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

export function DonutChart({
  items,
}: {
  items: BillingAnalytics['modelTotals']
}) {
  const { t } = useTranslation()
  const total = items.reduce((sum, item) => sum + item.totalTokens, 0)
  if (!items.length || !total) return <EmptyChart compact />
  const stops = items.reduce<{ values: string[]; offset: number }>(
    (result, item, index) => {
      const next = result.offset + (item.totalTokens / total) * 100
      return {
        values: [
          ...result.values,
          `${COLORS[index % COLORS.length]} ${result.offset}% ${next}%`,
        ],
        offset: next,
      }
    },
    { values: [], offset: 0 }
  ).values
  return (
    <div className='flex flex-col items-center gap-6 sm:flex-row sm:justify-center'>
      <div
        className='relative size-44 shrink-0 rounded-full'
        style={{ background: `conic-gradient(${stops.join(',')})` }}
        role='img'
        aria-label={t('billing.chart.modelShareAria', {
          total: formatInt(total),
        })}
      >
        <div className='absolute inset-7 flex flex-col items-center justify-center rounded-full bg-card shadow-inner'>
          <strong className='text-lg'>{formatInt(total)}</strong>
          <span className='text-xs text-muted-foreground'>
            {t('billing.chart.totalTokens')}
          </span>
        </div>
      </div>
      <div className='min-w-48 space-y-3'>
        {items.map((item, index) => (
          <div key={item.modelId} className='flex items-start gap-2 text-xs'>
            <i
              className='mt-1 size-2.5 shrink-0 rounded-full'
              style={{ background: COLORS[index % COLORS.length] }}
            />
            <div className='min-w-0 flex-1'>
              <div className='flex justify-between gap-3'>
                <span className='truncate font-medium'>{item.modelId}</span>
                <span>{percentage(item.totalTokens, total)}</span>
              </div>
              <div className='text-muted-foreground'>
                {formatInt(item.totalTokens)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function HorizontalDistribution({
  items,
}: {
  items: BillingAnalytics['tokenTotals']
}) {
  if (!items.length) return <EmptyChart compact />
  const total = items.reduce((sum, item) => sum + item.totalTokens, 0)
  const max = Math.max(1, ...items.map((item) => item.totalTokens))
  return (
    <div className='space-y-3'>
      {items.map((item) => (
        <div
          key={item.tokenId}
          className='grid grid-cols-[minmax(80px,1fr)_minmax(120px,3fr)_auto] items-center gap-3 text-xs'
        >
          <div className='min-w-0'>
            <div className='truncate font-medium'>{item.tokenLabel}</div>
            <div className='text-[10px] text-muted-foreground'>
              {item.status}
            </div>
          </div>
          <div className='h-2 overflow-hidden rounded-full bg-muted'>
            <div
              className='h-full min-w-0.5 rounded-full bg-primary'
              style={{ width: `${(item.totalTokens / max) * 100}%` }}
            />
          </div>
          <div className='min-w-24 text-right tabular-nums'>
            <span className='font-medium'>{formatInt(item.totalTokens)}</span>
            <span className='ml-2 text-muted-foreground'>
              {percentage(item.totalTokens, total)}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

function CompactMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className='border-l pl-4 first:border-l-0 first:pl-0'>
      <div className='text-xs text-muted-foreground'>{label}</div>
      <div className='mt-1 text-lg font-semibold tabular-nums'>{value}</div>
    </div>
  )
}

function EmptyChart({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  return (
    <div
      className={`flex items-center justify-center text-sm text-muted-foreground ${compact ? 'h-44' : 'h-64'}`}
    >
      {t('billing.chart.empty')}
    </div>
  )
}

export function LineChart({
  points,
  series,
  seriesKey,
  valueKey,
}: {
  points: BillingDailyPoint[]
  series: { key: string; label: string; color: string }[]
  seriesKey: 'groupId' | 'tokenId' | 'modelId'
  valueKey: 'requestCount' | 'totalTokens'
}) {
  const { t } = useTranslation()
  const days = [...new Set(points.map((point) => point.day))].sort()
  const lookup = new Map(
    points.map((point) => [
      `${point.day}:${String(point[seriesKey])}`,
      point[valueKey],
    ])
  )
  const visibleKeys = new Set(series.map((item) => item.key))
  const max = Math.max(
    1,
    ...points
      .filter((point) => visibleKeys.has(String(point[seriesKey])))
      .map((point) => point[valueKey])
  )
  const x = (index: number) =>
    days.length <= 1 ? 415 : 50 + index * (730 / (days.length - 1))
  const y = (value: number) => 210 - (value / max) * 170
  if (!points.length || !series.length)
    return (
      <div className='flex h-64 items-center justify-center text-sm text-muted-foreground'>
        {t('billing.chart.empty')}
      </div>
    )
  return (
    <div>
      <div className='mb-3 flex flex-wrap gap-x-4 gap-y-2 text-xs'>
        {series.map((item) => (
          <span key={item.key} className='flex items-center gap-1.5'>
            <i
              className='size-2.5 rounded-full'
              style={{ background: item.color }}
            />
            {item.label}
          </span>
        ))}
      </div>
      <div className='overflow-x-auto'>
        <svg
          viewBox='0 0 800 250'
          className='h-64 w-full min-w-[640px]'
          role='img'
          aria-label={t('billing.chart.dailyTrendAria')}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
            <g key={ratio}>
              <line
                x1='50'
                x2='780'
                y1={210 - ratio * 170}
                y2={210 - ratio * 170}
                stroke='currentColor'
                opacity='.1'
              />
              <text
                x='44'
                y={214 - ratio * 170}
                textAnchor='end'
                fontSize='10'
                fill='currentColor'
                opacity='.55'
              >
                {formatCompact(max * ratio)}
              </text>
            </g>
          ))}
          {days.map(
            (day, index) =>
              (index % Math.max(1, Math.ceil(days.length / 8)) === 0 ||
                index === days.length - 1) && (
                <text
                  key={day}
                  x={x(index)}
                  y='232'
                  textAnchor='middle'
                  fontSize='10'
                  fill='currentColor'
                  opacity='.6'
                >
                  {day.slice(5)}
                </text>
              )
          )}
          {series.map((item) => {
            const values = days.map((day, index) => ({
              day,
              value: lookup.get(`${day}:${item.key}`) ?? 0,
              x: x(index),
              y: y(lookup.get(`${day}:${item.key}`) ?? 0),
            }))
            return (
              <g key={item.key} data-series={item.key}>
                <polyline
                  fill='none'
                  stroke={item.color}
                  strokeWidth='2.5'
                  strokeLinejoin='round'
                  strokeLinecap='round'
                  points={values
                    .map((point) => `${point.x},${point.y}`)
                    .join(' ')}
                />
                {values.map((point) => (
                  <circle
                    key={point.day}
                    cx={point.x}
                    cy={point.y}
                    r='3.5'
                    fill={item.color}
                    stroke='var(--background)'
                    strokeWidth='1.5'
                  >
                    <title>
                      {item.label} · {point.day}: {formatInt(point.value)}
                    </title>
                  </circle>
                ))}
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

export function Sparkline({ values }: { values: number[] }) {
  const { t } = useTranslation()
  const max = Math.max(1, ...values)
  const coordinates = values.map((value, index) => {
    const x = values.length <= 1 ? 40 : (index * 80) / (values.length - 1)
    return { x, y: 24 - (value / max) * 20, value }
  })
  return values.length ? (
    <svg
      viewBox='0 0 80 28'
      className='h-8 w-24'
      aria-label={t('billing.chart.dailyRequestsAria')}
    >
      <polyline
        fill='none'
        stroke='#2563eb'
        strokeWidth='2'
        strokeLinecap='round'
        strokeLinejoin='round'
        points={coordinates.map((point) => `${point.x},${point.y}`).join(' ')}
      />
      {coordinates.map((point, index) => (
        <circle key={index} cx={point.x} cy={point.y} r='2.5' fill='#2563eb'>
          <title>{formatInt(point.value)}</title>
        </circle>
      ))}
    </svg>
  ) : (
    <span className='text-muted-foreground'>—</span>
  )
}

type BillingQuery = ReturnType<
  typeof useQuery<Awaited<ReturnType<typeof getBillingReport>>, Error>
>
function Records({
  report,
  models,
  modelId,
  setModelId,
  status,
  setStatus,
  keyword,
  setKeyword,
  page,
  totalPages,
  setPage,
}: {
  report: BillingQuery
  models: Awaited<ReturnType<typeof listModels>>
  modelId: string
  setModelId: (value: string) => void
  status: string
  setStatus: (value: string) => void
  keyword: string
  setKeyword: (value: string) => void
  page: number
  totalPages: number
  setPage: (value: number) => void
}) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader className='gap-3 lg:flex-row lg:items-end lg:justify-between'>
        <CardTitle className='text-base'>
          {t('billing.records.title')}
        </CardTitle>
        <div className='flex flex-wrap items-end gap-2'>
          <Field label={t('billing.filter.model')}>
            <NativeSelect value={modelId} onChange={setModelId}>
              <option value=''>{t('billing.filter.allModels')}</option>
              {models.map((model) => (
                <option key={model.modelId} value={model.modelId}>
                  {model.displayName}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t('billing.filter.status')}>
            <NativeSelect value={status} onChange={setStatus}>
              <option value=''>{t('billing.filter.allStatuses')}</option>
              {[
                'SETTLED',
                'PENDING',
                'READY_TO_SETTLE',
                'FAILED',
                'UNPRICED',
                'MISSING_USAGE',
                'REFUNDED',
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </NativeSelect>
          </Field>
          <div className='relative min-w-56'>
            <Search className='absolute top-2.5 left-3 size-4 text-muted-foreground' />
            <Input
              className='pl-9'
              placeholder={t('billing.filter.keywordPlaceholder')}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          {report.isFetching && (
            <Loader2 className='size-4 animate-spin text-muted-foreground' />
          )}
        </div>
      </CardHeader>
      <CardContent className='overflow-x-auto p-0'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('billing.table.timeRequest')}</TableHead>
              <TableHead>{t('billing.table.token')}</TableHead>
              <TableHead>{t('billing.table.model')}</TableHead>
              <TableHead>{t('billing.table.relay')}</TableHead>
              <TableHead>{t('billing.table.tokenBreakdown')}</TableHead>
              <TableHead>{t('billing.table.providerCost')}</TableHead>
              <TableHead>{t('billing.table.chargedPoints')}</TableHead>
              <TableHead>{t('billing.table.status')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className='h-32 text-center'>
                  <Loader2 className='mx-auto animate-spin' />
                </TableCell>
              </TableRow>
            ) : report.isError ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className='h-32 text-center text-destructive'
                >
                  {t('billing.records.loadFailed')}
                </TableCell>
              </TableRow>
            ) : report.data?.items.length ? (
              report.data.items.map((record) => (
                <UsageRow key={record.id} record={record} />
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className='h-32 text-center text-muted-foreground'
                >
                  {t('billing.records.empty')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
      <div className='flex items-center justify-between border-t px-4 py-3 text-sm'>
        <span className='text-muted-foreground'>
          {t('billing.records.total', {
            count: formatInt(report.data?.total),
          })}
        </span>
        <div className='flex items-center gap-2'>
          <Button
            size='sm'
            variant='outline'
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            {t('common.pagination.prev')}
          </Button>
          <span>
            {page} / {totalPages}
          </span>
          <Button
            size='sm'
            variant='outline'
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            {t('common.pagination.next')}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function UsageRow({ record }: { record: BillingRecord }) {
  const { t, localeTag } = useTranslation()
  return (
    <TableRow>
      <TableCell>
        <div>{new Date(record.createdAt).toLocaleString(localeTag)}</div>
        <div
          className='max-w-48 truncate font-mono text-xs text-muted-foreground'
          title={record.requestId}
        >
          {record.requestId}
        </div>
      </TableCell>
      <TableCell>
        <div>{record.tokenLabel}</div>
        <div className='text-xs text-muted-foreground'>
          {record.groupDisplayName} · #{record.groupId}
        </div>
      </TableCell>
      <TableCell className='min-w-52 font-mono text-xs'>
        <ModelLine
          label={t('billing.model.requested')}
          value={record.requestedModelId}
          help={t('billing.model.requestedHelp')}
        />
        <ModelLine
          label={t('billing.model.billingId')}
          value={record.modelId}
          help={t('billing.model.billingIdHelp')}
        />
        <ModelLine
          label={t('billing.model.sent')}
          value={record.upstreamModelId}
          help={t('billing.model.sentHelp')}
        />
        <ModelLine
          label={t('billing.model.reported')}
          value={record.reportedModelId}
          help={t('billing.model.reportedHelp')}
          fallback={
            record.upstreamModelSource === 'UNKNOWN'
              ? 'UNKNOWN'
              : t('billing.model.notReported')
          }
        />
      </TableCell>
      <TableCell>
        <div>{record.relayName ?? t('billing.records.noRelay')}</div>
        <div className='text-xs text-muted-foreground'>
          {record.provider ?? '—'}
        </div>
        <div className='text-xs text-muted-foreground'>
          {record.protocolCode ?? t('billing.records.noProtocol')}
        </div>
      </TableCell>
      <TableCell className='text-xs whitespace-nowrap'>
        <div>
          In {formatInt(record.inputTokens)} / Out{' '}
          {formatInt(record.outputTokens)}
        </div>
        <div className='text-muted-foreground'>
          Cache R {formatInt(record.cacheInputTokens)} / W{' '}
          {formatInt(record.cacheWriteInputTokens)}
        </div>
      </TableCell>
      <TableCell>
        ${money(record.providerCostUsd)}
        <div className='text-xs text-muted-foreground'>
          {record.priceSource}
        </div>
      </TableCell>
      <TableCell>{money(record.chargedPoints)}</TableCell>
      <TableCell>
        <StatusBadge record={record} />
      </TableCell>
    </TableRow>
  )
}

export function ModelLine({
  label,
  value,
  help,
  fallback = '—',
}: {
  label: string
  value: string | null
  help?: string
  fallback?: string
}) {
  const { t } = useTranslation()
  return (
    <div className='flex items-baseline' title={value ?? fallback}>
      <span className='inline-flex shrink-0 items-center gap-0.5 text-muted-foreground'>
        {label}
        {help && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type='button'
                className='inline-flex rounded-sm align-middle hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none'
                aria-label={t('billing.model.fieldHelpAria', { label })}
              >
                <AlertCircle className='size-3' aria-hidden='true' />
              </button>
            </TooltipTrigger>
            <TooltipContent className='max-w-80 leading-relaxed'>
              {help}
            </TooltipContent>
          </Tooltip>
        )}
        {t('billing.model.labelSuffix')}
      </span>
      {value ?? fallback}
    </div>
  )
}
function StatusBadge({ record }: { record: BillingRecord }) {
  const ok = record.status === 'SETTLED'
  const pending = ['PENDING', 'READY_TO_SETTLE'].includes(record.status)
  return (
    <div>
      <Badge variant={ok ? 'default' : pending ? 'secondary' : 'destructive'}>
        {record.status}
      </Badge>
      {record.errorCode && (
        <div className='mt-1 text-xs text-destructive'>{record.errorCode}</div>
      )}
    </div>
  )
}
function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      className={`border-b-2 px-4 py-2 text-sm font-medium ${active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'}`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
function LoadingCard() {
  return (
    <Card>
      <CardContent className='flex h-64 items-center justify-center'>
        <Loader2 className='animate-spin' />
      </CardContent>
    </Card>
  )
}
function Hint({ children }: { children: ReactNode }) {
  return (
    <Card>
      <CardContent className='py-10 text-center text-sm text-muted-foreground'>
        {children}
      </CardContent>
    </Card>
  )
}
function Metric({
  title,
  value,
  detail,
  icon,
}: {
  title: string
  value: string
  detail: string
  icon: ReactNode
}) {
  return (
    <Card>
      <CardContent className='flex items-start justify-between p-5'>
        <div>
          <div className='text-sm text-muted-foreground'>{title}</div>
          <div className='mt-1 text-2xl font-semibold'>{value}</div>
          <div className='mt-1 text-xs text-muted-foreground'>{detail}</div>
        </div>
        <div className='rounded-lg bg-muted p-2 [&>svg]:size-5'>{icon}</div>
      </CardContent>
    </Card>
  )
}
function Field({
  label,
  children,
  compact = false,
}: {
  label: string
  children: ReactNode
  compact?: boolean
}) {
  return (
    <label
      className={`grid text-xs text-muted-foreground ${compact ? 'gap-0.5' : 'gap-1'}`}
    >
      {label}
      {children}
    </label>
  )
}
function NativeSelect({
  value,
  onChange,
  children,
  compact = false,
}: {
  value: string
  onChange: (value: string) => void
  children: ReactNode
  compact?: boolean
}) {
  return (
    <select
      className={`h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground ${compact ? 'max-w-52 min-w-32' : 'min-w-36'}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {children}
    </select>
  )
}
function formatInt(value?: number, localeTag = currentLocaleTag()) {
  return new Intl.NumberFormat(localeTag).format(value ?? 0)
}
function formatCompact(value: number, localeTag = currentLocaleTag()) {
  return new Intl.NumberFormat(localeTag, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}
function percentage(value: number, total: number) {
  return `${total ? ((value / total) * 100).toFixed(1) : '0.0'}%`
}
function money(value?: number, localeTag = currentLocaleTag()) {
  return Number(value ?? 0).toLocaleString(localeTag, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })
}
