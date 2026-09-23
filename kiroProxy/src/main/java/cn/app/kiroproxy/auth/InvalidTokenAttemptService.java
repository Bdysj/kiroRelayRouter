package cn.app.kiroproxy.auth;

import java.time.Duration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

@Service
public class InvalidTokenAttemptService {
    public static final int MAX_ATTEMPTS = 10;
    public static final Duration COOLDOWN = Duration.ofHours(1);
    private static final Logger log = LoggerFactory.getLogger(InvalidTokenAttemptService.class);
    private final StringRedisTemplate redis;

    public InvalidTokenAttemptService(ObjectProvider<StringRedisTemplate> redis) {
        this.redis = redis.getIfAvailable();
    }

    public boolean coolingDown(String machineId) {
        if (redis == null || machineId == null || machineId.isBlank()) return false;
        try {
            String value = redis.opsForValue().get(key(machineId));
            return value != null && Long.parseLong(value) >= MAX_ATTEMPTS;
        } catch (Exception error) {
            log.warn("invalid-token cooldown lookup failed machine={}", machineId, error);
            return false;
        }
    }

    public long recordFailure(String machineId) {
        if (redis == null || machineId == null || machineId.isBlank()) return 0;
        try {
            String key = key(machineId);
            Long attempts = redis.opsForValue().increment(key);
            redis.expire(key, COOLDOWN);
            return attempts == null ? 0 : attempts;
        } catch (Exception error) {
            log.warn("invalid-token attempt write failed machine={}", machineId, error);
            return 0;
        }
    }

    public void clear(String machineId) {
        if (redis == null || machineId == null || machineId.isBlank()) return;
        try {
            redis.delete(key(machineId));
        } catch (Exception error) {
            log.warn("invalid-token attempt clear failed machine={}", machineId, error);
        }
    }

    private static String key(String machineId) {
        return "security:invalid-token:" + machineId.trim();
    }
}
