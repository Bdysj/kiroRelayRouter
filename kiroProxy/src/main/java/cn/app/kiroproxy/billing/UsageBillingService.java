package cn.app.kiroproxy.billing;

import cn.app.kiroproxy.auth.AccessPrincipal;
import cn.app.kiroproxy.billing.BillingRuleService.BillingRuleUnavailableException;
import cn.app.kiroproxy.billing.BillingRuleService.BillingSnapshot;
import cn.app.kiroproxy.protocol.ProtocolCode;
import cn.app.kiroproxy.i18n.RelayLanguage;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class UsageBillingService {
    private static final Logger log = LoggerFactory.getLogger(UsageBillingService.class);
    private final JdbcTemplate jdbc;
    private final BillingRealtimeCache cache;
    private final BillingRuleService billingRules;
    private final BigDecimal reservePoints;
    private final BigDecimal lowBalanceThreshold;
    private final boolean messagingEnabled;

    @Autowired
    public UsageBillingService(JdbcTemplate jdbc, BillingRealtimeCache cache, BillingRuleService billingRules,
            @Value("${kiro.billing.request-reserve-points:1}") BigDecimal reservePoints,
            @Value("${kiro.billing.low-balance-threshold:0.5}") BigDecimal lowBalanceThreshold,
            @Value("${kiro.billing.messaging-enabled:true}") boolean messagingEnabled) {
        this.jdbc = jdbc;
        this.cache = cache;
        this.billingRules = billingRules;
        this.reservePoints = reservePoints.max(BigDecimal.ZERO).setScale(8, RoundingMode.HALF_UP);
        this.lowBalanceThreshold = lowBalanceThreshold.max(BigDecimal.ZERO).setScale(8, RoundingMode.HALF_UP);
        this.messagingEnabled = messagingEnabled;
    }

    /** Test/embedded constructor: settle synchronously and do not require Redis. */
    public UsageBillingService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        this.cache = null;
        this.billingRules = new BillingRuleService(jdbc, null, new ObjectMapper());
        this.reservePoints = BigDecimal.ZERO.setScale(8);
        this.lowBalanceThreshold = new BigDecimal("0.50000000");
        this.messagingEnabled = false;
    }

    /** Test/embedded constructor: settle synchronously with the database-backed billing rule. */
    public UsageBillingService(JdbcTemplate jdbc, BillingRealtimeCache cache,
            BigDecimal reservePoints, BigDecimal lowBalanceThreshold, boolean messagingEnabled) {
        this(jdbc, cache, new BillingRuleService(jdbc, null, new ObjectMapper()),
                reservePoints, lowBalanceThreshold, messagingEnabled);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public Charge begin(String requestId, AccessPrincipal principal, String modelId) {
        return begin(requestId, principal, modelId, null, modelId, modelId, 0, 0);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public Charge begin(String requestId, AccessPrincipal principal, String modelId,
                        long estimatedInputTokens, long maximumOutputTokens) {
        return begin(requestId, principal, modelId, null, modelId, modelId,
                estimatedInputTokens, maximumOutputTokens);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public Charge begin(String requestId, AccessPrincipal principal, String modelId, Long configurationId,
                        String requestedModelId, String upstreamModelId,
                        long estimatedInputTokens, long maximumOutputTokens) {
        return begin(requestId, principal, modelId, configurationId, requestedModelId, upstreamModelId,
                estimatedInputTokens, maximumOutputTokens, RelayLanguage.ZH);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public Charge begin(String requestId, AccessPrincipal principal, String modelId, Long configurationId,
                        String requestedModelId, String upstreamModelId,
                        long estimatedInputTokens, long maximumOutputTokens, String language) {
        if (principal == null) return null;
        validateTokenForCharge(principal.tokenId(), language);
        Pricing basePrice = findPrice(modelId, Math.max(0, estimatedInputTokens), configurationId);
        if (basePrice == null) {
            throw new BillingRejectedException("MODEL_PRICE_NOT_CONFIGURED",
                    RelayLanguage.text(language, "当前模型尚未配置计费价格，请联系管理员处理。",
                            "Pricing is not configured for this model. Please contact the administrator."));
        }
        BillingSnapshot snapshot = createSnapshot(requestId, configurationId, modelId,
                basePrice, principal.billingMultiplierFor(modelId), language);
        BigDecimal estimatedPoints = tokenCost(Math.max(0, estimatedInputTokens), basePrice.inputPrice, basePrice.pricingUnit)
                .add(tokenCost(Math.max(0, maximumOutputTokens), basePrice.outputPrice, basePrice.pricingUnit))
                .multiply(snapshot.pointsPerUsd()).multiply(snapshot.billingMultiplier())
                .setScale(8, RoundingMode.UP);
        BigDecimal requestedReserve = reservePoints.max(estimatedPoints);
        ensureWallet(principal.tokenId());
        Wallet wallet = lockWallet(principal.tokenId());
        if (wallet.available.signum() <= 0) {
            throw new BillingRejectedException("INSUFFICIENT_POINTS", RelayLanguage.text(language,
                    "当前 Token 积分额度不足，请充值后重试。",
                    "This Token has insufficient Credits. Please top up and try again."));
        }
        if (wallet.available.compareTo(lowBalanceThreshold) <= 0 && wallet.frozen.signum() > 0) {
            throw new BillingRejectedException("LOW_BALANCE_REQUEST_IN_PROGRESS",
                    RelayLanguage.text(language,
                            "当前 Token 余额已低于安全阈值，已有一个请求正在结算，请稍后重试。",
                            "This Token is below the safe balance threshold while another request is settling. Please try again shortly."));
        }
        // Product rule: every positive balance may make one final request.
        // Freeze at most the currently available amount; final usage may make
        // the wallet negative, and the next request is then rejected above.
        BigDecimal authorizationReserve = requestedReserve.min(wallet.available);
        BigDecimal availableAfter = wallet.available.subtract(authorizationReserve);
        BigDecimal frozenAfter = wallet.frozen.add(authorizationReserve);
        updateWallet(principal.tokenId(), availableAfter, frozenAfter);
        jdbc.update("""
                insert into relay_point_ledger(event_key, access_token_id, request_id, entry_type,
                  available_delta, frozen_delta, available_after, frozen_after, note)
                values (?, ?, ?, 'FREEZE', ?, ?, ?, ?, '模型请求预冻结')
                """, "request:" + requestId + ":freeze", principal.tokenId(), requestId,
                authorizationReserve.negate(), authorizationReserve, availableAfter, frozenAfter);
        jdbc.update("""
                insert into relay_usage_record(request_id, access_token_id, group_id, model_id,
                  requested_model_id, upstream_model_id, upstream_model_source, relay_configuration_id,
                  input_price, cache_input_price, cache_write_input_price, output_price, pricing_unit,
                  currency, price_source, points_per_usd, billing_multiplier, reserved_points,
                  price_tier_min_input_tokens, status)
                values (?, ?, ?, ?, ?, ?, 'UNKNOWN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
                """, requestId, principal.tokenId(), principal.groupId(), modelId,
                normalized(requestedModelId), normalized(upstreamModelId), configurationId,
                basePrice.inputPrice, basePrice.cacheInputPrice, basePrice.cacheWriteInputPrice,
                basePrice.outputPrice, basePrice.pricingUnit, basePrice.currency, basePrice.priceSource,
                snapshot.pointsPerUsd(), snapshot.billingMultiplier(), authorizationReserve, basePrice.minInputTokens);
        syncCache(principal.tokenId(), availableAfter, frozenAfter, requestId, "PENDING");
        return new Charge(requestId, principal.tokenId(), modelId, normalized(requestedModelId),
                normalized(upstreamModelId), configurationId, snapshot, authorizationReserve);
    }

    /**
     * Authentication and billing run in separate transactions. Lock and check the
     * Token again immediately before reserving points so a concurrent admin
     * disable/archive/revoke cannot slip through with a previously built principal.
     */
    private void validateTokenForCharge(long tokenId, String language) {
        List<TokenAuthorization> rows = jdbc.query("""
                select t.enabled, t.status, t.expires_at, g.enabled group_enabled
                from relay_access_token t join relay_access_group g on g.id=t.group_id
                where t.id=? for update
                """, (rs, row) -> new TokenAuthorization(rs.getBoolean("enabled"), rs.getString("status"),
                rs.getTimestamp("expires_at") == null ? null : rs.getTimestamp("expires_at").toInstant(),
                rs.getBoolean("group_enabled")), tokenId);
        if (rows.isEmpty()) throw tokenRejected(language);
        TokenAuthorization token = rows.get(0);
        if (!token.enabled || !"ACTIVE".equals(token.status)) throw tokenRejected(language);
        if (!token.groupEnabled) {
            throw new BillingRejectedException("ACCESS_GROUP_DISABLED", RelayLanguage.text(language,
                    "当前 Token 所属访问分组已停用，本次请求未发送。",
                    "This Token belongs to a disabled access group. This request was not sent."));
        }
        if (token.expiresAt != null && !token.expiresAt.isAfter(Instant.now())) {
            throw new BillingRejectedException("TOKEN_EXPIRED", RelayLanguage.text(language,
                    "当前访问 Token 已过期，本次请求未发送。",
                    "This access Token has expired. This request was not sent."));
        }
    }

    private static BillingRejectedException tokenRejected(String language) {
        return new BillingRejectedException("TOKEN_INACTIVE", RelayLanguage.text(language,
                "当前 Token 已停用、撤销或归档，本次请求未发送。",
                "This Token is disabled, revoked, or archived. This request was not sent."));
    }

    /** Revalidates and snapshots pricing before a failover attempt reaches a different relay. */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public Charge switchRoute(Charge charge, Long configurationId, String upstreamModelId,
                              long estimatedInputTokens) {
        return switchRoute(charge, configurationId, upstreamModelId, estimatedInputTokens, RelayLanguage.ZH);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void selectProtocol(Charge charge, ProtocolCode protocol) {
        if (charge == null || protocol == null) return;
        jdbc.update("update relay_usage_record set protocol_code=? where request_id=? and status='PENDING'",
                protocol.name(), charge.requestId);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public Charge switchRoute(Charge charge, Long configurationId, String upstreamModelId,
                              long estimatedInputTokens, String language) {
        if (charge == null) return null;
        Pricing price = findPrice(charge.modelId, Math.max(0, estimatedInputTokens), configurationId);
        if (price == null) {
            throw new BillingRejectedException("MODEL_PRICE_NOT_CONFIGURED",
                    RelayLanguage.text(language, "当前服务节点与模型均未配置有效计费价格，请联系管理员处理。",
                            "No valid pricing is configured for this service node and model. Please contact the administrator."));
        }
        jdbc.update("""
                update relay_usage_record set relay_configuration_id=?, upstream_model_id=?,
                  reported_model_id=null, upstream_model_source='UNKNOWN',
                  input_price=?, cache_input_price=?, cache_write_input_price=?, output_price=?,
                  pricing_unit=?, currency=?, price_source=?, price_tier_min_input_tokens=?
                where request_id=? and status='PENDING'
                """, configurationId, normalized(upstreamModelId), price.inputPrice, price.cacheInputPrice,
                price.cacheWriteInputPrice, price.outputPrice, price.pricingUnit, price.currency,
                price.priceSource, price.minInputTokens, charge.requestId);
        BillingSnapshot snapshot = new BillingSnapshot(charge.requestId, configurationId, charge.modelId,
                price.inputPrice, price.cacheInputPrice, price.cacheWriteInputPrice, price.outputPrice,
                price.pricingUnit, price.currency, price.priceSource, price.minInputTokens,
                charge.snapshot.pointsPerUsd(), charge.snapshot.billingMultiplier(),
                charge.snapshot.ruleId(), charge.snapshot.ruleVersion());
        return new Charge(charge.requestId, charge.tokenId, charge.modelId, charge.requestedModelId,
                normalized(upstreamModelId), configurationId, snapshot, charge.reservedPoints);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void complete(Charge charge, JsonNode usage) {
        complete(charge, usage, charge == null ? null : charge.configurationId, null);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void complete(Charge charge, JsonNode usage, Long configurationId) {
        complete(charge, usage, configurationId, null);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void complete(Charge charge, JsonNode usage, Long configurationId, String reportedModelId) {
        complete(charge, usage, configurationId, reportedModelId, null);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void complete(Charge charge, JsonNode usage, Long configurationId, String reportedModelId,
                         RequestMetrics metrics) {
        if (charge == null) return;
        String reported = normalized(reportedModelId);
        String modelSource = reported == null ? "UNKNOWN" : "RESPONSE";
        jdbc.update("""
                update relay_usage_record set relay_configuration_id=?, reported_model_id=?,
                  upstream_model_source=? where request_id=? and status='PENDING'
                """, configurationId, reported, modelSource, charge.requestId);
        if (usage == null || usage.isMissingNode() || usage.isNull() || usage.isEmpty()) {
            finishAndRelease(charge.requestId, "MISSING_USAGE", "UPSTREAM_USAGE_MISSING");
            return;
        }
        Usage parsed = parseUsage(usage);
        BillingSnapshot snapshot = charge.snapshot;
        Pricing price = new Pricing(snapshot.inputPrice(), snapshot.cacheReadPrice(),
                snapshot.cacheWritePrice(), snapshot.outputPrice(), snapshot.pricingUnit(),
                snapshot.currency(), snapshot.priceSource(), snapshot.priceTierMinInputTokens());
        BigDecimal cost = tokenCost(parsed.input, price.inputPrice, price.pricingUnit)
                .add(tokenCost(parsed.cacheRead, price.cacheInputPrice, price.pricingUnit))
                .add(tokenCost(parsed.cacheWrite, price.cacheWriteInputPrice, price.pricingUnit))
                .add(tokenCost(parsed.output, price.outputPrice, price.pricingUnit))
                .add(parsed.toolCost).setScale(10, RoundingMode.HALF_UP);
        BigDecimal points = cost.multiply(snapshot.pointsPerUsd()).multiply(snapshot.billingMultiplier())
                .setScale(8, RoundingMode.HALF_UP);
        int changed = jdbc.update("""
                update relay_usage_record set input_tokens=?, cache_input_tokens=?, cache_write_input_tokens=?,
                  output_tokens=?, input_price=?, cache_input_price=?, cache_write_input_price=?, output_price=?,
                  pricing_unit=?, currency=?, price_source=?, price_tier_min_input_tokens=?,
                  relay_configuration_id=?,
                  provider_cost_usd=?, tool_cost_usd=?, charged_points=?, status='READY_TO_SETTLE',
                  error_code=null, completed_at=current_timestamp
                where request_id=? and status='PENDING'
                """, parsed.input, parsed.cacheRead, parsed.cacheWrite, parsed.output,
                price.inputPrice, price.cacheInputPrice, price.cacheWriteInputPrice, price.outputPrice,
                price.pricingUnit, price.currency, price.priceSource, price.minInputTokens, configurationId,
                cost, parsed.toolCost, points, charge.requestId);
        if (changed == 0) return;
        jdbc.update("""
                insert into relay_billing_outbox(event_key, request_id)
                select ?, ? where not exists (select 1 from relay_billing_outbox where event_key=?)
                """, "request:" + charge.requestId + ":settlement", charge.requestId,
                "request:" + charge.requestId + ":settlement");
        Wallet pendingWallet = lockWallet(charge.tokenId);
        log.info("billing pending request={} token_id={} status=READY_TO_SETTLE requested_model={} "
                        + "upstream_model={} relay_id={} relay={} available_points={} frozen_points={} reserved_points={} "
                        + "input_tokens={} cache_read_tokens={} cache_write_tokens={} output_tokens={} "
                        + "provider_cost_usd={} pending_points={} upstream_headers_ms={} first_output_ms={} response_ms={}",
                charge.requestId, charge.tokenId, charge.requestedModelId, charge.upstreamModelId, configurationId,
                metrics == null ? "UNKNOWN" : metrics.relayName,
                pendingWallet.available, pendingWallet.frozen, charge.reservedPoints,
                parsed.input, parsed.cacheRead, parsed.cacheWrite, parsed.output, cost, points,
                metrics == null ? -1 : metrics.upstreamHeadersMs,
                metrics == null ? -1 : metrics.firstOutputMs,
                metrics == null ? -1 : metrics.responseMs);
        if (!messagingEnabled) {
            settle(charge.requestId);
            jdbc.update("update relay_billing_outbox set status='PUBLISHED', published_at=current_timestamp where request_id=?",
                    charge.requestId);
        }
        syncRequest(charge.requestId, messagingEnabled ? "READY_TO_SETTLE" : "SETTLED");
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void settle(String requestId) {
        List<Map<String, Object>> rows = jdbc.queryForList("""
                select access_token_id, model_id, upstream_model_id, relay_configuration_id,
                       input_tokens, cache_input_tokens, cache_write_input_tokens, output_tokens,
                       reserved_points, charged_points, created_at, completed_at
                from relay_usage_record where request_id=? and status='READY_TO_SETTLE' for update
                """, requestId);
        if (rows.isEmpty()) return;
        long tokenId = ((Number) get(rows.get(0), "access_token_id")).longValue();
        BigDecimal reserved = decimal(get(rows.get(0), "reserved_points"));
        BigDecimal charged = decimal(get(rows.get(0), "charged_points"));
        Wallet wallet = lockWallet(tokenId);
        BigDecimal availableAfter = wallet.available.add(reserved).subtract(charged);
        BigDecimal frozenAfter = wallet.frozen.subtract(reserved).max(BigDecimal.ZERO);
        updateWallet(tokenId, availableAfter, frozenAfter);
        int inserted = jdbc.update("""
                insert into relay_point_ledger(event_key, access_token_id, request_id, entry_type,
                  available_delta, frozen_delta, available_after, frozen_after, note)
                select ?, ?, ?, 'SETTLE', ?, ?, ?, ?, '根据上游最终usage结算'
                where not exists (select 1 from relay_point_ledger where event_key=?)
                """, "request:" + requestId + ":settle", tokenId, requestId,
                reserved.subtract(charged), reserved.negate(), availableAfter, frozenAfter,
                "request:" + requestId + ":settle");
        if (inserted == 0) return;
        jdbc.update("update relay_usage_record set status='SETTLED' where request_id=? and status='READY_TO_SETTLE'", requestId);
        syncCache(tokenId, availableAfter, frozenAfter, requestId, "SETTLED");
        Map<String, Object> row = rows.get(0);
        log.info("billing settled request={} token_id={} status=SETTLED model={} upstream_model={} relay_id={} "
                        + "input_tokens={} cache_read_tokens={} cache_write_tokens={} output_tokens={} "
                        + "charged_points={} available_points={} frozen_points={} response_ms={}",
                requestId, tokenId, get(row, "model_id"), get(row, "upstream_model_id"),
                get(row, "relay_configuration_id"), get(row, "input_tokens"), get(row, "cache_input_tokens"),
                get(row, "cache_write_input_tokens"), get(row, "output_tokens"), charged, availableAfter,
                frozenAfter, elapsedMillis(get(row, "created_at"), get(row, "completed_at")));
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void fail(Charge charge, String errorCode) {
        if (charge != null) finishAndRelease(charge.requestId, "FAILED", safeCode(errorCode));
    }

    private void finishAndRelease(String requestId, String status, String errorCode) {
        List<Map<String, Object>> rows = jdbc.queryForList("""
                select access_token_id, reserved_points from relay_usage_record
                where request_id=? and status='PENDING' for update
                """, requestId);
        if (rows.isEmpty()) return;
        long tokenId = ((Number) get(rows.get(0), "access_token_id")).longValue();
        BigDecimal reserved = decimal(get(rows.get(0), "reserved_points"));
        Wallet wallet = lockWallet(tokenId);
        BigDecimal availableAfter = wallet.available.add(reserved);
        BigDecimal frozenAfter = wallet.frozen.subtract(reserved).max(BigDecimal.ZERO);
        updateWallet(tokenId, availableAfter, frozenAfter);
        jdbc.update("""
                insert into relay_point_ledger(event_key, access_token_id, request_id, entry_type,
                  available_delta, frozen_delta, available_after, frozen_after, note)
                select ?, ?, ?, 'RELEASE', ?, ?, ?, ?, ?
                where not exists (select 1 from relay_point_ledger where event_key=?)
                """, "request:" + requestId + ":release", tokenId, requestId, reserved,
                reserved.negate(), availableAfter, frozenAfter, errorCode, "request:" + requestId + ":release");
        jdbc.update("update relay_usage_record set status=?, error_code=?, completed_at=current_timestamp where request_id=? and status='PENDING'",
                status, errorCode, requestId);
        syncCache(tokenId, availableAfter, frozenAfter, requestId, status);
    }

    private Pricing findPrice(String modelId, long inputTokens) {
        return findPrice(modelId, inputTokens, null);
    }

    private BillingSnapshot createSnapshot(String requestId, Long configurationId, String modelId,
                                           Pricing price, BigDecimal billingMultiplier, String language) {
        try {
            return billingRules.createSnapshot(requestId, configurationId, modelId,
                    price.inputPrice, price.cacheInputPrice, price.cacheWriteInputPrice,
                    price.outputPrice, price.pricingUnit, price.currency, price.priceSource,
                    price.minInputTokens, billingMultiplier);
        } catch (BillingRuleUnavailableException error) {
            throw new BillingRejectedException(error.code(), RelayLanguage.text(language, error.getMessage(),
                    "The Points billing rule is temporarily unavailable. This request was rejected."));
        }
    }

    private Pricing findPrice(String modelId, long inputTokens, Long configurationId) {
        if (configurationId != null) {
            List<Pricing> relayMatches = jdbc.query("""
                    select input_price, cache_input_price, cache_write_input_price, output_price,
                           pricing_unit, currency, price_source, min_input_tokens
                    from relay_configuration_model_pricing
                    where configuration_id=? and model_id=? and enabled=true
                      and effective_from <= current_timestamp
                      and (effective_to is null or effective_to > current_timestamp)
                      and min_input_tokens <= ? and (max_input_tokens is null or max_input_tokens >= ?)
                    order by effective_from desc, min_input_tokens desc, id desc limit 1
                    """, (rs, row) -> new Pricing(rs.getBigDecimal("input_price"), rs.getBigDecimal("cache_input_price"),
                    rs.getBigDecimal("cache_write_input_price"), rs.getBigDecimal("output_price"),
                    rs.getLong("pricing_unit"), rs.getString("currency"), rs.getString("price_source"),
                    rs.getLong("min_input_tokens")), configurationId, modelId, inputTokens, inputTokens);
            if (!relayMatches.isEmpty()) return relayMatches.get(0);
        }
        List<Pricing> matches = jdbc.query("""
                select input_price, cache_input_price, cache_write_input_price, output_price,
                       pricing_unit, currency, price_source, min_input_tokens
                from relay_model_pricing
                where model_id=? and enabled=true and effective_from <= current_timestamp
                  and (effective_to is null or effective_to > current_timestamp)
                  and min_input_tokens <= ? and (max_input_tokens is null or max_input_tokens >= ?)
                order by effective_from desc, min_input_tokens desc, id desc limit 1
                """, (rs, row) -> new Pricing(rs.getBigDecimal("input_price"), rs.getBigDecimal("cache_input_price"),
                rs.getBigDecimal("cache_write_input_price"), rs.getBigDecimal("output_price"),
                rs.getLong("pricing_unit"), rs.getString("currency"), rs.getString("price_source"),
                rs.getLong("min_input_tokens")), modelId, inputTokens, inputTokens);
        return matches.isEmpty() ? null : matches.get(0);
    }

    /**
     * A wallet normally exists from the moment the Token is issued; this only
     * backfills one that does not. The insert must be a single conflict-tolerant
     * statement rather than a check followed by an insert, because two first
     * requests for the same Token can pass a {@code not exists} test at the
     * same time and one of them would then break on the primary key. That race
     * is reachable from a single node and certain to appear once several relays
     * share one database.
     */
    private void ensureWallet(long tokenId) {
        jdbc.update("""
                insert into relay_token_wallet(access_token_id, available_points) values (?, 0)
                on conflict (access_token_id) do nothing
                """, tokenId);
    }
    private Wallet lockWallet(long tokenId) {
        return jdbc.queryForObject("select available_points, frozen_points from relay_token_wallet where access_token_id=? for update",
                (rs, row) -> new Wallet(rs.getBigDecimal(1), rs.getBigDecimal(2)), tokenId);
    }
    private void updateWallet(long tokenId, BigDecimal available, BigDecimal frozen) {
        jdbc.update("update relay_token_wallet set available_points=?, frozen_points=?, version=version+1, updated_at=current_timestamp where access_token_id=?",
                available, frozen, tokenId);
    }
    private void syncCache(long tokenId, BigDecimal available, BigDecimal frozen, String requestId, String status) {
        if (cache != null) cache.updateWallet(tokenId, available, frozen, requestId, status);
    }
    private void syncRequest(String requestId, String status) { if (cache != null) cache.updateRequest(requestId, status); }

    private static Usage parseUsage(JsonNode usage) {
        boolean openAi = usage.path("prompt_tokens").canConvertToLong();
        long totalInput = nonnegative(firstLong(usage, "prompt_tokens", "input_tokens"));
        JsonNode details = usage.path("prompt_tokens_details");
        long cacheRead = nonnegative(firstLong(details, "cached_tokens", "cache_read_tokens"));
        if (cacheRead == 0) cacheRead = nonnegative(firstLong(usage, "cache_read_input_tokens", "cache_read_tokens"));
        long cacheWrite = nonnegative(firstLong(details, "cache_write_tokens", "cache_creation_tokens"));
        if (cacheWrite == 0) cacheWrite = nonnegative(firstLong(usage, "cache_creation_input_tokens", "cache_write_input_tokens"));
        long input = openAi ? Math.max(0, totalInput - cacheRead - cacheWrite) : totalInput;
        long output = nonnegative(firstLong(usage, "completion_tokens", "output_tokens"));
        return new Usage(input, cacheRead, cacheWrite, output,
                nonnegativeDecimal(firstDecimal(usage, "tool_cost_usd", "tool_cost")));
    }
    private static BigDecimal tokenCost(long tokens, BigDecimal price, long unit) {
        return BigDecimal.valueOf(tokens).multiply(price).divide(BigDecimal.valueOf(unit), 12, RoundingMode.HALF_UP);
    }
    private static long firstLong(JsonNode node, String... names) {
        for (String name : names) if (node.path(name).canConvertToLong()) return node.path(name).asLong();
        return 0;
    }
    private static BigDecimal firstDecimal(JsonNode node, String... names) {
        for (String name : names) if (node.path(name).isNumber() || node.path(name).isTextual()) {
            try { return new BigDecimal(node.path(name).asText()); } catch (NumberFormatException ignored) { }
        }
        return BigDecimal.ZERO;
    }
    private static Object get(Map<String, Object> row, String name) {
        Object value = row.get(name); return value == null ? row.get(name.toUpperCase()) : value;
    }
    private static long elapsedMillis(Object started, Object completed) {
        Instant start = instant(started);
        Instant end = instant(completed);
        return start == null || end == null ? -1 : Math.max(0, Duration.between(start, end).toMillis());
    }
    private static Instant instant(Object value) {
        if (value instanceof Instant instant) return instant;
        if (value instanceof OffsetDateTime dateTime) return dateTime.toInstant();
        if (value instanceof java.sql.Timestamp timestamp) return timestamp.toInstant();
        return null;
    }
    private static BigDecimal decimal(Object value) { return value instanceof BigDecimal b ? b : new BigDecimal(value.toString()); }
    private static long nonnegative(long value) { return Math.max(0, value); }
    private static BigDecimal nonnegativeDecimal(BigDecimal value) { return value.signum() < 0 ? BigDecimal.ZERO : value; }
    private static String safeCode(String code) {
        String value = code == null ? "UNKNOWN" : code.replaceAll("[^A-Za-z0-9_-]", "_").toUpperCase();
        return value.substring(0, Math.min(64, value.length()));
    }

    private static String normalized(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }

    public record Charge(String requestId, long tokenId, String modelId, String requestedModelId,
                         String upstreamModelId, Long configurationId,
                         BillingSnapshot snapshot, BigDecimal reservedPoints) {}
    public record RequestMetrics(long upstreamHeadersMs, long firstOutputMs, long responseMs, String relayName) {}
    public record Pricing(BigDecimal inputPrice, BigDecimal cacheInputPrice, BigDecimal cacheWriteInputPrice,
                          BigDecimal outputPrice, long pricingUnit, String currency, String priceSource,
                          long minInputTokens) {}
    private record Usage(long input, long cacheRead, long cacheWrite, long output, BigDecimal toolCost) {}
    private record Wallet(BigDecimal available, BigDecimal frozen) {}
    private record TokenAuthorization(boolean enabled, String status, Instant expiresAt, boolean groupEnabled) {}

    public static final class BillingRejectedException extends RuntimeException {
        private final String code;
        public BillingRejectedException(String code, String message) { super(message); this.code = code; }
        public String code() { return code; }
    }
}
