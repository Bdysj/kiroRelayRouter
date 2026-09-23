package cn.app.kiroproxy.config;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Service;

/** Maintains soft relay affinity for real downstream conversations only. */
@Service
public class ConversationAffinityService {
    private static final Logger log = LoggerFactory.getLogger(ConversationAffinityService.class);
    private static final Duration REDIS_RETRY_DELAY = Duration.ofSeconds(30);
    private static final DefaultRedisScript<Long> REPLACE_SCRIPT = new DefaultRedisScript<>("""
            if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
            redis.call('PSETEX', KEYS[1], ARGV[3], ARGV[2])
            return 1
            """, Long.class);
    private static final DefaultRedisScript<Long> DELETE_SCRIPT = new DefaultRedisScript<>("""
            if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
            return redis.call('DEL', KEYS[1])
            """, Long.class);

    private final StringRedisTemplate redis;
    private final Duration idleTtl;
    private final Duration maximumTtl;
    private final AtomicLong redisRetryAfterMillis = new AtomicLong();

    @Autowired
    public ConversationAffinityService(ObjectProvider<StringRedisTemplate> redis,
            @Value("${kiro.relay.affinity.idle-ttl:60m}") Duration idleTtl,
            @Value("${kiro.relay.affinity.maximum-ttl:12h}") Duration maximumTtl) {
        this(redis.getIfAvailable(), idleTtl, maximumTtl);
    }

    ConversationAffinityService(StringRedisTemplate redis, Duration idleTtl, Duration maximumTtl) {
        if (idleTtl.isZero() || idleTtl.isNegative()) throw new IllegalArgumentException("idleTtl must be positive");
        if (maximumTtl.compareTo(idleTtl) < 0) {
            throw new IllegalArgumentException("maximumTtl must not be shorter than idleTtl");
        }
        this.redis = redis;
        this.idleTtl = idleTtl;
        this.maximumTtl = maximumTtl;
    }

    public Optional<Binding> find(long accessTokenId, String conversationId, String modelId) {
        String key = key(accessTokenId, conversationId, modelId);
        if (key == null || !redisAvailable()) return Optional.empty();
        try {
            String value = redis.opsForValue().get(key);
            if (value == null) return Optional.empty();
            Binding binding = parse(key, value);
            if (binding == null || remainingTtl(binding.createdAtMillis()).isZero()) {
                redis.delete(key);
                return Optional.empty();
            }
            return Optional.of(binding);
        } catch (RuntimeException error) {
            redisUnavailable(error);
            return Optional.empty();
        }
    }

    /**
     * Records the successful relay without allowing concurrent first requests to overwrite one another.
     * A request that observed an old binding may atomically replace only that same binding after failover.
     */
    public void recordSuccess(long accessTokenId, String conversationId, String modelId,
            Binding observed, long relayId) {
        String key = key(accessTokenId, conversationId, modelId);
        if (key == null || !redisAvailable()) return;
        try {
            long now = Instant.now().toEpochMilli();
            if (observed == null) {
                String value = encode(relayId, now);
                redis.opsForValue().setIfAbsent(key, value, remainingTtl(now));
                return;
            }
            Duration ttl = remainingTtl(observed.createdAtMillis());
            if (ttl.isZero()) {
                redis.delete(key);
                redis.opsForValue().setIfAbsent(key, encode(relayId, now), remainingTtl(now));
                return;
            }
            String replacement = encode(relayId, observed.createdAtMillis());
            redis.execute(REPLACE_SCRIPT, List.of(key), observed.rawValue(), replacement,
                    Long.toString(ttl.toMillis()));
        } catch (RuntimeException error) {
            redisUnavailable(error);
        }
    }

    public void invalidate(Binding observed) {
        if (observed == null || !redisAvailable()) return;
        try {
            redis.execute(DELETE_SCRIPT, List.of(observed.key()), observed.rawValue());
        } catch (RuntimeException error) {
            redisUnavailable(error);
        }
    }

    private boolean redisAvailable() {
        return redis != null && System.currentTimeMillis() >= redisRetryAfterMillis.get();
    }

    private void redisUnavailable(RuntimeException error) {
        redisRetryAfterMillis.set(System.currentTimeMillis() + REDIS_RETRY_DELAY.toMillis());
        log.warn("conversation affinity temporarily disabled reason={}", error.getClass().getSimpleName());
    }

    private Duration remainingTtl(long createdAtMillis) {
        long hardRemaining = maximumTtl.toMillis() - Math.max(0, Instant.now().toEpochMilli() - createdAtMillis);
        return Duration.ofMillis(Math.max(0, Math.min(idleTtl.toMillis(), hardRemaining)));
    }

    private static Binding parse(String key, String value) {
        int separator = value.indexOf(':');
        if (separator <= 0 || separator == value.length() - 1) return null;
        try {
            return new Binding(key, Long.parseLong(value.substring(0, separator)),
                    Long.parseLong(value.substring(separator + 1)), value);
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static String encode(long relayId, long createdAtMillis) {
        return relayId + ":" + createdAtMillis;
    }

    private static String key(long accessTokenId, String conversationId, String modelId) {
        if (accessTokenId <= 0 || conversationId == null || conversationId.isBlank()
                || modelId == null || modelId.isBlank()) return null;
        String identity = accessTokenId + "\n" + conversationId.trim() + "\n" + modelId.trim();
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(identity.getBytes(StandardCharsets.UTF_8));
            return "relay:conversation-affinity:" + HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    public record Binding(String key, long relayId, long createdAtMillis, String rawValue) {}
}
