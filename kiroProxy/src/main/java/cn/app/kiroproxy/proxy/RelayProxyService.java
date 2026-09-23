package cn.app.kiroproxy.proxy;

import cn.app.kiroproxy.auth.AccessPrincipal;
import cn.app.kiroproxy.billing.UsageBillingService;
import cn.app.kiroproxy.config.RelayConfiguration;
import cn.app.kiroproxy.config.RelayConfigurationRepository;
import cn.app.kiroproxy.config.ConversationAffinityService;
import cn.app.kiroproxy.config.RelayModel;
import cn.app.kiroproxy.config.RelayEndpoint;
import cn.app.kiroproxy.config.RelaySelector;
import cn.app.kiroproxy.i18n.RelayLanguage;
import cn.app.kiroproxy.protocol.CanonicalStreamEvent;
import cn.app.kiroproxy.protocol.ProtocolAdapter;
import cn.app.kiroproxy.protocol.ProtocolAdapters;
import cn.app.kiroproxy.protocol.ProtocolCapability;
import cn.app.kiroproxy.protocol.ProtocolCode;
import cn.app.kiroproxy.protocol.RequestCapabilityInspector;
import cn.app.kiroproxy.protocol.RelayProtocol;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.beans.factory.DisposableBean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

@Service
public class RelayProxyService implements DisposableBean {
    private static final Logger log = LoggerFactory.getLogger(RelayProxyService.class);
    private final RelayConfigurationRepository repository;
    private final ObjectMapper mapper;
    private final ConcurrentHashMap<Integer, HttpClient> clients = new ConcurrentHashMap<>();
    private final int defaultConnectTimeoutMs;
    private final Duration requestTimeout;
    private final UsageBillingService billing;
    private final RelaySelector selector;
    private final ConversationAffinityService affinity;
    private final Duration affinityQueueWait;
    private final ScheduledThreadPoolExecutor deadlines = new ScheduledThreadPoolExecutor(1, task -> {
        Thread thread = new Thread(task, "relay-deadline");
        thread.setDaemon(true);
        return thread;
    });

    @Autowired
    public RelayProxyService(RelayConfigurationRepository repository, ObjectMapper mapper,
                             @Value("${kiro.relay.connect-timeout:15s}") Duration connectTimeout,
                             @Value("${kiro.relay.request-timeout:10m}") Duration requestTimeout,
                             @Value("${kiro.relay.affinity.queue-wait:10s}") Duration affinityQueueWait,
                             UsageBillingService billing, RelaySelector selector,
                             ConversationAffinityService affinity) {
        this.repository = repository;
        this.mapper = mapper;
        this.requestTimeout = requestTimeout;
        this.defaultConnectTimeoutMs = Math.toIntExact(connectTimeout.toMillis());
        this.billing = billing;
        this.selector = selector;
        this.affinity = affinity;
        this.affinityQueueWait = affinityQueueWait;
        deadlines.setRemoveOnCancelPolicy(true);
        // The configured relay terminates HTTP/2 chat streams with GOAWAY.
        // Pin the upstream connector to HTTP/1.1, which is also the protocol
        // used successfully by its OpenAI-compatible SSE endpoint.
    }

    public RelayProxyService(RelayConfigurationRepository repository, ObjectMapper mapper,
                             Duration connectTimeout, Duration requestTimeout) {
        this(repository, mapper, connectTimeout, requestTimeout, null, null, null, Duration.ZERO);
    }

    public RelayProxyService(RelayConfigurationRepository repository, ObjectMapper mapper,
                             Duration connectTimeout, Duration requestTimeout,
                             UsageBillingService billing, RelaySelector selector) {
        this(repository, mapper, connectTimeout, requestTimeout, billing, selector, null, Duration.ZERO);
    }

    RelayProxyService(RelayConfigurationRepository repository, ObjectMapper mapper,
                      Duration connectTimeout, Duration requestTimeout,
                      UsageBillingService billing, RelaySelector selector,
                      ConversationAffinityService affinity, Duration affinityQueueWait) {
        this.repository = repository;
        this.mapper = mapper;
        this.requestTimeout = requestTimeout;
        this.defaultConnectTimeoutMs = Math.toIntExact(connectTimeout.toMillis());
        this.billing = billing;
        this.selector = selector;
        this.affinity = affinity;
        this.affinityQueueWait = affinityQueueWait;
        deadlines.setRemoveOnCancelPolicy(true);
    }

    public RelayConfiguration configuration() {
        return repository.get();
    }

    public long availableRelayCount() {
        return selector == null ? 0 : selector.snapshot().stream()
                .filter(endpoint -> endpoint.enabled() && endpoint.healthStatus() == RelayEndpoint.HealthStatus.UP)
                .count();
    }

    public void streamChat(JsonNode body, RelayConfiguration config, OutputStream output) throws IOException {
        streamChat(body, config, output, UUID.randomUUID().toString().substring(0, 8));
    }

    public void streamChat(JsonNode body, RelayConfiguration config, OutputStream output, String requestId) throws IOException {
        streamChat(body, config, output, requestId, null);
    }

    public void streamChat(JsonNode body, RelayConfiguration config, OutputStream output, String requestId,
                           AccessPrincipal principal) throws IOException {
        streamChat(body, config, output, requestId, principal, RelayLanguage.ZH);
    }

