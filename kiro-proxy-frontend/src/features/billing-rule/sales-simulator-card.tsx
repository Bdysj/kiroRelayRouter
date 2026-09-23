import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, Calculator } from 'lucide-react'
import { listAccessGroupOptions } from '@/lib/api/admin'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { calculateSalesSimulation } from './sales-calculation'

export function SalesSimulatorCard({ pointsPerUsd }: { pointsPerUsd: number }) {
  const [userPayment, setUserPayment] = useState('20')
  const [userPoints, setUserPoints] = useState('500')
  const [selectedGroupId, setSelectedGroupId] = useState('')
  const [selectedModelId, setSelectedModelId] = useState('')
  const [upstreamPrice, setUpstreamPrice] = useState('29')
  const [upstreamUsd, setUpstreamUsd] = useState('100')
  const [upstreamMultiplier, setUpstreamMultiplier] = useState('2')
  const groups = useQuery({
    queryKey: ['admin-access-group-options'],
    queryFn: listAccessGroupOptions,
  })
  const defaultGroup =
    groups.data?.find(
      (group) => group.enabled && group.displayName.includes('普通')
    ) ??
    groups.data?.find((group) => group.enabled) ??
    groups.data?.[0]
  const selectedGroup =
    groups.data?.find((group) => String(group.id) === selectedGroupId) ??
    defaultGroup
  const effectiveModelId = selectedGroup?.modelIds.includes(selectedModelId)
    ? selectedModelId
    : (selectedGroup?.modelIds[0] ?? '')
  const billingMultiplier = Number(
    selectedGroup?.modelMultipliers[effectiveModelId] ?? 0
  )
  const result = useMemo(
    () =>
      calculateSalesSimulation({
        userPaymentRmb: number(userPayment),
        userPoints: number(userPoints),
        pointsPerUsd,
        billingMultiplier,
        upstreamPackagePriceRmb: number(upstreamPrice),
        upstreamPackageUsd: number(upstreamUsd),
        upstreamCostMultiplier: number(upstreamMultiplier),
      }),
    [
      userPayment,
      userPoints,
      pointsPerUsd,
      billingMultiplier,
      upstreamPrice,
      upstreamUsd,
      upstreamMultiplier,
    ]
  )
  const upstreamQuotaValid = number(upstreamUsd) > 0

  return (
    <Card id='sales-plan' className='scroll-mt-20'>
      <CardHeader>
        <div className='flex items-center gap-3'>
          <span className='flex size-9 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-950/40'>
            <Calculator className='size-5' />
          </span>
          <div>
            <CardTitle>销售模拟计算</CardTitle>
            <p className='mt-1 text-sm text-muted-foreground'>
              模拟积分套餐收入、平台扣费和上游采购成本。
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className='grid overflow-hidden rounded-xl border lg:grid-cols-[1.15fr_0.85fr]'>
          <div className='space-y-6 p-5 lg:border-r lg:p-6'>
            <SimulatorSection
              title='用户销售'
              description='该区域仅描述用户购买积分的销售方案，不直接参与上游模型价格计算。'
            >
              <div className='grid gap-3 sm:grid-cols-2'>
                <Field
                  label='用户支付'
                  value={userPayment}
                  onChange={setUserPayment}
                  prefix='¥'
                />
                <Field
                  label='用户获得积分'
                  value={userPoints}
                  onChange={setUserPoints}
                  suffix='Points'
                />
              </div>
              <div className='mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/35 px-4 py-3 text-sm'>
                <span>
                  <strong>¥{rmb(number(userPayment))}</strong>
                  <span className='mx-2 text-muted-foreground'>→</span>
                  <strong>{points(number(userPoints))} Points</strong>
                </span>
                <span className='text-muted-foreground'>
                  每 1 元发放{' '}
                  <strong className='text-foreground'>
                    {number(userPayment) > 0
                      ? points(number(userPoints) / number(userPayment))
                      : '--'}{' '}
                    Points / RMB
                  </strong>
                </span>
              </div>
            </SimulatorSection>

            <SimulatorSection
              title='平台扣费规则'
              description='模型倍率决定该分组使用对应模型时的积分消耗速度。'
            >
              <div className='grid gap-3 sm:grid-cols-3'>
                <ReadOnly
                  label='基础扣费率'
                  value={`${points(pointsPerUsd)} Points / USD`}
                  action={
                    <Button asChild size='sm' variant='outline'>
                      <a href='#billing-rule'>管理计费规则</a>
                    </Button>
                  }
                />
                <label className='grid gap-2 text-sm font-medium'>
                  访问分组
                  <select
                    className='h-9 rounded-md border border-input bg-background px-3 text-sm'
                    value={selectedGroup ? String(selectedGroup.id) : ''}
                    disabled={groups.isLoading || !groups.data?.length}
                    onChange={(event) => {
                      setSelectedGroupId(event.target.value)
                      setSelectedModelId('')
                    }}
                  >
                    {!groups.data?.length && (
                      <option value=''>暂无可用分组</option>
                    )}
                    {(groups.data ?? []).map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.displayName}
                        {group.enabled ? '' : '（已停用）'}
                      </option>
                    ))}
                  </select>
                </label>
                <label className='grid gap-2 text-sm font-medium'>
                  模型倍率
                  <select
                    className='h-9 rounded-md border border-input bg-background px-3 text-sm'
                    value={effectiveModelId}
                    disabled={!selectedGroup?.modelIds.length}
                    onChange={(event) => setSelectedModelId(event.target.value)}
                  >
                    {!selectedGroup?.modelIds.length && (
                      <option value=''>该分组暂无模型</option>
                    )}
                    {(selectedGroup?.modelIds ?? []).map((modelId, index) => (
                      <option key={modelId} value={modelId}>
                        {selectedGroup?.models[index] ?? modelId} ·{' '}
                        {multiplier(
                          Number(selectedGroup?.modelMultipliers[modelId] ?? 0)
                        )}
                        ×
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className='mt-3 rounded-lg bg-muted/35 px-4 py-3 text-sm'>
                每产生 1 USD 基础模型成本：{' '}
                <span className='font-mono font-semibold'>
                  {pointsPerUsd > 0 && billingMultiplier > 0
                    ? `${points(pointsPerUsd)} × ${multiplier(billingMultiplier)} = ${points(pointsPerUsd * billingMultiplier)} Points`
                    : '—'}
                </span>
              </div>
            </SimulatorSection>

            <SimulatorSection
              title='上游采购'
              description='上游成本倍率表示产生 1 USD 基础模型计费成本时，实际会消耗多少上游 USD 额度。'
            >
              <div className='grid gap-3 sm:grid-cols-2'>
                <Field
                  label='上游采购价格'
                  value={upstreamPrice}
                  onChange={setUpstreamPrice}
                  prefix='¥'
                />
                <Field
                  label='获得上游额度'
                  value={upstreamUsd}
                  onChange={setUpstreamUsd}
                  prefix='$'
                  suffix='USD'
                />
                <ReadOnly
                  label='每 $1 上游额度采购成本'
                  value={
                    upstreamQuotaValid
                      ? `¥${rmb(number(upstreamPrice) / number(upstreamUsd))} / USD`
                      : '—'
                  }
                />
                <Field
                  label='上游成本倍率'
                  value={upstreamMultiplier}
                  onChange={setUpstreamMultiplier}
                  suffix='×'
                />
              </div>
              {upstreamQuotaValid ? (
                <div className='mt-3 rounded-lg bg-muted/35 px-4 py-3 text-sm'>
                  基础模型成本 $1{' '}
                  <span className='mx-2 text-muted-foreground'>→</span>
                  实际上游消耗 ${multiplier(number(upstreamMultiplier))}
                </div>
              ) : (
                <ValidationMessage>请输入有效的上游采购额度</ValidationMessage>
              )}
            </SimulatorSection>
          </div>

          <div className='border-t bg-muted/15 p-5 lg:border-t-0 lg:p-6'>
            <h3 className='text-sm font-semibold'>实时测算结果</h3>
            {result ? (
              <ResultPanel result={result} />
            ) : (
              <div className='mt-4 rounded-lg border p-4 text-sm text-muted-foreground'>
                {groups.isError
                  ? '访问分组加载失败，请刷新后重试。'
                  : !upstreamQuotaValid
                    ? '请输入有效的上游采购额度。'
                    : '请填写有效且不小于 0 的模拟参数。'}
              </div>
            )}
          </div>
        </div>
        <div className='mt-4 flex gap-2 text-xs text-muted-foreground'>
          <AlertCircle className='mt-0.5 size-4 shrink-0' />
          <p>
            USD
            仅表示模型与上游额度的通用计费单位，不使用人民币汇率，也不会修改平台核心积分规则。
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

type Simulation = NonNullable<ReturnType<typeof calculateSalesSimulation>>
function ResultPanel({ result }: { result: Simulation }) {
  const profitable = result.estimatedProfitRmb >= 0
  const relation =
    result.multiplierDifference > 0
      ? '用户扣费倍率高于上游成本倍率'
      : result.multiplierDifference < 0
        ? '⚠ 用户扣费倍率低于上游成本倍率'
        : '倍率无价差'
  const relationTone =
    result.multiplierDifference > 0
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/25 dark:text-emerald-200'
      : result.multiplierDifference < 0
        ? 'border-orange-200 bg-orange-50 text-orange-800 dark:bg-orange-950/25 dark:text-orange-200'
        : 'bg-muted/40 text-muted-foreground'
  return (
    <div className='mt-4 space-y-4'>
      <div
        className={`rounded-xl border p-5 ${profitable ? 'border-emerald-200 bg-emerald-50 dark:bg-emerald-950/25' : 'border-orange-200 bg-orange-50 dark:bg-orange-950/25'}`}
      >
        <div className='text-sm text-muted-foreground'>预计利润</div>
        <div
          className={`mt-1 font-mono text-4xl font-bold ${profitable ? 'text-emerald-700 dark:text-emerald-300' : 'text-orange-700 dark:text-orange-300'}`}
        >
          ¥{rmb(result.estimatedProfitRmb)}
        </div>
        <div className='mt-3 text-sm'>
          毛利率{' '}
          <strong>
            {result.grossMargin == null
              ? '--'
              : `${result.grossMargin.toFixed(2)}%`}
          </strong>
        </div>
      </div>
      <div className='divide-y rounded-xl border bg-background px-4'>
        <ResultRow label='用户收入' value={`¥${rmb(result.userPaymentRmb)}`} />
        <ResultRow
          label='可支持基础模型额度'
          value={`$${usd(result.baseModelUsd)}`}
          detail={`${points(result.userPoints)} ÷ (${points(result.pointsPerUsd)} Points/USD × ${multiplier(result.billingMultiplier)}×)`}
        />
        <ResultRow
          label='实际上游额度消耗'
          value={`$${usd(result.actualUpstreamUsd)}`}
          detail={`$${usd(result.baseModelUsd)} × ${multiplier(result.upstreamCostMultiplier)}×`}
        />
        <ResultRow
          label='实际上游人民币成本'
          value={`¥${rmb(result.estimatedCostRmb)}`}
          detail={`$${usd(result.actualUpstreamUsd)} × ¥${rmb(result.upstreamRmbPerUsd)}`}
        />
        <ResultRow
          label='预计利润'
          value={`¥${rmb(result.estimatedProfitRmb)}`}
          detail={`¥${rmb(result.userPaymentRmb)} − ¥${rmb(result.estimatedCostRmb)}`}
        />
      </div>
      <div className={`rounded-xl border p-4 text-sm ${relationTone}`}>
        <div className='font-semibold'>倍率关系</div>
        <div className='mt-3 grid grid-cols-2 gap-3 text-xs'>
          <SmallResult
            label='用户扣费倍率'
            value={`${multiplier(result.billingMultiplier)}×`}
          />
          <SmallResult
            label='上游成本倍率'
            value={`${multiplier(result.upstreamCostMultiplier)}×`}
          />
          <SmallResult
            label='倍率差'
            value={`${result.multiplierDifference > 0 ? '+' : ''}${multiplier(result.multiplierDifference)}×`}
          />
          <SmallResult
            label='倍率覆盖率'
            value={
              result.multiplierCoverage == null
                ? '--'
                : `${multiplier(result.multiplierCoverage)}×`
            }
          />
        </div>
        <p className='mt-3 font-medium'>{relation}</p>
        <p className='mt-1 text-xs opacity-80'>
          最终是否盈利以人民币收入与实际上游采购成本为准。
        </p>
      </div>
    </div>
  )
}

function SimulatorSection({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section>
      <h3 className='text-sm font-semibold'>{title}</h3>
      <div className='mt-3'>{children}</div>
      <p className='mt-3 text-xs leading-5 text-muted-foreground'>
        {description}
      </p>
    </section>
  )
}
function Field({
  label,
  value,
  onChange,
  prefix,
  suffix,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  prefix?: string
  suffix?: string
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
          className={`${prefix ? 'pl-7' : ''} ${suffix ? 'pr-16' : ''}`}
          type='number'
          min='0'
          step='any'
          value={value}
          onChange={(event) => onChange(nonnegative(event.target.value))}
        />
        {suffix && (
          <span className='absolute top-2 right-3 text-muted-foreground'>
            {suffix}
          </span>
        )}
      </div>
    </label>
  )
}
function ReadOnly({
  label,
  value,
  action,
}: {
  label: string
  value: string
  action?: ReactNode
}) {
  return (
    <div>
      <div className='flex items-center justify-between gap-2 text-sm font-medium'>
        <span>{label}</span>
        {action}
      </div>
      <div className='mt-2 h-9 rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm'>
        {value}
      </div>
    </div>
  )
}
function ResultRow({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail?: string
}) {
  return (
    <div className='flex items-start justify-between gap-4 py-3'>
      <div>
        <div className='text-sm text-muted-foreground'>{label}</div>
        {detail && (
          <div className='mt-1 font-mono text-[11px] text-muted-foreground'>
            {detail}
          </div>
        )}
      </div>
      <strong className='shrink-0 font-mono'>{value}</strong>
    </div>
  )
}
function SmallResult({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className='opacity-75'>{label}</div>
      <div className='mt-1 font-mono text-base font-semibold'>{value}</div>
    </div>
  )
}
function ValidationMessage({ children }: { children: ReactNode }) {
  return (
    <div className='mt-3 rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 text-xs text-orange-800 dark:bg-orange-950/25 dark:text-orange-200'>
      {children}
    </div>
  )
}
function nonnegative(value: string) {
  const parsed = Number(value)
  return value !== '' && Number.isFinite(parsed) && parsed < 0 ? '0' : value
}
function number(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
function rmb(value: number) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
function usd(value: number) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })
}
function points(value: number) {
  return value.toLocaleString('en-US', { maximumFractionDigits: 6 })
}
function multiplier(value: number) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
