package cn.app.kiroproxy.config;

import cn.app.kiroproxy.protocol.ProtocolCode;
import cn.app.kiroproxy.protocol.ProtocolCapability;
import cn.app.kiroproxy.protocol.ProtocolStrategy;
import cn.app.kiroproxy.protocol.RelayProtocol;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

@Repository
public class RelayConfigurationRepository {
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public RelayConfigurationRepository(JdbcTemplate jdbc) {
        this(jdbc, new ObjectMapper());
    }

    @org.springframework.beans.factory.annotation.Autowired
    public RelayConfigurationRepository(JdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    public RelayConfiguration get() {
        List<RelayModel> models = jdbc.query(
                """
                select model_id, display_name, max_input_tokens, max_output_tokens
                from relay_model where enabled = true order by sort_order, model_id
                """,
                (result, row) -> new RelayModel(result.getString("model_id"), result.getString("display_name"),
                        result.getLong("max_input_tokens"), result.getLong("max_output_tokens")));
        PublicState state = jdbc.queryForObject("""
                select case when count(*) filter (where enabled=true) > 0 then true else false end enabled,
                  case when count(*) filter (where enabled=true and trim(api_key)<>'') > 0 then true else false end key_configured
                from relay_configuration
                """, (rs, row) -> new PublicState(rs.getBoolean("enabled"), rs.getBoolean("key_configured")));
        // Credential-bearing endpoint records are loaded only by RelayHealthService/RelaySelector.
        // The public configuration object carries a boolean sentinel, never a real API Key or URL.
        return new RelayConfiguration(state != null && state.enabled(), "",
                state != null && state.keyConfigured() ? "configured" : "", List.copyOf(models));
    }

    public List<RelayEndpoint> findEnabledEndpoints() {
        return findEndpoints(true);
    }

    public List<RelayEndpoint> findAllEndpoints() {
        return findEndpoints(false);
    }

    public Optional<RelayEndpoint> findEndpoint(long id) {
        return findAllEndpoints().stream().filter(endpoint -> endpoint.id() == id).findFirst();
    }

    public Map<String, String> knownModelDisplayNames() {
        Map<String, String> result = new LinkedHashMap<>();
        jdbc.query("select model_id, display_name from relay_model where enabled=true order by sort_order, model_id",
                (RowCallbackHandler) row -> result.put(row.getString("model_id"), row.getString("display_name")));
        return Map.copyOf(result);
    }

    /** Read-only protocol-test candidates sourced from the route matrix. */
    public List<TestModel> findEnabledTestModels(long configurationId) {
        return jdbc.query("""
                select cm.model_id,m.display_name,cm.upstream_model_id
                from relay_configuration_model cm
                join relay_model m on m.model_id=cm.model_id
                where cm.configuration_id=? and cm.enabled=true and m.enabled=true
                order by m.sort_order,m.model_id
                """, (rs, row) -> new TestModel(rs.getString("model_id"), rs.getString("display_name"),
                rs.getString("upstream_model_id")), configurationId);
    }

    private List<RelayEndpoint> findEndpoints(boolean enabledOnly) {
        String where = enabledOnly ? " where c.enabled=true" : "";
        Map<Long, Set<String>> models = new LinkedHashMap<>();
        Map<Long, Map<String, RelayEndpoint.ModelRoute>> routes = new LinkedHashMap<>();
        jdbc.query("""
                select configuration_id, model_id, upstream_model_id, priority_override, weight_override
                from relay_configuration_model where enabled=true order by configuration_id, model_id
                """, (RowCallbackHandler) result -> {
            long configurationId = result.getLong("configuration_id");
            String modelId = result.getString("model_id");
            models.computeIfAbsent(configurationId, ignored -> new LinkedHashSet<>()).add(modelId);
            routes.computeIfAbsent(configurationId, ignored -> new LinkedHashMap<>()).put(modelId,
                    new RelayEndpoint.ModelRoute(result.getString("upstream_model_id"),
                            (Integer) result.getObject("priority_override"),
                            (Integer) result.getObject("weight_override")));
        });
        Map<Long, List<RelayProtocol>> protocols = protocolMap();
        Map<Long, Map<String, List<RelayProtocol>>> modelProtocols = modelProtocolMap();
        return jdbc.query("""
                select c.id, c.name, c.provider, c.base_url, c.api_key, c.enabled, c.priority, c.weight,
                  c.health_status, c.failure_count, c.failure_threshold, c.connect_timeout_ms,
                  c.read_timeout_ms, c.max_concurrency, c.version, c.last_health_check_at,
                  c.last_health_latency_ms, c.last_success_at, c.protocol_strategy
                from relay_configuration c
                """ + where + " order by c.priority, c.id", (rs, row) -> endpoint(rs,
                models.getOrDefault(rs.getLong("id"), Set.of()), routes.getOrDefault(rs.getLong("id"), Map.of()),
                protocols.getOrDefault(rs.getLong("id"), List.of()),
                modelProtocols.getOrDefault(rs.getLong("id"), Map.of())));
    }

    @Transactional
    public long createEndpoint(String name, String provider, String baseUrl, String apiKey, boolean enabled,
                               int priority, int weight, int failureThreshold, int connectTimeoutMs,
                               int readTimeoutMs, int maxConcurrency) {
        return createEndpoint(name, provider, baseUrl, apiKey, enabled, priority, weight, failureThreshold,
                connectTimeoutMs, readTimeoutMs, maxConcurrency, ProtocolStrategy.OPENAI_SMART);
    }

    @Transactional
    public long createEndpoint(String name, String provider, String baseUrl, String apiKey, boolean enabled,
                               int priority, int weight, int failureThreshold, int connectTimeoutMs,
                               int readTimeoutMs, int maxConcurrency, ProtocolStrategy strategy) {
        Long id = jdbc.queryForObject("select nextval('relay_configuration_id_seq')", Long.class);
        jdbc.update("""
                insert into relay_configuration(id, name, provider, base_url, api_key, enabled, priority,
                  weight, health_status, failure_count, failure_threshold, connect_timeout_ms,
                  read_timeout_ms, max_concurrency, protocol_strategy)
                values (?, ?, ?, ?, ?, ?, ?, ?, 'UNKNOWN', 0, ?, ?, ?, ?, ?)
                """, id, name, provider, baseUrl, apiKey, enabled, priority, weight, failureThreshold,
                connectTimeoutMs, readTimeoutMs, maxConcurrency, strategy.name());
        applyProtocolTemplate(id, strategy);
        return id;
    }

    @Transactional
    public int updateEndpoint(long id, long expectedVersion, String name, String provider, String baseUrl,
                              String apiKey, boolean enabled, int priority, int weight, int failureThreshold,
                              int connectTimeoutMs, int readTimeoutMs, int maxConcurrency) {
        return updateEndpoint(id, expectedVersion, name, provider, baseUrl, apiKey, enabled, priority, weight,
                failureThreshold, connectTimeoutMs, readTimeoutMs, maxConcurrency, ProtocolStrategy.OPENAI_SMART);
    }

    @Transactional
    public int updateEndpoint(long id, long expectedVersion, String name, String provider, String baseUrl,
                              String apiKey, boolean enabled, int priority, int weight, int failureThreshold,
                              int connectTimeoutMs, int readTimeoutMs, int maxConcurrency,
                              ProtocolStrategy strategy) {
        String previous = jdbc.query("select protocol_strategy from relay_configuration where id=?",
                rs -> rs.next() ? rs.getString(1) : null, id);
        int changed = jdbc.update("""
                update relay_configuration set name=?, provider=?, base_url=?, api_key=?, enabled=?,
                  priority=?, weight=?, failure_threshold=?, connect_timeout_ms=?, read_timeout_ms=?,
                  max_concurrency=?, protocol_strategy=?, health_status='UNKNOWN', failure_count=0, version=version+1,
                  updated_at=current_timestamp where id=? and version=?
                """, name, provider, baseUrl, apiKey, enabled, priority, weight, failureThreshold,
                connectTimeoutMs, readTimeoutMs, maxConcurrency, strategy.name(), id, expectedVersion);
        if (changed > 0 && !strategy.name().equals(previous)) {
            jdbc.update("delete from relay_configuration_protocol where configuration_id=?", id);
            applyProtocolTemplate(id, strategy);
        }
        return changed;
    }

    public int disableEndpoint(long id) {
        return jdbc.update("""
                update relay_configuration set enabled=false, health_status='UNKNOWN', version=version+1,
                  updated_at=current_timestamp where id=?
                """, id);
    }

    @Transactional
    public int deleteEndpoint(long id) {
        // Keep the order explicit: first detach all models (and their route prices
        // through the FK cascade), then physically remove the relay itself.
        jdbc.update("delete from relay_configuration_model where configuration_id=?", id);
        return jdbc.update("delete from relay_configuration where id=?", id);
    }

    public int setEndpointEnabled(long id, boolean enabled) {
        return jdbc.update("""
                update relay_configuration set enabled=?, health_status='UNKNOWN', failure_count=0,
                  version=version+1, updated_at=current_timestamp where id=?
                """, enabled, id);
    }

    public void markHealth(long id, boolean up, long latencyMs) {
        if (up) {
            jdbc.update("""
                    update relay_configuration set health_status='UP', failure_count=0,
                      last_health_check_at=current_timestamp, last_health_latency_ms=?,
                      last_success_at=current_timestamp where id=?
                    """, latencyMs, id);
        } else {
            jdbc.update("""
                    update relay_configuration set failure_count=failure_count+1,
                      health_status=case when failure_count+1 >= failure_threshold then 'DOWN' else health_status end,
                      last_health_check_at=current_timestamp, last_health_latency_ms=?,
                      last_failure_at=current_timestamp where id=?
                    """, latencyMs, id);
        }
    }

    public void markProtocolVerification(long configurationId, ProtocolCode code, boolean verified,
                                         String message) {
        jdbc.update("""
                update relay_configuration_protocol set verification_status=?,last_verified_at=current_timestamp,
                  last_verification_message=?,updated_at=current_timestamp
                where configuration_id=? and protocol_code=?
                """, verified ? "VERIFIED" : "FAILED",
                message == null ? null : message.substring(0, Math.min(2000, message.length())),
                configurationId, code.name());
    }

    public void recordRequestSuccess(long id) {
        jdbc.update("update relay_configuration set failure_count=0, health_status='UP', last_success_at=current_timestamp where id=?", id);
    }

    public void recordRequestFailure(long id) {
        jdbc.update("""
                update relay_configuration set failure_count=failure_count+1,
                  health_status=case when failure_count+1 >= failure_threshold then 'DOWN' else health_status end,
                  last_failure_at=current_timestamp where id=?
                """, id);
    }

    @Transactional
    public void replaceEndpointModels(long configurationId, List<RelayModel> discovered) {
        for (RelayModel model : discovered) {
            int updated = jdbc.update("""
                    update relay_model set
                      display_name=case when display_name=model_id then ? else display_name end,
                      enabled=true where model_id=?
                    """, model.displayName(), model.modelId());
            if (updated == 0) {
                jdbc.update("""
                        insert into relay_model(model_id, display_name, sort_order, enabled)
                        values (?, ?, (select coalesce(max(sort_order), -1) + 1 from relay_model), true)
                        """, model.modelId(), model.displayName());
            }
        }
        jdbc.update("delete from relay_configuration_model where configuration_id=?", configurationId);
        for (RelayModel model : discovered) {
            jdbc.update("""
                    insert into relay_configuration_model(configuration_id, model_id, upstream_model_id)
                    select ?, model_id, model_id from relay_model where model_id=?
                    """, configurationId, model.modelId());
        }
    }

    @Transactional
    public Set<String> replaceEndpointModelIds(long configurationId, List<String> modelIds) {
        if (findEndpoint(configurationId).isEmpty()) {
            throw new IllegalArgumentException("中转配置不存在");
        }
        List<String> models = modelIds.stream()
                .map(String::trim)
                .filter(value -> !value.isEmpty())
                .distinct()
                .map(value -> {
                    if (value.length() > 255) throw new IllegalArgumentException("模型 ID 不能超过 255 个字符");
                    Integer count = jdbc.queryForObject("select count(*) from relay_model where model_id=?", Integer.class, value);
                    if (count == null || count == 0) throw new IllegalArgumentException("模型不存在：" + value);
                    return value;
                }).toList();
        Set<String> retained = new LinkedHashSet<>(models);
        Set<String> existing = new LinkedHashSet<>(jdbc.queryForList(
                "select model_id from relay_configuration_model where configuration_id=?", String.class,
                configurationId));
        existing.stream().filter(id -> !retained.contains(id)).forEach(id ->
                jdbc.update("delete from relay_configuration_model where configuration_id=? and model_id=?",
                        configurationId, id));
        for (String modelId : models) if (!existing.contains(modelId)) jdbc.update("""
                insert into relay_configuration_model(configuration_id,model_id,upstream_model_id)
                values (?,?,?)
                """, configurationId, modelId, modelId);
        return retained;
    }

    @Transactional
    public void replaceProtocols(long configurationId, List<ProtocolSettings> values) {
        RelayEndpoint endpoint = findEndpoint(configurationId)
                .orElseThrow(() -> new IllegalArgumentException("中转配置不存在"));
        Map<ProtocolCode, RelayProtocol> existing = endpoint.protocols().stream()
                .collect(java.util.stream.Collectors.toMap(RelayProtocol::code, value -> value));
        Set<ProtocolCode> seen = new LinkedHashSet<>();
        for (ProtocolSettings value : values) {
            if (!seen.add(value.code())) throw new IllegalArgumentException("协议不能重复：" + value.code());
            String path = validateProtocolPath(value.pathOverride());
            RelayProtocol old = existing.get(value.code());
            Set<ProtocolCapability> capabilities = RelayProtocol.capabilities(value.textSupported(),
                    value.imageSupported(), value.pdfSupported(), value.toolUseSupported(),
                    value.toolResultSupported(), value.streamingSupported(), value.promptCacheSupported());
            boolean unchanged = old != null && old.enabled() == value.enabled() && old.priority() == value.priority()
                    && java.util.Objects.equals(old.pathOverride(), path) && old.capabilities().equals(capabilities);
            int changed = jdbc.update("""
                    update relay_configuration_protocol set enabled=?,priority=?,path_override=?,
                      text_supported=?,image_supported=?,pdf_supported=?,tool_use_supported=?,
                      tool_result_supported=?,streaming_supported=?,prompt_cache_supported=?,
                      verification_status=case when ? then verification_status else 'UNVERIFIED' end,
                      last_verified_at=case when ? then last_verified_at else null end,
                      last_verification_message=case when ? then last_verification_message else null end,
                      updated_at=current_timestamp where configuration_id=? and protocol_code=?
                    """, value.enabled(), value.priority(), path, value.textSupported(), value.imageSupported(),
                    value.pdfSupported(), value.toolUseSupported(), value.toolResultSupported(),
                    value.streamingSupported(), value.promptCacheSupported(), unchanged, unchanged, unchanged,
                    configurationId, value.code().name());
            if (changed == 0) jdbc.update("""
                    insert into relay_configuration_protocol(configuration_id,protocol_code,enabled,priority,
                      path_override,text_supported,image_supported,pdf_supported,tool_use_supported,
                      tool_result_supported,streaming_supported,prompt_cache_supported)
                    values (?,?,?,?,?,?,?,?,?,?,?,?)
                    """, configurationId, value.code().name(), value.enabled(), value.priority(), path,
                    value.textSupported(), value.imageSupported(), value.pdfSupported(), value.toolUseSupported(),
                    value.toolResultSupported(), value.streamingSupported(), value.promptCacheSupported());
        }
        if (!seen.isEmpty()) jdbc.update("delete from relay_configuration_protocol where configuration_id=? and protocol_code not in ("
                + String.join(",", java.util.Collections.nCopies(seen.size(), "?")) + ")",
                java.util.stream.Stream.concat(java.util.stream.Stream.of(configurationId),
                        seen.stream().map(Enum::name)).toArray());
    }

    public void invalidateProtocolVerification(long configurationId) {
        jdbc.update("""
                update relay_configuration_protocol set verification_status='UNVERIFIED',last_verified_at=null,
                  last_verification_message=null,updated_at=current_timestamp where configuration_id=?
                """, configurationId);
    }

    public static String validateProtocolPath(String value) {
        String path = value == null || value.isBlank() ? null : value.trim();
        if (path != null && (!path.startsWith("/") || path.contains("://") || path.contains("..")
                || path.contains("?") || path.contains("#") || path.contains("\\")
                || !path.matches("/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+"))) {
            throw new IllegalArgumentException("协议路径覆盖必须是以 /开头的相对路径");
        }
        return path;
    }

    private Map<Long, List<RelayProtocol>> protocolMap() {
        Map<Long, List<RelayProtocol>> result = new LinkedHashMap<>();
        jdbc.query("""
                select configuration_id,id,protocol_code,enabled,priority,path_override,
                  text_supported,image_supported,pdf_supported,tool_use_supported,tool_result_supported,
                  streaming_supported,prompt_cache_supported,verification_status,last_verified_at,
                  last_verification_message
                from relay_configuration_protocol order by configuration_id,priority,id
                """, (RowCallbackHandler) rs -> result.computeIfAbsent(rs.getLong("configuration_id"),
                ignored -> new java.util.ArrayList<>()).add(protocol(rs, false)));
        return result;
    }

    private Map<Long, Map<String, List<RelayProtocol>>> modelProtocolMap() {
        Map<Long, Map<String, List<RelayProtocol>>> result = new LinkedHashMap<>();
        jdbc.query("""
                select mp.configuration_id,mp.model_id,p.id,p.protocol_code,mp.enabled,mp.priority,
                  p.path_override,p.text_supported,p.image_supported,p.pdf_supported,p.tool_use_supported,
                  p.tool_result_supported,p.streaming_supported,p.prompt_cache_supported,
                  p.verification_status,p.last_verified_at,p.last_verification_message,mp.capabilities
                from relay_configuration_model_protocol mp
                join relay_configuration_protocol p on p.id=mp.protocol_id
                order by mp.configuration_id,mp.model_id,mp.priority,p.id
                """, (RowCallbackHandler) rs -> result.computeIfAbsent(rs.getLong("configuration_id"),
                        ignored -> new LinkedHashMap<>())
                .computeIfAbsent(rs.getString("model_id"), ignored -> new java.util.ArrayList<>())
                .add(protocol(rs, true)));
        return result;
    }

    private RelayProtocol protocol(ResultSet rs, boolean modelOverride) throws SQLException {
        var verified = rs.getTimestamp("last_verified_at");
        Set<cn.app.kiroproxy.protocol.ProtocolCapability> capabilities = RelayProtocol.capabilities(
                rs.getBoolean("text_supported"), rs.getBoolean("image_supported"),
                rs.getBoolean("pdf_supported"), rs.getBoolean("tool_use_supported"),
                rs.getBoolean("tool_result_supported"), rs.getBoolean("streaming_supported"),
                rs.getBoolean("prompt_cache_supported"));
        if (modelOverride) capabilities = overrideCapabilities(capabilities, rs.getString("capabilities"));
        return new RelayProtocol(rs.getLong("id"), ProtocolCode.valueOf(rs.getString("protocol_code")),
                rs.getBoolean("enabled"), rs.getInt("priority"), rs.getString("path_override"),
                capabilities, rs.getString("verification_status"),
                verified == null ? null : verified.toInstant(), rs.getString("last_verification_message"));
    }

    private Set<cn.app.kiroproxy.protocol.ProtocolCapability> overrideCapabilities(
            Set<cn.app.kiroproxy.protocol.ProtocolCapability> inherited, String json) {
        if (json == null || json.isBlank()) return inherited;
        try {
            JsonNode values = mapper.readTree(json);
            if (values.isTextual()) values = mapper.readTree(values.asText());
            java.util.EnumSet<cn.app.kiroproxy.protocol.ProtocolCapability> result = inherited.isEmpty()
                    ? java.util.EnumSet.noneOf(cn.app.kiroproxy.protocol.ProtocolCapability.class)
                    : java.util.EnumSet.copyOf(inherited);
            for (cn.app.kiroproxy.protocol.ProtocolCapability capability
                    : cn.app.kiroproxy.protocol.ProtocolCapability.values()) {
                String key = capability.name().toLowerCase(java.util.Locale.ROOT);
                if (values.path(key).isBoolean()) {
                    if (values.path(key).asBoolean()) result.add(capability); else result.remove(capability);
                }
            }
            return result;
        } catch (Exception error) {
            throw new IllegalStateException("模型协议能力覆盖 JSON 无效", error);
        }
    }

    private void applyProtocolTemplate(long configurationId, ProtocolStrategy strategy) {
        if (strategy == ProtocolStrategy.OPENAI_SMART) {
            insertProtocol(configurationId, ProtocolCode.OPENAI_RESPONSES, 10, true, true, true, true, true, true);
            insertProtocol(configurationId, ProtocolCode.OPENAI_CHAT_COMPLETIONS, 20, true, true, false, true, true, true);
        } else if (strategy == ProtocolStrategy.ANTHROPIC_SMART) {
            insertProtocol(configurationId, ProtocolCode.ANTHROPIC_MESSAGES, 10, true, true, true, true, true, true);
            insertProtocol(configurationId, ProtocolCode.OPENAI_CHAT_COMPLETIONS, 20, true, true, false, true, true, true);
        } else if (strategy == ProtocolStrategy.AUTO) {
            insertProtocol(configurationId, ProtocolCode.ANTHROPIC_MESSAGES, 10, true, true, true, true, true, true);
            insertProtocol(configurationId, ProtocolCode.OPENAI_RESPONSES, 20, true, true, true, true, true, true);
            insertProtocol(configurationId, ProtocolCode.OPENAI_CHAT_COMPLETIONS, 30, true, true, false, true, true, true);
        }
    }

    private void insertProtocol(long configurationId, ProtocolCode code, int priority, boolean text,
                                boolean image, boolean pdf, boolean toolUse, boolean toolResult,
                                boolean streaming) {
        jdbc.update("""
                insert into relay_configuration_protocol(configuration_id,protocol_code,enabled,priority,
                  text_supported,image_supported,pdf_supported,tool_use_supported,tool_result_supported,
                  streaming_supported,prompt_cache_supported)
                values (?,?,true,?,?,?,?,?,?,?,?)
                """, configurationId, code.name(), priority, text, image, pdf, toolUse, toolResult, streaming,
                code != ProtocolCode.OPENAI_CHAT_COMPLETIONS);
    }

    private static RelayEndpoint endpoint(ResultSet rs, Set<String> models,
                                           Map<String, RelayEndpoint.ModelRoute> routes,
                                           List<RelayProtocol> protocols,
                                           Map<String, List<RelayProtocol>> modelProtocols) throws SQLException {
        var checkedAt = rs.getTimestamp("last_health_check_at");
        long latency = rs.getLong("last_health_latency_ms");
        boolean latencyWasNull = rs.wasNull();
        return new RelayEndpoint(rs.getLong("id"), rs.getString("name"), rs.getString("provider"),
                rs.getString("base_url"), rs.getString("api_key"), rs.getBoolean("enabled"),
                rs.getInt("priority"), rs.getInt("weight"),
                RelayEndpoint.HealthStatus.valueOf(rs.getString("health_status")),
                rs.getInt("failure_count"), rs.getInt("failure_threshold"),
                rs.getInt("connect_timeout_ms"), rs.getInt("read_timeout_ms"),
                rs.getInt("max_concurrency"), rs.getLong("version"),
                checkedAt == null ? null : checkedAt.toInstant(), latencyWasNull ? null : latency, models, routes,
                rs.getTimestamp("last_success_at") == null ? null : rs.getTimestamp("last_success_at").toInstant(),
                ProtocolStrategy.valueOf(rs.getString("protocol_strategy")), protocols, modelProtocols);
    }

    private record PublicState(boolean enabled, boolean keyConfigured) {}

    public record TestModel(String modelId, String displayName, String upstreamModelId) {}

    public record ProtocolSettings(ProtocolCode code, boolean enabled, int priority, String pathOverride,
            boolean textSupported, boolean imageSupported, boolean pdfSupported, boolean toolUseSupported,
            boolean toolResultSupported, boolean streamingSupported, boolean promptCacheSupported) {
        public ProtocolSettings {
            if (code == null) throw new IllegalArgumentException("协议类型不能为空");
            if (priority < 0) throw new IllegalArgumentException("协议优先级不能小于 0");
            if (!textSupported) throw new IllegalArgumentException("第一版协议必须支持文本");
        }
    }
}
