package cn.app.kiroproxy.api;

import cn.app.kiroproxy.config.RelayConfigurationRepository;
import cn.app.kiroproxy.config.RelayEndpoint;
import cn.app.kiroproxy.config.RelayHealthService;
import cn.app.kiroproxy.protocol.ProtocolStrategy;
import cn.app.kiroproxy.protocol.ProtocolCode;
import cn.app.kiroproxy.protocol.ProtocolVerificationService;
import cn.app.kiroproxy.protocol.RelayProtocol;
import cn.app.kiroproxy.protocol.ModelProtocolClassifier;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import java.net.URI;
import java.util.List;
import java.util.concurrent.RejectedExecutionException;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/admin/relays")
public class RelayAdminController {
    private static final String COMPATIBLE_PROVIDER = "openai-compatible";
    private final RelayConfigurationRepository repository;
    private final RelayHealthService health;
    private final ProtocolVerificationService protocolVerification;

    public RelayAdminController(RelayConfigurationRepository repository, RelayHealthService health,
                                ProtocolVerificationService protocolVerification) {
        this.repository = repository;
        this.health = health;
        this.protocolVerification = protocolVerification;
    }

    @GetMapping
    public List<RelayView> list() {
        return repository.findAllEndpoints().stream().map(RelayView::from).toList();
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public RelayView create(@Valid @RequestBody RelayRequest request) {
        validate(request, true);
        long id = repository.createEndpoint(request.name().trim(), COMPATIBLE_PROVIDER,
                baseUrl(request.baseUrl()), request.apiKey().trim(), false, request.priority(),
                request.weight(), request.failureThreshold(), request.connectTimeoutMs(),
                request.readTimeoutMs(), request.maxConcurrency(), request.protocolStrategy());
        if (!request.protocols().isEmpty()) repository.replaceProtocols(id, request.protocols());
        health.checkAllNow();
        return repository.findAllEndpoints().stream().filter(value -> value.id() == id).findFirst()
                .map(RelayView::from).orElseThrow();
    }

    @PutMapping("/{id}")
    public RelayView update(@PathVariable long id, @Valid @RequestBody RelayRequest request) {
        validate(request, false);
        RelayEndpoint old = repository.findEndpoint(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "中转配置不存在"));
        String apiKey = request.apiKey() == null || request.apiKey().isBlank() ? old.apiKey() : request.apiKey().trim();
        int updated = repository.updateEndpoint(id, request.version(), request.name().trim(),
                COMPATIBLE_PROVIDER, baseUrl(request.baseUrl()), apiKey, false, request.priority(),
                request.weight(), request.failureThreshold(), request.connectTimeoutMs(),
                request.readTimeoutMs(), request.maxConcurrency(), request.protocolStrategy());
        if (updated == 0) throw new ResponseStatusException(HttpStatus.CONFLICT, "配置已被其他管理员修改，请刷新后重试");
        if (!old.baseUrl().equals(baseUrl(request.baseUrl())) || !old.apiKey().equals(apiKey))
            repository.invalidateProtocolVerification(id);
        if (!request.protocols().isEmpty()) repository.replaceProtocols(id, request.protocols());
        health.checkAllNow();
        return repository.findAllEndpoints().stream().filter(value -> value.id() == id).findFirst()
                .map(RelayView::from).orElseThrow();
    }

