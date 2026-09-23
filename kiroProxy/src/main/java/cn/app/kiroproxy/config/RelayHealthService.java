package cn.app.kiroproxy.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

/** Periodically checks GET /models. Chat request threads only consume the selector snapshot. */
@Service
public class RelayHealthService implements DisposableBean {
    private static final Logger log = LoggerFactory.getLogger(RelayHealthService.class);
    private final RelayConfigurationRepository repository;
    private final RelaySelector selector;
    private final ObjectMapper mapper;
    private final StringRedisTemplate redis;
    private final Duration healthTimeout;
    private final ExecutorService checks;
    private final Map<Integer, HttpClient> clients = new ConcurrentHashMap<>();

    public RelayHealthService(RelayConfigurationRepository repository, RelaySelector selector,
                              ObjectMapper mapper, StringRedisTemplate redis,
                              @Value("${kiro.relay.health.timeout:8s}") Duration healthTimeout,
                              @Value("${kiro.relay.health.parallelism:4}") int parallelism) {
        this.repository = repository;
        this.selector = selector;
        this.mapper = mapper;
        this.redis = redis;
        this.healthTimeout = healthTimeout;
        this.checks = Executors.newFixedThreadPool(Math.max(1, parallelism), task -> {
            Thread thread = new Thread(task, "relay-health");
            thread.setDaemon(true);
            return thread;
        });
    }

    @Scheduled(fixedDelayString = "${kiro.relay.health.interval-ms:30000}",
            initialDelayString = "${kiro.relay.health.initial-delay-ms:30000}")
    public void scheduledCheck() {
        checkAllNow();
    }

    public synchronized HealthSummary checkAllNow() {
        List<RelayEndpoint> endpoints = repository.findEnabledEndpoints();
        var futures = endpoints.stream().map(endpoint ->
                java.util.concurrent.CompletableFuture.supplyAsync(() -> check(endpoint), checks)).toList();
        long up = futures.stream().map(java.util.concurrent.CompletableFuture::join)
                .filter(Boolean::booleanValue).count();
        selector.reload();
        return new HealthSummary(endpoints.size(), up);
    }

    public void reloadSelector() {
        selector.reload();
    }

    public synchronized HealthResult checkOneNow(long id) {
        RelayEndpoint endpoint = repository.findEndpoint(id)
                .orElseThrow(() -> new IllegalArgumentException("中转配置不存在"));
        boolean up = check(endpoint);
        selector.reload();
        RelayEndpoint refreshed = repository.findEndpoint(id).orElseThrow();
        return new HealthResult(id, up, refreshed.healthStatus().name(), refreshed.lastHealthLatencyMs(),
                refreshed.lastHealthCheckAt());
    }

    /** Reads the upstream catalog for route configuration without changing admin bindings. */
    public List<RelayModel> discoverModelsNow(long id) {
        RelayEndpoint endpoint = repository.findEndpoint(id)
                .orElseThrow(() -> new IllegalArgumentException("中转配置不存在"));
        if (endpoint.apiKey() == null || endpoint.apiKey().isBlank()) {
            throw new IllegalStateException("API Key未配置");
        }
        if (!"openai-compatible".equalsIgnoreCase(endpoint.provider())
                && !"openai".equalsIgnoreCase(endpoint.provider())) {
            throw new IllegalStateException("当前版本不支持该provider协议");
        }
        Map<String, String> knownModels = repository.knownModelDisplayNames();
        List<String> failures = new ArrayList<>();
        for (URI modelUri : modelUris(endpoint.baseUrl())) {
            try {
                HttpRequest request = HttpRequest.newBuilder(modelUri)
                        .timeout(Duration.ofMillis(Math.min(healthTimeout.toMillis(), endpoint.readTimeoutMs())))
                        .header("authorization", "Bearer " + endpoint.apiKey())
                        .header("accept", "application/json").GET().build();
                HttpResponse<byte[]> response = client(endpoint.connectTimeoutMs()).send(
                        request, HttpResponse.BodyHandlers.ofByteArray());
                if (response.statusCode() < 200 || response.statusCode() >= 300) {
                    failures.add(modelUri + " -> HTTP " + response.statusCode() + responseDetail(response.body()));
                    continue;
                }
                List<RelayModel> models = parseModels(mapper.readTree(response.body()), knownModels);
                if (!models.isEmpty()) return models;
                failures.add(modelUri + " -> HTTP 2xx，但模型列表为空");
            } catch (Exception error) {
                failures.add(modelUri + " -> " + error.getClass().getSimpleName()
                        + messageSuffix(error.getMessage()));
            }
        }
        throw new IllegalStateException("无法读取上游模型：" + String.join("; ", failures));
    }

