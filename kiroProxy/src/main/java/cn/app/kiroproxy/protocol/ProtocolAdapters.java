package cn.app.kiroproxy.protocol;

import java.util.Map;

public final class ProtocolAdapters {
    private static final Map<ProtocolCode, ProtocolAdapter> ADAPTERS = Map.of(
            ProtocolCode.OPENAI_CHAT_COMPLETIONS, new OpenAiChatCompletionsAdapter(),
            ProtocolCode.OPENAI_RESPONSES, new OpenAiResponsesAdapter(),
            ProtocolCode.ANTHROPIC_MESSAGES, new AnthropicMessagesAdapter());

    private ProtocolAdapters() {}

    public static ProtocolAdapter get(ProtocolCode code) {
        ProtocolAdapter adapter = ADAPTERS.get(code);
        if (adapter == null) throw new IllegalArgumentException("Unsupported protocol: " + code);
        return adapter;
    }
}
