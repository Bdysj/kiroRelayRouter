package cn.app.kiroproxy.protocol;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public final class OpenAiResponsesAdapter implements ProtocolAdapter {
    @Override public ProtocolCode code() { return ProtocolCode.OPENAI_RESPONSES; }

    @Override public ObjectNode encode(ObjectMapper mapper, ObjectNode canonical) {
        ObjectNode result = mapper.createObjectNode().put("model", canonical.path("model").asText())
                .put("stream", canonical.path("stream").asBoolean(true));
        if (canonical.has("max_tokens")) result.put("max_output_tokens", canonical.path("max_tokens").asInt());
        StringBuilder instructions = new StringBuilder();
        ArrayNode input = result.putArray("input");
        for (JsonNode message : canonical.path("messages")) {
            String role = message.path("role").asText();
            if ("system".equals(role)) {
                if (!instructions.isEmpty()) instructions.append('\n');
                instructions.append(message.path("content").asText());
                continue;
            }
            if ("tool".equals(role)) {
                input.addObject().put("type", "function_call_output")
                        .put("call_id", message.path("tool_call_id").asText())
                        .put("output", message.path("content").asText());
                continue;
            }
            ObjectNode target = input.addObject().put("role", role);
            if (message.path("content").isTextual()) target.put("content", message.path("content").asText());
            else {
                ArrayNode content = target.putArray("content");
                for (JsonNode part : message.path("content")) {
                    if ("text".equals(part.path("type").asText())) content.addObject()
                            .put("type", "input_text").put("text", part.path("text").asText());
                    else if ("image_url".equals(part.path("type").asText())) content.addObject()
                            .put("type", "input_image").put("image_url", part.path("image_url").path("url").asText());
                    else if ("file".equals(part.path("type").asText())) {
                        ObjectNode file = content.addObject().put("type", "input_file");
                        file.put("filename", part.path("file").path("filename").asText("attachment.pdf"));
                        file.put("file_data", part.path("file").path("file_data").asText());
                    }
                }
            }
            for (JsonNode call : message.path("tool_calls")) input.addObject().put("type", "function_call")
                    .put("call_id", call.path("id").asText()).put("name", call.path("function").path("name").asText())
                    .put("arguments", call.path("function").path("arguments").asText("{}"));
        }
        if (!instructions.isEmpty()) result.put("instructions", instructions.toString());
        if (canonical.path("temperature").isNumber()) result.set("temperature", canonical.path("temperature"));
        // Responses 协议把强度放在 reasoning.effort 下，而不是 Chat Completions 的顶层参数。
        if (canonical.path(ReasoningEffort.CANONICAL_FIELD).isTextual()) {
            result.putObject("reasoning").put("effort",
                    canonical.path(ReasoningEffort.CANONICAL_FIELD).asText());
        }
        if (canonical.path("tools").isArray() && !canonical.path("tools").isEmpty()) {
            ArrayNode tools = result.putArray("tools");
            for (JsonNode tool : canonical.path("tools")) {
                JsonNode function = tool.path("function");
                ObjectNode target = tools.addObject().put("type", "function")
                        .put("name", function.path("name").asText())
                        .put("description", function.path("description").asText(""));
                target.set("parameters", function.path("parameters"));
            }
            result.put("tool_choice", "auto");
        }
        return result;
    }

    @Override public Map<String, String> headers(String apiKey) {
        return Map.of("authorization", "Bearer " + apiKey, "content-type", "application/json",
                "accept", "text/event-stream");
    }

    @Override public List<CanonicalStreamEvent> decode(ObjectMapper mapper, String eventName, String data) throws Exception {
        if (data.isBlank()) return List.of();
        if ("[DONE]".equals(data.trim())) return List.of(CanonicalStreamEvent.simple(CanonicalStreamEvent.Type.DONE));
        JsonNode event = mapper.readTree(data);
        String type = event.path("type").asText(eventName);
        if ("error".equals(type) || type.endsWith(".failed")) return List.of(CanonicalStreamEvent.error(event));
        List<CanonicalStreamEvent> result = new ArrayList<>();
        if ("response.output_text.delta".equals(type)) result.add(CanonicalStreamEvent.text(
                CanonicalStreamEvent.Type.TEXT_DELTA, event.path("delta").asText()));
        else if ("response.reasoning_text.delta".equals(type)) result.add(CanonicalStreamEvent.text(
                CanonicalStreamEvent.Type.REASONING_DELTA, event.path("delta").asText()));
        else if ("response.output_item.added".equals(type)
                && "function_call".equals(event.path("item").path("type").asText())) {
            JsonNode item = event.path("item");
            result.add(CanonicalStreamEvent.tool(CanonicalStreamEvent.Type.TOOL_START,
                    event.path("output_index").asInt(), item.path("call_id").asText(null),
                    item.path("name").asText(null), null));
        } else if ("response.function_call_arguments.delta".equals(type)) result.add(CanonicalStreamEvent.tool(
                CanonicalStreamEvent.Type.TOOL_DELTA, event.path("output_index").asInt(), null, null,
                event.path("delta").asText()));
        else if ("response.completed".equals(type) || "response.incomplete".equals(type)) {
            JsonNode response = event.path("response");
            if (response.hasNonNull("usage")) result.add(CanonicalStreamEvent.usage(response.path("usage")));
            if (response.path("model").isTextual()) result.add(CanonicalStreamEvent.model(response.path("model").asText()));
            String reason = "response.incomplete".equals(type)
                    ? response.path("incomplete_details").path("reason").asText("incomplete") : "stop";
            result.add(CanonicalStreamEvent.finish(reason));
            result.add(CanonicalStreamEvent.simple(CanonicalStreamEvent.Type.DONE));
        }
        return result;
    }
}
