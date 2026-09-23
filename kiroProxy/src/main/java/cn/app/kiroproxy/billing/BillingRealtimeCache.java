package cn.app.kiroproxy.billing;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

@Component
public class BillingRealtimeCache {
    private static final Logger log = LoggerFactory.getLogger(BillingRealtimeCache.class);
    private final StringRedisTemplate redis;
    public BillingRealtimeCache(StringRedisTemplate redis) { this.redis = redis; }

    public void updateWallet(long tokenId, BigDecimal available, BigDecimal frozen,
                             String requestId, String requestStatus) {
        CompletableFuture.runAsync(() -> writeWallet(tokenId, available, frozen, requestId, requestStatus));
    }

    private void writeWallet(long tokenId, BigDecimal available, BigDecimal frozen,
                             String requestId, String requestStatus) {
        try {
            String key = "kiro:billing:wallet:" + tokenId;
            redis.opsForHash().putAll(key, Map.of("availablePoints", available.toPlainString(),
                    "frozenPoints", frozen.toPlainString()));
            redis.expire(key, Duration.ofHours(24));
            writeRequest(requestId, requestStatus);
        } catch (RuntimeException error) {
            log.debug("billing redis mirror unavailable token_id={} reason={}", tokenId, error.getClass().getSimpleName());
        }
    }

    public void updateRequest(String requestId, String status) {
        CompletableFuture.runAsync(() -> writeRequest(requestId, status));
    }

    private void writeRequest(String requestId, String status) {
        try {
            redis.opsForValue().set("kiro:billing:request:" + requestId, status, Duration.ofHours(24));
        } catch (RuntimeException error) {
            log.debug("billing redis request mirror unavailable request={} reason={}", requestId,
                    error.getClass().getSimpleName());
        }
    }
}