    private boolean check(RelayEndpoint endpoint) {
        long started = System.nanoTime();
        boolean up = false;
        try {
            if (endpoint.apiKey() == null || endpoint.apiKey().isBlank()) {
                throw new IllegalStateException("API Key未配置");
            }
            if (!"openai-compatible".equalsIgnoreCase(endpoint.provider())
                    && !"openai".equalsIgnoreCase(endpoint.provider())) {
                throw new IllegalStateException("当前版本不支持该provider协议");
            }
            Map<String, String> knownModels = repository.knownModelDisplayNames();
            List<String> failures = new ArrayList<>();
            for (URI modelUri : modelUris(endpoint.baseUrl())) {
                try {
                    HttpRequest request = HttpRequest.newBuilder(modelUri)
                            .timeout(Duration.ofMillis(Math.min(healthTimeout.toMillis(), endpoint.readTimeoutMs())))
                            .header("authorization", "Bearer " + endpoint.apiKey())
                            .header("accept", "application/json")
                            .GET().build();
                    HttpResponse<byte[]> response = client(endpoint.connectTimeoutMs()).send(
                            request, HttpResponse.BodyHandlers.ofByteArray());
                    if (response.statusCode() < 200 || response.statusCode() >= 300) {
                        failures.add(modelUri + " -> HTTP " + response.statusCode()
                                + responseDetail(response.body()));
                        continue;
                    }
                    List<RelayModel> models = parseModels(mapper.readTree(response.body()), knownModels);
                    if (models.isEmpty()) {
                        failures.add(modelUri + " -> HTTP 2xx，但未返回已配置模型");
                        continue;
                    }
                    // relay_configuration_model 由管理后台维护；健康检查只验证上游是否
                    // 正常返回管理员已登记的模型，不能覆盖管理员设置的关联关系。
                    up = true;
                    break;
                } catch (Exception error) {
                    failures.add(modelUri + " -> " + error.getClass().getSimpleName()
                            + messageSuffix(error.getMessage()));
                }
            }
            if (!up) throw new IllegalStateException(String.join("; ", failures));
        } catch (Exception error) {
            log.warn("relay health failed relay_id={} name={} reason={} detail={}", endpoint.id(), endpoint.name(),
                    error.getClass().getSimpleName(), error.getMessage());
        } finally {
            long latencyMs = Duration.ofNanos(System.nanoTime() - started).toMillis();
            repository.markHealth(endpoint.id(), up, latencyMs);
            cacheHealth(endpoint, up, latencyMs);
        }
        return up;
    }

    static List<URI> modelUris(String baseUrl) {
        String base = baseUrl.trim().replaceFirst("/+$", "");
        List<URI> result = new ArrayList<>();
        result.add(URI.create(base + "/models"));
        if (base.toLowerCase(java.util.Locale.ROOT).endsWith("/v1")) {
            result.add(URI.create(base.substring(0, base.length() - 3) + "/models"));
        } else {
            result.add(URI.create(base + "/v1/models"));
        }
        return result.stream().distinct().toList();
    }

    private String responseDetail(byte[] body) {
        if (body == null || body.length == 0) return "";
        try {
            JsonNode json = mapper.readTree(body);
            String code = text(json, "code");
            String message = text(json, "message");
            if (message.isBlank() && json.path("error").isObject()) {
                code = text(json.path("error"), "code", "type");
                message = text(json.path("error"), "message");
            }
            String detail = String.join(": ", java.util.stream.Stream.of(code, message)
                    .filter(value -> value != null && !value.isBlank()).toList());
            return messageSuffix(detail);
        } catch (Exception ignored) {
            String detail = new String(body, StandardCharsets.UTF_8).replaceAll("\\s+", " ").trim();
            return messageSuffix(detail);
        }
    }

    private static String messageSuffix(String value) {
        if (value == null || value.isBlank()) return "";
        String compact = value.replaceAll("\\s+", " ").trim();
        return " (" + compact.substring(0, Math.min(200, compact.length())) + ")";
    }

    List<RelayModel> parseModels(JsonNode response, Map<String, String> knownModels) {
        JsonNode entries = response.path("data");
        if (!entries.isArray() && response.isArray()) entries = response;
        if (!entries.isArray()) return List.of();
        Map<String, RelayModel> models = new LinkedHashMap<>();
        for (JsonNode entry : entries) {
            String id = text(entry, "id", "model_id", "modelId");
            if (id.isBlank()) continue;
            String display = text(entry, "display_name", "displayName", "name");
            // OpenAI-compatible providers are allowed to return only an id. Prefer
            // the platform display name when one exists, otherwise the id itself is
            // the most accurate name and must not cause the upstream model to vanish.
            if (display.isBlank()) display = knownModels.getOrDefault(id, id);
            models.putIfAbsent(id, new RelayModel(id, display));
        }
        return new ArrayList<>(models.values());
    }

    private HttpClient client(int connectTimeoutMs) {
        return clients.computeIfAbsent(connectTimeoutMs, timeout -> HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofMillis(timeout)).build());
    }

    private void cacheHealth(RelayEndpoint endpoint, boolean up, long latencyMs) {
        try {
            int failures = up ? 0 : endpoint.failureCount() + 1;
            String status = up || failures < endpoint.failureThreshold() ? "UP" : "DOWN";
            String key = "relay:health:" + endpoint.id();
            redis.opsForHash().putAll(key, Map.of("status", status,
                    "last_check", Instant.now().toString(), "latency_ms", Long.toString(latencyMs),
                    "failure_count", Integer.toString(failures)));
            redis.expire(key, Duration.ofMinutes(2));
        } catch (RuntimeException error) {
            log.debug("relay health Redis mirror unavailable: {}", error.getClass().getSimpleName());
        }
    }

    private static String text(JsonNode node, String... fields) {
        for (String field : fields) if (node.path(field).isTextual()) return node.path(field).asText().trim();
        return "";
    }

    @Override
    public void destroy() {
        checks.shutdownNow();
    }

    public record HealthSummary(long configured, long up) {}
    public record HealthResult(long configurationId, boolean up, String healthStatus, Long latencyMs,
                               Instant checkedAt) {}
}
