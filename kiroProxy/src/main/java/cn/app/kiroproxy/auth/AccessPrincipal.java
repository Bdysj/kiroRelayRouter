package cn.app.kiroproxy.auth;

import java.util.Set;
import java.util.Map;
import java.time.Instant;
import java.math.BigDecimal;

public record AccessPrincipal(long tokenId, long groupId, Set<String> modelIds,
                              Instant expiresAt, Map<String, BigDecimal> modelMultipliers) {
    public AccessPrincipal {
        modelIds = Set.copyOf(modelIds);
        modelMultipliers = Map.copyOf(modelMultipliers);
    }

    public BigDecimal billingMultiplierFor(String modelId) {
        BigDecimal multiplier = modelMultipliers.get(modelId);
        if (multiplier == null) throw new IllegalArgumentException("当前分组未配置该模型倍率");
        return multiplier;
    }

    public boolean expired() {
        return expiresAt != null && !expiresAt.isAfter(Instant.now());
    }
}
