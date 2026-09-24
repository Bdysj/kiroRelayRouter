import type { models as zh } from '../zh/models'

export const models: typeof zh = {
  title: 'Models',
  description: 'Manage platform models and their official reference pricing',
  reorderHint:
    'Drag the handle at the start of a row to reorder models; once the handle has focus you can also nudge it with ↑ / ↓. Saving the order renumbers every model, so existing duplicate sort values will not affect the result.',
  create: 'New model',
  alert: {
    enabledMissingPrice:
      '{count} enabled model(s) have no official reference price in effect',
    missingPrice:
      '{count} model(s) have no official reference price in effect yet',
    description:
      'Models without pricing cannot be billed for usage. Configure the input, cache and output reference prices before enabling them.',
    action: 'Configure reference price',
  },
  table: {
    sort: 'Sort order',
    displayName: 'Display name',
    status: 'Status',
    inputPrice: 'Input',
    cacheRead: 'Cache read',
    cacheWrite: 'Cache write',
    outputPrice: 'Output',
    boundRelays: 'Bound relays',
    actions: 'Actions',
    relayCount: '{count} relay(s)',
    priceMissing: 'No pricing',
    priceUnset: 'Not set',
    reorderHandle: 'Reorder "{name}", currently position {position} of {total}',
    details: 'Details',
    configurePrice: 'Set pricing',
  },
  detail: {
    subtitle: '{modelId} · Model details and official reference pricing',
    basic: 'Basic info',
    saveBasic: 'Save basic info',
    officialPricing: 'Official pricing',
    officialPricingHint:
      'Writes to relay_model_pricing only; the actual relay cost is left unchanged.',
  },
  field: {
    modelId: 'Model ID',
    displayNameOptional: 'Display name (optional)',
    displayNamePlaceholder: 'Leave empty to use the Model ID',
    sortOrder: 'Sort order',
    maxContextWindow: 'Max context window',
    maxContextWindowHelp:
      'Maximum number of context tokens this model accepts. It must match the real upstream capability; a value that is too high may make the upstream reject requests.',
    maxOutputTokensHelp:
      'Maximum output tokens allowed per answer. It is forwarded upstream as max_tokens or max_output_tokens, so keep it within the upstream limit.',
    maxContextWindowCreateHelp:
      'Defaults to 1,000,000 tokens. This value is returned to Kiro as model metadata and drives context usage and auto-compaction timing.',
    maxOutputTokensCreateHelp:
      'Defaults to 128,000 tokens. This value caps the output length of a single answer and should match the maximum output the upstream model supports.',
    viewHelp: 'View help for {label}',
  },
  pricing: {
    tier: 'Tier {index}: {min} – {max} Tokens',
    noUpperLimit: 'no limit',
    deleteTier: 'Delete tier {index}',
    saveTier: 'Save this tier',
    addTier: 'Add pricing tier',
    emptyTiers: 'No pricing yet. Add the first tier.',
    hint: 'Prices are per pricing token unit; for example, enter 3 for $3 / 1,000,000 tokens. Up to {decimals} decimal places.',
    inputPrice: 'Input price',
    cacheReadPrice: 'Cache read price',
    cacheWritePrice: 'Cache write price',
    outputPrice: 'Output price',
    pricingUnit: 'Pricing token unit',
    priceSource: 'Price source',
    minInputTokens: 'Min input tokens',
    maxInputTokens: 'Max input tokens',
    priceEnabled: 'Pricing enabled',
  },
  reasoning: {
    label: 'Reasoning effort levels',
    preset: 'Presets',
    preset_openai: 'OpenAI',
    preset_claude: 'Claude',
    preset_all: 'All',
    presetClear: 'Clear',
    defaultLabel: 'Default level',
    defaultAuto: 'Automatic (lowest: {level})',
    help: 'Selected levels appear in the effort dropdown at the bottom right of the Kiro input box. If the upstream rejects them, requests are downgraded automatically and the user sees nothing.',
    helpDisabled:
      'Selecting none means this model has no reasoning effort support, and Kiro hides the effort dropdown.',
  },
  createDialog: {
    description:
      'The model ID is the platform-wide identifier and cannot be changed after creation.',
    hint: 'New models are created disabled. Configure the official reference price first, then enable the model from the list.',
  },
  toast: {
    enabled: 'Model enabled',
    disabled: 'Model disabled',
    saved: 'Model saved',
    basicSaved: 'Basic info saved',
    priceSaved: 'Official reference price saved',
    tierDeleted: 'Pricing tier deleted',
    needPriceBeforeEnable:
      'Configure an official reference price that is currently in effect before enabling this model',
  },
  confirm: {
    disable: 'Disable "{name}"?',
  },
}
