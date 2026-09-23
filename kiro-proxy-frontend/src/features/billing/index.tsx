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
          <ThemeSwitch />
          <ConfigDrawer />
        </div>
      </Header>
      <Main className='max-w-none'>
        <div className='mb-4 flex flex-wrap items-start justify-between gap-3'>
          <div>
            <h1 className='text-2xl font-bold tracking-tight'>用量与账单</h1>
            <p className='text-muted-foreground'>
              按分组、Token 和模型分析每日调用量与结算数据
            </p>
          </div>
          <div className='flex flex-wrap items-end gap-2'>
            <Field label='开始日期'>
              <Input
                type='date'
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value)
                  setPage(1)
                }}
              />
            </Field>
            <Field label='结束日期'>
              <Input
                type='date'
                value={to}
                onChange={(e) => {
                  setTo(e.target.value)
                  setPage(1)
                }}
              />
            </Field>
            <Field label='中转站'>
              <NativeSelect
                value={relayId}
                onChange={(value) => {
                  setRelayId(value)
                  setPage(1)
                }}
              >
                <option value=''>全部中转站</option>
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
            按分组统计
          </TabButton>
          <TabButton
            active={tab === 'tokens'}
            onClick={() => {
              setTab('tokens')
              if (!tokenId && analytics.data?.tokenTotals[0])
                setTokenId(String(analytics.data.tokenTotals[0].tokenId))
            }}
          >
            按 Token 统计
          </TabButton>
          <TabButton
            active={tab === 'records'}
            onClick={() => setTab('records')}
          >
            账单明细
          </TabButton>
        </div>
        <div className='mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
          <Metric
            title='总请求数'
            value={formatInt(summary?.requestCount)}
            icon={<Cpu />}
            detail={`已结算 ${formatInt(summary?.settledCount)}`}
          />
          <Metric
            title='总 Token 用量'
            value={formatInt(summary?.totalTokens)}
            icon={<Coins />}
            detail='输入、缓存与输出合计'
          />
          <Metric
            title='上游成本'
            value={`$${money(summary?.providerCostUsd)}`}
            icon={<DollarSign />}
            detail='USD'
          />
          <Metric
            title='扣除积分'
            value={money(summary?.chargedPoints)}
            icon={<AlertCircle />}
            detail={`异常 ${formatInt(summary?.exceptionCount)} 笔`}
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
            分组{granularityLabel(granularity)}请求趋势
          </CardTitle>
          <div className='flex flex-wrap items-center gap-2'>
            <NativeSelect value={groupId} onChange={selectGroup} compact>
              <option value=''>全部分组</option>
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
          <CardTitle className='text-base'>分组统计</CardTitle>
        </CardHeader>
        <CardContent className='overflow-x-auto p-0'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>分组</TableHead>
                <TableHead>请求数</TableHead>
                <TableHead>Token 用量</TableHead>
                <TableHead>上游成本</TableHead>
                <TableHead>扣除积分</TableHead>
                <TableHead>活跃 Token 数</TableHead>
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
              <CardTitle className='text-base'>组内详情</CardTitle>
            </CardHeader>
            <CardContent>
              <div className='mb-5 flex items-center gap-2 text-sm'>
                <span className='text-muted-foreground'>当前分组</span>
                <Badge variant='secondary'>
                  {selectedGroup?.groupDisplayName ?? '—'}
                </Badge>
              </div>
              <div className='grid grid-cols-2 gap-y-5 sm:grid-cols-4'>
                <CompactMetric
                  label='请求数'
                  value={formatInt(selectedGroup?.requestCount)}
                />
                <CompactMetric
                  label='Token 用量'
                  value={formatInt(selectedGroup?.totalTokens)}
                />
                <CompactMetric
                  label='上游成本'
                  value={`$${money(selectedGroup?.providerCostUsd)}`}
                />
                <CompactMetric
                  label='扣除积分'
                  value={money(selectedGroup?.chargedPoints)}
                />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className='flex-row items-center justify-between gap-3'>
              <CardTitle className='text-base'>组内 Token 用量分布</CardTitle>
              <Badge variant='outline'>Token 用量</Badge>
            </CardHeader>
            <CardContent>
              <HorizontalDistribution items={data?.tokenTotals ?? []} />
            </CardContent>
          </Card>
        </div>
      ) : (
        <Hint>请在分组统计中选择一个分组，查看组内详情和 Token 用量分布。</Hint>
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
              单 Token 各模型{granularityLabel(granularity)} Token 用量
            </CardTitle>
            <p className='mt-1 text-xs text-muted-foreground'>
              归档 Token 仍会显示，以保证历史统计完整。
            </p>
          </div>
          <div className='flex flex-wrap items-end gap-2'>
            <Field label='访问分组' compact>
              <NativeSelect value={groupId} onChange={selectGroup} compact>
                <option value=''>全部分组</option>
                {(data?.groupTotals ?? []).map((item) => (
                  <option key={item.groupId} value={item.groupId}>
                    {item.groupDisplayName}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label='Token' compact>
              <NativeSelect value={tokenId} onChange={selectToken} compact>
                <option value=''>选择 Token</option>
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
            <CardTitle className='text-base'>该 Token 调用模型汇总</CardTitle>
          </CardHeader>
          <CardContent className='overflow-x-auto p-0'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>模型</TableHead>
                  <TableHead>请求数</TableHead>
                  <TableHead>Token 用量</TableHead>
                  <TableHead>上游成本</TableHead>
                  <TableHead>扣除积分</TableHead>
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
                        ? '该 Token 在当前日期范围内没有用量'
                        : '请选择 Token'}
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
              模型占比（按 Token 用量）
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

function granularityLabel(value: Granularity) {
  return { day: '每日', week: '每周', month: '每月' }[value]
}

function GranularitySwitch({
  value,
  onChange,
}: {
  value: Granularity
  onChange: (value: Granularity) => void
}) {
  return (
    <div className='flex h-9 items-center rounded-md bg-muted p-1'>
      {(
        [
          ['day', '日'],
          ['week', '周'],
          ['month', '月'],
        ] as const
      ).map(([key, label]) => (
        <button
          key={key}
          type='button'
          className={`h-7 min-w-9 rounded px-2 text-xs transition-colors ${value === key ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          aria-pressed={value === key}
          onClick={() => onChange(key)}
        >
          {label}
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
  return `${day.slice(5)}${granularity === 'week' ? ' 周' : ''}`
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
      aria-label='分组请求趋势图'
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
          aria-label='各模型 Token 用量堆叠柱状图'
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
        aria-label={`模型 Token 用量占比，总计 ${formatInt(total)}`}
      >
        <div className='absolute inset-7 flex flex-col items-center justify-center rounded-full bg-card shadow-inner'>
          <strong className='text-lg'>{formatInt(total)}</strong>
          <span className='text-xs text-muted-foreground'>总 Token</span>
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
  return (
    <div
      className={`flex items-center justify-center text-sm text-muted-foreground ${compact ? 'h-44' : 'h-64'}`}
    >
      当前筛选条件下暂无趋势数据
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
        当前筛选条件下暂无趋势数据
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
          aria-label='每日用量趋势图'
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
  const max = Math.max(1, ...values)
  const coordinates = values.map((value, index) => {
    const x = values.length <= 1 ? 40 : (index * 80) / (values.length - 1)
    return { x, y: 24 - (value / max) * 20, value }
  })
  return values.length ? (
    <svg viewBox='0 0 80 28' className='h-8 w-24' aria-label='每日请求趋势'>
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
  return (
    <Card>
      <CardHeader className='gap-3 lg:flex-row lg:items-end lg:justify-between'>
        <CardTitle className='text-base'>请求流水</CardTitle>
        <div className='flex flex-wrap items-end gap-2'>
          <Field label='模型'>
            <NativeSelect value={modelId} onChange={setModelId}>
              <option value=''>全部模型</option>
              {models.map((model) => (
                <option key={model.modelId} value={model.modelId}>
                  {model.displayName}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label='结算状态'>
            <NativeSelect value={status} onChange={setStatus}>
              <option value=''>全部状态</option>
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
              placeholder='请求 ID / Token 名称'
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
              <TableHead>时间 / 请求</TableHead>
              <TableHead>Token</TableHead>
              <TableHead>模型</TableHead>
              <TableHead>中转站</TableHead>
              <TableHead>Token 明细</TableHead>
              <TableHead>上游成本</TableHead>
              <TableHead>扣除积分</TableHead>
              <TableHead>状态</TableHead>
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
                  账单数据加载失败，请稍后重试
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
                  当前筛选条件下暂无用量记录
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
      <div className='flex items-center justify-between border-t px-4 py-3 text-sm'>
        <span className='text-muted-foreground'>
          共 {formatInt(report.data?.total)} 条
        </span>
        <div className='flex items-center gap-2'>
          <Button
            size='sm'
            variant='outline'
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            上一页
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
            下一页
          </Button>
        </div>
      </div>
    </Card>
  )
}

function UsageRow({ record }: { record: BillingRecord }) {
  return (
    <TableRow>
      <TableCell>
        <div>{new Date(record.createdAt).toLocaleString()}</div>
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
          label='请求'
          value={record.requestedModelId}
          help='客户端发起请求时携带的原始模型名称，可能是展示名称或别名。'
        />
        <ModelLine
          label='路由计费 ID'
          value={record.modelId}
          help='平台内部标准 Model ID，用于权限判断、路由选择和计费；不是中转站实际接收的模型 ID。'
        />
        <ModelLine
          label='发送'
          value={record.upstreamModelId}
          help='根据所选中转站的模型映射，实际写入上游请求 model 字段的 ID。'
        />
        <ModelLine
          label='上报'
          value={record.reportedModelId}
          help='从上游响应中读取的模型 ID，仅代表上游自报；平台无法验证其真实使用的底层模型。'
          fallback={
            record.upstreamModelSource === 'UNKNOWN' ? 'UNKNOWN' : '未上报'
          }
        />
      </TableCell>
      <TableCell>
        <div>{record.relayName ?? '未记录'}</div>
        <div className='text-xs text-muted-foreground'>
          {record.provider ?? '—'}
        </div>
        <div className='text-xs text-muted-foreground'>
          {record.protocolCode ?? '协议未记录'}
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
                aria-label={`${label}字段说明`}
              >
                <AlertCircle className='size-3' aria-hidden='true' />
              </button>
            </TooltipTrigger>
            <TooltipContent className='max-w-80 leading-relaxed'>
              {help}
            </TooltipContent>
          </Tooltip>
        )}
        ：
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
function formatInt(value?: number) {
  return new Intl.NumberFormat('zh-CN').format(value ?? 0)
}
function formatCompact(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}
function percentage(value: number, total: number) {
  return `${total ? ((value / total) * 100).toFixed(1) : '0.0'}%`
}
function money(value?: number) {
  return Number(value ?? 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })
}
