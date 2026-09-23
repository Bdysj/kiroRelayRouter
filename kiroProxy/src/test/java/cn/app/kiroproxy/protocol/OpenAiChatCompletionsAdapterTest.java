package cn.app.kiroproxy.protocol;

import static org.assertj.core.api.Assertions.assertThat;

import cn.app.kiroproxy.protocol.CanonicalStreamEvent.Type;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import org.junit.jupiter.api.Test;

class OpenAiChatCompletionsAdapterTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final OpenAiChatCompletionsAdapter adapter = new OpenAiChatCompletionsAdapter();

    @Test
    void shouldExtractReasoningContentFromDelta() throws Exception {
        String chunk = "{\"choices\":[{\"delta\":{\"reasoning_content\":\"思考步骤1: 分析问题...\"}}]}";

        List<CanonicalStreamEvent> events = adapter.decode(mapper, "data", chunk);

        assertThat(events).hasSize(1);
        assertThat(events.get(0).type()).isEqualTo(Type.REASONING_DELTA);
        assertThat(events.get(0).text()).isEqualTo("思考步骤1: 分析问题...");
    }

    @Test
    void shouldSupportReasoningFieldVariants() throws Exception {
        for (String field : List.of("reasoning_content", "reasoning", "thinking")) {
            String chunk = "{\"choices\":[{\"delta\":{\"" + field + "\":\"content\"}}]}";

            List<CanonicalStreamEvent> events = adapter.decode(mapper, "data", chunk);

            assertThat(events).as("field=%s", field).hasSize(1);
            assertThat(events.get(0).type()).isEqualTo(Type.REASONING_DELTA);
        }
    }

    @Test
    void shouldHandleBothReasoningAndTextInSameChunk() throws Exception {
        String chunk = "{\"choices\":[{\"delta\":{\"reasoning\":\"thinking...\",\"content\":\"answer\"}}]}";

        List<CanonicalStreamEvent> events = adapter.decode(mapper, "data", chunk);

        assertThat(events).hasSize(2);
        assertThat(events.get(0).type()).isEqualTo(Type.TEXT_DELTA);
        assertThat(events.get(0).text()).isEqualTo("answer");
        assertThat(events.get(1).type()).isEqualTo(Type.REASONING_DELTA);
        assertThat(events.get(1).text()).isEqualTo("thinking...");
    }

    @Test
    void shouldIgnoreEmptyReasoningContent() throws Exception {
        String chunk = "{\"choices\":[{\"delta\":{\"reasoning_content\":\"\"}}]}";

        List<CanonicalStreamEvent> events = adapter.decode(mapper, "data", chunk);

        assertThat(events).isEmpty();
    }
}
