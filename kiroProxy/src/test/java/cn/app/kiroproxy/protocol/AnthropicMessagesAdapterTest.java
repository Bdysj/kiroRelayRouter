package cn.app.kiroproxy.protocol;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Regression coverage for Anthropic's streamed tool_use wire shape. */
class AnthropicMessagesAdapterTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final AnthropicMessagesAdapter adapter = new AnthropicMessagesAdapter();

    @Test
    void reasoningEffortUsesAnthropicOutputConfig() throws Exception {
        ObjectNode canonical = (ObjectNode) mapper.readTree("""
                {"model":"claude-opus-4-6","reasoning_effort":"max",
                 "messages":[{"role":"user","content":"Hello"}]}
                """);

        ObjectNode encoded = adapter.encode(mapper, canonical);

        assertThat(encoded.path("output_config").path("effort").asText()).isEqualTo("max");
        assertThat(encoded.has("effort")).isFalse();
        assertThat(encoded.has("thinking")).isFalse();
    }

    @Test
    void effortAndStructuredOutputFormatAreBothPreserved() throws Exception {
        ObjectNode canonical = (ObjectNode) mapper.readTree("""
                {"model":"claude-opus-4-6","reasoning_effort":"high",
                 "_anthropic_output_format":{"type":"json_schema","schema":{"type":"object"}},
                 "messages":[{"role":"user","content":"Hello"}]}
                """);

        ObjectNode encoded = adapter.encode(mapper, canonical);

        assertThat(encoded.path("output_config").path("effort").asText()).isEqualTo("high");
        assertThat(encoded.path("output_config").path("format"))
                .isEqualTo(canonical.path("_anthropic_output_format"));
        assertThat(encoded.path("output_config").size()).isEqualTo(2);
    }

    @Test
    void unspecifiedEffortDoesNotAddOutputConfig() throws Exception {
        ObjectNode canonical = (ObjectNode) mapper.readTree("""
                {"model":"claude-opus-4-6","messages":[{"role":"user","content":"Hello"}]}
                """);

        assertThat(adapter.encode(mapper, canonical).has("output_config")).isFalse();
    }

    @Test
    void emptyToolInputInitializerIsNotMistakenForArgumentsSnapshot() throws Exception {
        List<CanonicalStreamEvent> start = adapter.decode(mapper, "content_block_start", """
                {"type":"content_block_start","index":1,"content_block":{
                  "type":"tool_use","id":"toolu_123","name":"read","input":{}
                }}
                """);

        assertThat(start).extracting(CanonicalStreamEvent::type)
                .containsExactly(CanonicalStreamEvent.Type.TOOL_START);
        assertThat(start.get(0).id()).isEqualTo("toolu_123");
        assertThat(start.get(0).name()).isEqualTo("read");

        List<CanonicalStreamEvent> delta = adapter.decode(mapper, "content_block_delta", """
                {"type":"content_block_delta","index":1,"delta":{
                  "type":"input_json_delta","partial_json":"{\\"path\\":\\"a.txt\\"}"
                }}
                """);

        assertThat(delta).singleElement().satisfies(event -> {
            assertThat(event.type()).isEqualTo(CanonicalStreamEvent.Type.TOOL_DELTA);
            assertThat(event.index()).isEqualTo(1);
            assertThat(event.text()).isEqualTo("{\"path\":\"a.txt\"}");
        });

        List<CanonicalStreamEvent> finish = adapter.decode(mapper, "message_delta", """
                {"type":"message_delta","delta":{"stop_reason":"tool_use"}}
                """);
        assertThat(finish).singleElement().satisfies(event -> {
            assertThat(event.type()).isEqualTo(CanonicalStreamEvent.Type.FINISH);
            assertThat(event.finishReason()).isEqualTo("tool_use");
        });

        assertThat(adapter.decode(mapper, "message_stop", "{\"type\":\"message_stop\"}"))
                .extracting(CanonicalStreamEvent::type)
                .containsExactly(CanonicalStreamEvent.Type.DONE);
    }

    @Test
    void nonEmptyToolInputAtStartRemainsACompatibleSnapshot() throws Exception {
        List<CanonicalStreamEvent> events = adapter.decode(mapper, "content_block_start", """
                {"type":"content_block_start","index":0,"content_block":{
                  "type":"tool_use","id":"toolu_456","name":"read",
                  "input":{"path":"a.txt"}
                }}
                """);

        assertThat(events).extracting(CanonicalStreamEvent::type)
                .containsExactly(CanonicalStreamEvent.Type.TOOL_START,
                        CanonicalStreamEvent.Type.TOOL_SNAPSHOT);
        assertThat(events.get(1).text()).isEqualTo("{\"path\":\"a.txt\"}");
    }
}
