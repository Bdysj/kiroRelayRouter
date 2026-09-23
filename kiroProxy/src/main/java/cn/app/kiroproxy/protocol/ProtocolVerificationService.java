package cn.app.kiroproxy.protocol;

import cn.app.kiroproxy.config.RelayConfigurationRepository;
import cn.app.kiroproxy.config.RelayEndpoint;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import javax.imageio.ImageIO;
import org.springframework.stereotype.Service;

@Service
public class ProtocolVerificationService implements org.springframework.beans.factory.DisposableBean {
    private static final int MAX_PROBE_TIMEOUT_MS = 1_800_000;
    private final RelayConfigurationRepository repository;
    private final ObjectMapper mapper;
    private final Map<String, DraftEvidence> draftEvidence = new ConcurrentHashMap<>();
    private final Map<String, ProtocolTestTask> protocolTestTasks = new ConcurrentHashMap<>();
    private final ThreadPoolExecutor protocolTestExecutor = new ThreadPoolExecutor(
            2, 4, 60, TimeUnit.SECONDS, new ArrayBlockingQueue<>(64), task -> {
                Thread thread = new Thread(task, "protocol-test-worker");
                thread.setDaemon(true);
                return thread;
            });
    private final java.util.concurrent.ScheduledExecutorService deadline =
            Executors.newSingleThreadScheduledExecutor(task -> {
                Thread thread = new Thread(task, "protocol-smoke-deadline");
                thread.setDaemon(true);
                return thread;
            });

    public ProtocolVerificationService(RelayConfigurationRepository repository, ObjectMapper mapper) {
        this.repository = repository;
        this.mapper = mapper;
    }

    /** Starts a bounded background test. Clients poll only while the related UI remains mounted. */
    public ProtocolTestTaskView startDraftTest(RelayEndpoint endpoint, RelayProtocol protocol, String modelId) {
        if (modelId == null || modelId.isBlank()) throw new IllegalArgumentException("请先选择测试模型");
        cleanupProtocolTestTasks();
        String taskId = UUID.randomUUID().toString();
        ProtocolTestTask task = new ProtocolTestTask(taskId, Instant.now());
        protocolTestTasks.put(taskId, task);
        try {
            protocolTestExecutor.execute(() -> {
                task.status = ProtocolTestTaskStatus.RUNNING;
                try {
                    task.result = verify(endpoint.id(), endpoint, protocol, modelId.trim());
                    task.status = ProtocolTestTaskStatus.COMPLETED;
                } catch (Exception error) {
                    task.message = errorMessage(error);
                    task.status = ProtocolTestTaskStatus.FAILED;
                } finally {
                    task.completedAt = Instant.now();
                }
            });
        } catch (RejectedExecutionException error) {
            protocolTestTasks.remove(taskId);
            throw error;
        }
        return task.view();
    }

    public java.util.Optional<ProtocolTestTaskView> findDraftTest(String taskId) {
        cleanupProtocolTestTasks();
        ProtocolTestTask task = protocolTestTasks.get(taskId);
        return task == null ? java.util.Optional.empty() : java.util.Optional.of(task.view());
    }

    private void cleanupProtocolTestTasks() {
        Instant expiredBefore = Instant.now().minus(Duration.ofMinutes(10));
        protocolTestTasks.entrySet().removeIf(entry -> {
            ProtocolTestTask task = entry.getValue();
            if (task.completedAt == null || !task.completedAt.isBefore(expiredBefore)) return false;
            if (task.result != null && task.result.verificationToken() != null)
                draftEvidence.remove(task.result.verificationToken());
            return true;
        });
    }