    public void streamChat(JsonNode body, RelayConfiguration config, OutputStream output, String requestId,
                           AccessPrincipal principal, String language) throws IOException {
        String lang = RelayLanguage.normalize(language);
        RelayModel model = selectModel(body, config);
        String conversationId = body.path("conversationState").path("conversationId").asText("");
        String requestedModel = requestedModelText(body, model);
        ConversationAffinityService.Binding affinityBinding = principal == null || affinity == null
                ? null : affinity.find(principal.tokenId(), conversationId, model.modelId()).orElse(null);
        long startedAt = System.nanoTime();
        StreamState state = new StreamState(startedAt, requestId, requestedModel, model.modelId());

        try {
            // Establish the downstream stream immediately. Waiting for the upstream
            // response headers or the accounting insert here made a healthy
            // request look frozen in Kiro.
            output.write(KiroProtocol.event(mapper, "initial-response", Map.of("conversationId", conversationId)));
            output.flush();
            ObjectNode upstreamBody = KiroProtocol.translateRequest(mapper, body, model.modelId());
            Set<ProtocolCapability> requiredCapabilities = RequestCapabilityInspector.inspect(upstreamBody);
            long estimatedInputTokens = Math.max(1, mapper.writeValueAsBytes(upstreamBody.path("messages")).length / 3L);
            long maximumOutputTokens = Math.max(0, upstreamBody.path("max_tokens").asLong(4096));
            long imageParts = 0;
            for (JsonNode message : upstreamBody.path("messages")) for (JsonNode part : message.path("content")) {
                if ("image_url".equals(part.path("type").asText())) imageParts++;
            }
            long upstreamHeadersMs = streamWithFailover(config, model, upstreamBody, state, output, startedAt,
                    requestId, upstreamBody.path("messages").size(), upstreamBody.path("tools").size(),
                    KiroProtocol.imageCount(body), imageParts, principal, estimatedInputTokens, maximumOutputTokens,
                    requiredCapabilities, lang, conversationId, affinityBinding);

            validateCompletedTools(state, lang);
            for (ToolState tool : state.tools.values()) if (tool.started) {
                output.write(KiroProtocol.event(mapper, "toolUseEvent",
                        Map.of("name", tool.name, "stop", true, "toolUseId", tool.id)));
            }
            long inputTokens = state.usage.path("prompt_tokens").asLong(0);
            long outputTokens = state.usage.path("completion_tokens").asLong(0);
            long cachedTokens = state.usage.path("prompt_tokens_details").path("cached_tokens").asLong(0);
            ObjectNode metadata = mapper.createObjectNode();
            metadata.putObject("tokenUsage")
                    .put("uncachedInputTokens", Math.max(0, inputTokens - cachedTokens))
                    .put("outputTokens", outputTokens)
                    .put("cacheReadInputTokens", cachedTokens)
                    .put("cacheWriteInputTokens", 0);
            metadata.put("stopReason", stopReason(state.finishReason, !state.tools.isEmpty()));
            output.write(KiroProtocol.event(mapper, "metadataEvent", metadata));
            output.write(KiroProtocol.event(mapper, "messageMetadataEvent", Map.of("conversationId", conversationId)));
            output.flush();
            // Finish accounting after the terminal frames are already visible
            // to Kiro so a database round trip does not add UI latency.
            long totalMs = elapsedMillis(startedAt);
            completeBilling(state.charge, state.usage, state.configurationId, state.reportedModelId,
                    new UsageBillingService.RequestMetrics(upstreamHeadersMs, state.firstOutputMillis(), totalMs,
                            state.relayName));
            log.debug("relay completed request={} requested_model={} platform_model={} sent_model={} reported_model={} "
                            + "reported_source={} relay_id={} relay={} upstream_headers_ms={} first_output_ms={} total_ms={} end={}",
                    requestId, requestedModel, model.modelId(), state.sentModelId,
                    state.reportedModelId == null ? "UNKNOWN" : state.reportedModelId,
                    state.reportedModelId == null ? "UNKNOWN" : "RESPONSE", state.configurationId, state.relayName,
                    upstreamHeadersMs, state.firstOutputMillis(), totalMs,
                    state.done ? "done" : "eof_after_finish");
        } catch (UsageBillingService.BillingRejectedException error) {
            failBilling(state.charge, error.code());
            log.info("relay billing_rejected request={} model={} code={}", requestId, model.displayName(), error.code());
            writeNoticeEvents(conversationId, model.displayName(), output,
                    error.getMessage() + RelayLanguage.requestId(lang, requestId));
        } catch (RelaySelector.ProtocolCapabilityUnavailableException error) {
            failBilling(state.charge, "PROTOCOL_CAPABILITY_UNAVAILABLE");
            log.info("relay capability_unavailable request={} model={} required={}", requestId,
                    model.displayName(), error.required());
            writeNoticeEvents(conversationId, model.displayName(), output,
                    error.getMessage() + RelayLanguage.requestId(lang, requestId));
        } catch (RelaySelector.NoRelayAvailableException error) {
            failBilling(state.charge, "NO_RELAY_AVAILABLE");
            log.warn("relay unavailable request={} model={} reason=no_candidate", requestId, model.displayName());
            writeNoticeEvents(conversationId, model.displayName(), output,
                    RelayLanguage.text(lang,
                            error.getMessage(), error.getMessage())
                            + RelayLanguage.requestId(lang, requestId));
        } catch (UpstreamFailure error) {
            failBilling(state.charge, error.code);
            log.warn("relay upstream_error request={} model={} elapsed_ms={} http_status={} code={}",
                    requestId, model.displayName(), elapsedMillis(startedAt), error.httpStatus, error.code);
            String text = error.getMessage() + RelayLanguage.requestId(lang, requestId);
            if (state.firstOutputNanos != 0) {
                // Do not mark partially emitted tool calls as a successful turn.
                writeException(output, text);
            } else {
                // Initial response has already been sent; terminate with one
                // readable assistant message and metadata instead of an exception.
                writeNoticeEvents(conversationId, model.displayName(), output, text);
            }
        } catch (KiroProtocol.InvalidImageException error) {
            failBilling(state.charge, "INVALID_IMAGE");
            log.warn("relay invalid_image request={}", requestId);
            writeException(output, RelayLanguage.text(lang, error.getMessage(),
                    "The image payload is invalid or unsupported."));
        } catch (KiroProtocol.InvalidDocumentException error) {
            failBilling(state.charge, error.code());
            log.warn("relay invalid_document request={} code={} reason={}", requestId, error.code(), error.reason());
            writeException(output, RelayLanguage.text(lang, error.getMessage(),
                    "Attachment processing failed. The current version accepts Base64 PDF documents only."));
        } catch (InterruptedException error) {
            failBilling(state.charge, "INTERRUPTED");
            Thread.currentThread().interrupt();
            writeException(output, RelayLanguage.text(lang, "请求已中断", "The request was interrupted."));
        } catch (Exception error) {
            failBilling(state.charge, error.getClass().getSimpleName());
            log.warn("relay failed request={} model={} elapsed_ms={} reason={}", requestId,
                    model.displayName(), elapsedMillis(startedAt), error.getClass().getSimpleName());
            writeException(output, RelayLanguage.text(lang,
                    "请求未正常完成，请凭请求号 " + requestId + " 联系管理员排查。",
                    "The request did not complete successfully. Contact the administrator with request ID " + requestId + "."));
        }
    }