    /** 单一保存接口：请求体带 id 时更新，不带 id 时创建。 */
    @PostMapping("/save")
    @Transactional
    public RelayView save(@Valid @RequestBody SaveRelayRequest request) {
        boolean enableAfterSave = request.enabled() == null || request.enabled();
        RelayRequest relay = request.toRelayRequest(false);
        RelayView saved = request.id() == null ? create(relay) : update(request.id(), relay);
        protocolVerification.consumeDraftEvidence(saved.id(), request.verificationTokens());
        if (enableAfterSave) {
            RelayEndpoint endpoint = repository.findEndpoint(saved.id()).orElseThrow();
            validateActivation(endpoint);
            repository.setEndpointEnabled(saved.id(), true);
            health.reloadSelector();
        }
        return repository.findEndpoint(saved.id()).map(RelayView::from).orElseThrow();
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable long id) {
        if (repository.deleteEndpoint(id) == 0) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "中转配置不存在");
        }
        health.reloadSelector();
    }

    @PostMapping("/health-check")
    public RelayHealthService.HealthSummary healthCheck() {
        return health.checkAllNow();
    }

    @PostMapping("/{id}/test")
    public RelayHealthService.HealthResult test(@PathVariable long id) {
        try { return health.checkOneNow(id); }
        catch (IllegalArgumentException error) { throw new ResponseStatusException(HttpStatus.NOT_FOUND, error.getMessage()); }
    }

    @PostMapping("/protocol-test")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public ProtocolVerificationService.ProtocolTestTaskView testProtocolDraft(
            @Valid @RequestBody ProtocolTestRequest request) {
        if (request.configurationId() == null)
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "请先保存为停用草稿，再到路由与价格中绑定测试模型");
        RelayEndpoint saved = repository.findEndpoint(request.configurationId())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "中转配置不存在"));
        String apiKey = request.apiKey() == null || request.apiKey().isBlank()
                ? saved.apiKey()
                : request.apiKey().trim();
        if (apiKey == null || apiKey.isBlank())
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "请先填写 API Key");
        String cleanBaseUrl = baseUrl(request.baseUrl());
        validateBaseUrl(cleanBaseUrl);
        RelayConfigurationRepository.TestModel testModel = repository.findEnabledTestModels(saved.id()).stream()
                .filter(model -> model.modelId().equals(request.modelId()))
                .findFirst()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "该模型不在当前中转站已启用的路由绑定中"));
        String upstreamModelId = testModel.upstreamModelId();
        RelayConfigurationRepository.ProtocolSettings settings = request.protocol();
        String path = RelayConfigurationRepository.validateProtocolPath(settings.pathOverride());
        ModelProtocolClassifier.Family family = ModelProtocolClassifier.classify(upstreamModelId);
        boolean explicitlyMapped = saved.modelProtocols()
                .getOrDefault(request.modelId(), List.of()).stream()
                .anyMatch(item -> item.enabled() && item.code() == settings.code());
        if (!explicitlyMapped
                && (request.protocolStrategy() == ProtocolStrategy.AUTO
                || family != ModelProtocolClassifier.Family.UNKNOWN)
                && !ModelProtocolClassifier.protocols(family).contains(settings.code()))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    family == ModelProtocolClassifier.Family.UNKNOWN
                            ? "无法从该模型 ID 识别协议家族，请在路由与价格中配置模型×协议映射"
                            : "所选模型与当前协议不匹配");
        RelayProtocol protocol = new RelayProtocol(0, settings.code(), settings.enabled(), settings.priority(),
                path, RelayProtocol.capabilities(settings.textSupported(), settings.imageSupported(),
                settings.pdfSupported(), settings.toolUseSupported(), settings.toolResultSupported(),
                settings.streamingSupported(), settings.promptCacheSupported()), "UNVERIFIED", null, null);
        RelayEndpoint draft = new RelayEndpoint(saved.id(), "protocol-draft", "openai-compatible", cleanBaseUrl, apiKey, true,
                0, 1, RelayEndpoint.HealthStatus.UP, 0, 1, request.connectTimeoutMs(), request.readTimeoutMs(),
                0, 0, null, null, java.util.Set.of(request.modelId()),
                java.util.Map.of(request.modelId(), new RelayEndpoint.ModelRoute(upstreamModelId, null, null)),
                null, request.protocolStrategy(), List.of(protocol), java.util.Map.of());
        try {
            return protocolVerification.startDraftTest(draft, protocol, request.modelId());
        } catch (RejectedExecutionException error) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "协议测试任务较多，请稍后重试");
        }
    }

    @GetMapping("/protocol-test/{taskId}")
    public ProtocolVerificationService.ProtocolTestTaskView protocolTestTask(@PathVariable String taskId) {
        return protocolVerification.findDraftTest(taskId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "协议测试任务不存在或已过期"));
    }

    @PutMapping("/{id}/enabled")
    public RelayView enabled(@PathVariable long id, @RequestBody EnabledRequest request) {
        RelayEndpoint endpoint = repository.findEndpoint(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "中转配置不存在"));
        if (request.enabled()) validateActivation(endpoint);
        if (repository.setEndpointEnabled(id, request.enabled()) == 0)
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "中转配置不存在");
        health.reloadSelector();
        return repository.findEndpoint(id).map(RelayView::from).orElseThrow();
    }

    @GetMapping("/{id}/test-models")
    public List<TestModelView> testModels(@PathVariable long id) {
        if (repository.findEndpoint(id).isEmpty())
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "中转配置不存在");
        return repository.findEnabledTestModels(id).stream()
                .map(model -> new TestModelView(model.modelId(), model.displayName(), model.upstreamModelId()))
                .toList();
    }

    @GetMapping("/{id}/upstream-models")
    public List<UpstreamModelView> upstreamModels(@PathVariable long id) {
        try {
            return health.discoverModelsNow(id).stream()
                    .map(model -> new UpstreamModelView(model.modelId(), model.displayName())).toList();
        } catch (IllegalArgumentException error) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, error.getMessage());
        } catch (IllegalStateException error) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, error.getMessage());
        }
    }

    private static void validate(RelayRequest request, boolean creating) {
        if (creating && (request.apiKey() == null || request.apiKey().isBlank())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "新增配置必须提供 API Key");
        }
        validateBaseUrl(request.baseUrl());
    }

    private void validateActivation(RelayEndpoint endpoint) {
        if (repository.findEnabledTestModels(endpoint.id()).isEmpty())
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "请先在路由与价格中绑定并启用至少一个模型");
        if (endpoint.protocols().stream().noneMatch(RelayProtocol::enabled))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "请至少启用一个协议");
    }

    private static void validateBaseUrl(String value) {
        try {
            URI uri = URI.create(value);
            if (!("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme()))
                    || uri.getHost() == null) throw new IllegalArgumentException();
        } catch (Exception error) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "baseUrl 必须是有效的 HTTP(S) 地址");
        }
    }

    private static String baseUrl(String value) {
        return value.trim().replaceFirst("/+$", "");
    }

    public record RelayRequest(@NotBlank String name, @NotBlank String baseUrl, String apiKey,
                               ProtocolStrategy protocolStrategy,
                               List<RelayConfigurationRepository.ProtocolSettings> protocols,
                               Boolean enabled, @Min(0) Integer priority,
                               @Min(1) @Max(1000000) Integer weight,
                               @Min(1) Integer failureThreshold, @Min(100) @Max(1800000) Integer connectTimeoutMs,
                               @Min(1000) @Max(1800000) Integer readTimeoutMs, @Min(0) Integer maxConcurrency,
                               @Min(0) Long version) {
        public RelayRequest {
            protocolStrategy = protocolStrategy == null ? ProtocolStrategy.AUTO : protocolStrategy;
            protocols = protocols == null ? List.of() : List.copyOf(protocols);
            enabled = enabled == null ? Boolean.TRUE : enabled;
            priority = priority == null ? 100 : priority;
            weight = weight == null ? 100 : weight;
            failureThreshold = failureThreshold == null ? 3 : failureThreshold;
            connectTimeoutMs = connectTimeoutMs == null ? 5000 : connectTimeoutMs;
            readTimeoutMs = readTimeoutMs == null ? 600000 : readTimeoutMs;
            maxConcurrency = maxConcurrency == null ? 0 : maxConcurrency;
            version = version == null ? 0L : version;
        }
    }

    public record SaveRelayRequest(Long id, @NotBlank String name, @NotBlank String baseUrl,
                                   String apiKey, Boolean enabled,
                                   ProtocolStrategy protocolStrategy,
                                   List<RelayConfigurationRepository.ProtocolSettings> protocols,
                                   java.util.Map<ProtocolCode, String> verificationTokens,
                                   @Min(0) Integer priority, @Min(1) @Max(1000000) Integer weight,
                                   @Min(1) Integer failureThreshold,
                                   @Min(100) @Max(1800000) Integer connectTimeoutMs,
                                   @Min(1000) @Max(1800000) Integer readTimeoutMs,
                                   @Min(0) Integer maxConcurrency,
                                   @Min(0) Long version) {
        RelayRequest toRelayRequest(boolean enabledValue) {
            return new RelayRequest(name, baseUrl, apiKey, protocolStrategy, protocols,
                    enabledValue, priority, weight,
                    failureThreshold, connectTimeoutMs, readTimeoutMs, maxConcurrency, version);
        }
    }

    public record ProtocolTestRequest(Long configurationId, @NotBlank String baseUrl, String apiKey,
            @NotBlank String modelId, ProtocolStrategy protocolStrategy,
            @Min(100) @Max(1800000) Integer connectTimeoutMs,
            @Min(1000) @Max(1800000) Integer readTimeoutMs,
            @Valid RelayConfigurationRepository.ProtocolSettings protocol) {
        public ProtocolTestRequest {
            protocolStrategy = protocolStrategy == null ? ProtocolStrategy.AUTO : protocolStrategy;
            connectTimeoutMs = connectTimeoutMs == null ? 5000 : connectTimeoutMs;
            readTimeoutMs = readTimeoutMs == null ? 600000 : readTimeoutMs;
            if (protocol == null) throw new IllegalArgumentException("协议配置不能为空");
        }
    }

    public record TestModelView(String modelId, String displayName, String upstreamModelId) {}
    public record UpstreamModelView(String modelId, String displayName) {}
    public record EnabledRequest(boolean enabled) {}

    public record RelayView(long id, String name, String baseUrl, boolean apiKeyConfigured,
                            ProtocolStrategy protocolStrategy, List<ProtocolView> protocols,
                            boolean enabled, int priority, int weight, String healthStatus, int failureCount,
                            int failureThreshold, int connectTimeoutMs, int readTimeoutMs, int maxConcurrency,
                            long version, java.time.Instant lastHealthCheckAt, Long lastHealthLatencyMs,
                            java.time.Instant lastSuccessAt, java.util.Set<String> modelIds) {
        static RelayView from(RelayEndpoint endpoint) {
            return new RelayView(endpoint.id(), endpoint.name(), endpoint.baseUrl(),
                    endpoint.apiKey() != null && !endpoint.apiKey().isBlank(), endpoint.protocolStrategy(),
                    endpoint.protocols().stream().map(ProtocolView::from).toList(), endpoint.enabled(),
                    endpoint.priority(), endpoint.weight(), endpoint.healthStatus().name(), endpoint.failureCount(),
                    endpoint.failureThreshold(), endpoint.connectTimeoutMs(), endpoint.readTimeoutMs(),
                    endpoint.maxConcurrency(), endpoint.version(), endpoint.lastHealthCheckAt(),
                    endpoint.lastHealthLatencyMs(), endpoint.lastSuccessAt(), endpoint.modelIds());
        }
    }

    public record ProtocolView(String code, boolean enabled, int priority, String pathOverride,
            java.util.Set<String> capabilities, String verificationStatus, java.time.Instant lastVerifiedAt,
            String lastVerificationMessage) {
        static ProtocolView from(RelayProtocol protocol) {
            return new ProtocolView(protocol.code().name(), protocol.enabled(), protocol.priority(),
                    protocol.pathOverride(), protocol.capabilities().stream().map(Enum::name)
                    .collect(java.util.stream.Collectors.toCollection(java.util.LinkedHashSet::new)),
                    protocol.verificationStatus(), protocol.lastVerifiedAt(), protocol.lastVerificationMessage());
        }
    }
}
