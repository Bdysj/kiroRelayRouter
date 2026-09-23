package cn.app.kiroproxy.billing;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

@Service
public class BillingRuleService {
    public static final String CACHE_KEY = "billing:rule:current";
    private static final Logger log = LoggerFactory.getLogger(BillingRuleService.class);
    private final JdbcTemplate jdbc;
    private final StringRedisTemplate redis;
    private final ObjectMapper mapper;

    @Autowired
    public BillingRuleService(JdbcTemplate jdbc, StringRedisTemplate redis, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.redis = redis;
        this.mapper = mapper;
    }

    public BillingRule current() {
        BillingRule cached = readCache();
        if (cached != null) return cached;
        BillingRule current = loadSingleCurrent(false);
        writeCache(current);
        return current;
    }

    public List<BillingRule> history() {
        return jdbc.query("""
                select id, version, points_per_usd, effective_from, effective_to,
                       enabled, created_at, updated_at
                from relay_billing_rule order by version desc
                """, BillingRuleService::mapRule);
    }

    public List<BillingRule> history(int page, int pageSize) {
        return jdbc.query("""
                select id, version, points_per_usd, effective_from, effective_to,
                       enabled, created_at, updated_at
                from relay_billing_rule order by version desc
                limit ? offset ?
                """, BillingRuleService::mapRule, pageSize, (page - 1L) * pageSize);
    }

    @Transactional
    public BillingRule createVersion(BigDecimal requestedPointsPerUsd) {
        BigDecimal pointsPerUsd = normalizePositive(requestedPointsPerUsd, "pointsPerUsd");
        BillingRule old = loadSingleCurrent(true);
        Instant now = Instant.now();
        jdbc.update("""
                update relay_billing_rule
                set effective_to=?, updated_at=?
                where id=? and effective_to is null and enabled=true
                """, Timestamp.from(now), Timestamp.from(now), old.id());
        long nextVersion = old.version() + 1;
        jdbc.update("""
                insert into relay_billing_rule(version, points_per_usd, effective_from,
                  enabled, created_at, updated_at)
                values (?, ?, ?, true, ?, ?)
                """, nextVersion, pointsPerUsd, Timestamp.from(now),
                Timestamp.from(now), Timestamp.from(now));
        BillingRule created = jdbc.queryForObject("""
                select id, version, points_per_usd, effective_from, effective_to,
                       enabled, created_at, updated_at
                from relay_billing_rule where version=?
                """, BillingRuleService::mapRule, nextVersion);
        refreshAfterCommit(created);
        return created;
    }

    public Simulation simulate(BigDecimal providerCostUsd, BigDecimal billingMultiplier) {
        BigDecimal cost = normalizeNonnegative(providerCostUsd, "providerCostUsd");
        BigDecimal multiplier = normalizePositive(billingMultiplier, "billingMultiplier");
        BigDecimal pointsPerUsd = current().pointsPerUsd();
        BigDecimal basePoints = cost.multiply(pointsPerUsd).setScale(8, RoundingMode.HALF_UP);
        BigDecimal chargedPoints = basePoints.multiply(multiplier).setScale(8, RoundingMode.HALF_UP);
        return new Simulation(cost, pointsPerUsd, basePoints, multiplier, chargedPoints);
    }

    public BillingSnapshot createSnapshot(String requestId, Long configurationId, String modelId,
                                          BigDecimal inputPrice, BigDecimal cacheReadPrice,
                                          BigDecimal cacheWritePrice, BigDecimal outputPrice,
                                          long pricingUnit, String currency, String priceSource,
                                          long priceTierMinInputTokens, BigDecimal billingMultiplier) {
        BillingRule rule;
        try {
            rule = current();
        } catch (RuntimeException error) {
            log.error("BILLING_RULE_UNAVAILABLE request={} reason={}", requestId,
                    error.getClass().getSimpleName());
            throw new BillingRuleUnavailableException("BILLING_RULE_UNAVAILABLE",
                    "当前没有可用的积分计费规则，本次请求已拒绝。", error);
        }
        return new BillingSnapshot(requestId, configurationId, modelId, inputPrice,
                cacheReadPrice, cacheWritePrice, outputPrice, pricingUnit,
                currency, priceSource, priceTierMinInputTokens, rule.pointsPerUsd(),
                billingMultiplier, rule.id(), rule.version());
    }

    private BillingRule loadSingleCurrent(boolean forUpdate) {
        try {
            List<BillingRule> rules = jdbc.query("""
                    select id, version, points_per_usd, effective_from, effective_to,
                           enabled, created_at, updated_at
                    from relay_billing_rule
                    where enabled=true and effective_from <= current_timestamp
                      and (effective_to is null or effective_to > current_timestamp)
                    order by version desc limit 2
                    """ + (forUpdate ? " for update" : ""), BillingRuleService::mapRule);
            if (rules.size() != 1) {
                log.error("BILLING_RULE_UNAVAILABLE active_rule_count={}", rules.size());
                throw new BillingRuleUnavailableException("BILLING_RULE_UNAVAILABLE",
                        rules.isEmpty() ? "当前没有有效的积分计费规则" : "检测到多个同时生效的积分计费规则");
            }
            return rules.get(0);
        } catch (BillingRuleUnavailableException error) {
            throw error;
        } catch (RuntimeException error) {
            log.error("BILLING_RULE_UNAVAILABLE database lookup failed reason={}",
                    error.getClass().getSimpleName());
            throw new BillingRuleUnavailableException("BILLING_RULE_UNAVAILABLE",
                    "积分计费规则暂时不可用", error);
        }
    }

