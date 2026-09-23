package cn.app.kiroproxy.api;

import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/admin/billing")
public class BillingAdminController {
    private final JdbcTemplate jdbc;

    public BillingAdminController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping
    public BillingReport report(
            @RequestParam(required = false) Instant from,
            @RequestParam(required = false) Instant to,
            @RequestParam(required = false) String modelId,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) Long relayId,
            @RequestParam(required = false) String keyword,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int pageSize) {
        if (page < 1) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "page 必须大于 0");
        if (pageSize < 1 || pageSize > 200) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "pageSize 必须在 1 到 200 之间");
        }
        Instant end = to == null ? Instant.now() : to;
        Instant start = from == null ? end.minus(30, ChronoUnit.DAYS) : from;
        if (!start.isBefore(end)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "开始时间必须早于结束时间");
        }

        StringBuilder where = new StringBuilder(" where u.created_at >= ? and u.created_at < ?");
        List<Object> args = new ArrayList<>();
        args.add(Timestamp.from(start));
        args.add(Timestamp.from(end));
        if (modelId != null && !modelId.isBlank()) {
            where.append(" and u.model_id = ?");
            args.add(modelId.trim());
        }
        if (status != null && !status.isBlank()) {
            where.append(" and u.status = ?");
            args.add(status.trim().toUpperCase());
        }
        if (relayId != null) {
            where.append(" and u.relay_configuration_id = ?");
            args.add(relayId);
        }
        if (keyword != null && !keyword.isBlank()) {
            where.append(" and (lower(u.request_id) like ? or lower(t.label) like ?)");
            String pattern = "%" + keyword.trim().toLowerCase() + "%";
            args.add(pattern);
            args.add(pattern);
        }

        String joins = """
                from relay_usage_record u
                join relay_access_token t on t.id = u.access_token_id
                join relay_access_group g on g.id = u.group_id
                left join relay_configuration r on r.id = u.relay_configuration_id
                """;
        Summary summary = jdbc.queryForObject("""
                select count(*) request_count,
                  coalesce(sum(u.input_tokens + u.cache_input_tokens + u.cache_write_input_tokens + u.output_tokens), 0) total_tokens,
                  coalesce(sum(u.provider_cost_usd), 0) provider_cost_usd,
                  coalesce(sum(u.charged_points), 0) charged_points,
                  coalesce(sum(case when u.status = 'SETTLED' then 1 else 0 end), 0) settled_count,
                  coalesce(sum(case when u.status in ('FAILED', 'UNPRICED', 'MISSING_USAGE') then 1 else 0 end), 0) exception_count
                """ + joins + where, (rs, row) -> new Summary(
                rs.getLong("request_count"), rs.getLong("total_tokens"),
                rs.getBigDecimal("provider_cost_usd"), rs.getBigDecimal("charged_points"),
                rs.getLong("settled_count"), rs.getLong("exception_count")), args.toArray());
        Long total = jdbc.queryForObject("select count(*) " + joins + where, Long.class, args.toArray());

        List<Object> pageArgs = new ArrayList<>(args);
        pageArgs.add(pageSize);
        pageArgs.add((page - 1L) * pageSize);
        List<UsageRecord> items = jdbc.query("""
                select u.id, u.request_id, u.access_token_id, t.label token_label,
                  g.id group_id, g.display_name group_display_name,
                  u.model_id, u.requested_model_id, u.upstream_model_id, u.reported_model_id,
                  u.upstream_model_source, u.protocol_code, u.relay_configuration_id, r.name relay_name, r.provider,
                  u.input_tokens, u.cache_input_tokens, u.cache_write_input_tokens, u.output_tokens,
                  u.provider_cost_usd, u.tool_cost_usd, u.charged_points, u.currency,
                  u.price_source, u.status, u.error_code, u.created_at, u.completed_at
                """ + joins + where + " order by u.created_at desc, u.id desc limit ? offset ?",
                BillingAdminController::mapRecord, pageArgs.toArray());
        return new BillingReport(start, end, summary, items, total == null ? 0 : total, page, pageSize);
    }

    @GetMapping("/analytics")
    public AnalyticsReport analytics(
            @RequestParam(required = false) Instant from,
            @RequestParam(required = false) Instant to,
            @RequestParam(required = false) Long relayId,
            @RequestParam(required = false) Long groupId,
            @RequestParam(required = false) Long tokenId) {
        Instant end = to == null ? Instant.now() : to;
        Instant start = from == null ? end.minus(30, ChronoUnit.DAYS) : from;
        validateRange(start, end);

        String joins = """
                from relay_usage_record u
                join relay_access_token t on t.id = u.access_token_id
                join relay_access_group g on g.id = u.group_id
                """;
        StringBuilder baseWhere = new StringBuilder(" where u.created_at >= ? and u.created_at < ?");
        List<Object> baseArgs = new ArrayList<>();
        baseArgs.add(Timestamp.from(start));
        baseArgs.add(Timestamp.from(end));
        if (relayId != null) {
            baseWhere.append(" and u.relay_configuration_id = ?");
            baseArgs.add(relayId);
        }

        Summary summary = jdbc.queryForObject("""
                select count(*) request_count,
                  coalesce(sum(u.input_tokens + u.cache_input_tokens + u.cache_write_input_tokens + u.output_tokens), 0) total_tokens,
                  coalesce(sum(u.provider_cost_usd), 0) provider_cost_usd,
                  coalesce(sum(u.charged_points), 0) charged_points,
                  coalesce(sum(case when u.status = 'SETTLED' then 1 else 0 end), 0) settled_count,
                  coalesce(sum(case when u.status in ('FAILED', 'UNPRICED', 'MISSING_USAGE') then 1 else 0 end), 0) exception_count
                """ + joins + baseWhere, (rs, row) -> mapSummary(rs), baseArgs.toArray());

        List<GroupTotal> groupTotals = jdbc.query("""
                select g.id group_id,g.display_name,count(*) request_count,
                  coalesce(sum(u.input_tokens + u.cache_input_tokens + u.cache_write_input_tokens + u.output_tokens),0) total_tokens,
                  coalesce(sum(u.provider_cost_usd),0) provider_cost_usd,
                  coalesce(sum(u.charged_points),0) charged_points,count(distinct u.access_token_id) token_count
                """ + joins + baseWhere + " group by g.id,g.display_name order by total_tokens desc,g.id",
                (rs, row) -> new GroupTotal(rs.getLong("group_id"), rs.getString("display_name"),
                        rs.getLong("request_count"), rs.getLong("total_tokens"),
                        rs.getBigDecimal("provider_cost_usd"), rs.getBigDecimal("charged_points"),
                        rs.getLong("token_count")), baseArgs.toArray());
        List<GroupDaily> groupDaily = jdbc.query("""
                select cast(u.created_at as date) usage_day,g.id group_id,g.display_name,count(*) request_count,
                  coalesce(sum(u.input_tokens + u.cache_input_tokens + u.cache_write_input_tokens + u.output_tokens),0) total_tokens,
                  coalesce(sum(u.provider_cost_usd),0) provider_cost_usd,coalesce(sum(u.charged_points),0) charged_points
                """ + joins + baseWhere + " group by cast(u.created_at as date),g.id,g.display_name order by usage_day,g.id",
                (rs, row) -> new GroupDaily(day(rs, "usage_day"), rs.getLong("group_id"),
                        rs.getString("display_name"), rs.getLong("request_count"), rs.getLong("total_tokens"),
                        rs.getBigDecimal("provider_cost_usd"), rs.getBigDecimal("charged_points")), baseArgs.toArray());

        StringBuilder tokenWhere = new StringBuilder(baseWhere);
        List<Object> tokenArgs = new ArrayList<>(baseArgs);
        if (groupId != null) {
            tokenWhere.append(" and u.group_id = ?");
            tokenArgs.add(groupId);
        }
        List<TokenTotal> tokenTotals = jdbc.query("""
                select t.id token_id,t.label,g.id group_id,g.display_name,t.status,count(*) request_count,
                  coalesce(sum(u.input_tokens + u.cache_input_tokens + u.cache_write_input_tokens + u.output_tokens),0) total_tokens,
                  coalesce(sum(u.provider_cost_usd),0) provider_cost_usd,coalesce(sum(u.charged_points),0) charged_points
                """ + joins + tokenWhere + " group by t.id,t.label,g.id,g.display_name,t.status order by total_tokens desc,t.id",
                (rs, row) -> new TokenTotal(rs.getLong("token_id"), rs.getString("label"), rs.getLong("group_id"),
                        rs.getString("display_name"), rs.getString("status"), rs.getLong("request_count"),
                        rs.getLong("total_tokens"), rs.getBigDecimal("provider_cost_usd"),
                        rs.getBigDecimal("charged_points")), tokenArgs.toArray());
        List<TokenDaily> tokenDaily = jdbc.query("""
                select cast(u.created_at as date) usage_day,t.id token_id,t.label,count(*) request_count,
                  coalesce(sum(u.input_tokens + u.cache_input_tokens + u.cache_write_input_tokens + u.output_tokens),0) total_tokens,
                  coalesce(sum(u.provider_cost_usd),0) provider_cost_usd,coalesce(sum(u.charged_points),0) charged_points
                """ + joins + tokenWhere + " group by cast(u.created_at as date),t.id,t.label order by usage_day,t.id",
                (rs, row) -> new TokenDaily(day(rs, "usage_day"), rs.getLong("token_id"), rs.getString("label"),
                        rs.getLong("request_count"), rs.getLong("total_tokens"),
                        rs.getBigDecimal("provider_cost_usd"), rs.getBigDecimal("charged_points")), tokenArgs.toArray());

        List<ModelTotal> modelTotals = List.of();
        List<ModelDaily> modelDaily = List.of();
        if (tokenId != null) {
            String modelWhere = tokenWhere + " and u.access_token_id = ?";
            List<Object> modelArgs = new ArrayList<>(tokenArgs);
            modelArgs.add(tokenId);
            modelTotals = jdbc.query("""
                    select u.model_id,count(*) request_count,
                      coalesce(sum(u.input_tokens + u.cache_input_tokens + u.cache_write_input_tokens + u.output_tokens),0) total_tokens,
                      coalesce(sum(u.provider_cost_usd),0) provider_cost_usd,coalesce(sum(u.charged_points),0) charged_points
                    """ + joins + modelWhere + " group by u.model_id order by total_tokens desc,u.model_id",
                    (rs, row) -> new ModelTotal(rs.getString("model_id"), rs.getLong("request_count"),
                            rs.getLong("total_tokens"), rs.getBigDecimal("provider_cost_usd"),
                            rs.getBigDecimal("charged_points")), modelArgs.toArray());
            modelDaily = jdbc.query("""
                    select cast(u.created_at as date) usage_day,u.model_id,count(*) request_count,
                      coalesce(sum(u.input_tokens + u.cache_input_tokens + u.cache_write_input_tokens + u.output_tokens),0) total_tokens,
                      coalesce(sum(u.provider_cost_usd),0) provider_cost_usd,coalesce(sum(u.charged_points),0) charged_points
                    """ + joins + modelWhere + " group by cast(u.created_at as date),u.model_id order by usage_day,u.model_id",
                    (rs, row) -> new ModelDaily(day(rs, "usage_day"), rs.getString("model_id"),
                            rs.getLong("request_count"), rs.getLong("total_tokens"),
                            rs.getBigDecimal("provider_cost_usd"), rs.getBigDecimal("charged_points")), modelArgs.toArray());
        }
        return new AnalyticsReport(start, end, summary, groupTotals, groupDaily, tokenTotals, tokenDaily,
                modelTotals, modelDaily);
    }

    private static void validateRange(Instant start, Instant end) {
        if (!start.isBefore(end))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "开始时间必须早于结束时间");
        if (start.isBefore(end.minus(366, ChronoUnit.DAYS)))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "统计范围不能超过 366 天");
    }

    private static Summary mapSummary(ResultSet rs) throws SQLException {
        return new Summary(rs.getLong("request_count"), rs.getLong("total_tokens"),
                rs.getBigDecimal("provider_cost_usd"), rs.getBigDecimal("charged_points"),
                rs.getLong("settled_count"), rs.getLong("exception_count"));
    }

    private static LocalDate day(ResultSet rs, String column) throws SQLException {
        return rs.getDate(column).toLocalDate();
    }

    private static UsageRecord mapRecord(ResultSet rs, int row) throws SQLException {
        Timestamp completedAt = rs.getTimestamp("completed_at");
        long input = rs.getLong("input_tokens");
        long cacheRead = rs.getLong("cache_input_tokens");
        long cacheWrite = rs.getLong("cache_write_input_tokens");
        long output = rs.getLong("output_tokens");
        return new UsageRecord(rs.getLong("id"), rs.getString("request_id"),
                rs.getLong("access_token_id"), rs.getString("token_label"), rs.getLong("group_id"),
                rs.getString("group_display_name"),
                rs.getString("model_id"), rs.getString("requested_model_id"),
                rs.getString("upstream_model_id"), rs.getString("reported_model_id"),
                rs.getString("upstream_model_source"), rs.getString("protocol_code"),
                (Long) rs.getObject("relay_configuration_id"),
                rs.getString("relay_name"), rs.getString("provider"), input, cacheRead, cacheWrite, output,
                input + cacheRead + cacheWrite + output, rs.getBigDecimal("provider_cost_usd"),
                rs.getBigDecimal("tool_cost_usd"), rs.getBigDecimal("charged_points"),
                rs.getString("currency"), rs.getString("price_source"), rs.getString("status"),
                rs.getString("error_code"), rs.getTimestamp("created_at").toInstant(),
                completedAt == null ? null : completedAt.toInstant());
    }

    public record BillingReport(Instant from, Instant to, Summary summary, List<UsageRecord> items,
                                long total, int page, int pageSize) {}
    public record AnalyticsReport(Instant from, Instant to, Summary summary,
                                  List<GroupTotal> groupTotals, List<GroupDaily> groupDaily,
                                  List<TokenTotal> tokenTotals, List<TokenDaily> tokenDaily,
                                  List<ModelTotal> modelTotals, List<ModelDaily> modelDaily) {}
    public record Summary(long requestCount, long totalTokens, BigDecimal providerCostUsd,
                          BigDecimal chargedPoints, long settledCount, long exceptionCount) {}
    public record GroupTotal(long groupId, String groupDisplayName, long requestCount, long totalTokens,
                             BigDecimal providerCostUsd, BigDecimal chargedPoints, long tokenCount) {}
    public record GroupDaily(LocalDate day, long groupId, String groupDisplayName, long requestCount,
                             long totalTokens, BigDecimal providerCostUsd, BigDecimal chargedPoints) {}
    public record TokenTotal(long tokenId, String tokenLabel, long groupId, String groupDisplayName,
                             String status, long requestCount, long totalTokens,
                             BigDecimal providerCostUsd, BigDecimal chargedPoints) {}
    public record TokenDaily(LocalDate day, long tokenId, String tokenLabel, long requestCount,
                             long totalTokens, BigDecimal providerCostUsd, BigDecimal chargedPoints) {}
    public record ModelTotal(String modelId, long requestCount, long totalTokens,
                             BigDecimal providerCostUsd, BigDecimal chargedPoints) {}
    public record ModelDaily(LocalDate day, String modelId, long requestCount, long totalTokens,
                             BigDecimal providerCostUsd, BigDecimal chargedPoints) {}
    public record UsageRecord(long id, String requestId, long accessTokenId, String tokenLabel,
                              long groupId, String groupDisplayName, String modelId,
                              String requestedModelId, String upstreamModelId, String reportedModelId,
                              String upstreamModelSource, String protocolCode,
                              Long relayConfigurationId, String relayName,
                              String provider, long inputTokens, long cacheInputTokens,
                              long cacheWriteInputTokens, long outputTokens, long totalTokens,
                              BigDecimal providerCostUsd, BigDecimal toolCostUsd, BigDecimal chargedPoints,
                              String currency, String priceSource, String status, String errorCode,
                              Instant createdAt, Instant completedAt) {}
}
