package cn.app.kiroproxy.config;

import cn.app.kiroproxy.protocol.ProtocolCode;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

/**
 * 记住「某条路由的上游不认推理强度参数」这件事。
 *
 * <p>为什么放 Redis 而不是数据库：这是<b>学来的临时结论</b>，不是管理员的配置。中转站换了
 * 后端、上游升级之后它就该失效，所以带 TTL；Redis 重启最多让第一个用户多付一次被拒的
 * 往返，自愈成本极低。管理员的显式裁决是另一回事，走数据库。
 *
 * <p>为什么还要一层进程内缓存：判定在请求热路径上，每个候选路由都要查一次。本地缓存把
 * Redis 往返摊薄到几秒一次，同时让 Redis 抖动对聊天完全不可见。
 *
 * <p>所有读路径 fail-open：查不到、超时、Redis 不可用，一律视为「支持」照常下发参数。
 * 缓存挂了应该退化成多一次被拒的往返，而不是把思考强度整体关掉。
 */
@Service
public class ReasoningSupportService {
    /** 标记有效期。上游能力会变，过期后允许重新探一次。 */
    public static final Duration DENY_TTL = Duration.ofHours(6);
    /**
     * 惊动管理员所需的独立来源数。
     *
     * <p>注意这和「自动降级」用的是两个不同的阈值：降级阈值是 1（确认一次就立刻生效，
     * 否则每个用户都要白付一次被拒的往返），这个阈值只决定什么时候值得提示管理员。
     */
    public static final int CONSENSUS_THRESHOLD = 3;
    /** 共识计数窗口。跨窗口的零星失败不该累积成告警。 */
    public static final Duration CONSENSUS_TTL = Duration.ofHours(24);
    /** 进程内缓存有效期。判定滞后最多这么久，换来热路径几乎零 Redis 往返。 */
    private static final Duration LOCAL_TTL = Duration.ofSeconds(5);

    private static final Logger log = LoggerFactory.getLogger(ReasoningSupportService.class);

    private final StringRedisTemplate redis;
    private final ReasoningAlertRepository alerts;
    private final Map<String, Local> local = new ConcurrentHashMap<>();

    public ReasoningSupportService(ObjectProvider<StringRedisTemplate> redis,
                                   ObjectProvider<ReasoningAlertRepository> alerts) {
        this.redis = redis.getIfAvailable();
        this.alerts = alerts.getIfAvailable();
    }

    /** 该路由是否已被确认不支持推理强度。 */
    public boolean suppressed(long relayId, ProtocolCode protocol, String upstreamModelId) {
        String key = key(relayId, protocol, upstreamModelId);
        long now = System.nanoTime();
        Local cached = local.get(key);
        if (cached != null && cached.expiresAtNanos() > now) return cached.denied();
        boolean denied = read(key);
        local.put(key, new Local(denied, now + LOCAL_TTL.toNanos()));
        return denied;
    }

    /**
     * 记下这条路由不认参数。
     *
     * <p>阈值就是 1：只要确认过一次，后续所有用户都应该立刻少走一次被拒的往返。
     * 「累积到几次才告警管理员」是另一个阈值，不在这里。
     */
    public void markUnsupported(long relayId, ProtocolCode protocol, String upstreamModelId) {
        String key = key(relayId, protocol, upstreamModelId);
        local.put(key, new Local(true, System.nanoTime() + LOCAL_TTL.toNanos()));
        if (redis == null) return;
        try {
            // 每次被拒都刷新 TTL：持续拒绝的路由应该一直保持标记。
            redis.opsForValue().set(key, "1", DENY_TTL);
        } catch (Exception error) {
            log.warn("reasoning deny write failed key={}", key, error);
        }
    }

    /**
     * 确认某条路由拒绝了推理强度参数：立刻标记降级，同时累积共识。
     *
     * <p>共识用 Redis SET 按来源 Token 去重，而不是简单自增 —— 「三个不同用户都撞上」
     * 才说明是普遍现象，一个用户重试三次刷不出告警。
     *
     * @param sourceId 触发者标识，用 Token 的数据库 ID（不是密钥本身）
     */
    public void noteRejection(long relayId, ProtocolCode protocol, String upstreamModelId,
                              String modelId, long sourceId) {
        markUnsupported(relayId, protocol, upstreamModelId);
        if (redis == null) return;
        long sources;
        try {
            String key = consensusKey(relayId, protocol, upstreamModelId);
            Long added = redis.opsForSet().add(key, Long.toString(sourceId));
            redis.expire(key, CONSENSUS_TTL);
            if (added == null || added == 0) return; // 这个来源已经计过，不重复评估
            Long size = redis.opsForSet().size(key);
            sources = size == null ? 0 : size;
        } catch (Exception error) {
            log.warn("reasoning consensus write failed relay={} protocol={} model={}",
                    relayId, protocol, upstreamModelId, error);
            return;
        }
        if (sources < CONSENSUS_THRESHOLD || alerts == null) return;
        try {
            alerts.raise(relayId, modelId, protocol, upstreamModelId,
                    ReasoningAlertRepository.KIND_REJECTED, (int) sources);
            log.warn("reasoning consensus reached relay={} protocol={} model={} upstream_model={} sources={}",
                    relayId, protocol, modelId, upstreamModelId, sources);
        } catch (Exception error) {
            log.warn("reasoning alert raise failed relay={} model={}", relayId, modelId, error);
        }
    }

