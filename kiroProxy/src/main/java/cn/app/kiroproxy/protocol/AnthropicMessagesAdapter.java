package cn.app.kiroproxy.protocol;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public final class AnthropicMessagesAdapter implements ProtocolAdapter {
    @Override public ProtocolCode code() { return ProtocolCode.ANTHROPIC_MESSAGES; }

    @Override public ObjectNode encode(ObjectMapper mapper, ObjectNode canonical) {
        ObjectNode result = mapper.createObjectNode().put("model", canonical.path("model").asText())
                .put("stream", canonical.path("stream").asBoolean(true))
                .put("max_tokens", canonical.path("max_tokens").asInt(4096));
        StringBuilder system = new StringBuilder();
        ArrayNode messages = result.putArray("messages");
        for (JsonNode message : canonical.path("messages")) {
            String role = message.path("role").asText();
            if ("system".equals(role)) {
                if (!system.isEmpty()) system.append('\n');
                system.append(textContent(message.path("content")));
                continue;
            }
            if ("tool".equals(role)) {
                ObjectNode item = messages.addObject().put("role", "user");
                item.putArray("content").addObject().put("type", "tool_result")
                        .put("tool_use_id", message.path("tool_call_id").asText())
                        .put("content", message.path("content").asText());
                continue;
            }
            ObjectNode item = messages.addObject().put("role", role);
            ArrayNode content = item.putArray("content");
            appendContent(content, message.path("content"));
            for (JsonNode call : message.path("tool_calls")) {
                ObjectNode use = content.addObject().put("type", "tool_use")
                        .put("id", call.path("id").asText()).put("name", call.path("function").path("name").asText());
                try { use.set("input", mapper.readTree(call.path("function").path("arguments").asText("{}"))); }
                catch (Exception ignored) { use.putObject("input"); }
            }
        }
        if (!system.isEmpty()) result.put("system", system.toString());
        if (canonical.path("temperature").isNumber()) result.set("temperature", canonical.path("temperature"));
        if (canonical.path("tools").isArray() && !canonical.path("tools").isEmpty()) {
            ArrayNode tools = result.putArray("tools");
            for (JsonNode tool : canonical.path("tools")) {
                JsonNode function = tool.path("function");
                ObjectNode target = tools.addObject().put("name", function.path("name").asText())
                        .put("description", function.path("description").asText(""));
                target.set("input_schema", function.path("parameters"));
            }
        }
        return result;
    }

    private static void appendContent(ArrayNode target, JsonNode source) {
        if (source.isTextual()) { target.addObject().put("type", "text").put("text", source.asText()); return; }
        for (JsonNode part : source) {
            if ("text".equals(part.path("type").asText())) {
                target.addObject().put("type", "text").put("text", part.path("text").asText());
            } else if ("image_url".equals(part.path("type").asText())) {
                DataUrl data = DataUrl.parse(part.path("image_url").path("url").asText());
                target.addObject().put("type", "image").putObject("source").put("type", "base64")
                        .put("media_type", data.mediaType).put("data", data.data);
            } else if ("file".equals(part.path("type").asText())) {
                DataUrl data = DataUrl.parse(part.path("file").path("file_data").asText());
                target.addObject().put("type", "document").putObject("source").put("type", "base64")
                        .put("media_type", data.mediaType).put("data", data.data);
            }
        }
    }

    private static String textContent(JsonNode content) {
        if (content.isTextual()) return content.asText();
        StringBuilder result = new StringBuilder();
        for (JsonNode part : content) if ("text".equals(part.path("type").asText())) {
            if (!result.isEmpty()) result.append('\n');
            result.append(part.path("text").asText());
        }
        return result.toString();
    }

    @Override public Map<String, String> headers(String apiKey) {
        return Map.of("x-api-key", apiKey, "anthropic-version", "2023-06-01",
                "content-type", "application/json", "accept", "text/event-stream");
    }

    @Override public List<CanonicalStreamEvent> decode(ObjectMapper mapper, String eventName, String data) throws Exception {
        if (data.isBlank()) return List.of();
        JsonNode event = mapper.readTree(data);
        String type = event.path("type").asText(eventName);
        List<CanonicalStreamEvent> result = new ArrayList<>();
        if ("error".equals(type)) return List.of(CanonicalStreamEvent.error(event));
        if ("message_start".equals(type)) {
            JsonNode message = event.path("message");
            if (message.hasNonNull("usage")) result.add(CanonicalStreamEvent.usage(message.path("usage")));
            if (message.path("model").isTextual()) result.add(CanonicalStreamEvent.model(message.path("model").asText()));
        } else if ("content_block_start".equals(type)) {
            JsonNode block = event.path("content_block");
            if ("text".equals(block.path("type").asText()) && !block.path("text").asText("").isEmpty())
                result.add(CanonicalStreamEvent.text(CanonicalStreamEvent.Type.TEXT_DELTA, block.path("text").asText()));
            if ("tool_use".equals(block.path("type").asText())) result.add(CanonicalStreamEvent.tool(
                    CanonicalStreamEvent.Type.TOOL_START, event.path("index").asInt(), block.path("id").asText(null),
                    block.path("name").asText(null), null));
        } else if ("content_block_delta".equals(type)) {
            JsonNode delta = event.path("delta");
            if ("text_delta".equals(delta.path("type").asText())) result.add(CanonicalStreamEvent.text(
                    CanonicalStreamEvent.Type.TEXT_DELTA, delta.path("text").asText()));
            if ("thinking_delta".equals(delta.path("type").asText())) result.add(CanonicalStreamEvent.text(
                    CanonicalStreamEvent.Type.REASONING_DELTA, delta.path("thinking").asText()));
            if ("input_json_delta".equals(delta.path("type").asText())) result.add(CanonicalStreamEvent.tool(
                    CanonicalStreamEvent.Type.TOOL_DELTA, event.path("index").asInt(), null, null,
                    delta.path("partial_json").asText()));
        } else if ("message_delta".equals(type)) {
            if (event.hasNonNull("usage")) result.add(CanonicalStreamEvent.usage(event.path("usage")));
            if (event.path("delta").path("stop_reason").isTextual()) result.add(CanonicalStreamEvent.finish(
                    event.path("delta").path("stop_reason").asText()));
        } else if ("message_stop".equals(type)) result.add(CanonicalStreamEvent.simple(CanonicalStreamEvent.Type.DONE));
        return result;
    }

    private record DataUrl(String mediaType, String data) {
        static DataUrl parse(String value) {
            int marker = value.indexOf(";base64,");
            if (!value.startsWith("data:") || marker < 0) throw new IllegalArgumentException("invalid data URL");
            return new DataUrl(value.substring(5, marker), value.substring(marker + 8));
        }
    }
}
