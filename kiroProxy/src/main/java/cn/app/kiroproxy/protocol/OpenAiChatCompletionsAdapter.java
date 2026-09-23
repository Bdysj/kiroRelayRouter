package cn.app.kiroproxy.protocol;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public final class OpenAiChatCompletionsAdapter implements ProtocolAdapter {
    @Override public ProtocolCode code() { return ProtocolCode.OPENAI_CHAT_COMPLETIONS; }
    @Override public ObjectNode encode(ObjectMapper mapper, ObjectNode canonical) { return canonical.deepCopy(); }
    @Override public Map<String, String> headers(String apiKey) {
        return Map.of("authorization", "Bearer " + apiKey, "content-type", "application/json",
                "accept", "text/event-stream");
    }

    @Override public List<CanonicalStreamEvent> decode(ObjectMapper mapper, String eventName, String data) throws Exception {
        if (data.isBlank()) return List.of();
        if ("[DONE]".equals(data.trim())) return List.of(CanonicalStreamEvent.simple(CanonicalStreamEvent.Type.DONE));
        JsonNode event = mapper.readTree(data);
        if (event.hasNonNull("error") || "error".equals(event.path("type").asText())
                || (!event.has("choices") && event.hasNonNull("code") && event.hasNonNull("message"))) {
            return List.of(CanonicalStreamEvent.error(event));
        }
        List<CanonicalStreamEvent> result = new ArrayList<>();
        if (event.hasNonNull("usage")) result.add(CanonicalStreamEvent.usage(event.path("usage")));
        if (event.path("model").isTextual()) result.add(CanonicalStreamEvent.model(event.path("model").asText()));
        JsonNode choice = event.path("choices").path(0);
        JsonNode delta = choice.path("delta");
        if (delta.path("content").isTextual()) result.add(CanonicalStreamEvent.text(
                CanonicalStreamEvent.Type.TEXT_DELTA, delta.path("content").asText()));
        for (String field : List.of("reasoning_content", "reasoning", "thinking")) {
            if (delta.path(field).isTextual()) {
                String text = delta.path(field).asText();
                if (!text.isEmpty()) {
                    result.add(CanonicalStreamEvent.text(CanonicalStreamEvent.Type.REASONING_DELTA, text));
                }
            }
        }
        for (JsonNode call : delta.path("tool_calls")) {
            int index = call.path("index").asInt(0);
            String id = call.path("id").asText(null);
            String name = call.path("function").path("name").asText(null);
            if (id != null || name != null) result.add(CanonicalStreamEvent.tool(
                    CanonicalStreamEvent.Type.TOOL_START, index, id, name, null));
            String arguments = call.path("function").path("arguments").asText("");
            if (!arguments.isEmpty()) result.add(CanonicalStreamEvent.tool(
                    CanonicalStreamEvent.Type.TOOL_DELTA, index, id, name, arguments));
        }
        if (choice.path("finish_reason").isTextual()) result.add(CanonicalStreamEvent.finish(
                choice.path("finish_reason").asText()));
        return result;
    }
}
