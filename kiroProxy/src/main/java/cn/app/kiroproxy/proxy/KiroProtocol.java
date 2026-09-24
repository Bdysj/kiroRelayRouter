package cn.app.kiroproxy.proxy;

import cn.app.kiroproxy.config.RelayModel;
import cn.app.kiroproxy.protocol.ReasoningEffort;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import java.util.zip.CRC32;
import java.math.BigDecimal;
import java.util.Map;
import java.util.Set;

public final class KiroProtocol {
    public static final String EVENT_STREAM = "application/vnd.amazon.eventstream";

    private KiroProtocol() {}

    public static byte[] event(ObjectMapper mapper, String eventType, Object payload) throws IOException {
        return event(mapper, eventType, payload, "event");
    }

    public static byte[] exception(ObjectMapper mapper, String type, String message) throws IOException {
        return event(mapper, type, mapper.createObjectNode().put("message", message), "exception");
    }

    private static byte[] event(ObjectMapper mapper, String eventType, Object payload, String messageType) throws IOException {
        ByteArrayOutputStream headers = new ByteArrayOutputStream();
        writeStringHeader(headers, ":message-type", messageType);
        writeStringHeader(headers, "exception".equals(messageType) ? ":exception-type" : ":event-type", eventType);
        writeStringHeader(headers, ":content-type", "application/json");
        byte[] headerBytes = headers.toByteArray();
        byte[] payloadBytes = mapper.writeValueAsBytes(payload);
        int totalLength = 16 + headerBytes.length + payloadBytes.length;

        ByteArrayOutputStream output = new ByteArrayOutputStream(totalLength);
        DataOutputStream data = new DataOutputStream(output);
        data.writeInt(totalLength);
        data.writeInt(headerBytes.length);
        data.writeInt((int) crc32(output.toByteArray()));
        data.write(headerBytes);
        data.write(payloadBytes);
        data.writeInt((int) crc32(output.toByteArray()));
        return output.toByteArray();
    }

    private static void writeStringHeader(ByteArrayOutputStream output, String name, String value) throws IOException {
        byte[] nameBytes = name.getBytes(StandardCharsets.UTF_8);
        byte[] valueBytes = value.getBytes(StandardCharsets.UTF_8);
        DataOutputStream data = new DataOutputStream(output);
        data.writeByte(nameBytes.length);
        data.write(nameBytes);
        data.writeByte(7);
        data.writeShort(valueBytes.length);
        data.write(valueBytes);
    }

    public static long crc32(byte[] value) {
        CRC32 crc = new CRC32();
        crc.update(value);
        return crc.getValue();
    }

    public static ObjectNode modelList(ObjectMapper mapper, List<RelayModel> models) {
        return modelList(mapper, models, BigDecimal.ONE);
    }

    public static ObjectNode modelList(ObjectMapper mapper, List<RelayModel> models, BigDecimal modelMultiplier) {
        Map<String, BigDecimal> multipliers = models.stream().collect(java.util.stream.Collectors.toMap(
                RelayModel::modelId, ignored -> modelMultiplier == null ? BigDecimal.ONE : modelMultiplier));
        return modelList(mapper, models, multipliers);
    }

