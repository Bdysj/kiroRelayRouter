package cn.app.kiroproxy.protocol;

import java.util.Set;

public enum ProtocolStrategy {
    AUTO(Set.of(ProtocolCode.values())),
    OPENAI_SMART(Set.of(ProtocolCode.OPENAI_CHAT_COMPLETIONS, ProtocolCode.OPENAI_RESPONSES)),
    ANTHROPIC_SMART(Set.of(ProtocolCode.ANTHROPIC_MESSAGES, ProtocolCode.OPENAI_CHAT_COMPLETIONS));

    private final Set<ProtocolCode> allowed;

    ProtocolStrategy(Set<ProtocolCode> allowed) { this.allowed = allowed; }

    public boolean allows(ProtocolCode code) { return allowed.contains(code); }
}