    private long streamWithFailover(RelayConfiguration config, RelayModel model, ObjectNode upstreamBody,
                                    StreamState state, OutputStream output, long startedAt, String requestId,
                                    int messageCount, int toolCount, long receivedImages, long upstreamImages,
                                    AccessPrincipal principal, long estimatedInputTokens, long maximumOutputTokens,
                                    Set<ProtocolCapability> requiredCapabilities,
                                    String language, String conversationId,
                                    ConversationAffinityService.Binding affinityBinding)
            throws IOException, InterruptedException {
        Set<RelaySelector.RouteKey> attempted = new HashSet<>();
        Exception lastFailure = null;
        while (true) {
            RelaySelector.Lease lease = null;
            RelayEndpoint endpoint;
            if (selector == null) {
                if (!attempted.isEmpty()) {
                    if (lastFailure instanceof IOException io) throw io;
                    throw new IOException("对外请求失败", lastFailure);
                }
                endpoint = legacyEndpoint(config, model.modelId());
                state.protocol = endpoint.protocolsFor(model.modelId(), requiredCapabilities).get(0);
            } else {
                try {
                    lease = selector.selectRoute(model.modelId(), requiredCapabilities, attempted,
                            affinityBinding == null ? null : affinityBinding.relayId(),
                            affinityBinding == null ? Duration.ZERO : affinityQueueWait);
                    endpoint = lease.endpoint();
                    state.protocol = lease.protocol();
                } catch (RelaySelector.ProtocolCapabilityUnavailableException error) {
                    if (affinity != null) affinity.invalidate(affinityBinding);
                    throw error;
                } catch (RelaySelector.NoRelayAvailableException error) {
                    boolean preferredFailed = affinityBinding != null && attempted.stream()
                            .anyMatch(route -> route.endpointId() == affinityBinding.relayId());
                    boolean preferredInvalid = affinityBinding != null
                            && !selector.supportsRoute(affinityBinding.relayId(), model.modelId(), requiredCapabilities);
                    if (affinity != null && (preferredFailed || preferredInvalid)) affinity.invalidate(affinityBinding);
                    if (lastFailure instanceof UpstreamFailure upstream) throw upstream;
                    if (lastFailure instanceof IOException io) throw io;
                    if (lastFailure instanceof UsageBillingService.BillingRejectedException billingError) {
                        throw billingError;
                    }
                    throw error;
                }
            }
            attempted.add(new RelaySelector.RouteKey(endpoint.id(), state.protocol.code()));
            try {
                ObjectNode canonicalBody = upstreamBody.deepCopy();
                String sentModelId = endpoint.upstreamModelId(model.modelId());
                canonicalBody.put("model", sentModelId);
                try {
                    if (state.charge == null) {
                        state.charge = beginBilling(requestId, principal, model.modelId(), endpoint.id(),
                                state.requestedModelId, sentModelId, estimatedInputTokens, maximumOutputTokens, language);
                    } else if (!java.util.Objects.equals(state.configurationId, endpoint.id())) {
                        state.charge = switchBillingRoute(state.charge, endpoint.id(), sentModelId,
                                estimatedInputTokens, language);
                    }
                } catch (UsageBillingService.BillingRejectedException error) {
                    if (!"MODEL_PRICE_NOT_CONFIGURED".equals(error.code())) throw error;
                    lastFailure = error;
                    log.warn("relay route_unpriced request={} requested_model={} platform_model={} sent_model={} relay_id={} relay={}",
                            requestId, state.requestedModelId, model.modelId(), sentModelId, endpoint.id(), endpoint.name());
                    continue;
                }
                recordBillingProtocol(state.charge, state.protocol.code(), language);
                state.configurationId = endpoint.id();
                state.relayName = endpoint.name();
                state.sentModelId = sentModelId;
                ProtocolAdapter adapter = ProtocolAdapters.get(state.protocol.code());
                byte[] requestBytes;
                try {
                    requestBytes = mapper.writeValueAsBytes(adapter.encode(mapper, canonicalBody));
                } catch (IllegalArgumentException error) {
                    throw new IOException("协议请求转换失败：" + state.protocol.code(), error);
                }
                log.debug("relay upstream_start request={} requested_model={} platform_model={} sent_model={} relay_id={} relay={} "
                                + "protocol={} elapsed_ms={} bytes={} messages={} tools={} received_images={} upstream_images={}",
                        requestId, state.requestedModelId, model.modelId(), sentModelId, endpoint.id(), endpoint.name(),
                        state.protocol.code(), elapsedMillis(startedAt), requestBytes.length, messageCount, toolCount,
                        receivedImages, upstreamImages);
                long headersMs = streamFromEndpoint(endpoint, model, state.protocol, adapter, requestBytes, state,
                        output, startedAt, requestId, language);
                if (selector != null) selector.recordSuccess(endpoint);
                if (principal != null && affinity != null) {
                    affinity.recordSuccess(principal.tokenId(), conversationId, model.modelId(),
                            affinityBinding, endpoint.id());
                }
                return headersMs;
            } catch (IOException error) {
                boolean routeConfigurationError = error instanceof UpstreamFailure upstream
                        && ("MODEL_NOT_FOUND".equals(upstream.code) || "MODEL_UNAVAILABLE".equals(upstream.code)
                        || "UPSTREAM_NOT_FOUND".equals(upstream.code));
                // A bad model alias is a relationship-level configuration error. It must not
                // degrade the health of an otherwise usable relay for all its other models.
                boolean hasProtocolAlternative = endpoint.protocolsFor(model.modelId(), requiredCapabilities).stream()
                        .anyMatch(protocol -> !attempted.contains(
                                new RelaySelector.RouteKey(endpoint.id(), protocol.code())));
                if (selector != null && !routeConfigurationError && !hasProtocolAlternative) {
                    selector.recordFailure(endpoint);
                }
                if (state.firstOutputNanos != 0 || selector == null) {
                    if (affinity != null && affinityBinding != null
                            && affinityBinding.relayId() == endpoint.id()) affinity.invalidate(affinityBinding);
                    throw error;
                }
                lastFailure = routeConfigurationError
                        ? new UpstreamFailure(((UpstreamFailure) error).httpStatus,
                                ((UpstreamFailure) error).code,
                                RelayLanguage.text(language,
                                        "当前服务节点「" + endpoint.name() + "」不支持配置的模型「"
                                                + endpoint.upstreamModelId(model.modelId()) + "」，请联系管理员。",
                                        "Service node '" + endpoint.name() + "' does not support configured model '"
                                                + endpoint.upstreamModelId(model.modelId()) + "'. Please contact the administrator."))
                        : error;
                log.warn("relay failover request={} failed_relay_id={} failed_protocol={} attempt={} "
                                + "protocol_alternative={} reason={}", requestId, endpoint.id(), state.protocol.code(),
                        attempted.size(), hasProtocolAlternative, error.getClass().getSimpleName());
            } finally {
                if (lease != null) lease.close();
            }
        }
    }

