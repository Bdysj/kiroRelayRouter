package cn.app.kiroproxy.protocol;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.EnumSet;
import java.util.Set;

public final class RequestCapabilityInspector {
    private RequestCapabilityInspector() {}

    public static Set<ProtocolCapability> inspect(JsonNode canonicalRequest) {
        EnumSet<ProtocolCapability> result = EnumSet.of(ProtocolCapability.TEXT);
        if (canonicalRequest.path("stream").asBoolean(false)) result.add(ProtocolCapability.STREAMING);
        if (canonicalRequest.path("tools").isArray() && !canonicalRequest.path("tools").isEmpty()) {
            result.add(ProtocolCapability.TOOL_USE);
        }
        for (JsonNode message : canonicalRequest.path("messages")) {
            if ("tool".equals(message.path("role").asText())) result.add(ProtocolCapability.TOOL_RESULT);
            if (!message.path("content").isArray()) continue;
            for (JsonNode part : message.path("content")) {
                String type = part.path("type").asText();
                if ("image_url".equals(type)) result.add(ProtocolCapability.IMAGE);
                if ("file".equals(type)) {
                    String data = part.path("file").path("file_data").asText("").toLowerCase();
                    if (data.startsWith("data:application/pdf;")) result.add(ProtocolCapability.PDF);
                }
            }
        }
        return Set.copyOf(result);
    }
}
