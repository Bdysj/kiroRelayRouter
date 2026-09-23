package cn.app.kiroproxy.protocol;

import java.util.Locale;
import java.util.Set;

/** Conservative model-family inference used only when no explicit model×protocol mapping exists. */
public final class ModelProtocolClassifier {
    private ModelProtocolClassifier() {}

    public enum Family { OPENAI, ANTHROPIC, UNKNOWN }

    public static Family classify(String modelId) {
        if (modelId == null || modelId.isBlank()) return Family.UNKNOWN;
        String value = modelId.trim().toLowerCase(Locale.ROOT);
        if (value.contains("claude") || value.startsWith("anthropic/")) return Family.ANTHROPIC;
        String leaf = value.substring(Math.max(value.lastIndexOf('/'), value.lastIndexOf(':')) + 1);
        if (value.startsWith("openai/") || leaf.startsWith("gpt-") || leaf.startsWith("chatgpt-")
                || leaf.startsWith("o1-") || leaf.equals("o1") || leaf.startsWith("o3-") || leaf.equals("o3")
                || leaf.startsWith("o4-") || leaf.equals("o4") || leaf.contains("codex")) return Family.OPENAI;
        return Family.UNKNOWN;
    }

    public static Set<ProtocolCode> protocols(Family family) {
        return switch (family) {
            case OPENAI -> Set.of(ProtocolCode.OPENAI_CHAT_COMPLETIONS, ProtocolCode.OPENAI_RESPONSES);
            case ANTHROPIC -> Set.of(ProtocolCode.ANTHROPIC_MESSAGES,
                    ProtocolCode.OPENAI_CHAT_COMPLETIONS);
            case UNKNOWN -> Set.of();
        };
    }
}