    public static ObjectNode modelList(ObjectMapper mapper, List<RelayModel> models,
                                       Map<String, BigDecimal> modelMultipliers) {
        ObjectNode result = mapper.createObjectNode();
        result.putObject("defaultModel").put("modelId", models.isEmpty() ? "" : models.get(0).displayName());
        ArrayNode list = result.putArray("models");
        for (RelayModel model : models) {
            BigDecimal multiplier = modelMultipliers.get(model.modelId());
            if (multiplier == null) {
                throw new IllegalArgumentException("模型 " + model.modelId() + " 未配置模型倍率");
            }
            multiplier = multiplier.stripTrailingZeros();
            ObjectNode item = list.addObject();
            item.put("modelId", model.displayName()).put("modelName", model.displayName()).put("rateMultiplier", multiplier);
            item.putArray("supportedInputTypes").add("TEXT").add("IMAGE").add("DOCUMENT");
            item.putObject("tokenLimits").put("maxInputTokens", model.maxInputTokens())
                    .put("maxOutputTokens", model.maxOutputTokens());
            // 点亮 Kiro 输入框右下角的 Effort 档位下拉框。Kiro 只在模型声明了
            // properties.reasoning.properties.effort.enum 时才渲染这个控件，选中后会在
            // 请求体顶层回传 additionalModelRequestFields.reasoning.effort。
            // 未配置档位的模型不下发这段 schema，控件随之消失 —— 与官方「低端模型没有
            // 思考强度」的表现一致。
            if (model.reasoningSupported()) {
                ObjectNode effort = item.putObject("additionalModelRequestFieldsSchema")
                        .putObject("properties").putObject("reasoning")
                        .putObject("properties").putObject("effort");
                ArrayNode levels = effort.putArray("enum");
                for (ReasoningEffort level : model.reasoningLevels()) levels.add(level.wire());
                ReasoningEffort defaultLevel = model.effectiveDefaultLevel();
                if (defaultLevel != null) effort.put("default", defaultLevel.wire());
            }
        }
        return result;
    }

    /**
     * 从 Kiro 请求里取出用户选中的推理强度。
     *
     * <p>Kiro 把它放在请求体<b>顶层</b>的 {@code additionalModelRequestFields} 下（与
     * {@code conversationState} 平级），形态由我们在模型 schema 里声明的路径决定。当前声明的是
     * {@code reasoning}，这里同时兼容 {@code output_config}，以免将来改了声明路径这里漏改。
     */
    public static Optional<ReasoningEffort> requestedEffort(JsonNode body, RelayModel model) {
        JsonNode fields = body.path("additionalModelRequestFields");
        String raw = fields.path("reasoning").path("effort")
                .asText(fields.path("output_config").path("effort").asText(null));
        return ReasoningEffort.parse(raw).flatMap(requested ->
                ReasoningEffort.clamp(requested, model.reasoningLevels()));
    }

    public static ObjectNode translateRequest(ObjectMapper mapper, JsonNode body, RelayModel model) {
        ObjectNode request = translateRequest(mapper, body, model.modelId());
        requestedEffort(body, model).ifPresent(effort ->
                request.put(ReasoningEffort.CANONICAL_FIELD, effort.wire()));
        return request;
    }

    public static ObjectNode translateRequest(ObjectMapper mapper, JsonNode body, String model) {
        JsonNode state = body.path("conversationState");
        ArrayNode messages = mapper.createArrayNode();
        JsonNode history = state.path("history");
        if (history.isArray()) for (JsonNode item : history) {
            if (item.has("userInputMessage")) {
                JsonNode user = item.path("userInputMessage");
                messages.add(userMessage(mapper, user));
                addToolResults(messages, user.path("userInputMessageContext").path("toolResults"));
            } else if (item.has("assistantResponseMessage")) {
                messages.add(assistantMessage(mapper, item.path("assistantResponseMessage")));
            }
        }

        JsonNode current = state.path("currentMessage").path("userInputMessage");
        JsonNode context = current.path("userInputMessageContext");
        JsonNode systemPrompt = context.path("systemPrompt");
        if (systemPrompt.isMissingNode() || systemPrompt.isNull()) systemPrompt = body.path("systemPrompt");
        if (!systemPrompt.isMissingNode() && !systemPrompt.isNull() && !systemPrompt.asText().isEmpty()) {
            messages.insert(0, mapper.createObjectNode().put("role", "system").put("content", systemPrompt.asText()));
        }
        JsonNode results = context.path("toolResults");
        if (!current.path("content").asText("").isEmpty() || current.path("content").isArray()
                || !imageBlocks(current).isEmpty() || !documentBlocks(current).isEmpty()
                || !results.isArray() || results.isEmpty()) messages.add(userMessage(mapper, current));
        addToolResults(messages, results);

        ObjectNode request = mapper.createObjectNode().put("model", model).put("stream", true);
        request.set("messages", messages);
        request.putObject("stream_options").put("include_usage", true);
        ArrayNode tools = mapper.createArrayNode();
        JsonNode sourceTools = context.path("tools");
        if (sourceTools.isArray()) for (JsonNode entry : sourceTools) {
            JsonNode spec = entry.path("toolSpecification");
            if (spec.isMissingNode()) continue;
            ObjectNode function = tools.addObject().put("type", "function").putObject("function");
            function.put("name", spec.path("name").asText()).put("description", spec.path("description").asText(""));
            JsonNode schema = spec.path("inputSchema").path("json");
            function.set("parameters", schema.isMissingNode() ? mapper.createObjectNode().put("type", "object") : schema);
        }
        if (!tools.isEmpty()) {
            request.set("tools", tools);
            request.put("tool_choice", "auto");
        }
        JsonNode inference = body.path("inferenceConfig");
        if (inference.has("maxTokens")) request.put("max_tokens", inference.path("maxTokens").asInt());
        if (inference.path("temperature").isNumber()) request.put("temperature", inference.path("temperature").asDouble());
        return request;
    }

