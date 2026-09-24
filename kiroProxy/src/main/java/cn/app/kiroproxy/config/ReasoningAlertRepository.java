package cn.app.kiroproxy.config;

import cn.app.kiroproxy.protocol.ProtocolCode;
import java.time.Instant;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * 推理强度不生效的路由告警。
 *
 * <p>Redis 里的计数是可丢的学习过程；「已经提示过管理员」这件事必须落库，否则重启后
 * 告警会凭空消失或反复弹出。同一条路由同一种告警只保留一行，再次出现时重置 resolved_at。
 */
@Repository
public class ReasoningAlertRepository {
    /** 上游明确拒绝该参数：事实，已自动降级。 */
    public static final String KIND_REJECTED = "REJECTED";
    /** 请求了中高档位却没产生 reasoning token：怀疑，需人工核实。 */
    public static final String KIND_IGNORED = "IGNORED";

    private final JdbcTemplate jdbc;

    public ReasoningAlertRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public void raise(long configurationId, String modelId, ProtocolCode protocol, String upstreamModelId,
                      String kind, int sourceCount) {
        jdbc.update("""
                insert into relay_reasoning_alert(configuration_id, model_id, protocol_code, upstream_model_id,
                  kind, source_count)
                values (?,?,?,?,?,?)
                on conflict (configuration_id, model_id, protocol_code, kind) do update set
                  upstream_model_id = excluded.upstream_model_id,
                  source_count = greatest(relay_reasoning_alert.source_count, excluded.source_count),
                  last_seen_at = CURRENT_TIMESTAMP,
                  resolved_at = null
                """, configurationId, modelId, protocol.name(), upstreamModelId, kind, sourceCount);
    }

    public List<AlertView> list(boolean openOnly) {
        return jdbc.query("""
                select a.id, a.configuration_id, c.name relay_name, a.model_id, m.display_name,
                  a.protocol_code, a.upstream_model_id, a.kind, a.source_count,
                  a.first_seen_at, a.last_seen_at, a.resolved_at,
                  rcm.reasoning_enabled
                from relay_reasoning_alert a
                  left join relay_configuration c on c.id = a.configuration_id
                  left join relay_model m on m.model_id = a.model_id
                  left join relay_configuration_model rcm
                    on rcm.configuration_id = a.configuration_id and rcm.model_id = a.model_id
                where (? = false or a.resolved_at is null)
                order by a.resolved_at nulls first, a.last_seen_at desc
                """, (rs, row) -> new AlertView(rs.getLong("id"), rs.getLong("configuration_id"),
                        rs.getString("relay_name"), rs.getString("model_id"), rs.getString("display_name"),
                        rs.getString("protocol_code"), rs.getString("upstream_model_id"), rs.getString("kind"),
                        rs.getInt("source_count"),
                        instant(rs.getTimestamp("first_seen_at")), instant(rs.getTimestamp("last_seen_at")),
                        instant(rs.getTimestamp("resolved_at")),
                        (Boolean) rs.getObject("reasoning_enabled")),
                openOnly);
    }

    public void resolve(long id) {
        jdbc.update("update relay_reasoning_alert set resolved_at = CURRENT_TIMESTAMP where id = ?", id);
    }

    /** 路由的裁决变更后清掉该路由的全部告警，避免管理员面对一堆已处理的历史项。 */
    public void resolveRoute(long configurationId, String modelId) {
        jdbc.update("""
                update relay_reasoning_alert set resolved_at = CURRENT_TIMESTAMP
                where configuration_id = ? and model_id = ? and resolved_at is null
                """, configurationId, modelId);
    }

    private static Instant instant(java.sql.Timestamp value) {
        return value == null ? null : value.toInstant();
    }

    public record AlertView(long id, long configurationId, String relayName, String modelId, String modelDisplayName,
                            String protocolCode, String upstreamModelId, String kind, int sourceCount,
                            Instant firstSeenAt, Instant lastSeenAt, Instant resolvedAt,
                            Boolean routeReasoningEnabled) {}
}
