package cn.app.kiroproxy.auth;

import cn.app.kiroproxy.config.RelayConfiguration;
import java.security.SecureRandom;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import java.math.BigDecimal;
import org.springframework.http.HttpStatus;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import cn.app.kiroproxy.i18n.RelayLanguage;

@Service
public class AccessTokenService {
    public static final String REQUEST_ATTRIBUTE = AccessPrincipal.class.getName();
    private final JdbcTemplate jdbc;
    private final SecureRandom random = new SecureRandom();

    private final BigDecimal defaultInitialPoints;

    @Autowired
    public AccessTokenService(JdbcTemplate jdbc,
            @Value("${kiro.billing.default-initial-points:100}") BigDecimal defaultInitialPoints) {
        this.jdbc = jdbc;
        this.defaultInitialPoints = defaultInitialPoints.max(BigDecimal.ZERO);
    }

    public AccessTokenService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        this.defaultInitialPoints = new BigDecimal("100");
    }

    public AccessPrincipal authenticate(String rawToken) {
        return authenticateToken(rawToken, null, false);
    }

    @Transactional
    public AccessPrincipal authenticate(String rawToken, String machineId) {
        return authenticate(rawToken, machineId, true);
    }

    @Transactional
    public AccessPrincipal authenticate(String rawToken, String machineId, boolean bindMachine) {
        return authenticate(rawToken, machineId, bindMachine, RelayLanguage.ZH);
    }

    @Transactional
    public AccessPrincipal authenticate(String rawToken, String machineId, boolean bindMachine, String language) {
        return authenticate(rawToken, machineId, null, bindMachine, language);
    }

    @Transactional
    public AccessPrincipal authenticate(String rawToken, String machineId, String legacyMachineId,
            boolean bindMachine, String language) {
        if (machineId == null || machineId.isBlank() || machineId.length() > 255) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, RelayLanguage.text(language,
                    "缺少有效机器码", "A valid machine identifier is required."));
        }
        String legacy = legacyMachineId == null ? null : legacyMachineId.trim();
        if (legacy != null && (legacy.isBlank() || legacy.length() > 255)) legacy = null;
        return authenticateToken(rawToken, machineId.trim(), legacy, bindMachine, language);
    }

    private AccessPrincipal authenticateToken(String rawToken, String machineId, boolean bindMachine) {
        return authenticateToken(rawToken, machineId, null, bindMachine, RelayLanguage.ZH);
    }

    private AccessPrincipal authenticateToken(String rawToken, String machineId, String legacyMachineId,
            boolean bindMachine, String language) {
        if (rawToken == null || rawToken.isBlank()) return null;
        List<AuthRow> matches = jdbc.query("""
                select t.id, g.id as group_id, t.expires_at,
                  t.max_machine_bindings, t.bound_machine_count
                from relay_access_token t join relay_access_group g on g.id = t.group_id
                where t.token = ? and t.enabled = true and t.status = 'ACTIVE' and g.enabled = true
                for update
                """, (rs, row) -> new AuthRow(rs.getLong("id"), rs.getLong("group_id"),
                        rs.getTimestamp("expires_at") == null ? null : rs.getTimestamp("expires_at").toInstant(),
                        rs.getInt("max_machine_bindings"),
                        rs.getInt("bound_machine_count")), rawToken.trim());
        if (matches.isEmpty()) return null;
        AuthRow match = matches.get(0);
        migrateLegacyMachine(match.tokenId, machineId, legacyMachineId, bindMachine);
        if (machineId != null) verifyMachine(match, machineId, bindMachine, language);
        List<ModelRate> modelRates = jdbc.query("""
                select gm.model_id, gm.billing_multiplier from relay_access_group_model gm
                join relay_model m on m.model_id = gm.model_id
                where gm.group_id = ? and m.enabled = true
                """, (rs, row) -> new ModelRate(rs.getString("model_id"),
                        rs.getBigDecimal("billing_multiplier")), match.groupId);
        Map<String, BigDecimal> modelMultipliers = modelRates.stream().collect(Collectors.toUnmodifiableMap(
                ModelRate::modelId, ModelRate::billingMultiplier));
        Set<String> models = modelMultipliers.keySet();
        // Expiration limits model calls, not login or model discovery.
        AccessPrincipal principal = new AccessPrincipal(match.tokenId, match.groupId,
                models, match.expiresAt, modelMultipliers);
        jdbc.update("update relay_access_token set last_used_at = current_timestamp where id = ?", principal.tokenId());
        return principal;
    }

    private void migrateLegacyMachine(long tokenId, String machineId, String legacyMachineId,
            boolean allowBinding) {
        if (!allowBinding || machineId == null || legacyMachineId == null || machineId.equals(legacyMachineId)) return;
        Integer current = jdbc.queryForObject("""
                select count(*) from relay_access_token_machine where access_token_id=? and machine_id=?
                """, Integer.class, tokenId, machineId);
        if (current != null && current > 0) return;
        // Upgrade an existing installation in place. This neither consumes nor
        // restores an allowance; the legacy identifier stops authorizing as
        // soon as the migration succeeds.
        jdbc.update("""
                update relay_access_token_machine set machine_id=?,last_used_at=current_timestamp
                where access_token_id=? and machine_id=?
                """, machineId, tokenId, legacyMachineId);
    }

    private void verifyMachine(AuthRow token, String machineId, boolean allowBinding, String language) {
        Integer existing = jdbc.queryForObject("""
                select count(*) from relay_access_token_machine
                where access_token_id=? and machine_id=?
                """, Integer.class, token.tokenId, machineId);
        if (existing != null && existing > 0) {
            jdbc.update("""
                    update relay_access_token_machine set last_used_at=current_timestamp
                    where access_token_id=? and machine_id=?
                    """, token.tokenId, machineId);
            return;
        }
        // An explicitly released machine has no active row and therefore uses
        // the same binding path as any other machine. Its previous unbind_count
        // is deliberately retained, so unbinding and re-binding the same
        // machine can never restore or bypass a consumed release allowance.
        if (!allowBinding) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, RelayLanguage.text(language,
                    "当前机器尚未绑定该 Token，请重新登录",
                    "This device is not authorized for the Token. Please sign in again."));
        }
        if (token.maxMachineBindings > 0 && token.boundMachineCount >= token.maxMachineBindings) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, RelayLanguage.text(language,
                    "该 Token 已达到机器码绑定上限",
                    "This Token has reached its device authorization limit."));
        }
        jdbc.update("""
                insert into relay_access_token_machine(access_token_id, machine_id)
                values (?, ?)
                """, token.tokenId, machineId);
        jdbc.update("""
                update relay_access_token set bound_machine_count=bound_machine_count+1
                where id=?
                """, token.tokenId);
    }

    public MachineBindingStatus machineBindingStatus(AccessPrincipal principal, String machineId) {
        if (principal == null) return null;
        return jdbc.queryForObject("""
                select max_machine_bindings, bound_machine_count, max_unbind_count, unbind_count,
                  exists(select 1 from relay_access_token_machine m
                    where m.access_token_id=t.id and m.machine_id=?) current_machine_bound
                from relay_access_token t where id=?
                """, (rs, row) -> status(rs.getInt("max_machine_bindings"),
                        rs.getInt("bound_machine_count"), rs.getInt("max_unbind_count"),
                        rs.getInt("unbind_count"), rs.getBoolean("current_machine_bound")),
                machineId == null ? "" : machineId.trim(), principal.tokenId());
    }

    @Transactional
    public MachineBindingStatus unbindCurrentMachine(AccessPrincipal principal, String machineId) {
        return unbindCurrentMachine(principal, machineId, RelayLanguage.ZH);
    }

    @Transactional
    public MachineBindingStatus unbindCurrentMachine(AccessPrincipal principal, String machineId, String language) {
        if (principal == null || machineId == null || machineId.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, RelayLanguage.text(language,
                    "缺少有效机器码", "A valid machine identifier is required."));
        }
        MapRow limits = jdbc.queryForObject("""
                select max_unbind_count, unbind_count from relay_access_token where id=? for update
                """, (rs, row) -> new MapRow(rs.getInt("max_unbind_count"), rs.getInt("unbind_count")),
                principal.tokenId());
        if (limits == null || limits.maxUnbindCount == 0 || limits.unbindCount >= limits.maxUnbindCount) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, RelayLanguage.text(language,
                    "该 Token 已无可用解绑次数", "This Token has no device releases remaining."));
        }
        if (jdbc.update("""
                delete from relay_access_token_machine where access_token_id=? and machine_id=?
                """, principal.tokenId(), machineId.trim()) == 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, RelayLanguage.text(language,
                    "当前机器未绑定该 Token", "This device is not authorized for the Token."));
        }
        jdbc.update("""
                update relay_access_token set bound_machine_count=bound_machine_count-1,
                  unbind_count=unbind_count+1 where id=?
                """, principal.tokenId());
        return machineBindingStatus(principal, machineId);
    }

    private static MachineBindingStatus status(int maxBindings, int boundCount,
            int maxUnbind, int unbindCount, boolean currentBound) {
        Integer remaining = maxUnbind == 0 ? 0 : Math.max(0, maxUnbind - unbindCount);
        return new MachineBindingStatus(maxBindings, boundCount, maxUnbind, unbindCount,
                remaining, currentBound);
    }

    public RelayConfiguration restrict(RelayConfiguration config, AccessPrincipal principal) {
        if (principal == null) return new RelayConfiguration(config.enabled(), config.baseUrl(), config.apiKey(), List.of());
        return new RelayConfiguration(config.enabled(), config.baseUrl(), config.apiKey(), config.models().stream()
                .filter(model -> principal.modelIds().contains(model.modelId())).toList());
    }

    public WalletStatus walletStatus(AccessPrincipal principal) {
        if (principal == null) return null;
        List<WalletStatus> rows = jdbc.query("""
                select available_points, frozen_points, updated_at
                from relay_token_wallet where access_token_id=?
                """, (rs, row) -> new WalletStatus(rs.getBigDecimal("available_points"),
                rs.getBigDecimal("frozen_points"), rs.getTimestamp("updated_at").toInstant()), principal.tokenId());
        return rows.isEmpty() ? new WalletStatus(BigDecimal.ZERO, BigDecimal.ZERO, Instant.now()) : rows.get(0);
    }

    @Transactional
    public IssuedToken issue(String label, long groupId, Instant expiresAt) {
        return issue(label, groupId, expiresAt, defaultInitialPoints);
    }

    @Transactional
    public IssuedToken issue(String label, long groupId, Instant expiresAt, BigDecimal initialPoints) {
        return issue(label, groupId, expiresAt, initialPoints, true);
    }

    @Transactional
    public IssuedToken issue(String label, long groupId, Instant expiresAt, BigDecimal initialPoints,
            boolean enabled) {
        return issue(label, groupId, expiresAt, initialPoints, enabled, 2, 2);
    }

    @Transactional
    public IssuedToken issue(String label, long groupId, Instant expiresAt, BigDecimal initialPoints,
            boolean enabled, int maxMachineBindings, int maxUnbindCount) {
        if (maxMachineBindings < 0 || maxUnbindCount < 0) {
            throw new IllegalArgumentException("机器码绑定和解绑上限不能小于0");
        }
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        String raw = "skr-" + Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        jdbc.update("""
                insert into relay_access_token(token, label, group_id, enabled, status, expires_at,
                  max_machine_bindings, max_unbind_count) values (?, ?, ?, ?, ?, ?, ?, ?)
                """, raw, label, groupId, enabled, enabled ? "ACTIVE" : "DISABLED",
                expiresAt == null ? null : Timestamp.from(expiresAt), maxMachineBindings, maxUnbindCount);
        long tokenId = jdbc.queryForObject("select id from relay_access_token where token = ?", Long.class, raw);
        BigDecimal granted = initialPoints == null ? defaultInitialPoints : initialPoints;
        if (granted.signum() < 0) throw new IllegalArgumentException("初始积分不能为负数");
        jdbc.update("insert into relay_token_wallet(access_token_id, available_points) values (?, ?)", tokenId, granted);
        jdbc.update("""
                insert into relay_point_ledger(event_key, access_token_id, entry_type, available_delta,
                  frozen_delta, available_after, frozen_after, note)
                values (?, ?, 'GRANT', ?, 0, ?, 0, '发放Token初始积分')
                """, "token:" + tokenId + ":initial-grant", tokenId, granted, granted);
        return new IssuedToken(raw, tokenId, granted);
    }

    public static String displayPrefix(String token) {
        return token == null ? "" : token.substring(0, Math.min(12, token.length()));
    }

    public record IssuedToken(String token, long tokenId, BigDecimal initialPoints) {
        public String prefix() { return displayPrefix(token); }
    }
    public record WalletStatus(BigDecimal availablePoints, BigDecimal frozenPoints, Instant updatedAt) {}
    public record MachineBindingStatus(int maxMachineBindings, int boundMachineCount,
                                       int maxUnbindCount, int unbindCount,
                                       Integer remainingUnbindCount, boolean currentMachineBound) {}
    private record AuthRow(long tokenId, long groupId, Instant expiresAt,
                           int maxMachineBindings,
                           int boundMachineCount) {}
    private record ModelRate(String modelId, BigDecimal billingMultiplier) {}
    private record MapRow(int maxUnbindCount, int unbindCount) {}
}
