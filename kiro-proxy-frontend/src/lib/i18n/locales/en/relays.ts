import { type relays as zhRelays } from '../zh/relays'

export const relays: typeof zhRelays = {
  title: 'Relays',
  desc: 'Manage upstream APIs, keys, connection settings, and health',
  action: {
    healthCheck: 'Health check',
    create: 'New relay',
  },
  table: {
    name: 'Name',
    strategy: 'Protocol strategy',
    baseUrl: 'API URL',
    status: 'Status',
    models: 'Models',
    lastCheck: 'Last check',
    lastSuccess: 'Last success',
    actions: 'Actions',
    protocolCount: '{count} protocols',
    modelCount: '{count} models',
    empty: 'No relays yet',
  },
  strategy: {
    auto: 'Auto mixed protocols',
    openaiSmart: 'OpenAI smart protocol',
    anthropicSmart: 'Claude smart protocol',
    autoDesc:
      'Prefers the configured model × protocol mapping; without one, detects the GPT/Claude model family and then picks by requested capabilities and protocol priority.',
    openaiSmartDesc:
      'Chooses between Responses and Chat Completions based on the requested capabilities.',
    anthropicSmartDesc:
      'Prefers Anthropic Messages, with Chat Completions as the compatibility path.',
  },
  capability: {
    text: 'Text',
    image: 'Image',
    pdf: 'PDF',
    streaming: 'Streaming',
  },
  dialog: {
    createTitle: 'New relay',
    editTitle: 'Edit relay',
    desc: 'Leave the API key empty when editing to keep the current value.',
    name: 'Name',
    baseUrl: 'API base URL',
    apiKey: 'API Key',
    apiKeyConfigured: 'API Key (configured)',
    strategy: 'Protocol strategy',
    protocolSection: 'Protocol setup (testing optional)',
    advancedExpand: 'Advanced protocol settings',
    advancedCollapse: 'Hide advanced settings',
    capabilities: 'Capabilities: {list}',
    testModelSource:
      'Test models come from the bound and enabled candidates in Routing & Pricing.',
    priority: 'Priority',
    weight: 'Weight',
    failureThreshold: 'Failure threshold',
    maxConcurrency: 'Max concurrency (0 = unlimited)',
    connectTimeout: 'Connect timeout (ms, per probe)',
    readTimeout: 'Stream idle timeout (ms)',
    timeoutHint:
      'A chat stream only times out after receiving no SSE data at all; protocol tests still apply the timeout per probe. Maximum 1,800,000ms (30 minutes).',
    enabled: 'Enable and include in routing',
    delete: 'Delete relay',
    deleteConfirm:
      'Permanently delete relay "{name}"? Bound models will be unbound first.',
  },
  protocol: {
    priority: 'Protocol priority',
    pathOverride: 'Path override',
    pathOverrideHelpLabel: 'View path override help',
    pathOverrideHelp:
      'Only fill this in when the upstream does not use the default path. It is a relative path appended to the API base URL and must start with /. For example, with base URL https://example.com/v1, entering /anthropic/messages sends requests to https://example.com/v1/anthropic/messages.',
    pathOverridePlaceholder: 'Use default path',
    testModel: 'Sample test model',
    testModelPlaceholder: 'Select a mounted model that matches this protocol',
    noEligibleModels:
      'None of the mounted models can be used with this protocol. Under auto mixing, unknown aliases need a model × protocol mapping in Routing & Pricing.',
    legendPassed: 'Green: passed',
    legendFailed: 'Red: failed',
    legendUntested: 'Default: not tested in this run',
    sampleVerified: '✓ Current model passed sampling',
    sampleTest: 'Sample test current model',
    sampleIncludesImage: ' (with image)',
    sampleIncludesPdf: ' (with PDF)',
    sampleIncludesBoth: ' (with image and PDF)',
    imageHint:
      'The test generates a tiny PNG containing a random check code: the OpenAI protocols use a Base64 data URL, while Anthropic uses a native Base64 source. It only passes if the model reads the code back correctly.',
    pdfHint:
      'The test sends a built-in tiny PDF and only passes if the model returns the random check code inside it.',
    verified: '✓ Last sampling passed',
    failed: '✗ Last sampling failed',
    notSampled: '• Not sampled',
  },
  toast: {
    healthDone: 'Health check finished: {up}/{total} available',
    testOk: 'Connection OK · {latency}ms',
    testFailed: 'Connection test failed',
    created: 'Relay created',
    updated: 'Relay updated',
    deleted: 'Relay and its model bindings deleted',
    protocolVerified: '{protocol} verified · {latency}ms',
  },
  error: {
    protocolMissing: 'Protocol configuration not found',
    protocolTestFailed: 'Protocol test task failed',
    protocolTestNoResult: 'Protocol test task returned no result',
    protocolTestCancelled: 'Protocol test polling cancelled',
    actionFailed: 'Operation failed',
  },
}