    private VerificationResult verify(long configurationId, RelayEndpoint endpoint, RelayProtocol protocol,
                                      String modelId) {
        long started = System.nanoTime();
        boolean connection = false;
        boolean streaming = false;
        boolean text = false;
        boolean streamingTested = protocol.capabilities().contains(ProtocolCapability.STREAMING);
        boolean imageTested = protocol.capabilities().contains(ProtocolCapability.IMAGE);
        Boolean image = imageTested ? Boolean.FALSE : null;
        boolean pdfTested = protocol.capabilities().contains(ProtocolCapability.PDF);
        Boolean pdf = pdfTested ? Boolean.FALSE : null;
        String message;
        try {
            ProtocolAdapter adapter = ProtocolAdapters.get(protocol.code());
            ObjectNode canonical = mapper.createObjectNode().put("model", endpoint.upstreamModelId(modelId))
                    .put("stream", streamingTested).put("max_tokens", 16);
            canonical.putArray("messages").addObject().put("role", "user").put("content", "Reply with OK only.");
            ProbeResult basic = executeProbe(endpoint, protocol, adapter, canonical, null, streamingTested);
            connection = basic.connection();
            streaming = basic.streaming();
            text = !basic.text().isBlank();
            if (!text) throw new IllegalStateException("未收到文本增量");

            if (imageTested) {
                String marker = "KIRO-IMG-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase(Locale.ROOT);
                try {
                    ProbeResult imageResult = executeProbe(endpoint, protocol, adapter,
                            imageProbe(endpoint.upstreamModelId(modelId), marker, streamingTested), marker,
                            streamingTested);
                    image = imageResult.text().toUpperCase(Locale.ROOT).contains(marker);
                    if (!image) throw new IllegalStateException("模型未返回图片内的随机校验码");
                } catch (Exception error) {
                    throw new IllegalStateException("图片验证失败：" + errorMessage(error), error);
                }
            }
            if (pdfTested) {
                String marker = "KIRO-PDF-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase(Locale.ROOT);
                ObjectNode pdfRequest = pdfProbe(endpoint.upstreamModelId(modelId), marker, streamingTested);
                try {
                    ProbeResult pdfResult = executeProbe(endpoint, protocol, adapter, pdfRequest, marker,
                            streamingTested);
                    pdf = pdfResult.text().toUpperCase(Locale.ROOT).contains(marker);
                    if (!pdf) throw new IllegalStateException("模型未返回 PDF 内的随机校验码");
                } catch (Exception error) {
                    throw new IllegalStateException("PDF 验证失败：" + errorMessage(error), error);
                }
            }
            List<String> verifiedCapabilities = new ArrayList<>(List.of("连接", "文本"));
            if (streamingTested) verifiedCapabilities.add("Streaming");
            if (imageTested) verifiedCapabilities.add("图片读取");
            if (pdfTested) verifiedCapabilities.add("PDF 读取");
            message = String.join("、", verifiedCapabilities) + "验证通过（模型：" + modelId + "）";
        } catch (Exception error) {
            message = errorMessage(error);
        }
        boolean verified = connection && text && (!streamingTested || streaming)
                && (!imageTested || Boolean.TRUE.equals(image))
                && (!pdfTested || Boolean.TRUE.equals(pdf));
        String verificationToken = null;
        if (verified) {
            Instant now = Instant.now();
            draftEvidence.entrySet().removeIf(entry -> entry.getValue().expiresAt().isBefore(now));
            verificationToken = UUID.randomUUID().toString();
            draftEvidence.put(verificationToken, new DraftEvidence(now.plus(Duration.ofMinutes(10)),
                    endpoint.baseUrl(), secretFingerprint(endpoint.apiKey()),
                    endpoint.upstreamModelId(modelId), endpoint.connectTimeoutMs(), endpoint.readTimeoutMs(),
                    protocol.code(), protocol.enabled(), protocol.priority(), protocol.path(),
                    protocol.capabilities(), message));
        }
        return new VerificationResult(configurationId, protocol.code(), modelId, connection, text,
                streamingTested, streamingTested ? streaming : null,
                imageTested, image, pdfTested, pdf,
                verified, verificationToken,
                Duration.ofNanos(System.nanoTime() - started).toMillis(),
                Instant.now(), message);
    }

