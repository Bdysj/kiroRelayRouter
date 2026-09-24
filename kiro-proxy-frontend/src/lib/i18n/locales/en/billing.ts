import type { billing as zh } from '../zh/billing'

export const billing: typeof zh = {
  title: 'Usage & billing',
  description:
    'Analyze daily calls and settlement data by group, token and model',
  filter: {
    from: 'Start date',
    to: 'End date',
    relay: 'Relay',
    allRelays: 'All relays',
    group: 'Access group',
    allGroups: 'All groups',
    selectToken: 'Select a token',
    model: 'Model',
    allModels: 'All models',
    status: 'Settlement status',
    allStatuses: 'All statuses',
    keywordPlaceholder: 'Request ID / token name',
  },
  tab: {
    groups: 'By group',
    tokens: 'By token',
    records: 'Ledger',
  },
  metric: {
    requests: 'Total requests',
    settled: '{count} settled',
    tokens: 'Total token usage',
    tokensDetail: 'Input, cache and output combined',
    providerCost: 'Upstream cost',
    chargedPoints: 'Credits charged',
    exceptions: '{count} exception(s)',
  },
  granularity: {
    day: 'Day',
    week: 'Week',
    month: 'Month',
  },
  chart: {
    empty: 'No trend data for the current filters',
    weekSuffix: ' wk',
    totalTokens: 'Total tokens',
    groupTrendAria: 'Group request trend chart',
    modelStackAria: 'Stacked token usage by model',
    modelShareAria: 'Share of token usage by model, {total} in total',
    dailyTrendAria: 'Daily usage trend chart',
    dailyRequestsAria: 'Daily request trend',
  },
  group: {
    trendTitle: {
      day: 'Daily group requests',
      week: 'Weekly group requests',
      month: 'Monthly group requests',
    },
    totalsTitle: 'Group totals',
    detailTitle: 'Group details',
    currentGroup: 'Current group',
    distributionTitle: 'Token usage within the group',
    hint: 'Select a group in the group totals table to see its details and token usage distribution.',
  },
  token: {
    chartTitle: {
      day: 'Daily token usage per model for one token',
      week: 'Weekly token usage per model for one token',
      month: 'Monthly token usage per model for one token',
    },
    archivedHint:
      'Archived tokens are still listed so historical stats stay complete.',
    modelSummaryTitle: 'Models called by this token',
    noUsage: 'This token has no usage in the selected date range',
    pickToken: 'Select a token',
    shareTitle: 'Model share (by token usage)',
  },
  table: {
    group: 'Group',
    requests: 'Requests',
    tokens: 'Token usage',
    providerCost: 'Upstream cost',
    chargedPoints: 'Credits charged',
    activeTokens: 'Active tokens',
    model: 'Model',
    timeRequest: 'Time / request',
    token: 'Token',
    relay: 'Relay',
    tokenBreakdown: 'Token breakdown',
    status: 'Status',
  },
  records: {
    title: 'Request ledger',
    loadFailed: 'Failed to load billing data. Please try again later.',
    empty: 'No usage records for the current filters',
    total: '{count} record(s)',
    noRelay: 'Not recorded',
    noProtocol: 'Protocol not recorded',
  },
  model: {
    requested: 'Requested',
    requestedHelp:
      'The original model name sent by the client; it may be a display name or an alias.',
    billingId: 'Routing & billing ID',
    billingIdHelp:
      "The platform's canonical model ID, used for permission checks, routing and billing. It is not the model ID the relay actually receives.",
    sent: 'Sent',
    sentHelp:
      "The ID actually written to the model field of the upstream request, based on the selected relay's model mapping.",
    reported: 'Reported',
    reportedHelp:
      'The model ID read from the upstream response. It is self-reported by the upstream; the platform cannot verify which underlying model was really used.',
    notReported: 'Not reported',
    labelSuffix: ': ',
    fieldHelpAria: 'About the {label} field',
  },
}
