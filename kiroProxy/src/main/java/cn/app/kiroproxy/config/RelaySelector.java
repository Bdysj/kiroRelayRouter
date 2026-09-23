package cn.app.kiroproxy.config;

import cn.app.kiroproxy.protocol.ProtocolCapability;
import cn.app.kiroproxy.protocol.RelayProtocol;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.locks.LockSupport;
import java.util.concurrent.atomic.AtomicInteger;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Service;

/** Selects an already health-checked upstream; it never performs network health checks on request threads. */
@Service
public class RelaySelector {
    private final RelayConfigurationRepository repository;
    private final StringRedisTemplate redis;
    private final ConcurrentHashMap<Long, AtomicInteger> inFlight = new ConcurrentHashMap<>();
    private volatile List<RelayEndpoint> snapshot = List.of();
    private volatile long redisRetryAfterNanos;
    private static final DefaultRedisScript<Long> ACQUIRE_SCRIPT = new DefaultRedisScript<>("""
            local current = tonumber(redis.call('GET', KEYS[1]) or '0')
            local limit = tonumber(ARGV[1])
            if current >= limit then return -1 end
            current = redis.call('INCR', KEYS[1])
            redis.call('PEXPIRE', KEYS[1], ARGV[2])
            return current
            """, Long.class);
    private static final DefaultRedisScript<Long> RELEASE_SCRIPT = new DefaultRedisScript<>("""
            local current = tonumber(redis.call('GET', KEYS[1]) or '0')
            if current <= 1 then redis.call('DEL', KEYS[1]); return 0 end
            return redis.call('DECR', KEYS[1])
            """, Long.class);

    public RelaySelector(RelayConfigurationRepository repository) {
        this(repository, null);
    }

    @Autowired
    public RelaySelector(RelayConfigurationRepository repository, StringRedisTemplate redis) {
        this.repository = repository;
        this.redis = redis;
    }

    public void reload() {
        snapshot = List.copyOf(repository.findEnabledEndpoints());
    }

    public List<RelayEndpoint> snapshot() {
        return snapshot;
    }

    public boolean hasAvailableRelay(String modelId) {
        return snapshot.stream().anyMatch(endpoint -> eligible(endpoint, modelId, Set.of())
                && belowLimit(endpoint));
    }

    /** Checks route validity without treating temporary concurrency saturation as invalidation. */
    public boolean supportsRoute(long endpointId, String modelId, Set<ProtocolCapability> required) {
        return snapshot.stream().anyMatch(endpoint -> endpoint.id() == endpointId
                && eligible(endpoint, modelId, Set.of())
                && !endpoint.protocolsFor(modelId, required).isEmpty());
    }

    public Lease select(String modelId, Set<Long> excludedIds) {
        return select(modelId, Set.of(ProtocolCapability.TEXT, ProtocolCapability.STREAMING), excludedIds);
    }

    /** Capability filtering is deliberately performed before relay priority and weight. */
    public Lease select(String modelId, Set<ProtocolCapability> required, Set<Long> excludedIds) {
        return selectRoute(modelId, required, Set.of(), excludedIds, null, Duration.ZERO);
    }

    public Lease selectRoute(String modelId, Set<ProtocolCapability> required, Set<RouteKey> excludedRoutes,
                             Long preferredEndpointId, Duration preferredWait) {
        return selectRoute(modelId, required, excludedRoutes, Set.of(), preferredEndpointId, preferredWait);
    }