    private long streamFromEndpoint(RelayEndpoint endpoint, RelayModel model, RelayProtocol protocol,
                                    ProtocolAdapter adapter, byte[] requestBytes,
                                    StreamState state, OutputStream output, long startedAt, String requestId,
                                    String language)
            throws IOException, InterruptedException {
        long attemptStartedAt = System.nanoTime();
        Duration timeout = Duration.ofMillis(endpoint.readTimeoutMs());
        // HttpRequest.timeout is a total-response deadline. It is unsuitable for
        // long-lived SSE because an otherwise healthy stream gets killed after
        // exactly readTimeoutMs. Header waiting and stream idleness are bounded
        // separately below instead.
        HttpRequest.Builder requestBuilder = HttpRequest.newBuilder(URI.create(endpoint.baseUrl() + protocol.path()));
        adapter.headers(endpoint.apiKey()).forEach(requestBuilder::header);
        HttpRequest request = requestBuilder.POST(HttpRequest.BodyPublishers.ofByteArray(requestBytes)).build();
        HttpResponse<InputStream> response = awaitUpstreamHeaders(client(endpoint.connectTimeoutMs()), request,
                model.displayName(), output, timeout, language);
        long upstreamHeadersMs = elapsedMillis(startedAt);
        log.debug("relay upstream_headers request={} relay_id={} elapsed_ms={} status={}", requestId,
                endpoint.id(), upstreamHeadersMs, response.statusCode());
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw classifyUpstreamFailure(response.statusCode(), readErrorBody(response, attemptStartedAt, timeout), language);
        }
        if (!response.headers().firstValue("content-type").orElse("")
                .toLowerCase(java.util.Locale.ROOT).startsWith("text/event-stream")) {
            JsonNode errorBody = readErrorBody(response, attemptStartedAt, timeout);
            if (errorBody.hasNonNull("error")) throw classifyUpstreamFailure(response.statusCode(), errorBody, language);
            throw new IOException(RelayLanguage.text(language, "服务节点未返回 SSE 流。",
                    "The service node did not return an SSE stream."));
        }
        InputStream upstreamStream = response.body();
        try (StreamIdleDeadline idleDeadline = new StreamIdleDeadline(upstreamStream, timeout);
             BufferedReader reader = new BufferedReader(new InputStreamReader(upstreamStream, StandardCharsets.UTF_8))) {
            String line;
            StringBuilder data = new StringBuilder();
            String eventName = "";
            try {
                while ((line = reader.readLine()) != null) {
                    idleDeadline.touch();
                    if (line.isEmpty()) {
                        processSse(adapter, eventName, data.toString(), model.displayName(), state, output, language);
                        data.setLength(0);
                        eventName = "";
                        if (state.done) break;
                    } else if (line.startsWith("event:")) {
                        eventName = line.substring(6).stripLeading();
                    } else if (line.startsWith("data:")) {
                        if (!data.isEmpty()) data.append('\n');
                        data.append(line.substring(5).stripLeading());
                    }
                }
            } catch (IOException error) {
                if (idleDeadline.timedOut()) throw idleTimeout(language);
                throw error;
            }
            if (idleDeadline.timedOut()) throw idleTimeout(language);
            if (!state.done) processSse(adapter, eventName, data.toString(), model.displayName(), state, output, language);
            if (!state.done && state.finishReason == null) throw new IOException(RelayLanguage.text(language,
                    "流意外中断，未收到结束标记。",
                    "The stream ended unexpectedly without a completion marker."));
        }
        return upstreamHeadersMs;
    }

    private static UpstreamFailure idleTimeout(String language) {
        return new UpstreamFailure(504, "UPSTREAM_IDLE_TIMEOUT", RelayLanguage.text(language,
                "服务节点的流式响应长时间无数据，本次请求已停止。",
                "The service node stream was idle for too long and the request was stopped."));
    }

    private void validateCompletedTools(StreamState state, String language) throws UpstreamFailure {
        if (state.tools.isEmpty()) return;
        if (isOutputLimit(state.finishReason)) {
            throw new UpstreamFailure(200, "TOOL_CALL_TRUNCATED", RelayLanguage.text(language,
                    "写文件工具的参数达到了模型输出上限，本次未执行不完整的写入；请继续生成或改为分段写入。",
                    "The file-writing tool arguments reached the model output limit. The incomplete write was not executed; continue or write the document in smaller sections."));
        }
        for (ToolState tool : state.tools.values()) {
            if (!tool.started) {
                throw new UpstreamFailure(200, "INVALID_TOOL_ARGUMENTS", RelayLanguage.text(language,
                        "服务节点返回的工具调用不完整，本次未执行写入。",
                        "The service node returned an incomplete tool call. The write was not executed."));
            }
            // Argument-free tools are valid and are represented by an empty
            // stream by some Anthropic-compatible providers.
            if (tool.input.isEmpty()) continue;
            try {
                JsonNode input = mapper.readTree(tool.input.toString());
                if (input == null || !input.isObject()) throw new IOException("tool input is not an object");
            } catch (IOException error) {
                throw new UpstreamFailure(200, "INVALID_TOOL_ARGUMENTS", RelayLanguage.text(language,
                        "服务节点返回的工具参数不完整，本次未执行写入；请重试或改为分段写入。",
                        "The service node returned incomplete tool arguments. The write was not executed; retry or write the document in smaller sections."));
            }
        }
    }

    private RelayEndpoint legacyEndpoint(RelayConfiguration config, String modelId) {
        return new RelayEndpoint(0, "legacy", "openai-compatible", config.baseUrl(), config.apiKey(), true,
                100, 100, RelayEndpoint.HealthStatus.UP, 0, 3, defaultConnectTimeoutMs,
                Math.toIntExact(requestTimeout.toMillis()), 0, 1, null, null, Set.of(modelId));
    }

    private HttpClient client(int connectTimeoutMs) {
        return clients.computeIfAbsent(connectTimeoutMs, timeout -> HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofMillis(timeout)).build());
    }

    private void failBilling(UsageBillingService.Charge charge, String code) {
        if (billing == null || charge == null) return;
        try { billing.fail(charge, code); }
        catch (RuntimeException error) {
            log.error("billing failure could not be recorded request={} reason={}", charge.requestId(), error.getClass().getSimpleName());
        }
    }

    private UsageBillingService.Charge beginBilling(String requestId, AccessPrincipal principal, String modelId,
                                                     Long configurationId, String requestedModelId,
                                                     String upstreamModelId, long estimatedInputTokens,
                                                     long maximumOutputTokens, String language) {
        if (billing == null || principal == null) return null;
        try { return billing.begin(requestId, principal, modelId, configurationId, requestedModelId,
                upstreamModelId, estimatedInputTokens, maximumOutputTokens, language); }
        catch (UsageBillingService.BillingRejectedException error) { throw error; }
        catch (RuntimeException error) {
            log.error("billing start could not be recorded request={} reason={}", requestId,
                    error.getClass().getSimpleName());
            // Financial authorization must be fail-closed: never send a paid
            // upstream request when its freeze/usage record was not committed.
            throw new UsageBillingService.BillingRejectedException("BILLING_UNAVAILABLE",
                    RelayLanguage.text(language, "计费服务暂时不可用，本次请求未发送，请稍后重试。",
                            "Billing is temporarily unavailable. The request was not sent. Please try again later."));
        }
    }

    private UsageBillingService.Charge switchBillingRoute(UsageBillingService.Charge charge, Long configurationId,
                                                           String upstreamModelId, long estimatedInputTokens,
                                                           String language) {
        if (billing == null || charge == null) return charge;
        try { return billing.switchRoute(charge, configurationId, upstreamModelId, estimatedInputTokens, language); }
        catch (UsageBillingService.BillingRejectedException error) { throw error; }
        catch (RuntimeException error) {
            log.error("billing route switch could not be recorded request={} reason={}", charge.requestId(),
                    error.getClass().getSimpleName());
            throw new UsageBillingService.BillingRejectedException("BILLING_UNAVAILABLE",
                    RelayLanguage.text(language, "计费服务暂时不可用，本次请求未发送，请稍后重试。",
                            "Billing is temporarily unavailable. The request was not sent. Please try again later."));
        }
    }

    private void recordBillingProtocol(UsageBillingService.Charge charge, ProtocolCode protocol, String language) {
        if (billing == null || charge == null) return;
        try { billing.selectProtocol(charge, protocol); }
        catch (RuntimeException error) {
            log.error("billing protocol could not be recorded request={} protocol={} reason={}",
                    charge.requestId(), protocol, error.getClass().getSimpleName());
            throw new UsageBillingService.BillingRejectedException("BILLING_UNAVAILABLE",
                    RelayLanguage.text(language, "计费服务暂时不可用，本次请求未发送，请稍后重试。",
                            "Billing is temporarily unavailable. The request was not sent. Please try again later."));
        }
    }

    private void completeBilling(UsageBillingService.Charge charge, JsonNode usage, Long configurationId,
                                 String reportedModelId, UsageBillingService.RequestMetrics metrics) {
        if (billing == null || charge == null) return;
        try { billing.complete(charge, usage, configurationId, reportedModelId, metrics); }
        catch (RuntimeException error) {
            log.error("billing completion could not be recorded request={} reason={}", charge.requestId(),
                    error.getClass().getSimpleName());
        }
    }

    public void writeException(OutputStream output, String message) throws IOException {
        output.write(KiroProtocol.exception(mapper, "internalServerException", message));
        output.flush();
    }

    private JsonNode readErrorBody(HttpResponse<InputStream> response, long startedAt, Duration timeout) {
        // Error bodies are small; cap bytes and wait time even when the relay
        // keeps the HTTP response open. Never log or forward the original body.
        InputStream input = response.body();
        long remaining = Math.max(0, timeout.toNanos() - (System.nanoTime() - startedAt));
        var deadline = deadlines.schedule(() -> {
            try { input.close(); } catch (IOException ignored) { }
        }, Math.min(TimeUnit.SECONDS.toNanos(2), remaining), TimeUnit.NANOSECONDS);
        try (input) {
            byte[] bytes = input.readNBytes(64 * 1024);
            try {
                JsonNode parsed = mapper.readTree(bytes);
                return parsed == null ? mapper.createObjectNode() : parsed;
            } catch (IOException ignored) {
                return mapper.createObjectNode();
            }
        } catch (IOException ignored) {
            return mapper.createObjectNode();
        } finally {
            deadline.cancel(false);
        }
    }

    private static UpstreamFailure classifyUpstreamFailure(int status, JsonNode body, String language) {
        JsonNode detail = body.hasNonNull("error") ? body.path("error") : body;
        String code = detail.path("code").asText(detail.path("type").asText(""))
                .toLowerCase(java.util.Locale.ROOT).replace('-', '_');
        String message = (detail.isTextual() ? detail.asText() : detail.path("message").asText(""))
                .toLowerCase(java.util.Locale.ROOT);
        boolean missingModel = java.util.Set.of("model_not_found", "unknown_model", "invalid_model", "model_not_exist").contains(code)
                || (message.contains("model") && (message.contains("does not exist") || message.contains("not found")
                || message.contains("unknown model") || message.contains("invalid model")))
                || (message.contains("模型") && (message.contains("不存在") || message.contains("未找到") || message.contains("无此")));
        if (missingModel) return new UpstreamFailure(status, "MODEL_NOT_FOUND",
                RelayLanguage.text(language, "当前所选模型不存在或未开放访问，请切换其他模型，或联系管理员检查模型配置。",
                        "The selected model does not exist or is not available. Select another model or contact the administrator."));
        boolean unavailable = java.util.Set.of("model_not_available", "model_unavailable", "unsupported_model").contains(code)
                || (message.contains("model") && (message.contains("not available") || message.contains("unavailable") || message.contains("not supported")))
                || message.contains("无可用渠道") || message.contains("没有可用渠道");
        if (unavailable) return new UpstreamFailure(status, "MODEL_UNAVAILABLE",
                RelayLanguage.text(language, "当前所选模型暂不可用，请切换其他模型或稍后重试。",
                        "The selected model is temporarily unavailable. Select another model or try again later."));
        if (status == 401 || status == 403) return new UpstreamFailure(status, "UPSTREAM_AUTH_FAILED",
                RelayLanguage.text(language, "认证失败或没有访问权限，请联系管理员检查凭据及模型权限。",
                        "Authentication failed or access was denied. Please contact the administrator."));
        if (status == 429) return new UpstreamFailure(status, "UPSTREAM_RATE_LIMITED",
                RelayLanguage.text(language, "请求受限，请稍后重试或联系管理员检查配额。",
                        "The request was rate limited. Please try again later or contact the administrator."));
        if (status == 404) return new UpstreamFailure(status, "UPSTREAM_NOT_FOUND",
                RelayLanguage.text(language, "接口或请求资源不存在，请联系管理员检查接口地址和模型配置。",
                        "The requested endpoint or resource was not found. Please contact the administrator."));
        return new UpstreamFailure(status, "UPSTREAM_REJECTED",
                RelayLanguage.text(language, "未能处理本次请求，请稍后重试或联系管理员检查配置。",
                        "The request could not be processed. Please try again later or contact the administrator."));
    }

    private static final class UpstreamFailure extends IOException {
        private final int httpStatus;
        private final String code;
        private UpstreamFailure(int httpStatus, String code, String message) {
            super(message);
            this.httpStatus = httpStatus;
            this.code = code;
        }
    }

    private HttpResponse<java.io.InputStream> awaitUpstreamHeaders(HttpClient client, HttpRequest request, String displayName,
            OutputStream output, Duration timeout, String language) throws IOException, InterruptedException {
        CompletableFuture<HttpResponse<java.io.InputStream>> pending = client.sendAsync(
                request, HttpResponse.BodyHandlers.ofInputStream());
        long deadlineNanos = System.nanoTime() + timeout.toNanos();
        try {
            while (true) {
                try {
                    long remainingNanos = deadlineNanos - System.nanoTime();
                    if (remainingNanos <= 0) throw new TimeoutException();
                    return pending.get(Math.min(TimeUnit.SECONDS.toNanos(5), remainingNanos), TimeUnit.NANOSECONDS);
                } catch (TimeoutException ignored) {
                    if (System.nanoTime() >= deadlineNanos) {
                        pending.cancel(true);
                        throw new UpstreamFailure(504, "UPSTREAM_HEADER_TIMEOUT", RelayLanguage.text(language,
                                "等待服务节点响应超时。", "Timed out waiting for the service node to respond."));
                    }
                    // A small valid EventStream frame both keeps intermediaries from
                    // buffering an idle response and detects a disconnected Kiro
                    // client, allowing the pending upstream request to be cancelled.
                    output.write(KiroProtocol.event(mapper, "assistantResponseEvent",
                            Map.of("content", "", "modelId", displayName)));
                    output.flush();
                } catch (ExecutionException error) {
                    Throwable cause = error.getCause();
                    if (cause instanceof IOException io) throw io;
                    throw new IOException(cause == null ? error.getMessage() : cause.getMessage(), cause);
                }
            }
        } catch (IOException | InterruptedException error) {
            pending.cancel(true);
            throw error;
        }
    }

    public boolean isLocallyHandledPrompt(JsonNode body) {
        if (KiroProtocol.imageCount(body) > 0) return false;
        String prompt = currentPrompt(body).trim();
        if (prompt.isEmpty() || prompt.length() > 100) return false;
        String normalized = prompt.toLowerCase().replaceAll("[\\s，。！？,.!?~`‘’“”\"']", "");
        if (normalized.matches("^(hi|hello|hey|你好|您好|哈喽|嗨|在吗|早上好|下午好|晚上好)$")) return true;
        return normalized.matches(".*(你是谁|你是什么|什么模型|哪个模型|模型名称|模型版本|whoareyou|whatmodelareyou|whichmodel|modelname|modelversion).*"
                ) && !normalized.matches(".*(项目|代码|结构|文件|分析|修改|错误|bug|code|project|repository|repo).*" );
    }

    public void writeLocalPromptResponse(JsonNode body, RelayConfiguration config, OutputStream output) throws IOException {
        writeLocalPromptResponse(body, config, output, RelayLanguage.ZH);
    }

    public void writeLocalPromptResponse(JsonNode body, RelayConfiguration config, OutputStream output,
                                         String language) throws IOException {
        RelayModel model = selectModel(body, config);
        String text = isModelIdentityPrompt(body)
                ? RelayLanguage.text(language, "我是 " + model.displayName() + " 模型。",
                        "I am the " + model.displayName() + " model.")
                : RelayLanguage.text(language,
                        "你好，我是 Kiro RelayRouter 编程助手。可以帮你分析项目结构、修改代码和排查问题。",
                        "Hello, I am the Kiro RelayRouter coding assistant. I can help analyze projects, modify code, and troubleshoot issues.");
        writeNoticeResponse(body, config, output, text);
    }

    public void writeTokenExpiredResponse(JsonNode body, RelayConfiguration config, OutputStream output) throws IOException {
        writeTokenExpiredResponse(body, config, output, RelayLanguage.ZH);
    }

    public void writeTokenExpiredResponse(JsonNode body, RelayConfiguration config, OutputStream output,
                                          String language) throws IOException {
        writeNoticeResponse(body, config, output,
                RelayLanguage.text(language,
                        "当前访问 Token 已过期，本次请求已被拦截。请联系管理员续期，或在 RelayRouter 控制面板中更换 Token 后重试。",
                        "The current access Token has expired and this request was blocked. Contact the administrator to renew it, or replace the Token in the RelayRouter control panel and try again."));
    }

    public void writeModelAccessChangedResponse(JsonNode body, RelayConfiguration config, OutputStream output,
                                                String requestedModel) throws IOException {
        writeModelAccessChangedResponse(body, config, output, requestedModel, RelayLanguage.ZH);
    }

    public void writeModelAccessChangedResponse(JsonNode body, RelayConfiguration config, OutputStream output,
                                                String requestedModel, String language) throws IOException {
        String conversationId = body.path("conversationState").path("conversationId").asText("");
        RelayModel fallback = config.defaultModel();
        String displayName = fallback == null ? "Kiro RelayRouter" : fallback.displayName();
        String removed = requestedModel == null || requestedModel.isBlank()
                ? RelayLanguage.text(language, "当前选择", "The selected ")
                : RelayLanguage.text(language, "“" + requestedModel + "”", "'" + requestedModel + "' ");
        String text = fallback == null
                ? RelayLanguage.text(language,
                        removed + "模型已不在当前 Token 的可用范围内，并且当前没有其他可用模型。请联系管理员。",
                        removed + "model is no longer available for this Token, and no alternative model is available. Please contact the administrator.")
                : RelayLanguage.text(language,
                        removed + "模型已被管理员从当前 Token 的可用分组中移除。模型列表会自动刷新；请改选“"
                                + fallback.displayName() + "”或其他可用模型后重新发送。",
                        removed + "model is no longer available for this Token. The model list will refresh automatically; select '"
                                + fallback.displayName() + "' or another available model and try again.");
        output.write(KiroProtocol.event(mapper, "initial-response", Map.of("conversationId", conversationId)));
        writeNoticeEvents(conversationId, displayName, output, text);
    }

    private void writeNoticeResponse(JsonNode body, RelayConfiguration config, OutputStream output, String text) throws IOException {
        String conversationId = body.path("conversationState").path("conversationId").asText("");
        String displayName = config.defaultModel() == null
                ? "Kiro RelayRouter" : selectModel(body, config).displayName();
        output.write(KiroProtocol.event(mapper, "initial-response", Map.of("conversationId", conversationId)));
        writeNoticeEvents(conversationId, displayName, output, text);
    }

    private void writeNoticeEvents(String conversationId, String displayName, OutputStream output, String text) throws IOException {
        output.write(KiroProtocol.event(mapper, "assistantResponseEvent", Map.of(
                "content", text,
                "modelId", displayName)));
        ObjectNode metadata = mapper.createObjectNode();
        metadata.putObject("tokenUsage").put("uncachedInputTokens", 0).put("outputTokens", 0)
                .put("cacheReadInputTokens", 0).put("cacheWriteInputTokens", 0);
        metadata.put("stopReason", "end_turn");
        output.write(KiroProtocol.event(mapper, "metadataEvent", metadata));
        output.write(KiroProtocol.event(mapper, "messageMetadataEvent", Map.of("conversationId", conversationId)));
        output.flush();
    }

    private void processSse(ProtocolAdapter adapter, String eventName, String data, String model,
                            StreamState state, OutputStream output, String language) throws IOException {
        if (data.isBlank()) return;
        java.util.List<CanonicalStreamEvent> events;
        try {
            events = adapter.decode(mapper, eventName, data);
        } catch (Exception error) {
            throw new IOException(RelayLanguage.text(language, "服务节点返回的 SSE 数据格式无效。",
                    "The service node returned invalid SSE data."));
        }
        for (CanonicalStreamEvent event : events) {
            switch (event.type()) {
                case ERROR -> throw classifyUpstreamFailure(200, event.error(), language);
                case USAGE -> state.usage = normalizeUsage(adapter.code(), event.usage(), state.usage);
                case MODEL -> {
                    String reported = event.model() == null ? "" : event.model().trim();
                    if (!reported.isEmpty() && state.reportedModelId != null
                            && !state.reportedModelId.equals(reported)) {
                        log.warn("relay reported_model_changed request={} first={} latest={}",
                                state.requestId, state.reportedModelId, reported);
                    }
                    if (!reported.isEmpty()) state.reportedModelId = reported;
                }
                case TEXT_DELTA -> {
                    if (event.text() == null || event.text().isEmpty()) break;
                    state.markFirstOutput();
                    output.write(KiroProtocol.event(mapper, "assistantResponseEvent",
                            Map.of("content", event.text(), "modelId", model)));
                }
                case REASONING_DELTA -> {
                    if (event.text() == null || event.text().isEmpty()) break;
                    state.markFirstOutput();
                    output.write(KiroProtocol.event(mapper, "reasoningContentEvent", Map.of("content", event.text())));
                }
                case TOOL_START -> {
                    ToolState tool = state.tools.computeIfAbsent(event.index(), ignored ->
                            new ToolState("tooluse_" + System.nanoTime() + "_" + event.index(), ""));
                    if (event.id() != null && !event.id().isBlank()) tool.id = event.id();
                    if (event.name() != null && !event.name().isBlank()) tool.name = event.name();
                    if (!tool.started && !tool.name.isEmpty()) {
                        state.markFirstOutput();
                        output.write(KiroProtocol.event(mapper, "toolUseEvent",
                                Map.of("name", tool.name, "toolUseId", tool.id)));
                        tool.started = true;
                    }
                }
                case TOOL_DELTA -> {
                    ToolState tool = state.tools.computeIfAbsent(event.index(), ignored ->
                            new ToolState("tooluse_" + System.nanoTime() + "_" + event.index(), ""));
                    if (event.text() != null && !event.text().isEmpty()) {
                        tool.input.append(event.text());
                        output.write(KiroProtocol.event(mapper, "toolUseEvent",
                                Map.of("input", event.text(), "name", tool.name, "toolUseId", tool.id)));
                    }
                }
                case FINISH -> {
                    state.finishReason = event.finishReason();
                    log.debug("relay upstream_finish request={} protocol={} elapsed_ms={}", state.requestId,
                            adapter.code(), elapsedMillis(state.startedAt));
                }
                case DONE -> {
                    state.done = true;
                    log.debug("relay upstream_done request={} protocol={} elapsed_ms={}", state.requestId,
                            adapter.code(), elapsedMillis(state.startedAt));
                }
            }
        }
        output.flush();
    }

    /** All downstream metadata and billing consume one OpenAI-shaped normalized usage object. */
    private ObjectNode normalizeUsage(ProtocolCode protocol, JsonNode raw, JsonNode previous) {
        long previousTotal = previous.path("prompt_tokens").asLong(0);
        long previousCached = previous.path("prompt_tokens_details").path("cached_tokens").asLong(0);
        long previousCacheWrite = previous.path("prompt_tokens_details").path("cache_write_tokens").asLong(0);
        long previousOutput = previous.path("completion_tokens").asLong(0);
        long cached;
        long cacheWrite;
        long totalInput;
        long outputTokens;
        if (protocol == ProtocolCode.OPENAI_CHAT_COMPLETIONS) {
            totalInput = raw.path("prompt_tokens").asLong(previousTotal);
            cached = raw.path("prompt_tokens_details").path("cached_tokens").asLong(previousCached);
            cacheWrite = raw.path("prompt_tokens_details").path("cache_write_tokens").asLong(previousCacheWrite);
            outputTokens = raw.path("completion_tokens").asLong(previousOutput);
        } else if (protocol == ProtocolCode.OPENAI_RESPONSES) {
            totalInput = raw.path("input_tokens").asLong(previousTotal);
            cached = raw.path("input_tokens_details").path("cached_tokens").asLong(previousCached);
            cacheWrite = raw.path("input_tokens_details").path("cache_write_tokens").asLong(previousCacheWrite);
            outputTokens = raw.path("output_tokens").asLong(previousOutput);
        } else {
            long uncached = raw.path("input_tokens").asLong(Math.max(0, previousTotal - previousCached - previousCacheWrite));
            cached = raw.path("cache_read_input_tokens").asLong(previousCached);
            cacheWrite = raw.path("cache_creation_input_tokens").asLong(previousCacheWrite);
            totalInput = uncached + cached + cacheWrite;
            outputTokens = raw.path("output_tokens").asLong(previousOutput);
        }
        ObjectNode usage = mapper.createObjectNode().put("prompt_tokens", totalInput)
                .put("completion_tokens", outputTokens).put("total_tokens", totalInput + outputTokens);
        usage.putObject("prompt_tokens_details").put("cached_tokens", cached)
                .put("cache_write_tokens", cacheWrite);
        return usage;
    }

    private RelayModel selectModel(JsonNode body, RelayConfiguration config) {
        if (config.models().isEmpty()) throw new IllegalStateException("后端尚未配置模型");
        String requested = body.path("conversationState").path("currentMessage").path("userInputMessage").path("modelId").asText("");
        if (requested.isBlank()) return config.defaultModel();
        return config.models().stream()
                .filter(model -> model.displayName().equals(requested))
                .findFirst().orElseThrow(() -> new IllegalArgumentException("该 Token 不允许使用请求的模型"));
    }

    private static String requestedModelText(JsonNode body, RelayModel selected) {
        String requested = body.path("conversationState").path("currentMessage")
                .path("userInputMessage").path("modelId").asText("").trim();
        return requested.isEmpty() ? selected.displayName() : requested;
    }

    private static boolean isModelIdentityPrompt(JsonNode body) {
        String normalized = currentPrompt(body).toLowerCase()
                .replaceAll("[\\s，。！？,.!?~`‘’“”\"']", "");
        return normalized.matches(".*(你是谁|你是什么|什么模型|哪个模型|模型名称|模型版本|whoareyou|whatmodelareyou|whichmodel|modelname|modelversion).*");
    }

    static String currentPrompt(JsonNode body) {
        JsonNode content = body.path("conversationState").path("currentMessage")
                .path("userInputMessage").path("content");
        if (content.isTextual()) return content.asText();
        for (String field : new String[]{"prompt", "input", "message"}) {
            if (body.path(field).isTextual()) return body.path(field).asText();
        }
        JsonNode messages = body.path("messages");
        if (messages.isArray()) {
            for (int index = messages.size() - 1; index >= 0; index--) {
                JsonNode message = messages.path(index);
                if (!"user".equals(message.path("role").asText())) continue;
                JsonNode value = message.path("content");
                if (value.isTextual()) return value.asText();
                if (value.isArray()) {
                    StringBuilder text = new StringBuilder();
                    for (JsonNode part : value) {
                        String partText = part.path("text").asText("");
                        if (!partText.isBlank()) text.append(partText).append('\n');
                    }
                    return text.toString();
                }
            }
        }
        return "";
    }

    private static String stopReason(String finishReason, boolean usedTools) {
        if (isOutputLimit(finishReason)) return "max_tokens";
        if (usedTools) return "tool_use";
        if ("content_filter".equals(finishReason)) return "content_filtered";
        return "end_turn";
    }

    private static boolean isOutputLimit(String finishReason) {
        return "length".equals(finishReason) || "max_tokens".equals(finishReason)
                || "max_output_tokens".equals(finishReason) || "incomplete".equals(finishReason);
    }

    @Override
    public void destroy() {
        deadlines.shutdownNow();
    }

    private static long elapsedMillis(long startedAt) {
        return Duration.ofNanos(System.nanoTime() - startedAt).toMillis();
    }

    private static final class StreamState {
        private final long startedAt;
        private final String requestId;
        private final String requestedModelId;
        private final String platformModelId;
        private final Map<Integer, ToolState> tools = new LinkedHashMap<>();
        private JsonNode usage = com.fasterxml.jackson.databind.node.MissingNode.getInstance();
        private UsageBillingService.Charge charge;
        private Long configurationId;
        private String relayName;
        private RelayProtocol protocol;
        private String sentModelId;
        private String reportedModelId;
        private String finishReason;
        private long firstOutputNanos;
        private boolean done;

        private StreamState(long startedAt, String requestId, String requestedModelId, String platformModelId) {
            this.startedAt = startedAt;
            this.requestId = requestId;
            this.requestedModelId = requestedModelId;
            this.platformModelId = platformModelId;
        }

        private void markFirstOutput() {
            if (firstOutputNanos == 0) {
                firstOutputNanos = System.nanoTime();
                log.debug("relay first_output request={} elapsed_ms={}", requestId, firstOutputMillis());
            }
        }

        private long firstOutputMillis() {
            return firstOutputNanos == 0 ? -1 : Duration.ofNanos(firstOutputNanos - startedAt).toMillis();
        }
    }

    private static final class ToolState {
        private String id;
        private String name;
        private final StringBuilder input = new StringBuilder();
        private boolean started;

        private ToolState(String id, String name) {
            this.id = id;
            this.name = name;
        }
    }

    /** Closes a stalled SSE body after a period with no received lines. */
    private final class StreamIdleDeadline implements AutoCloseable {
        private final InputStream stream;
        private final long timeoutNanos;
        private final AtomicLong generation = new AtomicLong();
        private final AtomicBoolean timedOut = new AtomicBoolean();
        private ScheduledFuture<?> future;

        private StreamIdleDeadline(InputStream stream, Duration timeout) {
            this.stream = stream;
            this.timeoutNanos = timeout.toNanos();
            touch();
        }

        private synchronized void touch() {
            long ticket = generation.incrementAndGet();
            if (future != null) future.cancel(false);
            future = deadlines.schedule(() -> expire(ticket), timeoutNanos, TimeUnit.NANOSECONDS);
        }

        private void expire(long ticket) {
            if (generation.get() != ticket) return;
            timedOut.set(true);
            try { stream.close(); } catch (IOException ignored) { }
        }

        private boolean timedOut() {
            return timedOut.get();
        }

        @Override public synchronized void close() {
            generation.incrementAndGet();
            if (future != null) future.cancel(false);
        }
    }
}
