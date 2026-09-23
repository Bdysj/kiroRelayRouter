package cn.app.kiroproxy.proxy;

import static org.assertj.core.api.Assertions.assertThat;

import cn.app.kiroproxy.config.RelayConfiguration;
import cn.app.kiroproxy.config.RelayModel;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class RelayProxyServiceStreamingTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private HttpServer server;
    private RelayProxyService service;

    @AfterEach
    void closeResources() {
        if (service != null) service.destroy();
        if (server != null) server.stop(0);
    }

    @Test
    void activeSseMayRunLongerThanConfiguredIdleTimeout() throws Exception {
        startServer(exchange -> {
            beginSse(exchange);
            try (var output = exchange.getResponseBody()) {
                for (int index = 0; index < 4; index++) {
                    writeEvent(output, "{\"choices\":[{\"delta\":{\"content\":\"x\"}}]}");
                    TimeUnit.MILLISECONDS.sleep(70);
                }
                writeEvent(output, "{\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}");
                writeEvent(output, "[DONE]");
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            }
        });
        service = new RelayProxyService(null, mapper, Duration.ofSeconds(1), Duration.ofMillis(120));

        ByteArrayOutputStream response = new ByteArrayOutputStream();
        long started = System.nanoTime();
        service.streamChat(requestBody(), configuration(), response, "active-stream");
        long elapsedMs = Duration.ofNanos(System.nanoTime() - started).toMillis();

        String wire = response.toString(StandardCharsets.UTF_8);
        assertThat(elapsedMs).isGreaterThanOrEqualTo(240);
        assertThat(wire).contains("assistantResponseEvent", "metadataEvent", "end_turn");
        assertThat(wire).doesNotContain("internalServerException");
    }

    @Test
    void streamWithNoDataIsStoppedByIdleTimeout() throws Exception {
        startServer(exchange -> {
            beginSse(exchange);
            try (var output = exchange.getResponseBody()) {
                writeEvent(output, "{\"choices\":[{\"delta\":{\"content\":\"started\"}}]}");
                TimeUnit.MILLISECONDS.sleep(350);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            }
        });
        service = new RelayProxyService(null, mapper, Duration.ofSeconds(1), Duration.ofMillis(120));

        ByteArrayOutputStream response = new ByteArrayOutputStream();
        service.streamChat(requestBody(), configuration(), response, "idle-stream");

        String wire = response.toString(StandardCharsets.UTF_8);
        assertThat(wire).contains("internalServerException", "流式响应长时间无数据");
        assertThat(wire).doesNotContain("metadataEvent");
    }

    @Test
    void outputLimitDoesNotCloseAndExecutePartialToolCall() throws Exception {
        startServer(exchange -> {
            beginSse(exchange);
            try (var output = exchange.getResponseBody()) {
                writeEvent(output, "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"function\":{\"name\":\"fs_write\",\"arguments\":\"{\\\"path\\\":\\\"x.md\\\"\"}}]}}]}");
                writeEvent(output, "{\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}");
                writeEvent(output, "[DONE]");
            }
        });
        service = new RelayProxyService(null, mapper, Duration.ofSeconds(1), Duration.ofSeconds(1));

        ByteArrayOutputStream response = new ByteArrayOutputStream();
        service.streamChat(requestBody(), configuration(), response, "truncated-tool");

        String wire = response.toString(StandardCharsets.UTF_8);
        assertThat(wire).contains("toolUseEvent", "internalServerException", "模型输出上限");
        assertThat(wire).doesNotContain("\"stop\":true", "metadataEvent");
    }

    private void startServer(com.sun.net.httpserver.HttpHandler handler) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", handler);
        server.start();
    }

    private static void beginSse(HttpExchange exchange) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
        exchange.sendResponseHeaders(200, 0);
    }

    private static void writeEvent(java.io.OutputStream output, String data) throws IOException {
        output.write(("data: " + data + "\n\n").getBytes(StandardCharsets.UTF_8));
        output.flush();
    }

    private RelayConfiguration configuration() {
        return new RelayConfiguration(true,
                "http://127.0.0.1:" + server.getAddress().getPort() + "/v1", "test-key",
                List.of(new RelayModel("gpt-test", "Test Model")));
    }

    private ObjectNode requestBody() {
        ObjectNode body = mapper.createObjectNode();
        ObjectNode state = body.putObject("conversationState");
        state.put("conversationId", "conversation-test");
        ObjectNode message = state.putObject("currentMessage").putObject("userInputMessage");
        message.put("modelId", "Test Model");
        message.put("content", "hello");
        message.putObject("userInputMessageContext");
        return body;
    }
}
