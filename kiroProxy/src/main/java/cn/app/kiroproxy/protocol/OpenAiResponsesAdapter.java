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
        boolean codexContract = isCodexResponsesModel(canonical.path("model").asText());
        ObjectNode result = mapper.createObjectNode().put("model", canonical.path("model").asText())
                .put("stream", canonical.path("stream").asBoolean(true));
        if (codexContract) result.put("store", false);
        if (canonical.has("max_tokens")) {
            int budget = canonical.path("max_tokens").asInt();
            result.put("max_output_tokens", budget > 0 ? Math.max(16, budget) : budget);
        }
        StringBuilder instructions = new StringBuilder();
        ArrayNode input = result.putArray("input");
        for (JsonNode message : canonical.path("messages")) {
            String role = message.path("role").asText();
            if ("system".equals(role) || "developer".equals(role)) {
                String text = contentText(message.path("content"));
                if (!text.isEmpty()) {
                    if (!instructions.isEmpty()) instructions.append('\n');
                    instructions.append(text);
                }
                continue;
            }
            if ("tool".equals(role)) {
                input.addObject().put("type", "function_call_output")
                        .put("call_id", message.path("tool_call_id").asText())
                        .put("output", contentText(message.path("content")));
                continue;
            }
            ArrayNode content = mapper.createArrayNode();
            String textType = "assistant".equals(role) ? "output_text" : "input_text";
            if (message.path("content").isTextual()) {
                if (!message.path("content").asText().isEmpty()) {
                    content.addObject().put("type", textType).put("text", message.path("content").asText());
                }
            } else {
                for (JsonNode part : message.path("content")) {
                    if ("text".equals(part.path("type").asText())) content.addObject()
                            .put("type", textType).put("text", part.path("text").asText());
                    else if ("image_url".equals(part.path("type").asText())) {
                        ObjectNode image = content.addObject().put("type", "input_image")
                                .put("image_url", part.path("image_url").path("url").asText());
                        if (part.path("image_url").hasNonNull("detail")) {
                            image.set("detail", part.path("image_url").path("detail").deepCopy());
                        }
                    } else if ("file".equals(part.path("type").asText())) {
                        ObjectNode file = content.addObject().put("type", "input_file");
                        file.put("filename", part.path("file").path("filename").asText("attachment.pdf"));
                        file.put("file_data", part.path("file").path("file_data").asText());
                    }
                }
            }
            // A tool-only assistant turn is a function_call item, not an empty message.
            if (!content.isEmpty()) input.addObject().put("role", role).set("content", content);
            for (JsonNode call : message.path("tool_calls")) input.addObject().put("type", "function_call")
                    .put("call_id", call.path("id").asText()).put("name", call.path("function").path("name").asText())
                    .put("arguments", call.path("function").path("arguments").asText("{}"));
        }
        result.put("instructions", instructions.toString());
        // Codex Responses gateways (including the gpt-6.1-sol route) reject
        // Chat-style sampling controls. CC Switch removes these before sending.
        if (!codexContract && canonical.path("temperature").isNumber()) {
            result.set("temperature", canonical.path("temperature"));
        }
        if (!codexContract && canonical.path("top_p").isNumber()) result.set("top_p", canonical.path("top_p"));
        if (canonical.path(ReasoningEffort.CANONICAL_FIELD).isTextual()) {
            result.putObject("reasoning").put("effort", canonical.path(ReasoningEffort.CANONICAL_FIELD).asText());
        }
        ArrayNode tools = result.putArray("tools");
        for (JsonNode tool : canonical.path("tools")) {
            JsonNode function = tool.path("function");
            ObjectNode target = tools.addObject().put("type", "function")
                    .put("name", function.path("name").asText())
                    .put("description", function.path("description").asText(""));
            target.set("parameters", function.path("parameters").deepCopy());
            // Kiro schemas have optional arguments. Do not let Responses implicitly
            // normalize them into required strict-mode arguments (e.g. optional paths).
            target.put("strict", function.path("strict").asBoolean(false));
        }
        JsonNode choice = canonical.path("tool_choice");
        if (choice.isTextual()) result.set("tool_choice", choice.deepCopy());
        else if ("function".equals(choice.path("type").asText())) {
            result.putObject("tool_choice").put("type", "function")
                    .put("name", choice.path("function").path("name").asText());
        } else if (!tools.isEmpty()) result.put("tool_choice", "auto");
        result.put("parallel_tool_calls", canonical.path("parallel_tool_calls").asBoolean(true));
        return result;
    }

    private static boolean isCodexResponsesModel(String model) {
        String value = model == null ? "" : model.trim().toLowerCase(java.util.Locale.ROOT);
        String leaf = value.substring(Math.max(value.lastIndexOf('/'), value.lastIndexOf(':')) + 1);
        return leaf.equals("gpt-6.1-sol") || leaf.startsWith("gpt-6.1-sol-")
                || leaf.equals("gpt-6-1-sol") || leaf.startsWith("gpt-6-1-sol-")
                || leaf.equals("gpt-6-astra") || leaf.startsWith("gpt-6-astra-");
    }

    private static String contentText(JsonNode content) {
        if (content.isTextual()) return content.asText();
        StringBuilder text = new StringBuilder();
        for (JsonNode part : content) {
            if (!part.path("text").isTextual()) continue;
            if (!text.isEmpty()) text.append('\n');
            text.append(part.path("text").asText());
        }
        return text.toString();
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
        if ("error".equals(type) || type.endsWith(".failed") || event.hasNonNull("error")) {
            JsonNode failure = event.path("response").hasNonNull("error") ? event.path("response") : event;
            return List.of(CanonicalStreamEvent.error(failure));
        }
        List<CanonicalStreamEvent> result = new ArrayList<>();
        if ("response.output_text.delta".equals(type)) result.add(CanonicalStreamEvent.text(
                CanonicalStreamEvent.Type.TEXT_DELTA, event.path("output_index").asInt(), event.path("delta").asText()));
        else if ("response.reasoning_text.delta".equals(type) || "response.reasoning_summary_text.delta".equals(type)) result.add(CanonicalStreamEvent.text(
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
        else if ("response.function_call_arguments.done".equals(type)) result.add(CanonicalStreamEvent.tool(
                CanonicalStreamEvent.Type.TOOL_SNAPSHOT, event.path("output_index").asInt(), null, null,
                event.path("arguments").asText()));
        else if ("response.output_item.done".equals(type)) {
            addCompletedItem(result, event.path("item"), event.path("output_index").asInt());
        } else if ("response.completed".equals(type) || "response.incomplete".equals(type)) {
            JsonNode response = event.path("response");
            if (response.hasNonNull("error") || "failed".equals(response.path("status").asText())) {
                return List.of(CanonicalStreamEvent.error(response));
            }
            int index = 0;
            for (JsonNode item : response.path("output")) addCompletedItem(result, item, index++);
            if (response.hasNonNull("usage")) result.add(CanonicalStreamEvent.usage(response.path("usage")));
            if (response.path("model").isTextual()) result.add(CanonicalStreamEvent.model(response.path("model").asText()));
            String reason = "response.incomplete".equals(type)
                    ? response.path("incomplete_details").path("reason").asText("incomplete") : "stop";
            result.add(CanonicalStreamEvent.finish(reason));
            result.add(CanonicalStreamEvent.simple(CanonicalStreamEvent.Type.DONE));
        }
        return result;
    }
    private static void addCompletedItem(List<CanonicalStreamEvent> events, JsonNode item, int index) {
        if ("function_call".equals(item.path("type").asText())) {
            events.add(CanonicalStreamEvent.tool(CanonicalStreamEvent.Type.TOOL_START, index,
                    item.path("call_id").asText(null), item.path("name").asText(null), null));
            if (item.path("arguments").isTextual()) events.add(CanonicalStreamEvent.tool(
                    CanonicalStreamEvent.Type.TOOL_SNAPSHOT, index, null, null, item.path("arguments").asText()));
        } else if ("message".equals(item.path("type").asText())) {
            StringBuilder text = new StringBuilder();
            for (JsonNode part : item.path("content")) {
                if ("output_text".equals(part.path("type").asText())) text.append(part.path("text").asText());
            }
            if (!text.isEmpty()) events.add(CanonicalStreamEvent.text(
                    CanonicalStreamEvent.Type.TEXT_SNAPSHOT, index, text.toString()));
        }
    }

}