    /** Applies a short-lived, single-use proof only when the saved configuration is byte-for-byte equivalent. */
    public void consumeDraftEvidence(long configurationId, Map<ProtocolCode, String> tokens) {
        if (tokens == null || tokens.isEmpty()) return;
        RelayEndpoint endpoint = repository.findEndpoint(configurationId)
                .orElseThrow(() -> new IllegalArgumentException("中转配置不存在"));
        tokens.forEach((code, token) -> {
            DraftEvidence evidence = token == null ? null : draftEvidence.remove(token);
            if (evidence == null || evidence.expiresAt().isBefore(Instant.now()) || evidence.code() != code) return;
            RelayProtocol protocol = endpoint.protocols().stream().filter(item -> item.code() == code).findFirst()
                    .orElse(null);
            boolean modelMatches = endpoint.modelIds().stream()
                    .map(endpoint::upstreamModelId).anyMatch(evidence.upstreamModelId()::equals);
            if (protocol != null && modelMatches && evidence.baseUrl().equals(endpoint.baseUrl())
                    && evidence.apiKeyHash().equals(secretFingerprint(endpoint.apiKey()))
                    && evidence.connectTimeoutMs() == endpoint.connectTimeoutMs()
                    && evidence.readTimeoutMs() == endpoint.readTimeoutMs()
                    && evidence.enabled() == protocol.enabled() && evidence.priority() == protocol.priority()
                    && evidence.path().equals(protocol.path())
                    && evidence.capabilities().equals(protocol.capabilities())) {
                repository.markProtocolVerification(configurationId, code, true, evidence.message());
            }
        });
    }