    private static ObjectNode userMessage(ObjectMapper mapper, JsonNode message) {
        ObjectNode result = mapper.createObjectNode().put("role", "user");
        ArrayNode content = mapper.createArrayNode();
        JsonNode sourceContent = message.path("content");
        if (sourceContent.isTextual() && !sourceContent.asText().isEmpty()) content.addObject().put("type", "text").put("text", sourceContent.asText());
        if (sourceContent.isArray()) for (JsonNode part : sourceContent) {
            if ("text".equals(part.path("type").asText())) content.addObject().put("type", "text").put("text", part.path("text").asText());
        }
        var urls = new LinkedHashSet<String>();
        for (JsonNode image : imageBlocks(message)) urls.add(imageUrl(image));
        for (String url : urls) {
            content.addObject().put("type", "image_url").putObject("image_url").put("url", url);
        }
        for (JsonNode document : documentBlocks(message)) content.add(documentPart(mapper, document));
        if (content.size() == 1 && "text".equals(content.get(0).path("type").asText())) result.put("content", content.get(0).path("text").asText());
        else result.set("content", content);
        return result;
    }

    private static List<JsonNode> imageBlocks(JsonNode message) {
        var images = new ArrayList<JsonNode>();
        for (JsonNode container : List.of(message, message.path("userInputMessageContext"))) {
            JsonNode value = container.path("images");
            if (value.isArray()) value.forEach(images::add);
            else if (!value.isMissingNode() && !value.isNull()) images.add(value);
        }
        if (message.path("content").isArray()) for (JsonNode part : message.path("content")) {
            if ("image".equals(part.path("type").asText()) || "image_url".equals(part.path("type").asText())) images.add(part);
        }
        return images;
    }

    public static int imageCount(JsonNode body) {
        JsonNode state = body.path("conversationState");
        int count = imageBlocks(state.path("currentMessage").path("userInputMessage")).size();
        if (state.path("history").isArray()) for (JsonNode entry : state.path("history")) {
            count += imageBlocks(entry.path("userInputMessage")).size();
        }
        return count;
    }

    public static int documentCount(JsonNode body) {
        JsonNode state = body.path("conversationState");
        int count = documentBlocks(state.path("currentMessage").path("userInputMessage")).size();
        if (state.path("history").isArray()) for (JsonNode entry : state.path("history")) {
            count += documentBlocks(entry.path("userInputMessage")).size();
        }
        return count;
    }

    private static List<JsonNode> documentBlocks(JsonNode message) {
        var documents = new ArrayList<JsonNode>();
        for (JsonNode container : List.of(message, message.path("userInputMessageContext"))) {
            for (String field : List.of("documents", "attachments")) {
                JsonNode value = container.path(field);
                if (value.isArray()) value.forEach(documents::add);
                else if (!value.isMissingNode() && !value.isNull()) documents.add(value);
            }
        }
        if (message.path("content").isArray()) for (JsonNode part : message.path("content")) {
            if (Set.of("document", "file", "input_file").contains(part.path("type").asText())) documents.add(part);
        }
        return documents;
    }