    /**
     * 怀疑某条路由静默忽略了推理强度：请求了中高档位，却既没有 reasoning token 也没有思考内容。
     *
     * <p>和 {@link #noteRejection} 的本质区别是<b>这里绝不写否定标记、绝不自动降级</b>。
     * 零思考有完全合法的解释 —— adaptive thinking 的模型自己判断这题不用想、或者上游根本
     * 不回传该计数。所以这只是个供人工核实的怀疑信号，不能拿来做确定的动作。
     */
    public void noteSuspectedIgnored(long relayId, ProtocolCode protocol, String upstreamModelId,
                                     String modelId, long sourceId) {
        if (redis == null) return;
        long sources;
        try {
            String key = ignoredKey(relayId, protocol, upstreamModelId);
            Long added = redis.opsForSet().add(key, Long.toString(sourceId));
            redis.expire(key, CONSENSUS_TTL);
            if (added == null || added == 0) return;
            Long size = redis.opsForSet().size(key);
            sources = size == null ? 0 : size;
        } catch (Exception error) {
            log.warn("reasoning ignored-consensus write failed relay={} protocol={} model={}",
                    relayId, protocol, upstreamModelId, error);
            return;
        }
        if (sources < CONSENSUS_THRESHOLD || alerts == null) return;
        try {
            alerts.raise(relayId, modelId, protocol, upstreamModelId,
                    ReasoningAlertRepository.KIND_IGNORED, (int) sources);
            log.warn("reasoning suspected ignored relay={} protocol={} model={} upstream_model={} sources={}",
                    relayId, protocol, modelId, upstreamModelId, sources);
        } catch (Exception error) {
            log.warn("reasoning ignored-alert raise failed relay={} model={}", relayId, modelId, error);
        }
    }

    /** 管理员显式裁决后清掉学习结果，让告警得以消解。 */
    public void clear(long relayId, ProtocolCode protocol, String upstreamModelId) {
        String key = key(relayId, protocol, upstreamModelId);
        local.remove(key);
        if (redis == null) return;
        try {
            redis.delete(List.of(key, consensusKey(relayId, protocol, upstreamModelId),
                    ignoredKey(relayId, protocol, upstreamModelId)));
        } catch (Exception error) {
            log.warn("reasoning deny clear failed key={}", key, error);
        }
    }

    /** 清掉某条路由在全部协议下的学习结果。管理员改裁决时并不知道是哪个协议出的问题。 */
    public void clearRoute(long relayId, String upstreamModelId) {
        for (ProtocolCode protocol : ProtocolCode.values()) clear(relayId, protocol, upstreamModelId);
    }

    private boolean read(String key) {
        if (redis == null) return false;
        try {
            return Boolean.TRUE.equals(redis.hasKey(key));
        } catch (Exception error) {
            log.warn("reasoning deny lookup failed key={}", key, error);
            return false;
        }
    }

    /**
     * 粒度必须是「中转站 × 协议 × 上游模型」。
     *
     * <p>同一个平台模型在不同中转站映射到不同上游 ID；同一个中转站的 Anthropic 端点可能
     * 认 effort 而 ChatCompletions 端点不认。少任何一维都会串味。
     */
    private static String key(long relayId, ProtocolCode protocol, String upstreamModelId) {
        return "relay:effort:deny:" + route(relayId, protocol, upstreamModelId);
    }

    private static String consensusKey(long relayId, ProtocolCode protocol, String upstreamModelId) {
        return "relay:effort:reject:" + route(relayId, protocol, upstreamModelId);
    }

    private static String ignoredKey(long relayId, ProtocolCode protocol, String upstreamModelId) {
        return "relay:effort:ignored:" + route(relayId, protocol, upstreamModelId);
    }

    private static String route(long relayId, ProtocolCode protocol, String upstreamModelId) {
        return relayId + ":" + protocol + ":" + (upstreamModelId == null ? "" : upstreamModelId.trim());
    }

    private record Local(boolean denied, long expiresAtNanos) {}
}
