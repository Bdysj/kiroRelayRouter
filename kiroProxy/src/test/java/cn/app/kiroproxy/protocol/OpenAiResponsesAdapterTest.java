package cn.app.kiroproxy.protocol;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import org.junit.jupiter.api.Test;

class OpenAiResponsesAdapterTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final OpenAiResponsesAdapter adapter = new OpenAiResponsesAdapter();

    @Test
    void preservesIncompleteReasonInsteadOfReportingSuccessfulStop() throws Exception {
        String data = "{\"type\":\"response.incomplete\",\"response\":{\"model\":\"gpt-test\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"usage\":{\"input_tokens\":10,\"output_tokens\":20}}}";

        List<CanonicalStreamEvent> events = adapter.decode(mapper, "response.incomplete", data);

        assertThat(events).extracting(CanonicalStreamEvent::type)
                .containsExactly(CanonicalStreamEvent.Type.USAGE, CanonicalStreamEvent.Type.MODEL,
                        CanonicalStreamEvent.Type.FINISH, CanonicalStreamEvent.Type.DONE);
        assertThat(events.get(2).finishReason()).isEqualTo("max_output_tokens");
    }

    @Test
    void completedResponseStillReportsNormalStop() throws Exception {
        String data = "{\"type\":\"response.completed\",\"response\":{\"model\":\"gpt-test\"}}";

        List<CanonicalStreamEvent> events = adapter.decode(mapper, "response.completed", data);

        assertThat(events).extracting(CanonicalStreamEvent::type)
                .containsExactly(CanonicalStreamEvent.Type.MODEL, CanonicalStreamEvent.Type.FINISH,
                        CanonicalStreamEvent.Type.DONE);
        assertThat(events.get(1).finishReason()).isEqualTo("stop");
    }
    @Test
    void emitsStatelessCodexCompatibleEnvelopeWithoutInventingReasoningOrSampling() throws Exception {
        var canonical = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree(
                "{\"model\":\"gpt-6.1-sol\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}");
        var encoded = adapter.encode(mapper, canonical);
        assertThat(encoded.path("store").asBoolean(true)).isFalse();
        assertThat(encoded.path("instructions").asText("missing")).isEmpty();
        assertThat(encoded.path("tools").isArray()).isTrue();
        assertThat(encoded.path("parallel_tool_calls").asBoolean()).isTrue();
        assertThat(encoded.has("reasoning")).isFalse();
        assertThat(encoded.has("temperature")).isFalse();
        assertThat(encoded.has("previous_response_id")).isFalse();
        assertThat(encoded.path("input").path(0).path("content").path(0).path("type").asText())
                .isEqualTo("input_text");
        assertThat(canonical.has("store")).isFalse();
    }

    @Test
    void preservesOptionalKiroSchemasRatherThanEnablingStrictMode() throws Exception {
        var canonical = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree("""
            {"model":"gpt-6.1-sol","messages":[],"tools":[{"type":"function","function":{
              "name":"fs_write","parameters":{"type":"object","properties":{
                "path":{"type":"string"},"create_dirs":{"type":"boolean"}},"required":["path"]}}}]}
            """);
        var schema = canonical.path("tools").path(0).path("function").path("parameters").deepCopy();
        var tool = adapter.encode(mapper, canonical).path("tools").path(0);
        assertThat(tool.path("strict").asBoolean(true)).isFalse();
        assertThat(tool.path("parameters")).isEqualTo(schema);
        assertThat(tool.has("function")).isFalse();
        ((com.fasterxml.jackson.databind.node.ObjectNode) canonical.path("tools").path(0).path("function"))
                .put("strict", true);
        assertThat(adapter.encode(mapper, canonical).path("tools").path(0).path("strict").asBoolean()).isTrue();
    }

    @Test
    void replaysAssistantTextAsOutputTextAndSkipsEmptyToolOnlyMessages() throws Exception {
        var canonical = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree("""
            {"model":"gpt-6.1-sol","messages":[
              {"role":"system","content":[{"type":"text","text":"Be precise"}]},
              {"role":"assistant","content":[{"type":"text","text":"Checking"}]},
              {"role":"assistant","content":"","tool_calls":[{"id":"call-original","function":{
                "name":"fs_read","arguments":"{\"path\":\"a.txt\"}"}}]},
              {"role":"tool","tool_call_id":"call-original","content":"file contents"}]}
            """.replace("{\"path\":\"a.txt\"}", "{\\\"path\\\":\\\"a.txt\\\"}"));
        var encoded = adapter.encode(mapper, canonical);
        assertThat(encoded.path("instructions").asText()).isEqualTo("Be precise");
        var input = encoded.path("input");
        assertThat(input.size()).isEqualTo(3);
        assertThat(input.path(0).path("content").path(0).path("type").asText()).isEqualTo("output_text");
        assertThat(input.path(1).path("type").asText()).isEqualTo("function_call");
        assertThat(input.path(1).path("call_id").asText()).isEqualTo("call-original");
        assertThat(input.path(2).path("type").asText()).isEqualTo("function_call_output");
        assertThat(input.path(2).path("call_id").asText()).isEqualTo("call-original");
    }

    @Test
    void preservesMediaReasoningChoiceAndCapsProbeBudgets() throws Exception {
        var canonical = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree("""
            {"model":"gpt-6.1-sol","max_tokens":1,"temperature":0.2,"top_p":0.9,"reasoning_effort":"medium","parallel_tool_calls":false,
             "tool_choice":{"type":"function","function":{"name":"read"}},
             "messages":[{"role":"user","content":[
                {"type":"image_url","image_url":{"url":"data:image/png;base64,aGVsbG8=","detail":"high"}},
                {"type":"file","file":{"filename":"x.pdf","file_data":"data:application/pdf;base64,aGVsbG8="}}]}]}
            """);
        var encoded = adapter.encode(mapper, canonical);
        assertThat(encoded.path("max_output_tokens").asInt()).isEqualTo(16);
        assertThat(encoded.path("reasoning").path("effort").asText()).isEqualTo("medium");
        assertThat(encoded.has("temperature")).isFalse();
        assertThat(encoded.has("top_p")).isFalse();
        assertThat(encoded.path("parallel_tool_calls").asBoolean(true)).isFalse();
        assertThat(encoded.path("tool_choice").path("name").asText()).isEqualTo("read");
        var content = encoded.path("input").path(0).path("content");
        assertThat(content.path(0).path("type").asText()).isEqualTo("input_image");
        assertThat(content.path(0).path("detail").asText()).isEqualTo("high");
        assertThat(content.path(1).path("type").asText()).isEqualTo("input_file");
        canonical.put("max_tokens", 8192);
        assertThat(adapter.encode(mapper, canonical).path("max_output_tokens").asInt()).isEqualTo(8192);
    }

    @Test
    void correlatesResponsesToolEventsByCallIdAndItemId() throws Exception {
        var added = adapter.decode(mapper, "", """
            {"type":"response.output_item.added","output_index":2,
             "item":{"id":"fc_item_2","type":"function_call","call_id":"call_2","name":"read"}}
            """);
        assertThat(added).singleElement().satisfies(event -> {
            assertThat(event.type()).isEqualTo(CanonicalStreamEvent.Type.TOOL_START);
            assertThat(event.id()).isEqualTo("call_2");
            assertThat(event.itemId()).isEqualTo("fc_item_2");
            assertThat(event.index()).isEqualTo(2);
        });

        var delta = adapter.decode(mapper, "", """
            {"type":"response.function_call_arguments.delta","output_index":2,
             "item_id":"fc_item_2","delta":"{\\\"path\\\":\\\"a.txt\\\"}"}
            """);
        assertThat(delta).singleElement().satisfies(event -> {
            assertThat(event.id()).isNull();
            assertThat(event.itemId()).isEqualTo("fc_item_2");
            assertThat(event.text()).isEqualTo("{\"path\":\"a.txt\"}");
        });
    }

    @Test
    void recognizesSnapshotsAndNestedFailures() throws Exception {
        var events = adapter.decode(mapper, "", """
            {"type":"response.output_item.done","output_index":3,"item":{"type":"function_call",
                "call_id":"call-original","name":"read","arguments":"{}"}}
            """);
        assertThat(events).extracting(CanonicalStreamEvent::type).containsExactly(
                CanonicalStreamEvent.Type.TOOL_START, CanonicalStreamEvent.Type.TOOL_SNAPSHOT,
                CanonicalStreamEvent.Type.TOOL_DONE);
        assertThat(events.get(0).index()).isEqualTo(3);
        var failed = adapter.decode(mapper, "", """
            {"type":"response.failed","response":{"error":{"code":"invalid_request_error",
              "param":"input[2].call_id","message":"No tool call found"}}}
            """);
        assertThat(failed).hasSize(1);
        assertThat(failed.get(0).type()).isEqualTo(CanonicalStreamEvent.Type.ERROR);
        assertThat(failed.get(0).error().path("error").path("param").asText()).isEqualTo("input[2].call_id");
    }

}