    private Lease selectRoute(String modelId, Set<ProtocolCapability> required, Set<RouteKey> excludedRoutes,
                              Set<Long> excludedIds, Long preferredEndpointId, Duration preferredWait) {
        boolean hasModelRelay = snapshot.stream().anyMatch(endpoint -> eligible(endpoint, modelId, excludedIds));
        boolean hasCapableProtocol = snapshot.stream().filter(endpoint -> eligible(endpoint, modelId, excludedIds))
                .anyMatch(endpoint -> !endpoint.protocolsFor(modelId, required).isEmpty());
        if (hasModelRelay && !hasCapableProtocol) throw new ProtocolCapabilityUnavailableException(required);
        List<Candidate> candidates = snapshot.stream()
                .filter(endpoint -> eligible(endpoint, modelId, excludedIds))
                .flatMap(endpoint -> endpoint.protocolsFor(modelId, required).stream()
                        .map(protocol -> new Candidate(endpoint, protocol)))
                .filter(candidate -> !excludedRoutes.contains(new RouteKey(candidate.endpoint.id(),
                        candidate.protocol.code())))
                .sorted(Comparator.comparingInt((Candidate candidate) ->
                                preferredEndpointId != null && candidate.endpoint.id() == preferredEndpointId ? 0 : 1)
                        .thenComparingInt(candidate -> candidate.protocol.priority())
                        .thenComparingInt(candidate -> candidate.endpoint.priorityFor(modelId))
                        .thenComparingLong(candidate -> candidate.endpoint.id()))
                .toList();
        if (preferredEndpointId != null && !preferredWait.isZero() && !preferredWait.isNegative()) {
            List<Candidate> preferred = candidates.stream()
                    .filter(candidate -> candidate.endpoint.id() == preferredEndpointId).toList();
            Lease lease = waitForPreferred(preferred, modelId, preferredWait);
            if (lease != null) return lease;
        }
        Lease selected = acquireByPriority(candidates, modelId, preferredEndpointId);
        if (selected != null) return selected;
        throw new NoRelayAvailableException("当前模型没有同时满足请求能力的可用中转协议，或所有候选均已达并发上限");
    }

    private Lease waitForPreferred(List<Candidate> candidates, String modelId, Duration wait) {
        if (candidates.isEmpty()) return null;
        long deadline = System.nanoTime() + wait.toNanos();
        do {
            Lease lease = acquireByPriority(candidates, modelId, null);
            if (lease != null) return lease;
            if (Thread.currentThread().isInterrupted()) return null;
            LockSupport.parkNanos(Math.min(Duration.ofMillis(25).toNanos(),
                    Math.max(0, deadline - System.nanoTime())));
        } while (System.nanoTime() < deadline);
        return null;
    }

    private Lease acquireByPriority(List<Candidate> candidates, String modelId, Long preferredEndpointId) {
        int offset = 0;
        while (offset < candidates.size()) {
            boolean affinityTier = preferredEndpointId != null
                    && candidates.get(offset).endpoint.id() == preferredEndpointId;
            int protocolPriority = candidates.get(offset).protocol.priority();
            int relayPriority = candidates.get(offset).endpoint.priorityFor(modelId);
            List<Candidate> tier = new ArrayList<>();
            while (offset < candidates.size()
                    && (preferredEndpointId != null
                            && candidates.get(offset).endpoint.id() == preferredEndpointId) == affinityTier
                    && candidates.get(offset).protocol.priority() == protocolPriority
                    && candidates.get(offset).endpoint.priorityFor(modelId) == relayPriority) {
                tier.add(candidates.get(offset++));
            }
            while (!tier.isEmpty()) {
                Candidate choice = weightedPickCandidate(tier, modelId);
                RelayEndpoint selected = choice.endpoint;
                AcquireResult acquired = tryAcquire(selected);
                if (acquired.acquired()) return new Lease(selected, choice.protocol, this, acquired.distributed());
                tier.remove(choice);
            }
        }
        return null;
    }

    public void recordSuccess(RelayEndpoint endpoint) {
        java.util.concurrent.CompletableFuture.runAsync(() -> {
            try { repository.recordRequestSuccess(endpoint.id()); }
            catch (RuntimeException ignored) { }
        });
    }

    public void recordFailure(RelayEndpoint endpoint) {
        repository.recordRequestFailure(endpoint.id());
        reload();
    }

    private boolean eligible(RelayEndpoint endpoint, String modelId, Set<Long> excludedIds) {
        return endpoint.enabled() && endpoint.healthStatus() == RelayEndpoint.HealthStatus.UP
                && endpoint.supports(modelId) && !excludedIds.contains(endpoint.id());
    }

    private boolean belowLimit(RelayEndpoint endpoint) {
        return endpoint.maxConcurrency() == 0
                || inFlight.computeIfAbsent(endpoint.id(), ignored -> new AtomicInteger()).get() < endpoint.maxConcurrency();
    }