    private static ObjectNode documentPart(ObjectMapper mapper, JsonNode document) {
        JsonNode fileObject = document.path("file");
        String filename = firstText(document, "filename", "name", "title");
        if (filename.isBlank() && fileObject.isObject()) {
            filename = firstText(fileObject, "filename", "name", "title");
        }
        if (filename.isBlank()) filename = "attachment.pdf";
        String mediaType = firstText(document, "mediaType", "media_type", "mimeType").toLowerCase(Locale.ROOT);
        if (mediaType.isBlank()) mediaType = document.path("source").path("media_type").asText("").toLowerCase(Locale.ROOT);
        if (mediaType.isBlank() && fileObject.isObject()) {
            mediaType = firstText(fileObject, "mediaType", "media_type", "mimeType").toLowerCase(Locale.ROOT);
        }
        String format = firstText(document, "format").toLowerCase(Locale.ROOT);
        if (mediaType.isBlank() && "pdf".equals(format)) mediaType = "application/pdf";
        if (mediaType.isBlank() && filename.toLowerCase(Locale.ROOT).endsWith(".pdf")) {
            mediaType = "application/pdf";
        }
        JsonNode data = firstNode(document, "data", "bytes", "file_data");
        if ((data == null || data.isMissingNode()) && document.path("source").isObject()) {
            data = firstNode(document.path("source"), "data", "bytes");
        }
        if ((data == null || data.isMissingNode()) && fileObject.isObject()) {
            data = firstNode(fileObject, "data", "bytes", "file_data");
        }
        String encoded = binaryBase64(data);
        if (encoded.startsWith("data:")) {
            int marker = encoded.indexOf(";base64,");
            if (marker < 0) throw new InvalidDocumentException("ATTACHMENT_PROCESSING_FAILED", "INVALID_DATA_URL");
            mediaType = encoded.substring(5, marker).toLowerCase(Locale.ROOT);
            encoded = encoded.substring(marker + 8);
        }
        int parameters = mediaType.indexOf(';');
        if (parameters >= 0) mediaType = mediaType.substring(0, parameters);
        if (!"application/pdf".equals(mediaType)) {
            throw new InvalidDocumentException("ATTACHMENT_PROCESSING_FAILED", "UNSUPPORTED_MEDIA_TYPE");
        }
        if (encoded.isBlank()) throw new InvalidDocumentException("ATTACHMENT_PROCESSING_FAILED", "MISSING_BYTES");
        byte[] decoded;
        try {
            encoded = encoded.replaceAll("\\s", "");
            decoded = Base64.getDecoder().decode(encoded);
        } catch (IllegalArgumentException error) {
            throw new InvalidDocumentException("ATTACHMENT_PROCESSING_FAILED", "INVALID_BASE64");
        }
        if (decoded.length < 5 || decoded[0] != '%' || decoded[1] != 'P' || decoded[2] != 'D'
                || decoded[3] != 'F' || decoded[4] != '-') {
            throw new InvalidDocumentException("ATTACHMENT_PROCESSING_FAILED", "INVALID_PDF_SIGNATURE");
        }
        ObjectNode file = mapper.createObjectNode().put("type", "file");
        file.putObject("file").put("filename", filename)
                .put("file_data", "data:application/pdf;base64," + encoded);
        return file;
    }

    private static String binaryBase64(JsonNode data) {
        if (data == null || data.isMissingNode() || data.isNull()) return "";
        if (data.isTextual()) return data.asText();
        if ("Buffer".equals(data.path("type").asText()) && data.path("data").isArray()) {
            data = data.path("data");
        }
        if (!data.isArray()) return "";
        byte[] bytes = new byte[data.size()];
        for (int i = 0; i < bytes.length; i++) {
            if (!data.get(i).isIntegralNumber() || !data.get(i).canConvertToInt()
                    || data.get(i).asInt() < 0 || data.get(i).asInt() > 255) return "";
            bytes[i] = (byte) data.get(i).asInt();
        }
        return Base64.getEncoder().encodeToString(bytes);
    }

    private static String firstText(JsonNode node, String... names) {
        for (String name : names) if (node.path(name).isTextual()) return node.path(name).asText();
        return "";
    }

    private static JsonNode firstNode(JsonNode node, String... names) {
        for (String name : names) if (!node.path(name).isMissingNode() && !node.path(name).isNull()) return node.path(name);
        return null;
    }

