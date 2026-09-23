export interface SalesSimulationInput {
  userPaymentRmb: number
  userPoints: number
  pointsPerUsd: number
  billingMultiplier: number
  upstreamPackagePriceRmb: number
  upstreamPackageUsd: number
  upstreamCostMultiplier: number
}

export interface SalesSimulationResult {
  userPaymentRmb: number
  userPoints: number
  pointsPerUsd: number
  billingMultiplier: number
  upstreamPackagePriceRmb: number
  upstreamPackageUsd: number
  upstreamCostMultiplier: number
  baseModelUsd: number
  actualUpstreamUsd: number
  upstreamRmbPerUsd: number
  estimatedCostRmb: number
  estimatedProfitRmb: number
  grossMargin: number | null
  multiplierDifference: number
  multiplierCoverage: number | null
}

export function calculateSalesSimulation(
  input: SalesSimulationInput
): SalesSimulationResult | null {
  const values = Object.values(input)
  if (!values.every((value) => Number.isFinite(value) && value >= 0)) {
    return null
  }
  if (
    input.pointsPerUsd <= 0 ||
    input.billingMultiplier <= 0 ||
    input.upstreamPackageUsd <= 0 ||
    input.upstreamCostMultiplier <= 0
  ) {
    return null
  }

  const baseModelUsd =
    input.userPoints / (input.pointsPerUsd * input.billingMultiplier)
  const actualUpstreamUsd = baseModelUsd * input.upstreamCostMultiplier
  const upstreamRmbPerUsd =
    input.upstreamPackagePriceRmb / input.upstreamPackageUsd
  const estimatedCostRmb = actualUpstreamUsd * upstreamRmbPerUsd
  const estimatedProfitRmb = input.userPaymentRmb - estimatedCostRmb

  return {
    ...input,
    baseModelUsd,
    actualUpstreamUsd,
    upstreamRmbPerUsd,
    estimatedCostRmb,
    estimatedProfitRmb,
    grossMargin:
      input.userPaymentRmb > 0
        ? (estimatedProfitRmb / input.userPaymentRmb) * 100
        : null,
    multiplierDifference:
      input.billingMultiplier - input.upstreamCostMultiplier,
    multiplierCoverage:
      input.upstreamCostMultiplier > 0
        ? input.billingMultiplier / input.upstreamCostMultiplier
        : null,
  }
}
