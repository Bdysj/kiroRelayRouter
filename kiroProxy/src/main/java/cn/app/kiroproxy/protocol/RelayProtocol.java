package cn.app.kiroproxy.protocol;

import java.time.Instant;
import java.util.EnumSet;
import java.util.Set;

public record RelayProtocol(long id, ProtocolCode code, boolean enabled, int priority,
        String pathOverride, Set<ProtocolCapability> capabilities, String verificationStatus,
        Instant lastVerifiedAt, String lastVerificationMessage) {

    public RelayProtocol {
        capabilities = capabilities == null ? Set.of() : Set.copyOf(capabilities);
    }

    public boolean supports(Set<ProtocolCapability> required) {
        return enabled && capabilities.containsAll(required);
    }

    public String path() {
        return pathOverride == null || pathOverride.isBlank() ? code.defaultPath() : pathOverride;
    }

    public static Set<ProtocolCapability> capabilities(boolean text, boolean image, boolean pdf,
            boolean toolUse, boolean toolResult, boolean streaming, boolean promptCache) {
        EnumSet<ProtocolCapability> result = EnumSet.noneOf(ProtocolCapability.class);
        if (text) result.add(ProtocolCapability.TEXT);
        if (image) result.add(ProtocolCapability.IMAGE);
        if (pdf) result.add(ProtocolCapability.PDF);
        if (toolUse) result.add(ProtocolCapability.TOOL_USE);
        if (toolResult) result.add(ProtocolCapability.TOOL_RESULT);
        if (streaming) result.add(ProtocolCapability.STREAMING);
        if (promptCache) result.add(ProtocolCapability.PROMPT_CACHE);
        return result;
    }
}
