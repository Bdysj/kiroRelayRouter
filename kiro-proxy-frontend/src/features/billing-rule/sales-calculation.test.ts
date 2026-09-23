import { describe, expect, it } from 'vitest'
import { calculateSalesSimulation } from './sales-calculation'

describe('calculateSalesSimulation', () => {
  it('calculates package profit with platform and upstream multipliers', () => {
    const result = calculateSalesSimulation({
      userPaymentRmb: 100,
      userPoints: 1000,
      pointsPerUsd: 10,
      billingMultiplier: 2.5,
      upstreamPackagePriceRmb: 700,
      upstreamPackageUsd: 1000,
      upstreamCostMultiplier: 1.2,
    })

    expect(result).toMatchObject({
      baseModelUsd: 40,
      actualUpstreamUsd: 48,
      upstreamRmbPerUsd: 0.7,
      estimatedProfitRmb: 66.4,
      grossMargin: 66.4,
      multiplierDifference: 1.3,
    })
    expect(result?.estimatedCostRmb).toBeCloseTo(33.6, 10)
  })

  it('matches the default sales example', () => {
    const result = calculateSalesSimulation({
      userPaymentRmb: 20,
      userPoints: 500,
      pointsPerUsd: 20,
      billingMultiplier: 2.5,
      upstreamPackagePriceRmb: 29,
      upstreamPackageUsd: 100,
      upstreamCostMultiplier: 2,
    })

    expect(result).toMatchObject({
      baseModelUsd: 10,
      actualUpstreamUsd: 20,
      upstreamRmbPerUsd: 0.29,
      estimatedCostRmb: 5.8,
      estimatedProfitRmb: 14.2,
      grossMargin: 71,
      multiplierDifference: 0.5,
      multiplierCoverage: 1.25,
    })
  })

  it('keeps zero revenue finite and leaves gross margin empty', () => {
    const result = calculateSalesSimulation({
      userPaymentRmb: 0,
      userPoints: 500,
      pointsPerUsd: 20,
      billingMultiplier: 2.5,
      upstreamPackagePriceRmb: 29,
      upstreamPackageUsd: 100,
      upstreamCostMultiplier: 2,
    })

    expect(result?.grossMargin).toBeNull()
    expect(Number.isFinite(result?.estimatedProfitRmb ?? Number.NaN)).toBe(true)
  })

  it('rejects invalid inputs', () => {
    expect(
      calculateSalesSimulation({
        userPaymentRmb: 100,
        userPoints: 100,
        pointsPerUsd: 10,
        billingMultiplier: 1,
        upstreamPackagePriceRmb: 700,
        upstreamPackageUsd: 0,
        upstreamCostMultiplier: 1,
      })
    ).toBeNull()
  })
})
