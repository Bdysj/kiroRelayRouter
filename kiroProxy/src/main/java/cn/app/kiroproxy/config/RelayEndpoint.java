package cn.app.kiroproxy.config;

import cn.app.kiroproxy.protocol.ProtocolCapability;
import cn.app.kiroproxy.protocol.ProtocolStrategy;
import cn.app.kiroproxy.protocol.ModelProtocolClassifier;
import cn.app.kiroproxy.protocol.RelayProtocol;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** A credential-bearing upstream endpoint. Never serialize this record to a downstream response. */
public record RelayEndpoint(
        long id,
        String name,
        String provider,
        String baseUrl,
        String apiKey,
        boolean enabled,
        int priority,
        int weight,
        HealthStatus healthStatus,
        int failureCount,
        int failureThreshold,
        int connectTimeoutMs,
        int readTimeoutMs,
        int maxConcurrency,
        long version,
        Instant lastHealthCheckAt,
        Long lastHealthLatencyMs,
        Set<String> modelIds,
        Map<String, ModelRoute> modelRoutes,
        Instant lastSuccessAt,
        ProtocolStrategy protocolStrategy,
        List<RelayProtocol> protocols,
        Map<String, List<RelayProtocol>> modelProtocols) {

    public RelayEndpoint(long id, String name, String provider, String baseUrl, String apiKey, boolean enabled,
            int priority, int weight, HealthStatus healthStatus, int failureCount, int failureThreshold,
            int connectTimeoutMs, int readTimeoutMs, int maxConcurrency, long version, Instant lastHealthCheckAt,
            Long lastHealthLatencyMs, Set<String> modelIds) {
        this(id, name, provider, baseUrl, apiKey, enabled, priority, weight, healthStatus, failureCount,
                failureThreshold, connectTimeoutMs, readTimeoutMs, maxConcurrency, version, lastHealthCheckAt,
                lastHealthLatencyMs, modelIds, Map.of(), null, ProtocolStrategy.OPENAI_SMART, List.of(), Map.of());
    }

    public RelayEndpoint(long id, String name, String provider, String baseUrl, String apiKey, boolean enabled,
            int priority, int weight, HealthStatus healthStatus, int failureCount, int failureThreshold,
            int connectTimeoutMs, int readTimeoutMs, int maxConcurrency, long version, Instant lastHealthCheckAt,
            Long lastHealthLatencyMs, Set<String> modelIds, Map<String, ModelRoute> modelRoutes) {
        this(id, name, provider, baseUrl, apiKey, enabled, priority, weight, healthStatus, failureCount,
                failureThreshold, connectTimeoutMs, readTimeoutMs, maxConcurrency, version, lastHealthCheckAt,
                lastHealthLatencyMs, modelIds, modelRoutes, null, ProtocolStrategy.OPENAI_SMART, List.of(), Map.of());
    }

    public RelayEndpoint {
        modelIds = modelIds == null ? Set.of() : Set.copyOf(modelIds);
        modelRoutes = modelRoutes == null ? Map.of() : Map.copyOf(modelRoutes);
        protocolStrategy = protocolStrategy == null ? ProtocolStrategy.OPENAI_SMART : protocolStrategy;
        protocols = protocols == null ? List.of() : List.copyOf(protocols);
        modelProtocols = modelProtocols == null ? Map.of() : Map.copyOf(modelProtocols);
    }

    public boolean supports(String modelId) {
        return modelIds.contains(modelId);
    }

    public String upstreamModelId(String modelId) {
        ModelRoute route = modelRoutes.get(modelId);
        return route == null ? modelId : route.upstreamModelId();
    }

    public int priorityFor(String modelId) {
        ModelRoute route = modelRoutes.get(modelId);
        return route == null || route.priorityOverride() == null ? priority : route.priorityOverride();
    }

    public int weightFor(String modelId) {
        ModelRoute route = modelRoutes.get(modelId);
        return route == null || route.weightOverride() == null ? weight : route.weightOverride();
    }

    /** Model-specific rows replace relay defaults; absence means inheritance. */
    public List<RelayProtocol> protocolsFor(String modelId, Set<ProtocolCapability> required) {
        List<RelayProtocol> configured = modelProtocols.get(modelId);
        boolean explicitlyMapped = configured != null && !configured.isEmpty();
        if (!explicitlyMapped) configured = protocols;
        if (configured.isEmpty()) configured = List.of(new RelayProtocol(0,
                cn.app.kiroproxy.protocol.ProtocolCode.OPENAI_CHAT_COMPLETIONS, true, 10, null,
                RelayProtocol.capabilities(true, true, false, true, true, true, false),
                "UNVERIFIED", null, null));
        ModelProtocolClassifier.Family family = ModelProtocolClassifier.classify(upstreamModelId(modelId));
        Set<cn.app.kiroproxy.protocol.ProtocolCode> inferred = !explicitlyMapped
                ? ModelProtocolClassifier.protocols(family) : Set.of();
        boolean requireFamilyMatch = protocolStrategy == ProtocolStrategy.AUTO
                || family != ModelProtocolClassifier.Family.UNKNOWN;
        return configured.stream()
                .filter(protocol -> protocolStrategy.allows(protocol.code()))
                .filter(protocol -> explicitlyMapped || !requireFamilyMatch || inferred.contains(protocol.code()))
                .filter(protocol -> protocol.supports(required))
                .sorted(Comparator.comparingInt(RelayProtocol::priority).thenComparing(p -> p.code().name()))
                .toList();
    }

    public record ModelRoute(String upstreamModelId, Integer priorityOverride, Integer weightOverride) {}

    public enum HealthStatus { UNKNOWN, UP, DOWN }
}
