package cn.app.kiroproxy.proxy;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import cn.app.kiroproxy.config.*;
import cn.app.kiroproxy.protocol.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/** Runs Kiro -> real selector -> HTTP Responses upstream -> CRC-checked Kiro eventstream. */
class RelayProxyServiceResponsesTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final List<JsonNode> requests = new CopyOnWriteArrayList<>();
    private final List<String> authorizations = new CopyOnWriteArrayList<>();
    private HttpServer server;
    private RelayProxyService service;

    @AfterEach void closeResources() {
        if (service != null) service.destroy();
        if (server != null) server.stop(0);
    }

    @Test void forwardsKiroAgentEnvelopeAndKeepsOriginalToolIdsOnTheSecondTurn() throws Exception {
        start(exchange -> completeText(exchange, "OK"));
        var body = requestBody();
        ObjectNode state = (ObjectNode) body.path("conversationState");
        var history = state.putArray("history");
        history.addObject().putObject("assistantResponseMessage").put("content", "")
                .putArray("toolUses").addObject().put("name", "read").put("toolUseId", "original-id")
                .putObject("input").put("path", "a.txt");
        current(body).put("content", "Summarize it").path("userInputMessageContext");
        ((ObjectNode) current(body).path("userInputMessageContext")).putArray("toolResults")
                .addObject().put("toolUseId", "original-id").putArray("content").addObject().put("text", "file content");

        var frames = stream(body);
        assertThat(requests).hasSize(1);
        var wire = requests.get(0);
        assertThat(authorizations).containsExactly("Bearer mock-upstream-key");
        assertThat(wire.path("model").asText()).isEqualTo("gpt-6.1-sol");
        assertThat(wire.path("store").asBoolean(true)).isFalse();
        assertThat(wire.path("tools").path(0).path("strict").asBoolean(true)).isFalse();
        assertThat(wire.path("input").path(0).path("type").asText()).isEqualTo("function_call");
        assertThat(wire.path("input").path(1).path("type").asText()).isEqualTo("function_call_output");
        assertThat(wire.path("input").path(1).path("call_id").asText()).isEqualTo("original-id");
        assertThat(text(frames)).isEqualTo("OK");
        assertThat(frames).anyMatch(frame -> frame.path("stopReason").asText().equals("end_turn"));
    }

    @Test void reconstructsSnapshotOnlyFunctionCallsExactlyOnce() throws Exception {
        start(exchange -> sse(exchange, """
            {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call",
                "call_id":"upstream-id","name":"read","arguments":"{\"path\":\"a.txt\"}"}}
            """.replace("{\"path\":\"a.txt\"}", "{\\\"path\\\":\\\"a.txt\\\"}"), """
            {"type":"response.completed","response":{"model":"gpt-6.1-sol","output":[
              {"type":"reasoning"},{"type":"function_call","call_id":"upstream-id","name":"read",
                "arguments":"{\"path\":\"a.txt\"}"}],"usage":{"input_tokens":12,"output_tokens":7}}}
            """.replace("{\"path\":\"a.txt\"}", "{\\\"path\\\":\\\"a.txt\\\"}")));
        var frames = stream(requestBody());
        assertThat(toolInputs(frames)).isEqualTo("{\"path\":\"a.txt\"}");
        assertThat(frames.stream().filter(frame -> frame.path("stop").asBoolean()).count()).isEqualTo(1);
        assertThat(frames).anyMatch(frame -> frame.path("stopReason").asText().equals("tool_use"));
        assertThat(frames.stream().filter(frame -> frame.has("toolUseId")))
                .allMatch(frame -> frame.path("toolUseId").asText().equals("upstream-id"));
    }

    @Test void reconcilesPartialArgumentsWithDoneAndCompletedSnapshotsWithoutDuplication() throws Exception {
        start(exchange -> sse(exchange,
                "{\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"upstream-id\",\"name\":\"read\"}}",
                mapper.createObjectNode().put("type", "response.function_call_arguments.delta").put("output_index", 0)
                        .put("delta", "{\"path\":").toString(),
                mapper.createObjectNode().put("type", "response.function_call_arguments.done").put("output_index", 0)
                        .put("arguments", "{\"path\":\"a.txt\"}").toString(),
                completedCall("{\"path\":\"a.txt\"}")));
        var frames = stream(requestBody());
        assertThat(toolInputs(frames)).isEqualTo("{\"path\":\"a.txt\"}");
        assertThat(frames.stream().filter(frame -> frame.path("stop").asBoolean()).count()).isEqualTo(1);
    }

    @Test void keepsArgumentDeltasWhenArgumentsDoneHasAnEmptySnapshot() throws Exception {
        start(exchange -> sse(exchange,
                "{\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"upstream-id\",\"name\":\"read\"}}",
                mapper.createObjectNode().put("type", "response.function_call_arguments.delta").put("output_index", 0)
                        .put("delta", "{\"path\":\"a.txt\"}").toString(),
                mapper.createObjectNode().put("type", "response.function_call_arguments.done").put("output_index", 0)
                        .put("arguments", "").toString(),
                completedCall("{\"path\":\"a.txt\"}")));
        var frames = stream(requestBody());
        assertThat(toolInputs(frames)).isEqualTo("{\"path\":\"a.txt\"}");
        assertThat(frames.stream().filter(frame -> frame.path("stop").asBoolean()).count()).isEqualTo(1);
    }

    @Test void doesNotDuplicateTextWhenUpstreamRepeatsItInCompletedOutput() throws Exception {
        start(exchange -> sse(exchange,
                "{\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"O\"}",
                "{\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"K\"}",
                completedText("OK")));
        assertThat(text(stream(requestBody()))).isEqualTo("OK");
    }

    @Test void omitsCodexUnsupportedSamplingParametersAndPreservesOutputBudget() throws Exception {
        start(exchange -> completeText(exchange, "OK"));
        var body = requestBody();
        body.putObject("inferenceConfig").put("temperature", 0.2).put("topP", 0.8).put("maxTokens", 2048);

        assertThat(text(stream(body))).isEqualTo("OK");
        assertThat(requests).hasSize(1);
        var wire = requests.get(0);
        assertThat(wire.has("temperature")).isFalse();
        assertThat(wire.has("top_p")).isFalse();
        assertThat(wire.path("max_output_tokens").asInt()).isEqualTo(2048);
    }

    @Test void doesNotRetryOrDropOutputCapsHistoryFailuresOrAuthenticationFailures() throws Exception {
        start(exchange -> reject(exchange, 400, "unsupported_parameter", "max_output_tokens", "Unsupported parameter: 'max_output_tokens'"));
        var body = requestBody();
        body.putObject("inferenceConfig").put("maxTokens", 2048);
        stream(body);
        assertThat(requests).hasSize(1);
        assertThat(requests.get(0).path("max_output_tokens").asInt()).isEqualTo(2048);
    }

    @Test void authFailureDoesNotTriggerSamplingRetries() throws Exception {
        start(exchange -> reject(exchange, 403, "access_denied", "temperature", "temperature is not supported"));
        var body = requestBody();
        body.putObject("inferenceConfig").put("temperature", 0.2);
        var frames = stream(body);
        assertThat(requests).hasSize(1);
        assertThat(text(frames)).contains("认证失败");
    }

    @Test void nestedResponseFailedDoesNotBecomeSuccessfulEmptyTurn() throws Exception {
        start(exchange -> sse(exchange, """
            {"type":"response.failed","response":{"error":{"code":"model_not_found","message":"model not found"}}}
            """));
        var frames = stream(requestBody());
        assertThat(requests).hasSize(1);
        assertThat(text(frames)).contains("不支持配置的模型");
    }

    @Test void incompleteSnapshotToolIsNeverClosedForExecution() throws Exception {
        start(exchange -> sse(exchange,
                "{\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"id\",\"name\":\"read\"}}",
                mapper.createObjectNode().put("type", "response.function_call_arguments.delta").put("output_index", 0)
                        .put("delta", "{\"path\":").toString(),
                "{\"type\":\"response.incomplete\",\"response\":{\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}"));
        var frames = stream(requestBody());
        assertThat(frames).noneMatch(frame -> frame.path("stop").asBoolean());
        assertThat(frames).noneMatch(frame -> frame.has("stopReason"));
        assertThat(frames).anyMatch(frame -> frame.path("message").asText().contains("模型输出上限"));
    }

    @Test void streamedOutputIsNotReplayedAfterAnyContentHasReachedKiro() throws Exception {
        start(exchange -> sse(exchange,
                "{\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}",
                "{\"type\":\"error\",\"error\":{\"code\":\"unsupported_parameter\",\"param\":\"temperature\",\"message\":\"Unsupported parameter: 'temperature'\"}}"));
        var body = requestBody();
        body.putObject("inferenceConfig").put("temperature", 0.2);
        var frames = stream(body);
        assertThat(text(frames)).isEqualTo("partial");
        assertThat(requests).hasSize(1);
        assertThat(frames).noneMatch(frame -> frame.has("stopReason"));
    }

    private void start(com.sun.net.httpserver.HttpHandler handler) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/responses", exchange -> {
            requests.add(mapper.readTree(exchange.getRequestBody()));
            authorizations.add(exchange.getRequestHeaders().getFirst("Authorization"));
            handler.handle(exchange);
        });
        server.start();
        var protocol = new RelayProtocol(1, ProtocolCode.OPENAI_RESPONSES, true, 10, null,
                RelayProtocol.capabilities(true, true, true, true, true, true, false), "UNVERIFIED", null, null);
        var endpoint = new RelayEndpoint(1, "Mock SS-AI", "OPENAI", "http://127.0.0.1:" + server.getAddress().getPort(),
                "mock-upstream-key", true, 10, 1, RelayEndpoint.HealthStatus.UP, 0, 3, 1000, 2000, 10,
                0, null, null, Set.of("gpt-6.1-sol"), Map.of(), null, ProtocolStrategy.OPENAI_SMART,
                List.of(protocol), Map.of());
        var repository = mock(RelayConfigurationRepository.class);
        when(repository.findEnabledEndpoints()).thenReturn(List.of(endpoint));
        var selector = new RelaySelector(repository);
        selector.reload();
        service = new RelayProxyService(repository, mapper, Duration.ofSeconds(1), Duration.ofSeconds(2), null, selector);
    }

    private List<JsonNode> stream(ObjectNode body) throws Exception {
        var output = new ByteArrayOutputStream();
        var config = new RelayConfiguration(true, "unused", "unused", List.of(new RelayModel("gpt-6.1-sol", "Sol")));
        service.streamChat(body, config, output, "responses-test");
        return frames(output.toByteArray());
    }

    private ObjectNode requestBody() {
        var body = mapper.createObjectNode();
        var message = body.putObject("conversationState").put("conversationId", "mock-conversation")
                .putObject("currentMessage").putObject("userInputMessage").put("modelId", "Sol").put("content", "Read a file");
        var spec = message.putObject("userInputMessageContext").put("systemPrompt", "Help with files")
                .putArray("tools").addObject().putObject("toolSpecification").put("name", "read");
        var schema = spec.putObject("inputSchema").putObject("json").put("type", "object");
        var properties = schema.putObject("properties");
        properties.putObject("path").put("type", "string");
        properties.putObject("optional_limit").put("type", "integer");
        schema.putArray("required").add("path");
        return body;
    }

    private ObjectNode current(ObjectNode body) {
        return (ObjectNode) body.path("conversationState").path("currentMessage").path("userInputMessage");
    }

    private String completedText(String text) {
        var event = mapper.createObjectNode().put("type", "response.completed");
        var response = event.putObject("response").put("model", "gpt-6.1-sol");
        response.putArray("output").addObject().put("type", "message").putArray("content")
                .addObject().put("type", "output_text").put("text", text);
        return event.toString();
    }

    private String completedCall(String arguments) {
        var event = mapper.createObjectNode().put("type", "response.completed");
        event.putObject("response").putArray("output").addObject().put("type", "function_call")
                .put("call_id", "upstream-id").put("name", "read").put("arguments", arguments);
        return event.toString();
    }

    private void completeText(HttpExchange exchange, String text) throws IOException {
        sse(exchange, completedText(text));
    }

    private void sse(HttpExchange exchange, String... events) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
        exchange.sendResponseHeaders(200, 0);
        try (var output = exchange.getResponseBody()) {
            for (String event : events) {
                // Convert test JSON text blocks to single-line SSE data, just like actual gateways.
                String json = mapper.readTree(event).toString();
                output.write(("data: " + json + "\n\n").getBytes(StandardCharsets.UTF_8));
                output.flush();
            }
        }
    }

    private void reject(HttpExchange exchange, int status, String code, String param, String message) throws IOException {
        var body = mapper.createObjectNode();
        body.putObject("error").put("code", code).put("param", param).put("message", message);
        byte[] bytes = mapper.writeValueAsBytes(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var output = exchange.getResponseBody()) { output.write(bytes); }
    }

    private List<JsonNode> frames(byte[] wire) throws IOException {
        List<JsonNode> frames = new ArrayList<>();
        int offset = 0;
        while (offset < wire.length) {
            ByteBuffer prelude = ByteBuffer.wrap(wire, offset, 12);
            int length = prelude.getInt(), headers = prelude.getInt(), crc = prelude.getInt();
            assertThat(Integer.toUnsignedLong(crc)).isEqualTo(KiroProtocol.crc32(java.util.Arrays.copyOfRange(wire, offset, offset + 8)));
            assertThat(Integer.toUnsignedLong(ByteBuffer.wrap(wire, offset + length - 4, 4).getInt()))
                    .isEqualTo(KiroProtocol.crc32(java.util.Arrays.copyOfRange(wire, offset, offset + length - 4)));
            frames.add(mapper.readTree(java.util.Arrays.copyOfRange(wire, offset + 12 + headers, offset + length - 4)));
            offset += length;
        }
        assertThat(offset).isEqualTo(wire.length);
        return frames;
    }

    private String text(List<JsonNode> frames) {
        return frames.stream().filter(frame -> frame.has("modelId")).map(frame -> frame.path("content").asText())
                .collect(java.util.stream.Collectors.joining());
    }

    private String toolInputs(List<JsonNode> frames) {
        return frames.stream().filter(frame -> frame.has("toolUseId")).map(frame -> frame.path("input").asText())
                .collect(java.util.stream.Collectors.joining());
    }
}
