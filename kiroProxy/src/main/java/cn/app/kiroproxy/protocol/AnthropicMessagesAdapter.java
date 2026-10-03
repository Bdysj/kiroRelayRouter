package cn.app.kiroproxy.protocol;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public final class AnthropicMessagesAdapter implements ProtocolAdapter {
    public static final String PROMPT_CACHE_ENABLED = "_anthropic_prompt_cache_enabled";

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
                ObjectNode resultBlock = item.putArray("content").addObject().put("type", "tool_result")
                        .put("tool_use_id", message.path("tool_call_id").asText());
                JsonNode toolContent = message.path("content");
                if (toolContent.isTextual()) resultBlock.put("content", toolContent.asText());
                else if (toolContent.isArray() || toolContent.isObject()) resultBlock.set("content", toolContent.deepCopy());
                else resultBlock.put("content", "");
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
        JsonNode format = canonical.path("_anthropic_output_format");
        if (format.isObject()) result.putObject("output_config").set("format", format.deepCopy());
        // Anthropic 用顶层 effort 表达强度。这里刻意不下发 thinking.budget_tokens：那条路径要求
        // budget < max_tokens，为了塞进预算就得抬高 max_tokens，而预扣费正是按 max_tokens 估的，
        // 会凭空放大用户的冻结额度。老模型若不认 effort，由请求链路的自动降级兜住。
        if (canonical.path(ReasoningEffort.CANONICAL_FIELD).isTextual()) {
            result.put("effort", canonical.path(ReasoningEffort.CANONICAL_FIELD).asText());
        }
        if (canonical.path("tools").isArray() && !canonical.path("tools").isEmpty()) {
            ArrayNode tools = result.putArray("tools");
            for (JsonNode tool : canonical.path("tools")) {
                JsonNode function = tool.path("function");
                ObjectNode target = tools.addObject().put("name", function.path("name").asText())
                        .put("description", function.path("description").asText(""));
                target.set("input_schema", function.path("parameters"));
            }
        }
        if (canonical.path(PROMPT_CACHE_ENABLED).asBoolean(false)) applyPromptCache(result);
        return result;
    }

    private static void applyPromptCache(ObjectNode request) {
        // 缓存键按 tools → system → messages 累积。分别标记稳定前缀，避免动态 system
        // 或新一轮正文变化时连工具定义也无法复用。使用显式断点兼容未支持顶层自动缓存的中转站。
        JsonNode tools = request.path("tools");
        if (tools.isArray() && !tools.isEmpty()) markCache((ObjectNode) tools.get(tools.size() - 1));
        JsonNode system = request.path("system");
        if (system.isTextual() && !system.asText().isEmpty()) {
            ObjectNode block = request.putArray("system").addObject()
                    .put("type", "text").put("text", system.asText());
            markCache(block);
        }
        // 最多四个断点：工具、system、最近两条非空 user 消息（含 tool_result）。
        // 上一条 user 是上一轮写入的位置，显式保留它，避免长工具调用超出自动回溯窗口；
        // 当前 user 写入新的前缀。不在空文本块上标记，以免上游拒绝请求。
        JsonNode messages = request.path("messages");
        int marked = 0;
        for (int index = messages.size() - 1; index >= 0 && marked < 2; index--) {
            if (!"user".equals(messages.get(index).path("role").asText())) continue;
            JsonNode content = messages.get(index).path("content");
            for (int blockIndex = content.size() - 1; blockIndex >= 0; blockIndex--) {
                JsonNode block = content.get(blockIndex);
                if (!block.isObject() || ("text".equals(block.path("type").asText())
                        && block.path("text").asText().isEmpty())) continue;
                markCache((ObjectNode) block);
                marked++;
                break;
            }
        }
    }

    private static void markCache(ObjectNode block) {
        block.putObject("cache_control").put("type", "ephemeral");
    }

    private static void appendContent(ArrayNode target, JsonNode source) {
        if (source.isTextual()) { target.addObject().put("type", "text").put("text", source.asText()); return; }
        // Anthropic multimodal requests place attachments before the instruction text.
        // Kiro's canonical messages may put text first; OpenAI adapters retain their original ordering.
        for (JsonNode part : source) {
            if ("image_url".equals(part.path("type").asText())) {
                DataUrl data = DataUrl.parse(part.path("image_url").path("url").asText());
                target.addObject().put("type", "image").putObject("source").put("type", "base64")
                        .put("media_type", data.mediaType).put("data", data.data);
            } else if ("file".equals(part.path("type").asText())) {
                DataUrl data = DataUrl.parse(part.path("file").path("file_data").asText());
                target.addObject().put("type", "document").putObject("source").put("type", "base64")
                        .put("media_type", data.mediaType).put("data", data.data);
            }
        }
        for (JsonNode part : source) {
            if ("text".equals(part.path("type").asText())) {
                target.addObject().put("type", "text").put("text", part.path("text").asText());
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
            if ("tool_use".equals(block.path("type").asText())) {
                int index = event.path("index").asInt();
                result.add(CanonicalStreamEvent.tool(
                        CanonicalStreamEvent.Type.TOOL_START, index, block.path("id").asText(null),
                        block.path("name").asText(null), null));
                // The documented streaming shape sends input via
                // input_json_delta, but compatible gateways sometimes include
                // the complete input in content_block_start. Preserve it as a
                // snapshot instead of silently dropping the tool arguments.
                JsonNode input = block.path("input");
                // Anthropic's normal streaming shape includes input: {} in
                // content_block_start as an initializer. It is not a complete
                // arguments snapshot: the real JSON arrives afterwards through
                // input_json_delta. Treating this empty object as received
                // arguments makes the next delta look inconsistent ("{}" is
                // not a prefix of '{...}') and aborts an otherwise successful
                // tool call after the upstream has already charged the request.
                boolean nonEmptySnapshot = input.isTextual() ? !input.asText().isBlank()
                        : input.isObject() ? !input.isEmpty()
                        : input.isArray() && !input.isEmpty();
                if (!input.isMissingNode() && !input.isNull() && nonEmptySnapshot) {
                    result.add(CanonicalStreamEvent.tool(CanonicalStreamEvent.Type.TOOL_SNAPSHOT,
                            index, null, null, input.isTextual() ? input.asText() : input.toString()));
                }
            }
        } else if ("content_block_delta".equals(type)) {
            JsonNode delta = event.path("delta");
            if ("text_delta".equals(delta.path("type").asText())) result.add(CanonicalStreamEvent.text(
                    CanonicalStreamEvent.Type.TEXT_DELTA, delta.path("text").asText()));
            if ("thinking_delta".equals(delta.path("type").asText())) result.add(CanonicalStreamEvent.text(
                    CanonicalStreamEvent.Type.REASONING_DELTA, delta.path("thinking").asText()));
            if ("input_json_delta".equals(delta.path("type").asText())) result.add(CanonicalStreamEvent.tool(
                    CanonicalStreamEvent.Type.TOOL_DELTA, event.path("index").asInt(), null, null,
                    delta.path("partial_json").asText()));
        } else if ("content_block_stop".equals(type)) {
            JsonNode block = event.path("content_block");
            // Anthropic's content_block_stop is the exact equivalent of
            // Responses function_call_arguments.done for tool_use blocks.
            // The block type is often omitted, so rely on the stream index;
            // the relay correlates it with the preceding tool_use start.
            result.add(CanonicalStreamEvent.toolDone(event.path("index").asInt(),
                    block.path("id").asText(null), null, block.path("name").asText(null)));
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
