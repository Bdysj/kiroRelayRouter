package cn.app.kiroproxy.api;

import cn.app.kiroproxy.config.ReasoningAlertRepository;
import cn.app.kiroproxy.config.ReasoningSupportService;
import cn.app.kiroproxy.protocol.ReasoningEffort;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ModelAdminService {
    /** 重排时相邻模型的 sort_order 间隔，留出空位便于后续人工插值。 */
    public static final int SORT_ORDER_STEP = 10;

    private final JdbcTemplate jdbc;
    private final ReasoningSupportService reasoningSupport;
    private final ReasoningAlertRepository reasoningAlerts;

    public ModelAdminService(JdbcTemplate jdbc,
                             ObjectProvider<ReasoningSupportService> reasoningSupport,
                             ObjectProvider<ReasoningAlertRepository> reasoningAlerts) {
        this.jdbc = jdbc;
        this.reasoningSupport = reasoningSupport.getIfAvailable();
        this.reasoningAlerts = reasoningAlerts.getIfAvailable();
    }

    public List<ModelView> list() {
        return jdbc.query("""
                select m.model_id, m.display_name, m.sort_order, m.enabled,
                  m.max_input_tokens, m.max_output_tokens, m.reasoning_levels, m.reasoning_default_level,
                  (select count(*) from relay_access_group_model gm where gm.model_id=m.model_id) access_group_count
                from relay_model m order by m.sort_order, m.model_id
                """,
                (rs, row) -> new ModelView(rs.getString("model_id"), rs.getString("display_name"),
                        rs.getInt("sort_order"), rs.getBoolean("enabled"), rs.getLong("max_input_tokens"),
                        rs.getLong("max_output_tokens"),
                        ReasoningEffort.parseList(rs.getString("reasoning_levels")).stream()
                                .map(ReasoningEffort::wire).toList(),
                        ReasoningEffort.parse(rs.getString("reasoning_default_level"))
                                .map(ReasoningEffort::wire).orElse(null),
                        rs.getInt("access_group_count"),
                        prices(rs.getString("model_id")), bindings(rs.getString("model_id"))));
    }

    public ModelView get(String modelId) {
        return list().stream().filter(model -> model.modelId().equals(modelId)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("模型不存在"));
    }

    @Transactional
    public ModelView save(ModelRequest request) {
        String id = clean(request.modelId(), "模型 ID");
        requireCurrentPriceWhenEnabling(id, request.enabled());
        String name = request.displayName() == null || request.displayName().isBlank()
                ? id : request.displayName().trim();
        String reasoningLevels = String.join(",", request.reasoningLevels());
        int changed = jdbc.update("""
                update relay_model set display_name=?, sort_order=?, enabled=?, max_input_tokens=?,
                  max_output_tokens=?, reasoning_levels=?, reasoning_default_level=? where model_id=?
                """, name, request.sortOrder(), request.enabled(), request.maxInputTokens(),
                request.maxOutputTokens(), reasoningLevels, request.reasoningDefaultLevel(), id);
        if (changed == 0) jdbc.update("""
                insert into relay_model(model_id, display_name, sort_order, enabled, max_input_tokens,
                  max_output_tokens, reasoning_levels, reasoning_default_level) values (?,?,?,?,?,?,?,?)
                """, id, name, request.sortOrder(), request.enabled(), request.maxInputTokens(),
                request.maxOutputTokens(), reasoningLevels, request.reasoningDefaultLevel());
        return get(id);
    }

    /**
     * 按前端拖拽后的顺序整体重排 sort_order。
     *
     * <p>库里存量数据大量是默认值 0，单独改动某一行的 sort_order 无法在「全是 0」的集合里表达顺序，
     * 因此这里不做局部调整，而是一次性给<b>全部</b>模型重新编号：请求里给出的顺序排在前面，
     * 未出现在请求里的模型按当前次序接在后面。编号使用步长 {@value #SORT_ORDER_STEP}，
     * 留出空位便于后续人工微调，同时保证任意两行的 sort_order 严格递增且互不相同。
     */
    @Transactional
    public List<ModelView> reorder(ReorderRequest request) {
        List<String> requested = request.modelIds().stream().map(id -> clean(id, "模型 ID")).distinct().toList();
        for (String modelId : requested) requireModel(modelId);
        List<String> remaining = jdbc.queryForList(
                "select model_id from relay_model order by sort_order, model_id", String.class);
        List<String> ordered = new java.util.ArrayList<>(requested);
        java.util.Set<String> seen = new java.util.HashSet<>(requested);
        for (String modelId : remaining) if (seen.add(modelId)) ordered.add(modelId);

        List<Object[]> batch = new java.util.ArrayList<>(ordered.size());
        for (int index = 0; index < ordered.size(); index++) {
            batch.add(new Object[]{(index + 1) * SORT_ORDER_STEP, ordered.get(index)});
        }
        jdbc.batchUpdate("update relay_model set sort_order=? where model_id=?", batch);
        return list();
    }

    public void disable(String modelId) {
        if (jdbc.update("update relay_model set enabled=false where model_id=?", modelId) == 0)
            throw new IllegalArgumentException("模型不存在");
    }

    @Transactional
    public ModelView setEnabled(String modelId, boolean enabled) {
        requireModel(modelId);
        requireCurrentPriceWhenEnabling(modelId, enabled);
        if (jdbc.update("update relay_model set enabled=? where model_id=?", enabled, modelId) == 0)
            throw new IllegalArgumentException("模型不存在");
        return get(modelId);
    }

    private void requireCurrentPriceWhenEnabling(String modelId, boolean enabled) {
        if (!enabled) return;
        Integer prices = jdbc.queryForObject("""
                select count(*) from relay_model_pricing
                where model_id=? and enabled=true and effective_from<=current_timestamp
                  and (effective_to is null or effective_to>current_timestamp)
                """, Integer.class, modelId);
        if (prices == null || prices == 0) {
            throw new IllegalArgumentException("请先为模型配置当前有效的官方参考价，再启用模型");
        }
    }

    @Transactional
    public ModelView savePrice(String modelId, PricingRequest value) {
        requireModel(modelId);
        if (value.id() == null) {
            jdbc.update("""
                    insert into relay_model_pricing(model_id,input_price,cache_input_price,cache_write_input_price,
                      output_price,pricing_unit,currency,price_source,min_input_tokens,max_input_tokens,
                      effective_from,effective_to,enabled) values (?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """, modelId, value.inputPrice(), value.cacheInputPrice(), value.cacheWriteInputPrice(),
                    value.outputPrice(), value.pricingUnit(), "USD", clean(value.priceSource(), "价格来源"),
                    value.minInputTokens(), value.maxInputTokens(), Timestamp.from(value.effectiveFrom()),
                    timestamp(value.effectiveTo()), value.enabled());
        } else {
            int changed = jdbc.update("""
                    update relay_model_pricing set input_price=?,cache_input_price=?,cache_write_input_price=?,
                      output_price=?,pricing_unit=?,price_source=?,min_input_tokens=?,max_input_tokens=?,
                      effective_from=?,effective_to=?,enabled=?,updated_at=current_timestamp
                    where id=? and model_id=?
                    """, value.inputPrice(), value.cacheInputPrice(), value.cacheWriteInputPrice(), value.outputPrice(),
                    value.pricingUnit(), clean(value.priceSource(), "价格来源"), value.minInputTokens(),
                    value.maxInputTokens(), Timestamp.from(value.effectiveFrom()), timestamp(value.effectiveTo()),
                    value.enabled(), value.id(), modelId);
            if (changed == 0) throw new IllegalArgumentException("价格记录不存在");
        }
        return get(modelId);
    }

    public void deletePrice(String modelId, long id) {
        if (jdbc.update("delete from relay_model_pricing where id=? and model_id=?", id, modelId) == 0)
            throw new IllegalArgumentException("价格记录不存在");
    }

    @Transactional
    public ModelView saveBinding(String modelId, long configurationId, BindingRequest value) {
        requireModel(modelId);
        if (configurationId != value.configurationId()) throw new IllegalArgumentException("ID 不一致");
        upsertBinding(modelId, value);
        replaceBindingProtocols(modelId, configurationId, value.protocols());
        return get(modelId);
    }

    @Transactional
    public void removeBinding(String modelId, long configurationId) {
        if (jdbc.update("delete from relay_configuration_model where configuration_id=? and model_id=?",
                configurationId, modelId) == 0) throw new IllegalArgumentException("模型路由关系不存在");
    }

    @Transactional
    public void bulkRoutes(BulkRouteRequest request) {
        if (request.modelIds().isEmpty()) throw new IllegalArgumentException("请至少选择一个模型");
        Integer relayCount = jdbc.queryForObject("select count(*) from relay_configuration where id=?",
                Integer.class, request.configurationId());
        if (relayCount == null || relayCount == 0) throw new IllegalArgumentException("站点不存在");
        for (String modelId : request.modelIds().stream().distinct().toList()) {
            requireModel(modelId);
            Integer relationCount = jdbc.queryForObject("""
                    select count(*) from relay_configuration_model where configuration_id=? and model_id=?
                    """, Integer.class, request.configurationId(), modelId);
            if (relationCount == null || relationCount == 0) jdbc.update("""
                    insert into relay_configuration_model(configuration_id,model_id,upstream_model_id)
                    values (?,?,?)
                    """, request.configurationId(), modelId, modelId);
            if (request.enabled() != null) jdbc.update("""
                    update relay_configuration_model set enabled=?,updated_at=current_timestamp
                    where configuration_id=? and model_id=?
                    """, request.enabled(), request.configurationId(), modelId);
            if (request.setPriorityOverride()) jdbc.update("""
                    update relay_configuration_model set priority_override=?,updated_at=current_timestamp
                    where configuration_id=? and model_id=?
                    """, request.priorityOverride(), request.configurationId(), modelId);
            if (request.setWeightOverride()) jdbc.update("""
                    update relay_configuration_model set weight_override=?,updated_at=current_timestamp
                    where configuration_id=? and model_id=?
                    """, request.weightOverride(), request.configurationId(), modelId);
            if (request.clearCostPrice()) jdbc.update(
                    "delete from relay_configuration_model_pricing where configuration_id=? and model_id=?",
                    request.configurationId(), modelId);
            else if (request.costPrices() != null) {
                replaceCostPrices(modelId, request.configurationId(), request.costPrices().stream()
                        .map(p -> new PricingRequest(null, p.inputPrice(), p.cacheInputPrice(),
                                p.cacheWriteInputPrice(), p.outputPrice(), p.pricingUnit(), p.priceSource(),
                                p.minInputTokens(), p.maxInputTokens(), p.effectiveFrom(), p.effectiveTo(),
                                p.enabled()))
                        .toList());
            }
        }
    }

    @Transactional
    public BulkUnbindResult bulkRemoveBindings(BulkUnbindRequest request) {
        if (request.modelIds().isEmpty()) throw new IllegalArgumentException("请至少选择一个模型");
        Integer relayCount = jdbc.queryForObject("select count(*) from relay_configuration where id=?",
                Integer.class, request.configurationId());
        if (relayCount == null || relayCount == 0) throw new IllegalArgumentException("站点不存在");
        int removed = 0;
        for (String modelId : request.modelIds().stream().distinct().toList()) {
            requireModel(modelId);
            removed += jdbc.update("delete from relay_configuration_model where configuration_id=? and model_id=?",
                    request.configurationId(), modelId);
        }
        return new BulkUnbindResult(removed);
    }

    private void upsertBinding(String modelId, BindingRequest value) {
        String upstream = value.upstreamModelId() == null || value.upstreamModelId().isBlank()
                ? modelId : clean(value.upstreamModelId(), "上游模型 ID");
        Boolean previousDecision = jdbc.query("""
                select reasoning_enabled from relay_configuration_model
                where configuration_id=? and model_id=?
                """, rs -> rs.next() ? (Boolean) rs.getObject("reasoning_enabled") : null,
                value.configurationId(), modelId);
        int changed = jdbc.update("""
                update relay_configuration_model set upstream_model_id=?,enabled=?,priority_override=?,
                  weight_override=?,reasoning_enabled=?,updated_at=current_timestamp
                where configuration_id=? and model_id=?
                """, upstream, value.enabled(), value.priorityOverride(), value.weightOverride(),
                value.reasoningEnabled(), value.configurationId(), modelId);
        if (changed == 0) {
            int inserted = jdbc.update("""
                    insert into relay_configuration_model(configuration_id,model_id,upstream_model_id,enabled,
                      priority_override,weight_override,reasoning_enabled)
                    select id,?,?,?,?,?,? from relay_configuration where id=?
                    """, modelId, upstream, value.enabled(), value.priorityOverride(), value.weightOverride(),
                    value.reasoningEnabled(), value.configurationId());
            if (inserted == 0) throw new IllegalArgumentException("站点不存在");
        }
        // 管理员改了裁决就意味着他已经看过告警：清掉运行期学到的结论和未处理的告警，
        // 否则告警列表会堆满已经处理过的历史项，管理员很快就不看了。
        if (!java.util.Objects.equals(previousDecision, value.reasoningEnabled())) {
            if (reasoningSupport != null) reasoningSupport.clearRoute(value.configurationId(), upstream);
            if (reasoningAlerts != null) reasoningAlerts.resolveRoute(value.configurationId(), modelId);
        }
        replaceCostPrices(modelId, value.configurationId(), value.costPrices());
    }

    private void replaceBindingProtocols(String modelId, long configurationId,
                                         List<BindingProtocolRequest> protocols) {
        if (protocols == null) {
            jdbc.update("delete from relay_configuration_model_protocol where configuration_id=? and model_id=?",
                    configurationId, modelId);
            return;
        }
        jdbc.update("delete from relay_configuration_model_protocol where configuration_id=? and model_id=?",
                configurationId, modelId);
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (BindingProtocolRequest protocol : protocols) {
            if (!seen.add(protocol.code())) throw new IllegalArgumentException("模型协议不能重复");
            String capabilities;
            try {
                capabilities = protocol.capabilities() == null ? null
                        : new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(protocol.capabilities());
            } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
                throw new IllegalArgumentException("能力覆盖格式无效");
            }
            int inserted = jdbc.update("""
                    insert into relay_configuration_model_protocol(configuration_id,model_id,protocol_id,
                      enabled,priority,capabilities)
                    select ?,?,id,?,?,cast(? as json) from relay_configuration_protocol
                    where configuration_id=? and protocol_code=?
                    """, configurationId, modelId, protocol.enabled(), protocol.priority(), capabilities,
                    configurationId, protocol.code());
            if (inserted == 0) throw new IllegalArgumentException("中转站未配置协议：" + protocol.code());
        }
    }

    private void insertCostPrice(String modelId, long configurationId, PricingRequest value) {
        if (value.id() != null) {
            int changed = jdbc.update("""
                    update relay_configuration_model_pricing set input_price=?,cache_input_price=?,
                      cache_write_input_price=?,output_price=?,pricing_unit=?,price_source=?,min_input_tokens=?,
                      max_input_tokens=?,effective_from=?,effective_to=?,enabled=?,updated_at=current_timestamp
                    where id=? and configuration_id=? and model_id=?
                    """, value.inputPrice(), value.cacheInputPrice(), value.cacheWriteInputPrice(), value.outputPrice(),
                    value.pricingUnit(), clean(value.priceSource(), "价格来源"), value.minInputTokens(),
                    value.maxInputTokens(), Timestamp.from(value.effectiveFrom()), timestamp(value.effectiveTo()),
                    value.enabled(), value.id(), configurationId, modelId);
            if (changed == 0) throw new IllegalArgumentException("成本价记录不存在");
            return;
        }
        jdbc.update("""
                insert into relay_configuration_model_pricing(configuration_id,model_id,input_price,
                  cache_input_price,cache_write_input_price,output_price,pricing_unit,currency,price_source,
                  min_input_tokens,max_input_tokens,effective_from,effective_to,enabled)
                values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, configurationId, modelId, value.inputPrice(), value.cacheInputPrice(),
                value.cacheWriteInputPrice(), value.outputPrice(), value.pricingUnit(), "USD",
                clean(value.priceSource(), "价格来源"), value.minInputTokens(), value.maxInputTokens(),
                Timestamp.from(value.effectiveFrom()), timestamp(value.effectiveTo()), value.enabled());
    }

    private void replaceCostPrices(String modelId, long configurationId, List<PricingRequest> values) {
        List<PricingRequest> prices = values == null ? List.of() : values;
        List<Long> retainedIds = prices.stream().map(PricingRequest::id).filter(java.util.Objects::nonNull).toList();
        if (retainedIds.isEmpty()) {
            jdbc.update("delete from relay_configuration_model_pricing where configuration_id=? and model_id=?",
                    configurationId, modelId);
        } else {
            String placeholders = String.join(",", java.util.Collections.nCopies(retainedIds.size(), "?"));
            java.util.ArrayList<Object> args = new java.util.ArrayList<>();
            args.add(configurationId); args.add(modelId); args.addAll(retainedIds);
            jdbc.update("delete from relay_configuration_model_pricing where configuration_id=? and model_id=? "
                    + "and id not in (" + placeholders + ")", args.toArray());
        }
        for (PricingRequest value : prices) insertCostPrice(modelId, configurationId, value);
    }

    private List<PricingView> prices(String modelId) {
        return jdbc.query("""
                select id,input_price,cache_input_price,cache_write_input_price,output_price,pricing_unit,
                  currency,price_source,min_input_tokens,max_input_tokens,effective_from,effective_to,enabled
                from relay_model_pricing where model_id=? order by min_input_tokens,effective_from desc,id
                """, (rs, row) -> price(rs), modelId);
    }

    private List<BindingView> bindings(String modelId) {
        return jdbc.query("""
                select cm.configuration_id,c.name,c.provider,c.health_status,c.priority relay_priority,
                  c.weight relay_weight,c.protocol_strategy,cm.upstream_model_id,cm.enabled,cm.priority_override,
                  cm.weight_override,cm.reasoning_enabled
                from relay_configuration_model cm join relay_configuration c on c.id=cm.configuration_id
                where cm.model_id=? order by c.priority,c.id
                """, (rs, row) -> new BindingView(rs.getLong("configuration_id"), rs.getString("name"),
                        rs.getString("provider"), rs.getString("health_status"), rs.getInt("relay_priority"),
                        rs.getInt("relay_weight"), rs.getString("upstream_model_id"), rs.getBoolean("enabled"),
                        (Integer) rs.getObject("priority_override"), (Integer) rs.getObject("weight_override"),
                        (Boolean) rs.getObject("reasoning_enabled"),
                        costPrices(rs.getLong("configuration_id"), modelId), rs.getString("protocol_strategy"),
                        bindingProtocols(rs.getLong("configuration_id"), modelId)), modelId);
    }

    private List<PricingView> costPrices(long configurationId, String modelId) {
        return jdbc.query("""
                select id,input_price,cache_input_price,cache_write_input_price,output_price,pricing_unit,
                  currency,price_source,min_input_tokens,max_input_tokens,effective_from,effective_to,enabled
                from relay_configuration_model_pricing where configuration_id=? and model_id=?
                order by min_input_tokens,effective_from desc,id
                """, (rs, row) -> price(rs), configurationId, modelId);
    }

    private List<BindingProtocolView> bindingProtocols(long configurationId, String modelId) {
        return jdbc.query("""
                select p.protocol_code,mp.enabled,mp.priority,mp.capabilities
                from relay_configuration_model_protocol mp
                join relay_configuration_protocol p on p.id=mp.protocol_id
                where mp.configuration_id=? and mp.model_id=? order by mp.priority,p.protocol_code
                """, (rs, row) -> new BindingProtocolView(rs.getString("protocol_code"), rs.getBoolean("enabled"),
                rs.getInt("priority"), parseCapabilities(rs.getString("capabilities"))), configurationId, modelId);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Boolean> parseCapabilities(String value) {
        if (value == null || value.isBlank()) return null;
        try {
            var mapper = new com.fasterxml.jackson.databind.ObjectMapper();
            var node = mapper.readTree(value);
            if (node.isTextual()) node = mapper.readTree(node.asText());
            return mapper.convertValue(node, Map.class);
        }
        catch (Exception ignored) { return null; }
    }

    private static PricingView price(java.sql.ResultSet rs) throws java.sql.SQLException {
        Timestamp to = rs.getTimestamp("effective_to");
        String enabledColumn;
        try { rs.findColumn("price_enabled"); enabledColumn = "price_enabled"; }
        catch (java.sql.SQLException ignored) { enabledColumn = "enabled"; }
        return new PricingView(rs.getLong("id"), rs.getBigDecimal("input_price"),
                rs.getBigDecimal("cache_input_price"), rs.getBigDecimal("cache_write_input_price"),
                rs.getBigDecimal("output_price"), rs.getLong("pricing_unit"), rs.getString("currency"),
                rs.getString("price_source"), rs.getLong("min_input_tokens"),
                (Long) rs.getObject("max_input_tokens"), rs.getTimestamp("effective_from").toInstant(),
                to == null ? null : to.toInstant(), rs.getBoolean(enabledColumn));
    }

    private void requireModel(String id) {
        Integer count = jdbc.queryForObject("select count(*) from relay_model where model_id=?", Integer.class, id);
        if (count == null || count == 0) throw new IllegalArgumentException("模型不存在");
    }
    private static String clean(String value, String label) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(label + "不能为空");
        String result = value.trim();
        if (result.length() > 255) throw new IllegalArgumentException(label + "不能超过 255 个字符");
        return result;
    }
    private static Timestamp timestamp(Instant value) { return value == null ? null : Timestamp.from(value); }

    /** 价格允许的小数位数，与 relay_*_pricing 的 numeric(30,12) 保持一致。 */
    public static final int PRICE_SCALE = 12;
    /** numeric(30,12) 的绝对值上界（不含），即 10^18。 */
    private static final BigDecimal PRICE_LIMIT = BigDecimal.TEN.pow(30 - PRICE_SCALE);

    /**
     * 把请求里的价格收敛到数据库标度。前端允许输入高精度小数，这里显式四舍五入，
     * 避免 JDBC/PostgreSQL 在落库时静默截断，同时对超出存储范围的数值给出明确的 400。
     */
    private static BigDecimal normalizePrice(BigDecimal value, String label) {
        if (value == null) return BigDecimal.ZERO.setScale(PRICE_SCALE);
        if (value.abs().compareTo(PRICE_LIMIT) >= 0)
            throw new IllegalArgumentException(label + "超出可存储范围，整数部分最多 18 位");
        return value.setScale(PRICE_SCALE, java.math.RoundingMode.HALF_UP);
    }

    public record ModelView(String modelId, String displayName, int sortOrder, boolean enabled,
                            long maxInputTokens, long maxOutputTokens,
                            List<String> reasoningLevels, String reasoningDefaultLevel, int accessGroupCount,
                            List<PricingView> referencePrices, List<BindingView> bindings) {}
    public record PricingView(long id, BigDecimal inputPrice, BigDecimal cacheInputPrice,
                              BigDecimal cacheWriteInputPrice, BigDecimal outputPrice, long pricingUnit,
                              String currency, String priceSource, long minInputTokens, Long maxInputTokens,
                              Instant effectiveFrom, Instant effectiveTo, boolean enabled) {}
    public record BindingView(long configurationId, String configurationName, String provider, String healthStatus,
                              int relayPriority, int relayWeight, String upstreamModelId, boolean enabled,
                              Integer priorityOverride, Integer weightOverride, Boolean reasoningEnabled,
                              List<PricingView> costPrices, String protocolStrategy,
                              List<BindingProtocolView> protocols) {}
    public record BindingProtocolView(String code, boolean enabled, int priority,
                                      Map<String, Boolean> capabilities) {}
    public record ModelRequest(String modelId, String displayName, int sortOrder, boolean enabled,
                               long maxInputTokens, long maxOutputTokens,
                               List<String> reasoningLevels, String reasoningDefaultLevel) {
        public ModelRequest {
            if (sortOrder < 0) throw new IllegalArgumentException("排序值不能小于 0");
            if (maxInputTokens <= 0) throw new IllegalArgumentException("最大上下文窗口必须大于 0");
            if (maxOutputTokens <= 0) throw new IllegalArgumentException("最大输出 Tokens 必须大于 0");
            // 写入侧严格校验：未知档位直接拒绝，避免脏值进库后在模型列表里被静默忽略。
            List<ReasoningEffort> levels = reasoningLevels == null ? List.of()
                    : reasoningLevels.stream()
                            .map(value -> ReasoningEffort.parse(value).orElseThrow(
                                    () -> new IllegalArgumentException("未知的推理强度档位：" + value)))
                            .distinct().sorted().toList();
            ReasoningEffort parsedDefault = ReasoningEffort.parse(reasoningDefaultLevel).orElse(null);
            if (reasoningDefaultLevel != null && !reasoningDefaultLevel.isBlank() && parsedDefault == null)
                throw new IllegalArgumentException("未知的默认推理强度档位：" + reasoningDefaultLevel);
            if (parsedDefault != null && !levels.contains(parsedDefault))
                throw new IllegalArgumentException("默认推理强度档位必须在已选档位中");
            reasoningLevels = levels.stream().map(ReasoningEffort::wire).toList();
            reasoningDefaultLevel = parsedDefault == null ? null : parsedDefault.wire();
        }
    }
    public record PricingRequest(Long id, BigDecimal inputPrice, BigDecimal cacheInputPrice,
                                 BigDecimal cacheWriteInputPrice, BigDecimal outputPrice, long pricingUnit,
                                 String priceSource, long minInputTokens, Long maxInputTokens,
                                 Instant effectiveFrom, Instant effectiveTo, boolean enabled) {
        public PricingRequest {
            inputPrice = normalizePrice(inputPrice, "输入价");
            cacheInputPrice = normalizePrice(cacheInputPrice, "缓存读取价");
            cacheWriteInputPrice = normalizePrice(cacheWriteInputPrice, "缓存写入价");
            outputPrice = normalizePrice(outputPrice, "输出价");
            priceSource = priceSource == null || priceSource.isBlank() ? "manual" : priceSource;
            effectiveFrom = effectiveFrom == null ? Instant.now() : effectiveFrom;
            if (inputPrice.signum() < 0 || cacheInputPrice.signum() < 0 || cacheWriteInputPrice.signum() < 0
                    || outputPrice.signum() < 0) throw new IllegalArgumentException("价格不能为负数");
            if (pricingUnit <= 0) throw new IllegalArgumentException("定价 Token 单位必须大于 0");
            if (minInputTokens < 0 || maxInputTokens != null && maxInputTokens < minInputTokens)
                throw new IllegalArgumentException("价格阶梯范围无效");
            if (effectiveTo != null && !effectiveTo.isAfter(effectiveFrom))
                throw new IllegalArgumentException("失效时间必须晚于生效时间");
        }
    }
    public record BindingRequest(long configurationId, String upstreamModelId, boolean enabled,
                                 Integer priorityOverride, Integer weightOverride, Boolean reasoningEnabled,
                                 List<PricingRequest> costPrices,
                                 List<BindingProtocolRequest> protocols) {
        public BindingRequest {
            if (priorityOverride != null && priorityOverride < 0)
                throw new IllegalArgumentException("优先级覆盖不能小于 0");
            if (weightOverride != null && weightOverride <= 0)
                throw new IllegalArgumentException("权重覆盖必须大于 0");
        }
    }
    public record BindingProtocolRequest(String code, boolean enabled, int priority,
                                         Map<String, Boolean> capabilities) {
        public BindingProtocolRequest {
            try { cn.app.kiroproxy.protocol.ProtocolCode.valueOf(code); }
            catch (Exception error) { throw new IllegalArgumentException("未知协议：" + code); }
            if (priority < 0) throw new IllegalArgumentException("模型协议优先级不能小于 0");
        }
    }
    public record BulkRouteRequest(List<String> modelIds, long configurationId, Boolean enabled,
                                   boolean setPriorityOverride, Integer priorityOverride,
                                   boolean setWeightOverride, Integer weightOverride,
                                   List<PricingRequest> costPrices, boolean clearCostPrice) {
        public BulkRouteRequest {
            modelIds = modelIds == null ? List.of() : List.copyOf(modelIds);
            if (priorityOverride != null && priorityOverride < 0)
                throw new IllegalArgumentException("优先级覆盖不能小于 0");
            if (weightOverride != null && weightOverride <= 0)
                throw new IllegalArgumentException("权重覆盖必须大于 0");
        }
    }
    public record BulkUnbindRequest(List<String> modelIds, long configurationId) {
        public BulkUnbindRequest {
            modelIds = modelIds == null ? List.of() : List.copyOf(modelIds);
        }
    }
    /** 拖拽排序后的完整模型顺序；列表首位排最前。 */
    public record ReorderRequest(List<String> modelIds) {
        public ReorderRequest {
            modelIds = modelIds == null ? List.of() : List.copyOf(modelIds);
            if (modelIds.isEmpty()) throw new IllegalArgumentException("请至少提供一个模型 ID");
        }
    }
    public record BulkUnbindResult(int removed) {}
}
