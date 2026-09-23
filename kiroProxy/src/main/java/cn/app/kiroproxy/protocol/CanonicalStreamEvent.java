package cn.app.kiroproxy.protocol;

import com.fasterxml.jackson.databind.JsonNode;

public record CanonicalStreamEvent(Type type, String text, int index, String id, String name,
        JsonNode usage, String model, String finishReason, JsonNode error) {
    public enum Type { TEXT_DELTA, REASONING_DELTA, TOOL_START, TOOL_DELTA, USAGE, MODEL, FINISH, DONE, ERROR }

    public static CanonicalStreamEvent text(Type type, String value) {
        return new CanonicalStreamEvent(type, value, 0, null, null, null, null, null, null);
    }
    public static CanonicalStreamEvent tool(Type type, int index, String id, String name, String value) {
        return new CanonicalStreamEvent(type, value, index, id, name, null, null, null, null);
    }
    public static CanonicalStreamEvent usage(JsonNode value) {
        return new CanonicalStreamEvent(Type.USAGE, null, 0, null, null, value, null, null, null);
    }
    public static CanonicalStreamEvent model(String value) {
        return new CanonicalStreamEvent(Type.MODEL, null, 0, null, null, null, value, null, null);
    }
    public static CanonicalStreamEvent finish(String value) {
        return new CanonicalStreamEvent(Type.FINISH, null, 0, null, null, null, null, value, null);
    }
    public static CanonicalStreamEvent simple(Type type) {
        return new CanonicalStreamEvent(type, null, 0, null, null, null, null, null, null);
    }
    public static CanonicalStreamEvent error(JsonNode value) {
        return new CanonicalStreamEvent(Type.ERROR, null, 0, null, null, null, null, null, value);
    }
}
