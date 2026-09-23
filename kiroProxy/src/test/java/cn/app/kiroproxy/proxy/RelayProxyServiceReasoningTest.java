package cn.app.kiroproxy.proxy;

import static org.assertj.core.api.Assertions.assertThat;

import cn.app.kiroproxy.protocol.AnthropicMessagesAdapter;
import cn.app.kiroproxy.protocol.CanonicalStreamEvent;
import cn.app.kiroproxy.protocol.OpenAiChatCompletionsAdapter;
import cn.app.kiroproxy.protocol.OpenAiResponsesAdapter;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * 验证reasoning功能在各个协议适配器中的正确处理
 */
class RelayProxyServiceReasoningTest {
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void openAiChatCompletionsAdapterHandlesReasoningContent() throws Exception {
        OpenAiChatCompletionsAdapter adapter = new OpenAiChatCompletionsAdapter();
        String data = "{\"choices\":[{\"delta\":{\"reasoning_content\":\"Let me analyze this...\"}}]}";

        List<CanonicalStreamEvent> events = adapter.decode(mapper, "chunk", data);

        assertThat(events).hasSize(1);
        assertThat(events.get(0).type()).isEqualTo(CanonicalStreamEvent.Type.REASONING_DELTA);
        assertThat(events.get(0).text()).isEqualTo("Let me analyze this...");
    }

    @Test
    void openAiResponsesAdapterHandlesReasoningTextDelta() throws Exception {
        OpenAiResponsesAdapter adapter = new OpenAiResponsesAdapter();
        String data = "{\"type\":\"response.reasoning_text.delta\",\"delta\":\"Thinking step by step...\"}";

        List<CanonicalStreamEvent> events = adapter.decode(mapper, "response.reasoning_text.delta", data);

        assertThat(events).hasSize(1);
        assertThat(events.get(0).type()).isEqualTo(CanonicalStreamEvent.Type.REASONING_DELTA);
        assertThat(events.get(0).text()).isEqualTo("Thinking step by step...");
    }

    @Test
    void anthropicMessagesAdapterHandlesThinkingDelta() throws Exception {
        AnthropicMessagesAdapter adapter = new AnthropicMessagesAdapter();
        String data = "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Considering the options...\"}}";

        List<CanonicalStreamEvent> events = adapter.decode(mapper, "content_block_delta", data);

        assertThat(events).hasSize(1);
        assertThat(events.get(0).type()).isEqualTo(CanonicalStreamEvent.Type.REASONING_DELTA);
        assertThat(events.get(0).text()).isEqualTo("Considering the options...");
    }

    @Test
    void textDeltaIsNotConfusedWithReasoningDelta() throws Exception {
        OpenAiChatCompletionsAdapter adapter = new OpenAiChatCompletionsAdapter();
        String data = "{\"choices\":[{\"delta\":{\"content\":\"Hello, world!\"}}]}";

        List<CanonicalStreamEvent> events = adapter.decode(mapper, "chunk", data);

        assertThat(events).hasSize(1);
        assertThat(events.get(0).type()).isEqualTo(CanonicalStreamEvent.Type.TEXT_DELTA);
        assertThat(events.get(0).text()).isEqualTo("Hello, world!");
    }

    @Test
    void anthropicTextDeltaIsNotConfusedWithThinkingDelta() throws Exception {
        AnthropicMessagesAdapter adapter = new AnthropicMessagesAdapter();
        String data = "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Response text\"}}";

        List<CanonicalStreamEvent> events = adapter.decode(mapper, "content_block_delta", data);

        assertThat(events).hasSize(1);
        assertThat(events.get(0).type()).isEqualTo(CanonicalStreamEvent.Type.TEXT_DELTA);
        assertThat(events.get(0).text()).isEqualTo("Response text");
    }
}