    private BillingRule readCache() {
        if (redis == null) return null;
        try {
            String value = redis.opsForValue().get(CACHE_KEY);
            if (value == null || value.isBlank()) return null;
            JsonNode node = mapper.readTree(value);
            BigDecimal points = new BigDecimal(node.path("pointsPerUsd").asText());
            if (points.signum() <= 0) throw new IllegalArgumentException("invalid cached rate");
            return new BillingRule(node.path("id").asLong(), node.path("version").asLong(),
                    points, Instant.parse(node.path("effectiveFrom").asText()), null, true,
                    Instant.parse(node.path("createdAt").asText()),
                    Instant.parse(node.path("updatedAt").asText()));
        } catch (RuntimeException | java.io.IOException error) {
            log.warn("billing rule Redis cache unavailable reason={}", error.getClass().getSimpleName());
            evictCache();
            return null;
        }
    }

    private void writeCache(BillingRule rule) {
        if (redis == null) return;
        try {
            ObjectNode node = mapper.createObjectNode();
            node.put("id", rule.id());
            node.put("version", rule.version());
            node.put("pointsPerUsd", rule.pointsPerUsd().toPlainString());
            node.put("effectiveFrom", rule.effectiveFrom().toString());
            node.put("createdAt", rule.createdAt().toString());
            node.put("updatedAt", rule.updatedAt().toString());
            redis.opsForValue().set(CACHE_KEY, mapper.writeValueAsString(node));
        } catch (RuntimeException | java.io.IOException error) {
            log.warn("billing rule Redis cache write failed reason={}", error.getClass().getSimpleName());
        }
    }

    private void evictCache() {
        if (redis == null) return;
        try {
            redis.delete(CACHE_KEY);
        } catch (RuntimeException ignored) {
            // PostgreSQL remains the source of truth when Redis is unavailable.
        }
    }

    private void refreshAfterCommit(BillingRule created) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            evictCache();
            writeCache(created);
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                evictCache();
                writeCache(created);
            }
        });
    }

    private static BillingRule mapRule(ResultSet rs, int row) throws SQLException {
        Timestamp effectiveTo = rs.getTimestamp("effective_to");
        return new BillingRule(rs.getLong("id"), rs.getLong("version"),
                rs.getBigDecimal("points_per_usd"), rs.getTimestamp("effective_from").toInstant(),
                effectiveTo == null ? null : effectiveTo.toInstant(), rs.getBoolean("enabled"),
                rs.getTimestamp("created_at").toInstant(), rs.getTimestamp("updated_at").toInstant());
    }

    private static BigDecimal normalizePositive(BigDecimal value, String field) {
        if (value == null || value.signum() <= 0) throw new IllegalArgumentException(field + " 必须大于 0");
        if (value.precision() - value.scale() > 12) throw new IllegalArgumentException(field + " 数值过大");
        return value.setScale(8, RoundingMode.HALF_UP);
    }

    private static BigDecimal normalizeNonnegative(BigDecimal value, String field) {
        if (value == null || value.signum() < 0) throw new IllegalArgumentException(field + " 不能小于 0");
        return value.setScale(10, RoundingMode.HALF_UP);
    }

    public record BillingRule(long id, long version, BigDecimal pointsPerUsd,
                              Instant effectiveFrom, Instant effectiveTo, boolean enabled,
                              Instant createdAt, Instant updatedAt) {}

    public record BillingSnapshot(String requestId, Long configurationId, String modelId,
                                  BigDecimal inputPrice, BigDecimal cacheReadPrice,
                                  BigDecimal cacheWritePrice, BigDecimal outputPrice,
                                  long pricingUnit, String currency, String priceSource,
                                  long priceTierMinInputTokens, BigDecimal pointsPerUsd,
                                  BigDecimal billingMultiplier, long ruleId, long ruleVersion) {}

    public record Simulation(BigDecimal providerCostUsd, BigDecimal pointsPerUsd,
                             BigDecimal basePoints, BigDecimal billingMultiplier,
                             BigDecimal chargedPoints) {}

    public static final class BillingRuleUnavailableException extends RuntimeException {
        private final String code;
        public BillingRuleUnavailableException(String code, String message) { super(message); this.code = code; }
        public BillingRuleUnavailableException(String code, String message, Throwable cause) {
            super(message, cause); this.code = code;
        }
        public String code() { return code; }
    }
}
