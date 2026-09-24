import { type routeMatrix as zh } from '../zh/route-matrix'

export const routeMatrix: typeof zh = {
  title: 'Model routing matrix',
  description:
    'Manage Relay × Model support, scheduling overrides and actual cost in one place',
  bulkAction: 'Bulk actions',
  strategy: {
    AUTO: 'Auto mixed protocols',
    OPENAI_SMART: 'OpenAI smart protocol',
    ANTHROPIC_SMART: 'Claude smart protocol',
  },
  filter: {
    searchPlaceholder: 'Search model ID / name',
    allStrategies: 'All strategies',
    allRelays: 'All upstreams',
    allModels: 'All models',
    boundOnly: 'Bound only',
  },
  table: {
    model: 'Model',
    officialPrice: 'Official price',
    notConfigured: 'Not configured',
    tiers: '{count} price tiers',
    unbound: 'Not bound',
  },
  status: {
    relayDisabled: 'Upstream disabled',
    routeDisabled: 'Route disabled',
    modelDisabled: 'Model disabled',
    noAccessGroup: 'No access group',
    relayDown: 'Upstream down',
    catalogLoading: 'Loading catalog',
    catalogError: 'Catalog error',
    modelMissing: 'Model missing',
  },
  drawer: {
    description: 'Edit a single Relay × Model route',
    mapping: 'Model mapping',
    platformModelId: 'Platform model ID',
    upstreamLoading: 'Loading upstream model catalog…',
    upstreamError:
      'Could not load the upstream model catalog. Check the upstream connection.',
    upstreamAvailable: 'Models available upstream',
    upstreamSelect: 'Pick a model ID returned by the upstream',
    upstreamInvalid:
      'This Upstream Model ID is not in the catalog returned by the upstream. Pick a valid ID from the input suggestions.',
    scheduling: 'Scheduling',
    inheritPlaceholder: 'Empty = default {value}',
    relayDefaults:
      'Upstream defaults: Priority = {priority}, Weight = {weight}',
    protocolRouting: 'Protocol routing',
    strategyLabel: 'Strategy: ',
    availableProtocols: 'Available protocols: ',
    customProtocols: 'Custom model protocols',
    inheritProtocols:
      'Inheriting the upstream protocol strategy and capabilities. Nothing to configure here.',
    protocolPriority: 'Priority',
    costTitle: 'Actual upstream cost',
    configureCost: 'Configure actual cost',
    officialTitle: 'Official reference & price advantage',
    ratio: 'Cost vs. official: ',
    advantage: 'Price advantage: ',
    noOfficial: 'No official reference price configured yet',
    removeBinding: 'Delete binding',
  },
  bulk: {
    title: 'Bulk edit model routes',
    description:
      '{count} models selected. Bulk updates create missing bindings automatically; bulk unbind only removes existing bindings on the target upstream.',
    operation: 'Operation',
    operationUpdate: 'Bind / update',
    operationUnbind: 'Unbind',
    targetRelay: 'Target upstream',
    bindingStatus: 'Route status',
    keepUnchanged: 'Keep unchanged',
    priorityOverride: 'Priority override (empty = inherit)',
    weightOverride: 'Weight override (empty = inherit)',
    copyCost: 'Apply the same cost tiers to all selected models',
    unbindNotice:
      '{count} of the selected models are bound to “{relay}”. Unbound models are skipped.',
    unbindWithCount: 'Unbind ({count})',
    confirmUpdate: 'Confirm bulk update',
    confirmUnbindTitle: 'Unbind the selected models?',
    confirmUnbindDesc:
      'This unbinds {count} models from “{relay}” and deletes their cost prices and protocol overrides. Bindings on other upstreams are untouched.',
    unbinding: 'Unbinding…',
    confirmUnbind: 'Confirm unbind',
  },
  cost: {
    hint: 'Prices are per Pricing Unit. For $3 / 1,000,000 tokens enter 3. Decimals allowed, up to {decimals} places (e.g. 0.000000075).',
    tierTitle: 'Tier {index}: {min} – {max} tokens',
    noMaximum: 'no cap',
    removeTier: 'Delete cost tier {index}',
    addTier: 'Add cost tier',
  },
  reasoning: {
    title: 'Reasoning effort',
    decisionLabel: 'Does this route support reasoning effort?',
    decisionAuto: 'Automatic (follow runtime probing)',
    decisionSupported: 'Confirmed supported',
    decisionUnsupported: 'Confirmed unsupported',
    hintAuto:
      'Effort is sent according to the model configuration. If the upstream rejects it, the request is downgraded automatically and the route is remembered — invisible to the user.',
    hintSupported:
      'Always send effort and ignore runtime probing. Use this to correct a false positive; if the call is wrong, every request pays one extra rejected round trip.',
    hintUnsupported:
      'Never send effort on this route. Use this once the upstream is confirmed not to support it.',
    alertTitle: 'Reasoning effort not taking effect ({count})',
    alertRejected:
      '"{model}" was rejected for reasoning effort on relay "{relay}" ({count} users)',
    alertIgnored:
      '"{model}" appears to ignore reasoning effort on relay "{relay}" ({count} users, no reasoning tokens)',
    alertRejectedAdvice:
      'Requests are already downgraded automatically and users see nothing. Consider setting this route to "Confirmed unsupported".',
    alertIgnoredAdvice:
      'This is only a suspicion: a model that decides it needs no thinking looks the same. Verify manually before changing configuration.',
    alertDismiss: 'Dismiss',
    alertResolved: 'Alert dismissed',
  },
  toast: {
    saved: 'Route and pricing saved',
    removed: 'Binding deleted',
    bulkUpdated: 'Updated {count} model routes',
    bulkUpdatedWithInvalid:
      'Updated {count} model routes, {invalid} of them still need a valid upstream model ID',
    bulkUnbound: 'Unbound {count} model routes',
    actionFailed: 'Action failed',
  },
}
