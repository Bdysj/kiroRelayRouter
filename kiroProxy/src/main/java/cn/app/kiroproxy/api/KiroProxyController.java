package cn.app.kiroproxy.api;

import cn.app.kiroproxy.auth.AccessPrincipal;
import cn.app.kiroproxy.auth.AccessTokenService;
import cn.app.kiroproxy.config.RelayConfiguration;
import cn.app.kiroproxy.proxy.KiroProtocol;
import cn.app.kiroproxy.proxy.RelayProxyService;
import cn.app.kiroproxy.i18n.RelayLanguage;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import java.util.UUID;
import java.time.Duration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

@RestController
@RequestMapping("/relay")
public class KiroProxyController {
    private static final Logger log = LoggerFactory.getLogger(KiroProxyController.class);
    private final RelayProxyService proxy;
    private final ObjectMapper mapper;
    private final AccessTokenService tokens;

    public KiroProxyController(RelayProxyService proxy, ObjectMapper mapper, AccessTokenService tokens) {
        this.proxy = proxy;
        this.mapper = mapper;
        this.tokens = tokens;
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        RelayConfiguration config = proxy.configuration();
        long availableRelays = proxy.availableRelayCount();
        return Map.of("ok", true, "enabled", config.enabled(), "configured",
                !config.models().isEmpty() && availableRelays > 0, "availableRelays", availableRelays);
    }

    @PostMapping("/kiro")
    public ResponseEntity<StreamingResponseBody> kiro(@RequestHeader(value = "x-amz-target", required = false) String target,
                                                       @RequestBody(required = false) JsonNode body,
                                                       @RequestParam(value = "lang", defaultValue = "en") String language,
                                                       HttpServletRequest request) throws Exception {
        String lang = RelayLanguage.normalize(language);
        long acceptedAt = System.nanoTime();
        String suppliedId = request.getHeader("x-relay-request-id");
        String requestId = suppliedId != null && suppliedId.matches("[A-Za-z0-9-]{8,64}")
                ? suppliedId : UUID.randomUUID().toString();
        JsonNode requestBody = body == null ? mapper.createObjectNode() : body;
        AccessPrincipal principal = (AccessPrincipal) request.getAttribute(AccessTokenService.REQUEST_ATTRIBUTE);
        RelayConfiguration config = tokens.restrict(proxy.configuration(), principal);
        String requestTarget = target == null ? "" : target;
        if (requestTarget.matches("(?i).*ListAvailableModels.*")) {
            byte[] response = mapper.writeValueAsBytes(principal == null
                    ? KiroProtocol.modelList(mapper, config.models())
                    : KiroProtocol.modelList(mapper, config.models(), principal.modelMultipliers()));
            return ResponseEntity.ok().contentType(MediaType.valueOf("application/x-amz-json-1.0"))
                    .cacheControl(CacheControl.noStore())
                    .body(output -> output.write(response));
        }
        boolean chat = requestTarget.matches("(?i).*(GenerateAssistantResponse|SendMessage).*") || requestBody.has("conversationState");
        if (!chat) {
            byte[] response = mapper.writeValueAsBytes(Map.of());
            return ResponseEntity.ok().contentType(MediaType.valueOf("application/x-amz-json-1.0"))
                    .body(output -> output.write(response));
        }

        // Preserve Kiro's chat UI and return a readable terminal stream. Never
        // enter local prompt handling or the upstream connector for expired tokens.
        if (principal.expired()) {
            log.info("relay token_expired request={} token_id={}", requestId, principal.tokenId());
            return ResponseEntity.ok().contentType(MediaType.valueOf(KiroProtocol.EVENT_STREAM))
                    .cacheControl(CacheControl.noStore()).header("X-Accel-Buffering", "no")
                    .header("X-Relay-Request-Id", requestId).header("X-Relay-Token-Expired", "true")
                    .header("X-Relay-Result-Code", "TOKEN_EXPIRED")
                    .body(output -> proxy.writeTokenExpiredResponse(requestBody, config, output, lang));
        }

        String requestedModel = requestBody.path("conversationState").path("currentMessage")
                .path("userInputMessage").path("modelId").asText("");
        if (config.models().isEmpty() || (!requestedModel.isBlank()
                && config.models().stream().noneMatch(model -> model.displayName().equals(requestedModel)))) {
            log.info("relay model_access_changed request={} requested_model={} available_models={}",
                    requestId, requestedModel.isBlank() ? "UNKNOWN" : requestedModel, config.models().size());
            return ResponseEntity.ok().contentType(MediaType.valueOf(KiroProtocol.EVENT_STREAM))
                    .cacheControl(CacheControl.noStore()).header("X-Accel-Buffering", "no")
                    .header("X-Relay-Request-Id", requestId)
                    .header("X-Relay-Result-Code", "MODEL_ACCESS_CHANGED")
                    .body(output -> proxy.writeModelAccessChangedResponse(requestBody, config, output, requestedModel, lang));
        }

        long queuedAt = System.nanoTime();
        log.debug("relay accepted request={} config_ms={}", requestId,
                Duration.ofNanos(queuedAt - acceptedAt).toMillis());
        StreamingResponseBody stream = output -> {
            long runningAt = System.nanoTime();
            log.debug("relay stream_start request={} queue_ms={}", requestId,
                    Duration.ofNanos(runningAt - queuedAt).toMillis());
            if (!config.enabled()) proxy.writeException(output, RelayLanguage.text(lang,
                    "kiroProxy 服务已关闭", "The kiroProxy service is disabled."));
            else if (proxy.isLocallyHandledPrompt(requestBody)) proxy.writeLocalPromptResponse(requestBody, config, output, lang);
            else proxy.streamChat(requestBody, config, output, requestId, principal, lang);
            log.debug("relay stream_end request={} total_ms={}", requestId,
                    Duration.ofNanos(System.nanoTime() - acceptedAt).toMillis());
        };
        return ResponseEntity.ok()
                .contentType(MediaType.valueOf(KiroProtocol.EVENT_STREAM))
                .cacheControl(CacheControl.noCache())
                .header("X-Accel-Buffering", "no")
                .header("X-Relay-Request-Id", requestId)
                .body(stream);
    }

    @PostMapping("/session")
    public RelayConfigController.ConfigView validateToken(HttpServletRequest request,
            @RequestParam(value = "lang", defaultValue = "en") String language) {
        AccessPrincipal principal = (AccessPrincipal) request.getAttribute(AccessTokenService.REQUEST_ATTRIBUTE);
        // Authentication already performed a database lookup in the filter.
        return RelayConfigController.ConfigView.from(tokens.restrict(proxy.configuration(), principal), principal,
                tokens.walletStatus(principal), tokens.machineBindingStatus(principal,
                        RelayConfigController.machineId(request)));
    }

    @DeleteMapping("/session/machine")
    public AccessTokenService.MachineBindingStatus unbindMachine(HttpServletRequest request,
            @RequestParam(value = "lang", defaultValue = "en") String language) {
        AccessPrincipal principal = (AccessPrincipal) request.getAttribute(AccessTokenService.REQUEST_ATTRIBUTE);
        return tokens.unbindCurrentMachine(principal, RelayConfigController.machineId(request),
                RelayLanguage.normalize(language));
    }
}
