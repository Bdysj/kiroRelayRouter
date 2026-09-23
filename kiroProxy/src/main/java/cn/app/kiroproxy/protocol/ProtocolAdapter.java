package cn.app.kiroproxy.protocol;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.List;
import java.util.Map;

public interface ProtocolAdapter {
    ProtocolCode code();
    ObjectNode encode(ObjectMapper mapper, ObjectNode canonical);
    Map<String, String> headers(String apiKey);
    List<CanonicalStreamEvent> decode(ObjectMapper mapper, String eventName, String data) throws Exception;
}