    private static String imageUrl(JsonNode image) {
        String url = image.path("image_url").isTextual() ? image.path("image_url").asText()
                : image.path("image_url").path("url").asText("");
        if (url.startsWith("https://") || url.startsWith("http://")) return url;
        JsonNode data = image.path("source").path("bytes");
        if (data.isMissingNode() || data.isNull()) data = image.path("data");
        if (data.isMissingNode() || data.isNull()) data = image.path("source").path("data");
        if ("Buffer".equals(data.path("type").asText())) data = data.path("data");
        String encoded = url;
        if (encoded.isEmpty() && data.isTextual()) encoded = data.asText();
        else if (encoded.isEmpty() && data.isArray()) {
            byte[] bytes = new byte[data.size()];
            for (int i = 0; i < bytes.length; i++) {
                if (!data.get(i).isIntegralNumber() || !data.get(i).canConvertToInt()
                        || data.get(i).asInt() < 0 || data.get(i).asInt() > 255) throw new InvalidImageException();
                bytes[i] = (byte) data.get(i).asInt();
            }
            encoded = Base64.getEncoder().encodeToString(bytes);
        }
        String mediaType = image.path("format").asText(image.path("mimeType")
                .asText(image.path("source").path("media_type").asText("image/png"))).toLowerCase(Locale.ROOT);
        if (encoded.startsWith("data:")) {
            int marker = encoded.indexOf(";base64,");
            if (marker < 0) throw new InvalidImageException();
            mediaType = encoded.substring(5, marker).toLowerCase(Locale.ROOT);
            encoded = encoded.substring(marker + 8);
        }
        if (!mediaType.startsWith("image/")) mediaType = "image/" + mediaType;
        if (mediaType.equals("image/jpg")) mediaType = "image/jpeg";
        if (!List.of("image/png", "image/jpeg", "image/gif", "image/webp").contains(mediaType)) throw new InvalidImageException();
        try {
            if (encoded.isBlank() || Base64.getDecoder().decode(encoded).length == 0) throw new InvalidImageException();
        } catch (IllegalArgumentException error) {
            throw new InvalidImageException();
        }
        return "data:" + mediaType + ";base64," + encoded;
    }

    public static final class InvalidImageException extends IllegalArgumentException {
        public InvalidImageException() {
            super("检测到图片，但图片数据缺失、编码无效或格式不受支持；请重新粘贴 PNG、JPEG、GIF 或 WebP 图片后重试。");
        }
    }

    public static final class InvalidDocumentException extends IllegalArgumentException {
        private final String code;
        private final String reason;
        public InvalidDocumentException(String code, String reason) {
            super("附件处理失败；当前版本仅支持携带有效 Base64 数据的 PDF 文档。");
            this.code = code;
            this.reason = reason;
        }
        public String code() { return code; }
        public String reason() { return reason; }
    }

    private static ObjectNode assistantMessage(ObjectMapper mapper, JsonNode message) {
        ObjectNode result = mapper.createObjectNode().put("role", "assistant").put("content", message.path("content").asText(""));
        JsonNode uses = message.path("toolUses");
        if (uses.isArray() && !uses.isEmpty()) {
            ArrayNode calls = result.putArray("tool_calls");
            for (JsonNode use : uses) {
                ObjectNode call = calls.addObject().put("id", use.path("toolUseId").asText(UUID.randomUUID().toString())).put("type", "function");
                JsonNode input = use.path("input");
                call.putObject("function").put("name", use.path("name").asText()).put("arguments", input.isTextual() ? input.asText() : input.toString());
            }
        }
        return result;
    }

    private static void addToolResults(ArrayNode messages, JsonNode results) {
        if (!results.isArray()) return;
        for (JsonNode item : results) {
            StringBuilder content = new StringBuilder();
            JsonNode parts = item.path("content");
            if (parts.isArray()) for (JsonNode part : parts) {
                if (!content.isEmpty()) content.append('\n');
                content.append(part.has("json") ? part.path("json").toString() : part.path("text").asText(part.toString()));
            }
            messages.addObject().put("role", "tool").put("tool_call_id", item.path("toolUseId").asText()).put("content", content.toString());
        }
    }
}