    private AcquireResult tryAcquire(RelayEndpoint endpoint) {
        AtomicInteger count = inFlight.computeIfAbsent(endpoint.id(), ignored -> new AtomicInteger());
        if (endpoint.maxConcurrency() == 0) {
            count.incrementAndGet();
            return new AcquireResult(true, false);
        }
        while (true) {
            int current = count.get();
            if (current >= endpoint.maxConcurrency()) return new AcquireResult(false, false);
            if (count.compareAndSet(current, current + 1)) break;
        }
        if (redis != null && System.nanoTime() >= redisRetryAfterNanos) {
            try {
                long ttlMs = Math.max(60_000L, endpoint.readTimeoutMs() + 60_000L);
                Long value = redis.execute(ACQUIRE_SCRIPT, List.of("relay:inflight:" + endpoint.id()),
                        Integer.toString(endpoint.maxConcurrency()), Long.toString(ttlMs));
                if (value != null && value >= 0) return new AcquireResult(true, true);
                count.decrementAndGet();
                return new AcquireResult(false, false);
            } catch (RuntimeException error) {
                // Keep one-node availability when Redis is temporarily offline;
                // retry distributed coordination after a short cool-down.
                redisRetryAfterNanos = System.nanoTime() + java.time.Duration.ofSeconds(30).toNanos();
            }
        }
        return new AcquireResult(true, false);
    }

    private static Candidate weightedPickCandidate(List<Candidate> candidates, String modelId) {
        long total = candidates.stream().mapToLong(value -> value.endpoint.weightFor(modelId)).sum();
        long value = ThreadLocalRandom.current().nextLong(total);
        for (Candidate candidate : candidates) {
            value -= candidate.endpoint.weightFor(modelId);
            if (value < 0) return candidate;
        }
        return candidates.get(candidates.size() - 1);
    }

    private void release(long endpointId, boolean distributed) {
        AtomicInteger count = inFlight.get(endpointId);
        if (count != null) count.updateAndGet(value -> Math.max(0, value - 1));
        if (distributed && redis != null) {
            try { redis.execute(RELEASE_SCRIPT, List.of("relay:inflight:" + endpointId)); }
            catch (RuntimeException ignored) { }
        }
    }

    public static final class Lease implements AutoCloseable {
        private final RelayEndpoint endpoint;
        private final RelayProtocol protocol;
        private final RelaySelector owner;
        private final boolean distributed;
        private boolean closed;

        private Lease(RelayEndpoint endpoint, RelayProtocol protocol, RelaySelector owner, boolean distributed) {
            this.endpoint = endpoint;
            this.protocol = protocol;
            this.owner = owner;
            this.distributed = distributed;
        }

        public RelayEndpoint endpoint() { return endpoint; }
        public RelayProtocol protocol() { return protocol; }

        @Override
        public void close() {
            if (!closed) {
                closed = true;
                owner.release(endpoint.id(), distributed);
            }
        }
    }

    private record AcquireResult(boolean acquired, boolean distributed) {}
    private record Candidate(RelayEndpoint endpoint, RelayProtocol protocol) {}
    public record RouteKey(long endpointId, cn.app.kiroproxy.protocol.ProtocolCode protocolCode) {}

    public static final class NoRelayAvailableException extends RuntimeException {
        public NoRelayAvailableException(String message) { super(message); }
    }

    public static final class ProtocolCapabilityUnavailableException extends RuntimeException {
        private final Set<ProtocolCapability> required;
        public ProtocolCapabilityUnavailableException(Set<ProtocolCapability> required) {
            super(required.contains(ProtocolCapability.PDF)
                    ? "PROTOCOL_CAPABILITY_UNAVAILABLE：当前模型暂无支持 PDF 附件的可用中转协议。"
                    : "PROTOCOL_CAPABILITY_UNAVAILABLE：当前模型暂无满足请求能力的可用中转协议。");
            this.required = Set.copyOf(required);
        }
        public Set<ProtocolCapability> required() { return required; }
    }
}
