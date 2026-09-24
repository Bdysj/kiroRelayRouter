import type { billingRule as zh } from '../zh/billing-rule'

export const billingRule: typeof zh = {
  title: 'Credits & billing rules',
  description:
    'Manage the billing rule for platform credits in one place, with full version history.',
  unavailable:
    'The current billing rule is unavailable, so model billing requests will be safely rejected.',
  toast: {
    saved: 'The new credit billing rule is now in effect',
    saveFailed: 'Could not update the billing rule',
  },
  conversion: {
    title: 'Base credit conversion',
    upstreamCost: 'Upstream model cost',
    platformPoints: 'Platform credits',
    hint1:
      'This value converts the USD model cost incurred at the relay into base platform credits.',
    hint2:
      'What the end user is actually charged is still multiplied by the model multiplier configured for that model in the access group.',
    editRule: 'Edit rule',
  },
  example: {
    title: 'Example',
    upstreamCost: 'Upstream cost',
    basePoints: 'Base credits',
    afterMultiplier: 'After a {multiplier}× model multiplier',
  },
  info: {
    title: 'Current rule',
    currentRate: 'Exchange rate',
    version: 'Rule version',
    status: 'Status',
    effectiveFrom: 'Effective from',
    updatedAt: 'Last updated',
  },
  history: {
    title: 'Previous versions',
    show: 'View previous versions',
    collapse: 'Hide previous versions',
    loadFailed: 'Could not load previous versions. Please try again later.',
    empty: 'No previous versions',
    scrollMore: 'Scroll down to load more · {count} loaded',
  },
  logic: {
    title: 'How it is calculated',
    chargeTitle: 'Credits charged to the user',
    upstreamCost: 'Upstream model cost',
    baseRate: 'Base rate',
    modelMultiplier: 'Model multiplier',
    chargedPoints: 'Credits charged',
    profitTitle: 'Sales margin estimate',
  },
  dialog: {
    title: 'Edit credit billing rule',
    description:
      'Saving creates a new version; previous rules are kept, not overwritten.',
    newRate: 'New Points / USD',
    current: 'Current',
    next: 'After change',
    consumptionSpeed: 'Credit burn rate',
    exampleMultiplier: 'Example {multiplier}× model multiplier ($1 cost)',
    currentPoints: 'Currently {points} Points',
    warning:
      'The new rule only applies to model requests that start after you save. Requests already in flight, and past invoices, keep using the points_per_usd snapshot taken when the request started and are not recalculated.',
    saveAndConfirm: 'Save and confirm',
  },
  confirm: {
    title: 'Billing rule is about to change',
    description: 'This immediately affects new requests started after saving.',
    change: 'Change',
    action: 'Apply now',
  },
}
