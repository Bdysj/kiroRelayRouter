package cn.app.kiroproxy.api;

import cn.app.kiroproxy.auth.AccessTokenService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/admin/access")
public class AccessAdminController {
    private final JdbcTemplate jdbc;
    private final AccessTokenService tokens;

    @Autowired
    public AccessAdminController(JdbcTemplate jdbc, AccessTokenService tokens) {
        this.jdbc = jdbc;
        this.tokens = tokens;
    }

    /** 仅保留给旧调用方的源码兼容；管理接口鉴权已统一交给 Spring Security JWT 过滤链。 */
    @Deprecated
    public AccessAdminController(JdbcTemplate jdbc, AccessTokenService tokens, String ignoredLegacyToken) {
        this(jdbc, tokens);
    }

    @GetMapping("/groups")
    public PageResult<Map<String, Object>> groupPage(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "5") int pageSize,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) Boolean enabled) {
        validatePage(page, pageSize, 50);
        List<Object> arguments = new ArrayList<>();
        String where = groupFilters(keyword, enabled, arguments);
        Long total = jdbc.queryForObject("select count(*) from relay_access_group g" + where,
                Long.class, arguments.toArray());
        return pageResult(groupRows(pageSize, (page - 1L) * pageSize, where, arguments),
                total, page, pageSize);
    }

    /** Source-compatible overload for embedded callers and tests. */
    public PageResult<Map<String, Object>> groupPage(int page, int pageSize) {
        return groupPage(page, pageSize, null, null);
    }

    @GetMapping("/groups/options")
    public List<Map<String, Object>> groupOptions() {
        return groups();
    }

    /** Source-compatible unpaged view for embedded callers and tests. */
    public List<Map<String, Object>> groups() {
        return groupRows(null, null, "", List.of());
    }

    private List<Map<String, Object>> groupRows(Integer limit, Long offset, String where,
                                                 List<Object> filterArguments) {
        String sql = """
                select g.id, g.display_name, g.enabled,
                  g.created_at, g.updated_at, count(gm.model_id) model_count
                from relay_access_group g
                left join relay_access_group_model gm on gm.group_id = g.id
                """ + where + """
                group by g.id, g.display_name, g.enabled, g.created_at, g.updated_at
                order by g.id
                """ + (limit == null ? "" : " limit ? offset ?");
        var mapper = (org.springframework.jdbc.core.RowMapper<Map<String, Object>>) (rs, row) -> {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("id", rs.getLong("id"));
            value.put("displayName", rs.getString("display_name"));
            value.put("enabled", rs.getBoolean("enabled"));
            value.put("modelCount", rs.getLong("model_count"));
            value.put("createdAt", rs.getObject("created_at"));
            value.put("updatedAt", rs.getObject("updated_at"));
            return value;
        };
        List<Object> queryArguments = new ArrayList<>(filterArguments);
        if (limit != null) {
            queryArguments.add(limit);
            queryArguments.add(offset);
        }
        List<Map<String, Object>> groups = jdbc.query(sql, mapper, queryArguments.toArray());
        Map<Long, Map<String, Object>> groupsById = new LinkedHashMap<>();
        for (Map<String, Object> value : groups) {
            value.put("models", new ArrayList<String>());
            value.put("modelIds", new ArrayList<String>());
            value.put("modelMultipliers", new LinkedHashMap<String, BigDecimal>());
            groupsById.put(((Number) value.get("id")).longValue(), value);
        }
        if (!groupsById.isEmpty()) {
            String placeholders = String.join(",", java.util.Collections.nCopies(groupsById.size(), "?"));
            jdbc.query("""
                    select gm.group_id, gm.model_id, gm.billing_multiplier, m.display_name
                    from relay_access_group_model gm join relay_model m on m.model_id = gm.model_id
                    where gm.group_id in (""" + placeholders + ") order by gm.group_id, m.sort_order, m.model_id",
                    (org.springframework.jdbc.core.RowCallbackHandler) rs ->
                            appendGroupModel(groupsById.get(rs.getLong("group_id")),
                                    rs.getString("model_id"), rs.getString("display_name"),
                                    rs.getBigDecimal("billing_multiplier")),
                    groupsById.keySet().toArray());
        }
        return groups;
    }

    @SuppressWarnings("unchecked")
    private static void appendGroupModel(Map<String, Object> group, String modelId,
                                         String displayName, BigDecimal multiplier) {
        if (group == null) return;
        ((List<String>) group.get("models")).add(displayName);
        ((List<String>) group.get("modelIds")).add(modelId);
        ((Map<String, BigDecimal>) group.get("modelMultipliers")).put(modelId, multiplier);
    }

    private static String groupFilters(String keyword, Boolean enabled, List<Object> arguments) {
        List<String> filters = new ArrayList<>();
        if (keyword != null && !keyword.isBlank()) {
            filters.add("lower(g.display_name) like ?");
            arguments.add("%" + keyword.trim().toLowerCase(java.util.Locale.ROOT) + "%");
        }
        if (enabled != null) {
            filters.add("g.enabled = ?");
            arguments.add(enabled);
        }
        return filters.isEmpty() ? "" : " where " + String.join(" and ", filters);
    }

    @GetMapping("/summary")
    public Map<String, Object> summary() {
        return jdbc.queryForMap("""
                select
                  (select count(*) from relay_access_group) "groupTotal",
                  (select count(*) from relay_access_group where enabled=true) "enabledGroupTotal",
                  (select count(*) from relay_access_token) "tokenTotal",
                  (select count(*) from relay_access_token
                    where enabled=true and status='ACTIVE') "activeTokenTotal"
                """);
    }

    @PostMapping("/groups")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> createGroup(@Valid @RequestBody GroupRequest request) {
        var keyHolder = new GeneratedKeyHolder();
        jdbc.update(connection -> {
            var statement = connection.prepareStatement("""
                    insert into relay_access_group(display_name, enabled) values (?, ?)
                    """, new String[]{"id"});
            statement.setString(1, request.displayName().trim());
            statement.setBoolean(2, request.enabled());
            return statement;
        }, keyHolder);
        Number key = keyHolder.getKey();
        if (key == null) throw new IllegalStateException("无法获取新建分组 ID");
        long groupId = key.longValue();
        Map<String, BigDecimal> modelMultipliers = replaceGroupModels(groupId, request.models(), request.modelMultipliers());
        return groupResult(groupId, request, modelMultipliers);
    }

    @PutMapping("/groups/{id}")
    @Transactional
    public Map<String, Object> updateGroup(@PathVariable long id, @Valid @RequestBody GroupRequest request) {
        if (jdbc.update("""
                update relay_access_group set display_name=?, enabled=?,
                  updated_at=current_timestamp where id=?
                """, request.displayName().trim(), request.enabled(), id) == 0) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "访问分组不存在");
        }
        Map<String, BigDecimal> modelMultipliers = replaceGroupModels(id, request.models(), request.modelMultipliers());
        return groupResult(id, request, modelMultipliers);
    }

    private Map<String, BigDecimal> replaceGroupModels(long groupId, List<String> modelReferences,
                                                        Map<String, BigDecimal> requestedMultipliers) {
        jdbc.update("delete from relay_access_group_model where group_id = ?", groupId);
        Map<String, BigDecimal> savedMultipliers = new LinkedHashMap<>();
        for (String modelReference : modelReferences.stream().map(String::trim).distinct().toList()) {
            List<String> modelIds = jdbc.queryForList("""
                    select model_id from relay_model
                    where model_id = ? or display_name = ?
                    order by case when model_id = ? then 0 else 1 end, sort_order, model_id limit 1
                    """, String.class, modelReference, modelReference, modelReference);
            if (modelIds.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "未找到模型: " + modelReference);
            }
            String modelId = modelIds.get(0);
            BigDecimal multiplier = requestedMultipliers.getOrDefault(modelId,
                    requestedMultipliers.get(modelReference));
            if (multiplier == null || multiplier.signum() <= 0) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "请为模型 " + modelReference + " 配置大于 0 的模型倍率");
            }
            jdbc.update("insert into relay_access_group_model(group_id, model_id, billing_multiplier) values (?, ?, ?)",
                    groupId, modelId, multiplier);
            savedMultipliers.put(modelId, multiplier);
        }
        return savedMultipliers;
    }

    private static Map<String, Object> groupResult(long groupId, GroupRequest request,
                                                    Map<String, BigDecimal> modelMultipliers) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("id", groupId);
        result.put("displayName", request.displayName().trim());
        result.put("enabled", request.enabled());
        result.put("models", request.models());
        result.put("modelIds", List.copyOf(modelMultipliers.keySet()));
        result.put("modelMultipliers", modelMultipliers);
        result.put("modelCount", modelMultipliers.size());
        return result;
    }

    /**
     * 只改分组名称的窄接口。
     *
     * <p>{@code PUT /groups/{id}} 是全量覆盖语义，会连带走 {@link #replaceGroupModels} 重建模型权限，
     * 仅为了改个名字而提交整份权限存在把并发修改覆盖掉的风险，因此单独提供这个端点。
     * 分组名只作展示字段，所有外键都按 {@code id} 关联，改名不影响 Token 鉴权和计费流水。
     */
    @PutMapping("/groups/{id}/name")
    public Map<String, Object> renameGroup(@PathVariable long id,
            @Valid @RequestBody RenameGroupRequest request) {
        String displayName = request.displayName().trim();
        if (displayName.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "分组名称不能为空");
        }
        Long duplicate = jdbc.queryForObject("""
                select count(*) from relay_access_group where lower(display_name)=lower(?) and id<>?
                """, Long.class, displayName, id);
        if (duplicate != null && duplicate > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "已存在同名分组：" + displayName);
        }
        if (jdbc.update("""
                update relay_access_group set display_name=?, updated_at=current_timestamp where id=?
                """, displayName, id) == 0) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "访问分组不存在");
        }
        return Map.of("id", id, "displayName", displayName);
    }

    @PutMapping("/groups/{id}/enabled")
    public Map<String, Object> setGroupEnabled(@PathVariable long id,
            @Valid @RequestBody EnabledRequest request) {
        if (jdbc.update("""
                update relay_access_group set enabled = ?, updated_at = current_timestamp where id = ?
                """, request.enabled(), id) == 0) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "访问分组不存在");
        }
        return Map.of("id", id, "enabled", request.enabled());
    }

    @DeleteMapping("/groups/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Transactional
    public void deleteGroup(@PathVariable long id) {
        try {
            if (jdbc.update("delete from relay_access_group where id = ?", id) == 0) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "访问分组不存在");
            }
        } catch (DataIntegrityViolationException error) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "该分组仍有访问 Token 或计费流水关联，请先停用分组");
        }
    }

    @GetMapping("/tokens")
    public PageResult<Map<String, Object>> tokenPage(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "10") int pageSize,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) Long groupId,
            @RequestParam(required = false) Boolean enabled,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String deviceStatus) {
        validatePage(page, pageSize, 100);
        List<Object> filterArguments = new ArrayList<>();
        String where = tokenFilters(keyword, groupId, enabled, status, deviceStatus, filterArguments);
        Long total = jdbc.queryForObject("select count(*) from relay_access_token t" + where,
                Long.class, filterArguments.toArray());
        List<Object> pageArguments = new ArrayList<>(filterArguments);
        pageArguments.add(pageSize);
        pageArguments.add((page - 1L) * pageSize);
        List<Map<String, Object>> items = jdbc.query("""
                select t.id, t.label, t.token, g.id as group_id,
                  g.display_name as group_display_name, t.enabled, t.status, t.expires_at,
                  t.last_used_at, t.revoked_at, t.archived_at, t.created_at,
                  t.max_machine_bindings, t.bound_machine_count,
                  t.max_unbind_count, t.unbind_count,
                  (select count(*) from relay_access_group_model gm where gm.group_id=g.id) model_count,
                  (t.last_used_at is null
                    and not exists(select 1 from relay_usage_record u where u.access_token_id=t.id)
                    and not exists(select 1 from relay_access_token_machine m where m.access_token_id=t.id)
                    and not exists(select 1 from relay_point_ledger l where l.access_token_id=t.id
                      and l.event_key not in ('token:' || cast(t.id as varchar) || ':initial-grant',
                                              'token:' || cast(t.id as varchar) || ':migration-grant'))
                    and coalesce(w.version,0)=0 and coalesce(w.frozen_points,0)=0) can_hard_delete
                from relay_access_token t
                join relay_access_group g on g.id = t.group_id
                left join relay_token_wallet w on w.access_token_id=t.id
                """ + where + " order by t.id desc limit ? offset ?",
                (rs, row) -> {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("id", rs.getLong("id"));
            value.put("prefix", AccessTokenService.displayPrefix(rs.getString("token")));
            value.put("requiresReissue", rs.getString("token") == null);
            value.put("label", rs.getString("label"));
            value.put("groupId", rs.getLong("group_id"));
            value.put("groupDisplayName", rs.getString("group_display_name"));
            value.put("groupModelCount", rs.getLong("model_count"));
            value.put("enabled", rs.getBoolean("enabled"));
            value.put("status", effectiveStatus(rs.getString("status"), rs.getBoolean("enabled")));
            value.put("expiresAt", rs.getObject("expires_at"));
            value.put("lastUsedAt", rs.getObject("last_used_at"));
            value.put("revokedAt", rs.getObject("revoked_at"));
            value.put("archivedAt", rs.getObject("archived_at"));
            value.put("canHardDelete", rs.getBoolean("can_hard_delete"));
            value.put("createdAt", rs.getObject("created_at"));
            value.put("maxMachineBindings", rs.getInt("max_machine_bindings"));
            value.put("boundMachineCount", rs.getInt("bound_machine_count"));
            value.put("maxUnbindCount", rs.getInt("max_unbind_count"));
            value.put("unbindCount", rs.getInt("unbind_count"));
            value.put("remainingUnbindCount", rs.getInt("max_unbind_count") == 0 ? 0
                    : Math.max(0, rs.getInt("max_unbind_count") - rs.getInt("unbind_count")));
            return value;
        }, pageArguments.toArray());
        return pageResult(items, total, page, pageSize);
    }

    /** Source-compatible overload for embedded callers and tests. */
    public PageResult<Map<String, Object>> tokenPage(int page, int pageSize) {
        return tokenPage(page, pageSize, null, null, null, null, null);
    }

    /** Source-compatible overload for callers written before lifecycle status was added. */
    public PageResult<Map<String, Object>> tokenPage(int page, int pageSize, String keyword,
            Long groupId, Boolean enabled, String deviceStatus) {
        return tokenPage(page, pageSize, keyword, groupId, enabled, null, deviceStatus);
    }

    private static String tokenFilters(String keyword, Long groupId, Boolean enabled,
            String status, String deviceStatus, List<Object> arguments) {
        List<String> conditions = new ArrayList<>();
        if (status == null || status.isBlank() || "all".equalsIgnoreCase(status)) {
            conditions.add("t.status <> 'ARCHIVED'");
        } else {
            String normalizedStatus = status.trim().toUpperCase();
            if (!List.of("ACTIVE", "DISABLED", "REVOKED", "ARCHIVED").contains(normalizedStatus)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "无效的 Token 状态");
            }
            conditions.add("t.status = ?");
            arguments.add(normalizedStatus);
        }
        if (keyword != null && !keyword.isBlank()) {
            String like = "%" + keyword.trim().toLowerCase() + "%";
            conditions.add("(lower(t.label) like ? or lower(t.token) like ?)");
            arguments.add(like);
            arguments.add(like);
        }
        if (groupId != null) {
            conditions.add("t.group_id = ?");
            arguments.add(groupId);
        }
        if (enabled != null) {
            conditions.add("t.enabled = ?");
            arguments.add(enabled);
        }
        if (deviceStatus != null && !deviceStatus.isBlank() && !"all".equals(deviceStatus)) {
            switch (deviceStatus) {
                case "unbound" -> conditions.add("t.bound_machine_count = 0");
                case "bound" -> conditions.add("t.bound_machine_count > 0");
                case "limit" -> conditions.add(
                        "t.max_machine_bindings > 0 and t.bound_machine_count >= t.max_machine_bindings");
                default -> throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "无效的设备状态");
            }
        }
        return conditions.isEmpty() ? "" : " where " + String.join(" and ", conditions);
    }

    private static String effectiveStatus(String status, boolean enabled) {
        return "ACTIVE".equals(status) && !enabled ? "DISABLED" : status;
    }

    @GetMapping("/tokens/{id}/secret")
    public ResponseEntity<Map<String, Object>> tokenSecret(@PathVariable long id) {
        List<Map<String, Object>> rows = jdbc.query("""
                select id, token from relay_access_token where id=? and status <> 'ARCHIVED'
                """, (rs, row) -> {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("id", rs.getLong("id"));
            value.put("token", rs.getString("token"));
            value.put("requiresReissue", rs.getString("token") == null);
            return value;
        }, id);
        if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Token 不存在");
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(rows.get(0));
    }

    /** Source-compatible unpaged view for embedded callers and migration tests. */
    public List<Map<String, Object>> tokenList() {
        return jdbc.query("""
                select t.id, t.label, t.token, g.id as group_id,
                  g.display_name as group_display_name, t.enabled,
                  t.expires_at, t.last_used_at, t.created_at,
                  t.max_machine_bindings, t.bound_machine_count,
                  t.max_unbind_count, t.unbind_count,
                  coalesce(u.request_count, 0) request_count, coalesce(u.input_tokens, 0) input_tokens,
                  coalesce(u.cache_input_tokens, 0) cache_input_tokens,
                  coalesce(u.cache_write_input_tokens, 0) cache_write_input_tokens,
                  coalesce(u.output_tokens, 0) output_tokens,
                  coalesce(u.total_tokens, 0) total_tokens,
                  coalesce(u.provider_cost_usd, 0) provider_cost_usd,
                  coalesce(u.charged_points, 0) charged_points,
                  coalesce(w.available_points, 0) available_points,
                  coalesce(w.frozen_points, 0) frozen_points
                from relay_access_token t join relay_access_group g on g.id = t.group_id
                left join relay_token_wallet w on w.access_token_id = t.id
                left join (
                  select access_token_id, count(*) request_count, sum(input_tokens) input_tokens,
                    sum(cache_input_tokens) cache_input_tokens,
                    sum(cache_write_input_tokens) cache_write_input_tokens, sum(output_tokens) output_tokens,
                    sum(input_tokens + cache_input_tokens + cache_write_input_tokens + output_tokens) total_tokens,
                    sum(provider_cost_usd) provider_cost_usd, sum(charged_points) charged_points
                  from relay_usage_record group by access_token_id
                ) u on u.access_token_id = t.id where t.status <> 'ARCHIVED' order by t.id
                """, (rs, row) -> {
                    Map<String, Object> value = new LinkedHashMap<>();
                    value.put("id", rs.getLong("id"));
                    value.put("prefix", AccessTokenService.displayPrefix(rs.getString("token")));
                    value.put("token", rs.getString("token"));
                    value.put("requiresReissue", rs.getString("token") == null);
                    value.put("label", rs.getString("label"));
                    value.put("groupId", rs.getLong("group_id"));
                    value.put("groupDisplayName", rs.getString("group_display_name"));
                    value.put("enabled", rs.getBoolean("enabled"));
                    value.put("expiresAt", rs.getObject("expires_at"));
                    value.put("lastUsedAt", rs.getObject("last_used_at"));
                    value.put("createdAt", rs.getObject("created_at"));
                    value.put("maxMachineBindings", rs.getInt("max_machine_bindings"));
                    value.put("boundMachineCount", rs.getInt("bound_machine_count"));
                    value.put("maxUnbindCount", rs.getInt("max_unbind_count"));
                    value.put("unbindCount", rs.getInt("unbind_count"));
                    value.put("remainingUnbindCount", rs.getInt("max_unbind_count") == 0 ? 0
                            : Math.max(0, rs.getInt("max_unbind_count") - rs.getInt("unbind_count")));
                    value.put("availablePoints", rs.getBigDecimal("available_points"));
                    value.put("frozenPoints", rs.getBigDecimal("frozen_points"));
                    Map<String, Object> usage = new LinkedHashMap<>();
                    usage.put("requestCount", rs.getLong("request_count"));
                    usage.put("inputTokens", rs.getLong("input_tokens"));
                    usage.put("cacheInputTokens", rs.getLong("cache_input_tokens"));
                    usage.put("cacheWriteInputTokens", rs.getLong("cache_write_input_tokens"));
                    usage.put("outputTokens", rs.getLong("output_tokens"));
                    usage.put("totalTokens", rs.getLong("total_tokens"));
                    usage.put("providerCostUsd", rs.getBigDecimal("provider_cost_usd"));
                    usage.put("chargedPoints", rs.getBigDecimal("charged_points"));
                    value.put("usage", usage);
                    return value;
                });
    }

    @Deprecated
    public List<Map<String, Object>> tokenList(String ignoredLegacyToken) {
        return tokenList();
    }

    @PostMapping("/tokens")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> issue(@Valid @RequestBody IssueTokenRequest request) {
        long activeGroupId = requireActiveGroup(request.groupId());
        validateExpiry(request.expiresAt());
        return issueOne(request.label(), activeGroupId, request.enabled(), request.expiresAt(),
                request.initialPoints(), request.maxMachineBindings(), request.maxUnbindCount());
    }

    @PostMapping("/tokens/batch")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> issueBatch(@Valid @RequestBody BatchIssueTokenRequest request) {
        long activeGroupId = requireActiveGroup(request.groupId());
        validateExpiry(request.expiresAt());
        List<Map<String, Object>> issuedTokens = new ArrayList<>(request.quantity());
        for (int index = 1; index <= request.quantity(); index++) {
            String label = request.labelPrefix().trim() + "-" + String.format("%03d", index);
            issuedTokens.add(issueOne(label, activeGroupId, request.enabled(), request.expiresAt(),
                    request.initialPoints(), request.maxMachineBindings(), request.maxUnbindCount()));
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("quantity", issuedTokens.size());
        result.put("groupId", activeGroupId);
        result.put("items", issuedTokens);
        return result;
    }

    private long requireActiveGroup(long groupId) {
        List<Long> groupIds = jdbc.queryForList(
                "select id from relay_access_group where id = ? and enabled = true", Long.class, groupId);
        if (groupIds.isEmpty()) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "访问分组不存在或已停用");
        return groupIds.get(0);
    }

    private static void validateExpiry(Instant expiresAt) {
        if (expiresAt != null && !expiresAt.isAfter(Instant.now())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "过期时间必须晚于当前时间");
        }
    }

    private Map<String, Object> issueOne(String label, long groupId, boolean enabled, Instant expiresAt,
            BigDecimal initialPoints, int maxMachineBindings, int maxUnbindCount) {
        AccessTokenService.IssuedToken issued = tokens.issue(label.trim(), groupId,
                expiresAt, initialPoints, enabled, maxMachineBindings, maxUnbindCount);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("token", issued.token());
        result.put("prefix", issued.prefix());
        result.put("label", label.trim());
        result.put("groupId", groupId);
        result.put("enabled", enabled);
        result.put("expiresAt", expiresAt);
        result.put("initialPoints", issued.initialPoints());
        result.put("maxMachineBindings", maxMachineBindings);
        result.put("maxUnbindCount", maxUnbindCount);
        return result;
    }

    @PutMapping("/tokens/{id}/machine-limits")
    public Map<String, Object> updateMachineLimits(@PathVariable long id,
            @Valid @RequestBody MachineLimitsRequest request) {
        if (jdbc.update("""
                update relay_access_token set max_machine_bindings=?, max_unbind_count=?,
                  updated_at=current_timestamp where id=? and status in ('ACTIVE','DISABLED')
                """, request.maxMachineBindings(), request.maxUnbindCount(), id) == 0) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Token 不存在");
        }
        return Map.of("id", id, "maxMachineBindings", request.maxMachineBindings(),
                "maxUnbindCount", request.maxUnbindCount());
    }

    @PutMapping("/tokens/machine-limits")
    @Transactional
    public Map<String, Object> updateMachineLimitsBulk(
            @Valid @RequestBody BulkMachineLimitsRequest request) {
        int updated = 0;
        for (Long id : request.tokenIds().stream().distinct().toList()) {
            updated += jdbc.update("""
                    update relay_access_token set max_machine_bindings=?, max_unbind_count=?,
                      updated_at=current_timestamp where id=? and status in ('ACTIVE','DISABLED')
                    """, request.maxMachineBindings(), request.maxUnbindCount(), id);
        }
        return Map.of("updated", updated);
    }

    @PostMapping("/tokens/{id}/points")
    @Transactional
    public Map<String, Object> adjustPoints(@PathVariable long id,
            @Valid @RequestBody PointAdjustmentRequest request) {
        List<Map<String, Object>> wallets = jdbc.queryForList(
                "select available_points, frozen_points from relay_token_wallet where access_token_id=? for update", id);
        if (wallets.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Token钱包不存在");
        BigDecimal before = (BigDecimal) wallets.get(0).get("AVAILABLE_POINTS");
        BigDecimal frozen = (BigDecimal) wallets.get(0).get("FROZEN_POINTS");
        BigDecimal after = before.add(request.points());
        jdbc.update("update relay_token_wallet set available_points=?, version=version+1, updated_at=current_timestamp where access_token_id=?",
                after, id);
        String key = "token:" + id + ":adjust:" + java.util.UUID.randomUUID();
        jdbc.update("""
                insert into relay_point_ledger(event_key, access_token_id, entry_type, available_delta,
                  frozen_delta, available_after, frozen_after, note) values (?, ?, 'ADJUST', ?, 0, ?, ?, ?)
                """, key, id, request.points(), after, frozen, request.note());
        return Map.of("accessTokenId", id, "availablePoints", after, "frozenPoints", frozen);
    }

    @PutMapping("/tokens/{id}/status")
    @Transactional
    public Map<String, Object> setTokenStatus(@PathVariable long id,
            @Valid @RequestBody TokenStatusRequest request) {
        String target = request.status() == null ? "" : request.status().trim().toUpperCase();
        if (!List.of("ACTIVE", "DISABLED", "REVOKED").contains(target)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "状态只能是 ACTIVE、DISABLED 或 REVOKED");
        }
        List<String> currentRows = jdbc.queryForList(
                "select status from relay_access_token where id=? for update", String.class, id);
        if (currentRows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Token 不存在");
        String current = currentRows.get(0);
        if ("ARCHIVED".equals(current)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "归档 Token 不能修改状态");
        }
        if ("REVOKED".equals(current) && !"REVOKED".equals(target)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "永久撤销的 Token 不能恢复");
        }
        jdbc.update("""
                update relay_access_token set status=?, enabled=?,
                  revoked_at=case when ?='REVOKED' then coalesce(revoked_at,current_timestamp) else revoked_at end,
                  updated_at=current_timestamp where id=?
                """, target, "ACTIVE".equals(target), target, id);
        return Map.of("id", id, "status", target, "enabled", "ACTIVE".equals(target));
    }

    @PostMapping("/tokens/{id}/archive")
    @Transactional
    public Map<String, Object> archiveToken(@PathVariable long id) {
        if (jdbc.update("""
                update relay_access_token set status='ARCHIVED',enabled=false,
                  archived_at=coalesce(archived_at,current_timestamp),updated_at=current_timestamp where id=?
                """, id) == 0) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Token 不存在");
        }
        return Map.of("id", id, "status", "ARCHIVED", "enabled", false);
    }

    @DeleteMapping("/tokens/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Transactional
    public void hardDeleteToken(@PathVariable long id) {
        List<Long> rows = jdbc.queryForList(
                "select id from relay_access_token where id=? for update", Long.class, id);
        if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Token 不存在");
        Integer deletable = jdbc.queryForObject("""
                select count(*) from relay_access_token t
                left join relay_token_wallet w on w.access_token_id=t.id
                where t.id=? and t.last_used_at is null
                  and not exists(select 1 from relay_usage_record u where u.access_token_id=t.id)
                  and not exists(select 1 from relay_access_token_machine m where m.access_token_id=t.id)
                  and not exists(select 1 from relay_point_ledger l where l.access_token_id=t.id
                    and l.event_key not in ('token:' || cast(t.id as varchar) || ':initial-grant',
                                            'token:' || cast(t.id as varchar) || ':migration-grant'))
                  and coalesce(w.version,0)=0 and coalesce(w.frozen_points,0)=0
                """, Integer.class, id);
        if (deletable == null || deletable == 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "该 Token 已使用或存在用量、账本、钱包变更历史，只能归档，不能物理删除");
        }
        jdbc.update("delete from relay_access_token where id=?", id);
    }

    @GetMapping("/pricing")
    public List<Map<String, Object>> pricing() {
        return jdbc.queryForList("""
                select id, model_id, input_price, cache_input_price, cache_write_input_price,
                  output_price, pricing_unit, currency, price_source, effective_from, effective_to,
                  min_input_tokens, max_input_tokens, enabled, created_at, updated_at
                from relay_model_pricing order by model_id, effective_from desc, min_input_tokens, id desc
                """);
    }

    @PostMapping("/pricing")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> createPricing(@Valid @RequestBody PricingRequest request) {
        String currency = request.currency().trim().toUpperCase();
        if (!"USD".equals(currency)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "当前计费仅支持 USD");
        }
        Instant effectiveFrom = request.effectiveFrom() == null ? Instant.now() : request.effectiveFrom();
        if (request.effectiveTo() != null && !request.effectiveTo().isAfter(effectiveFrom)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "价格失效时间必须晚于生效时间");
        }
        if (request.maxInputTokens() != null && request.maxInputTokens() < request.minInputTokens()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "阶梯最大输入Token不能小于最小值");
        }
        int inserted = jdbc.update("""
                insert into relay_model_pricing(model_id, input_price, cache_input_price,
                  cache_write_input_price, output_price, pricing_unit, currency, price_source,
                  effective_from, effective_to, min_input_tokens, max_input_tokens, enabled)
                select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                where exists (select 1 from relay_model where model_id = ?)
                """, request.modelId().trim(), request.inputPrice(), request.cacheInputPrice(),
                request.cacheWriteInputPrice(), request.outputPrice(), request.pricingUnit(), currency,
                request.priceSource().trim(), Timestamp.from(effectiveFrom),
                request.effectiveTo() == null ? null : Timestamp.from(request.effectiveTo()),
                request.minInputTokens(), request.maxInputTokens(), request.enabled(),
                request.modelId().trim());
        if (inserted == 0) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "模型不存在");
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("modelId", request.modelId().trim());
        result.put("effectiveFrom", effectiveFrom);
        result.put("pricingUnit", request.pricingUnit());
        result.put("currency", currency);
        result.put("minInputTokens", request.minInputTokens());
        result.put("maxInputTokens", request.maxInputTokens());
        result.put("enabled", request.enabled());
        return result;
    }

    @GetMapping("/usage")
    public List<Map<String, Object>> usage(@RequestParam(required = false) Long accessTokenId,
            @RequestParam(defaultValue = "100") int limit) {
        if (limit < 1 || limit > 500) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "limit 必须在 1 到 500 之间");
        }
        String columns = """
                select u.id, u.request_id, u.access_token_id, t.label as token_label, u.group_id,
                  g.display_name as group_display_name, u.model_id, u.requested_model_id,
                  u.upstream_model_id, u.reported_model_id, u.upstream_model_source,
                  u.relay_configuration_id, u.input_tokens, u.cache_input_tokens,
                  u.cache_write_input_tokens, u.output_tokens, u.provider_cost_usd, u.tool_cost_usd,
                  u.points_per_usd, u.billing_multiplier, u.charged_points, u.status,
                  u.error_code, u.created_at, u.completed_at
                from relay_usage_record u
                join relay_access_token t on t.id = u.access_token_id
                join relay_access_group g on g.id = u.group_id
                """;
        if (accessTokenId == null) {
            return jdbc.queryForList(columns + " order by u.id desc limit ?", limit);
        }
        return jdbc.queryForList(columns + " where u.access_token_id = ? order by u.id desc limit ?",
                accessTokenId, limit);
    }

    @Deprecated
    public List<Map<String, Object>> usage(String ignoredLegacyToken, long accessTokenId, int limit) {
        return usage(Long.valueOf(accessTokenId), limit);
    }

    public record GroupRequest(@NotBlank @Size(max = 128) String displayName, boolean enabled,
                               List<@NotBlank String> models,
                               Map<String, BigDecimal> modelMultipliers) {
        /** Source-compatible constructor; production requests use one explicit rate per model. */
        public GroupRequest(String displayName, boolean enabled, List<String> models,
                            BigDecimal modelMultiplier) {
            this(displayName, enabled, models, models == null ? Map.of() : models.stream().collect(
                    java.util.stream.Collectors.toUnmodifiableMap(model -> model, ignored -> modelMultiplier)));
        }

        public GroupRequest {
            models = models == null ? List.of() : List.copyOf(models);
            modelMultipliers = modelMultipliers == null ? Map.of() : Map.copyOf(modelMultipliers);
        }
    }

    public record EnabledRequest(boolean enabled) {}

    /** 仅重命名分组；长度上界对齐 relay_access_group.display_name varchar(128)。 */
    public record RenameGroupRequest(@NotBlank @Size(max = 128) String displayName) {}

    public record TokenStatusRequest(@NotBlank String status) {}

    public record IssueTokenRequest(@NotBlank @Size(max = 128) String label, @Min(1) long groupId, boolean enabled,
                                    Instant expiresAt, @DecimalMin("0") BigDecimal initialPoints,
                                    @Min(0) Integer maxMachineBindings,
                                    @Min(0) Integer maxUnbindCount) {
        public IssueTokenRequest(String label, long groupId, boolean enabled,
                                 Instant expiresAt, BigDecimal initialPoints) {
            this(label, groupId, enabled, expiresAt, initialPoints, 2, 2);
        }

        public IssueTokenRequest {
            initialPoints = initialPoints == null ? new BigDecimal("100") : initialPoints;
            maxMachineBindings = maxMachineBindings == null ? 2 : maxMachineBindings;
            maxUnbindCount = maxUnbindCount == null ? 2 : maxUnbindCount;
        }
    }

    public record BatchIssueTokenRequest(@NotBlank @Size(max = 120) String labelPrefix,
                                         @Min(1) @Max(1000) int quantity,
                                         @Min(1) long groupId, boolean enabled,
                                         Instant expiresAt,
                                         @DecimalMin("0") BigDecimal initialPoints,
                                         @Min(0) Integer maxMachineBindings,
                                         @Min(0) Integer maxUnbindCount) {
        public BatchIssueTokenRequest {
            initialPoints = initialPoints == null ? new BigDecimal("100") : initialPoints;
            maxMachineBindings = maxMachineBindings == null ? 2 : maxMachineBindings;
            maxUnbindCount = maxUnbindCount == null ? 2 : maxUnbindCount;
        }
    }

    public record MachineLimitsRequest(@Min(0) int maxMachineBindings,
                                       @Min(0) int maxUnbindCount) {}

    public record BulkMachineLimitsRequest(List<@Min(1) Long> tokenIds,
                                           @Min(0) int maxMachineBindings,
                                           @Min(0) int maxUnbindCount) {
        public BulkMachineLimitsRequest {
            tokenIds = tokenIds == null ? List.of() : List.copyOf(tokenIds);
            if (tokenIds.isEmpty()) throw new IllegalArgumentException("请至少选择一个 Token");
        }
    }

    public record PointAdjustmentRequest(BigDecimal points, String note) {
        public PointAdjustmentRequest {
            if (points == null || points.signum() == 0) throw new IllegalArgumentException("调整积分不能为0");
            note = note == null || note.isBlank() ? "管理员手工调整" : note.trim();
        }
    }

    public record PageResult<T>(List<T> items, long total, int page, int pageSize, int totalPages) {}

    private static void validatePage(int page, int pageSize, int maximumPageSize) {
        if (page < 1) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "page 必须大于 0");
        if (pageSize < 1 || pageSize > maximumPageSize) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "pageSize 必须在 1 到 " + maximumPageSize + " 之间");
        }
    }

    private static <T> PageResult<T> pageResult(List<T> items, Long totalValue, int page, int pageSize) {
        long total = totalValue == null ? 0 : totalValue;
        int totalPages = Math.max(1, (int) Math.ceil(total / (double) pageSize));
        return new PageResult<>(items, total, page, pageSize, totalPages);
    }

    public record PricingRequest(@NotBlank String modelId,
                                 @DecimalMin("0") BigDecimal inputPrice,
                                 @DecimalMin("0") BigDecimal cacheInputPrice,
                                 @DecimalMin("0") BigDecimal cacheWriteInputPrice,
                                 @DecimalMin("0") BigDecimal outputPrice,
                                 @Min(1) long pricingUnit,
                                 @NotBlank String currency,
                                 @NotBlank String priceSource,
                                 Instant effectiveFrom, Instant effectiveTo,
                                 @Min(0) long minInputTokens, Long maxInputTokens, boolean enabled) {
        public PricingRequest {
            inputPrice = inputPrice == null ? BigDecimal.ZERO : inputPrice;
            cacheInputPrice = cacheInputPrice == null ? BigDecimal.ZERO : cacheInputPrice;
            cacheWriteInputPrice = cacheWriteInputPrice == null ? BigDecimal.ZERO : cacheWriteInputPrice;
            outputPrice = outputPrice == null ? BigDecimal.ZERO : outputPrice;
            pricingUnit = pricingUnit == 0 ? 1_000_000L : pricingUnit;
            currency = currency == null || currency.isBlank() ? "USD" : currency;
            priceSource = priceSource == null || priceSource.isBlank() ? "official" : priceSource;
        }
    }
}
