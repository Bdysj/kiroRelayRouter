import { beforeEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { useI18nStore } from '@/lib/i18n'
import {
  DonutChart,
  LineChart,
  ModelLine,
  SmoothAreaChart,
  Sparkline,
  StackedBarChart,
} from './index'

describe('billing trend charts', () => {
  beforeEach(() => {
    // 断言用的是中文文案，显式固定语言。
    useI18nStore.getState().setLocale('zh')
  })

  it('renders a visible marker when a line series contains only one day', async () => {
    await render(
      <LineChart
        points={[
          {
            day: '2026-09-16',
            groupId: 1,
            requestCount: 69,
            totalTokens: 2_746_502,
            providerCostUsd: 6.181756,
            chargedPoints: 138.766342,
          },
        ]}
        series={[{ key: '1', label: '普通用户组', color: '#2563eb' }]}
        seriesKey='groupId'
        valueKey='requestCount'
      />
    )

    const series = document.querySelector('[data-series="1"]')
    expect(series?.querySelector('polyline')).not.toBeNull()
    expect(series?.querySelector('circle')).not.toBeNull()
    expect(series?.querySelector('title')?.textContent).toContain('69')
  })

  it('renders a visible marker for a one-day table sparkline', async () => {
    await render(<Sparkline values={[69]} />)

    const chart = document.querySelector('svg[aria-label="每日请求趋势"]')
    expect(chart?.querySelector('circle')).not.toBeNull()
    expect(chart?.querySelector('title')?.textContent).toBe('69')
  })

  it('provides an accessible explanation trigger for model fields', async () => {
    const view = await render(
      <ModelLine
        label='上报'
        value='gpt-5.6-sol'
        help='仅代表上游自报，不代表真实底层模型。'
      />
    )

    await expect
      .element(view.getByRole('button', { name: '上报字段说明' }))
      .toBeVisible()
  })

  it('renders model usage as stacked bars', async () => {
    await render(
      <StackedBarChart
        points={[
          dailyPoint('2026-09-15', 'model-a', 100),
          dailyPoint('2026-09-15', 'model-b', 50),
          dailyPoint('2026-09-16', 'model-a', 80),
        ]}
        series={[
          { key: 'model-a', label: 'Model A', color: '#2563eb' },
          { key: 'model-b', label: 'Model B', color: '#10b981' },
        ]}
        granularity='day'
      />
    )

    const chart = document.querySelector(
      'svg[aria-label="各模型 Token 用量堆叠柱状图"]'
    )
    expect(chart?.querySelectorAll('rect')).toHaveLength(3)
  })

  it('renders a smooth group trend and model proportion donut', async () => {
    await render(
      <>
        <SmoothAreaChart
          points={[
            { day: '2026-09-15', label: '09-15', value: 20 },
            { day: '2026-09-16', label: '09-16', value: 30 },
          ]}
        />
        <DonutChart
          items={[
            {
              modelId: 'model-a',
              requestCount: 2,
              totalTokens: 75,
              providerCostUsd: 1,
              chargedPoints: 2,
            },
            {
              modelId: 'model-b',
              requestCount: 1,
              totalTokens: 25,
              providerCostUsd: 0.5,
              chargedPoints: 1,
            },
          ]}
        />
      </>
    )

    expect(
      document.querySelector('svg[aria-label="分组请求趋势图"] path')
    ).not.toBeNull()
    expect(document.body.textContent).toContain('75.0%')
    expect(document.body.textContent).toContain('25.0%')
  })
})

function dailyPoint(day: string, modelId: string, totalTokens: number) {
  return {
    day,
    modelId,
    requestCount: 1,
    totalTokens,
    providerCostUsd: 0,
    chargedPoints: 0,
  }
}