    private ProbeResult executeProbe(RelayEndpoint endpoint, RelayProtocol protocol, ProtocolAdapter adapter,
                                     ObjectNode canonical, String expectedText, boolean streamingTested) throws Exception {
        int probeTimeoutMs = Math.min(endpoint.readTimeoutMs(), MAX_PROBE_TIMEOUT_MS);
        byte[] bytes = mapper.writeValueAsBytes(adapter.encode(mapper, canonical));
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(endpoint.baseUrl() + protocol.path()))
                .timeout(Duration.ofMillis(probeTimeoutMs));
        adapter.headers(endpoint.apiKey()).forEach(builder::header);
        builder.setHeader("accept", streamingTested ? "text/event-stream" : "application/json");
        HttpClient client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofMillis(endpoint.connectTimeoutMs())).build();
        HttpResponse<java.io.InputStream> response = client.send(builder.POST(
                HttpRequest.BodyPublishers.ofByteArray(bytes)).build(), HttpResponse.BodyHandlers.ofInputStream());
        boolean connection = response.statusCode() >= 200 && response.statusCode() < 300;
        boolean streaming = response.headers().firstValue("content-type").orElse("").toLowerCase(Locale.ROOT)
                .startsWith("text/event-stream");
        if (!connection) {
            try (java.io.InputStream body = response.body()) { body.readNBytes(16 * 1024); }
            throw new IllegalStateException("HTTP " + response.statusCode());
        }
        if (!streamingTested) {
            String responseText = readNonStreamingText(response.body(), protocol.code(), probeTimeoutMs);
            return new ProbeResult(connection, false, responseText);
        }
        if (!streaming) throw new IllegalStateException("未返回 SSE 流");
        java.io.InputStream responseBody = response.body();
        var timeout = deadline.schedule(() -> {
            try { responseBody.close(); } catch (Exception ignored) { }
        }, probeTimeoutMs, TimeUnit.MILLISECONDS);
        StringBuilder receivedText = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(responseBody, StandardCharsets.UTF_8))) {
            String eventName = "";
            StringBuilder data = new StringBuilder();
            String line;
            int receivedCharacters = 0;
            boolean done = false;
            while (!done && (line = reader.readLine()) != null) {
                receivedCharacters += line.length();
                if (receivedCharacters > 256 * 1024) throw new IllegalStateException("协议测试响应过大");
                if (line.startsWith("event:")) eventName = line.substring(6).stripLeading();
                else if (line.startsWith("data:")) data.append(line.substring(5).stripLeading());
                else if (line.isEmpty() && !data.isEmpty()) {
                    List<CanonicalStreamEvent> events = adapter.decode(mapper, eventName, data.toString());
                    for (CanonicalStreamEvent event : events) {
                        if (event.type() == CanonicalStreamEvent.Type.ERROR)
                            throw new IllegalStateException("协议返回错误事件");
                        if (event.type() == CanonicalStreamEvent.Type.TEXT_DELTA && event.text() != null) {
                            receivedText.append(event.text());
                            if (expectedText == null && !receivedText.toString().isBlank()) done = true;
                            if (expectedText != null && receivedText.toString().toUpperCase(Locale.ROOT)
                                    .contains(expectedText)) done = true;
                        }
                        if (event.type() == CanonicalStreamEvent.Type.DONE) done = true;
                    }
                    eventName = "";
                    data.setLength(0);
                }
            }
        } finally {
            timeout.cancel(false);
        }
        return new ProbeResult(connection, streaming, receivedText.toString());
    }

    private String readNonStreamingText(java.io.InputStream responseBody, ProtocolCode code,
                                        int probeTimeoutMs) throws Exception {
        var timeout = deadline.schedule(() -> {
            try { responseBody.close(); } catch (Exception ignored) { }
        }, probeTimeoutMs, TimeUnit.MILLISECONDS);
        try (responseBody) {
            byte[] bytes = responseBody.readNBytes(256 * 1024 + 1);
            if (bytes.length > 256 * 1024) throw new IllegalStateException("协议测试响应过大");
            var body = mapper.readTree(bytes);
            if (body == null || body.hasNonNull("error")) throw new IllegalStateException("协议返回错误响应");
            StringBuilder text = new StringBuilder();
            if (code == ProtocolCode.OPENAI_CHAT_COMPLETIONS) {
                appendText(text, body.path("choices").path(0).path("message").path("content"));
            } else if (code == ProtocolCode.OPENAI_RESPONSES) {
                appendText(text, body.path("output_text"));
                for (var output : body.path("output"))
                    for (var content : output.path("content")) appendText(text, content.path("text"));
            } else {
                for (var content : body.path("content")) appendText(text, content.path("text"));
            }
            return text.toString();
        } finally {
            timeout.cancel(false);
        }
    }

    private static void appendText(StringBuilder target, com.fasterxml.jackson.databind.JsonNode value) {
        if (value.isTextual()) target.append(value.asText());
        else for (var item : value) if (item.path("text").isTextual()) target.append(item.path("text").asText());
    }

    private ObjectNode pdfProbe(String modelId, String marker, boolean streaming) {
        ObjectNode canonical = mapper.createObjectNode().put("model", modelId).put("stream", streaming)
                .put("max_tokens", 32);
        ArrayNode content = canonical.putArray("messages").addObject().put("role", "user").putArray("content");
        content.addObject().put("type", "text")
                .put("text", "Read the attached PDF and reply with only the probe code printed inside it.");
        ObjectNode file = content.addObject().put("type", "file").putObject("file");
        file.put("filename", "kiro-protocol-probe.pdf");
        file.put("file_data", "data:application/pdf;base64," + Base64.getEncoder().encodeToString(pdfBytes(marker)));
        return canonical;
    }

    private ObjectNode imageProbe(String modelId, String marker, boolean streaming) {
        ObjectNode canonical = mapper.createObjectNode().put("model", modelId).put("stream", streaming)
                .put("max_tokens", 32);
        ArrayNode content = canonical.putArray("messages").addObject().put("role", "user").putArray("content");
        content.addObject().put("type", "text")
                .put("text", "Read the attached image and reply with only the probe code visibly printed in it.");
        content.addObject().put("type", "image_url").putObject("image_url")
                .put("url", "data:image/png;base64," + Base64.getEncoder().encodeToString(imageBytes(marker)));
        return canonical;
    }

    /** Builds a high-contrast PNG in memory. The trailing marker is ignored by PNG decoders and aids wire-level tests. */
    private static byte[] imageBytes(String marker) {
        try {
            BufferedImage image = new BufferedImage(640, 160, BufferedImage.TYPE_INT_RGB);
            Graphics2D graphics = image.createGraphics();
            try {
                graphics.setColor(Color.WHITE);
                graphics.fillRect(0, 0, image.getWidth(), image.getHeight());
                graphics.setColor(Color.BLACK);
                graphics.setFont(new Font(Font.MONOSPACED, Font.BOLD, 42));
                graphics.drawString(marker, 40, 98);
            } finally {
                graphics.dispose();
            }
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            if (!ImageIO.write(image, "png", output)) throw new IllegalStateException("PNG 编码器不可用");
            output.writeBytes(marker.getBytes(StandardCharsets.US_ASCII));
            return output.toByteArray();
        } catch (Exception error) {
            throw new IllegalStateException("无法生成图片测试载荷", error);
        }
    }

    /** Builds a one-page PDF in memory, so no customer file or fixed answer is used by the probe. */
    private static byte[] pdfBytes(String marker) {
        String stream = "BT /F1 18 Tf 72 720 Td (" + marker + ") Tj ET";
        List<String> objects = List.of(
                "<< /Type /Catalog /Pages 2 0 R >>",
                "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
                "<< /Length " + stream.getBytes(StandardCharsets.US_ASCII).length + " >>\nstream\n" + stream + "\nendstream",
                "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        output.writeBytes("%PDF-1.4\n".getBytes(StandardCharsets.US_ASCII));
        List<Integer> offsets = new ArrayList<>();
        for (int index = 0; index < objects.size(); index++) {
            offsets.add(output.size());
            output.writeBytes(((index + 1) + " 0 obj\n" + objects.get(index) + "\nendobj\n")
                    .getBytes(StandardCharsets.US_ASCII));
        }
        int xref = output.size();
        output.writeBytes(("xref\n0 " + (objects.size() + 1) + "\n0000000000 65535 f \n")
                .getBytes(StandardCharsets.US_ASCII));
        for (Integer offset : offsets) output.writeBytes(String.format(Locale.ROOT, "%010d 00000 n \n", offset)
                .getBytes(StandardCharsets.US_ASCII));
        output.writeBytes(("trailer\n<< /Size " + (objects.size() + 1) + " /Root 1 0 R >>\nstartxref\n"
                + xref + "\n%%EOF\n").getBytes(StandardCharsets.US_ASCII));
        return output.toByteArray();
    }

    private static String errorMessage(Exception error) {
        return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
    }

    private static String secretFingerprint(String value) {
        try {
            return java.util.HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private record ProbeResult(boolean connection, boolean streaming, String text) {}

    private record DraftEvidence(Instant expiresAt, String baseUrl, String apiKeyHash, String upstreamModelId,
            int connectTimeoutMs, int readTimeoutMs, ProtocolCode code, boolean enabled, int priority, String path,
            java.util.Set<ProtocolCapability> capabilities, String message) {}

    public record VerificationResult(long configurationId, ProtocolCode protocol, String modelId, boolean connection,
            boolean text, boolean streamingTested, Boolean streaming, boolean imageTested, Boolean image,
            boolean pdfTested, Boolean pdf, boolean verified,
            String verificationToken,
            long latencyMs, Instant checkedAt, String message) {}

    public enum ProtocolTestTaskStatus { QUEUED, RUNNING, COMPLETED, FAILED }

    public record ProtocolTestTaskView(String taskId, ProtocolTestTaskStatus status,
            VerificationResult result, String message, Instant createdAt, Instant completedAt) {}

    private static final class ProtocolTestTask {
        private final String taskId;
        private final Instant createdAt;
        private volatile ProtocolTestTaskStatus status = ProtocolTestTaskStatus.QUEUED;
        private volatile VerificationResult result;
        private volatile String message;
        private volatile Instant completedAt;

        private ProtocolTestTask(String taskId, Instant createdAt) {
            this.taskId = taskId;
            this.createdAt = createdAt;
        }

        private ProtocolTestTaskView view() {
            return new ProtocolTestTaskView(taskId, status, result, message, createdAt, completedAt);
        }
    }

    @Override public void destroy() {
        draftEvidence.clear();
        protocolTestTasks.clear();
        protocolTestExecutor.shutdownNow();
        deadline.shutdownNow();
    }
}
