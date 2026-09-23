package cn.app.kiroproxy.api;

import cn.app.kiroproxy.billing.BillingRuleService.BillingRuleUnavailableException;
import cn.app.kiroproxy.i18n.RelayLanguage;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.core.task.TaskRejectedException;
import org.springframework.web.server.ResponseStatusException;

@RestControllerAdvice
public class ApiExceptionHandler {
    @ExceptionHandler(BillingRuleUnavailableException.class)
    ResponseEntity<Map<String, String>> billingRuleUnavailable(BillingRuleUnavailableException error,
                                                                HttpServletRequest request) {
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .body(Map.of("code", error.code(), "message", RelayLanguage.text(language(request),
                        error.getMessage(), "The Points billing rule is temporarily unavailable.")));
    }

    @ExceptionHandler(TaskRejectedException.class)
    ResponseEntity<Map<String, String>> overloaded(HttpServletRequest request) {
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .header("Retry-After", "1")
                .body(Map.of("error", RelayLanguage.text(language(request),
                        "当前流式连接已满，请稍后重试",
                        "The streaming connection limit has been reached. Please try again later.")));
    }
    @ExceptionHandler({IllegalArgumentException.class, MethodArgumentNotValidException.class})
    ResponseEntity<Map<String, String>> badRequest(Exception error) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(Map.of("error", error.getMessage()));
    }

    @ExceptionHandler(ResponseStatusException.class)
    ResponseEntity<Map<String, String>> responseStatus(ResponseStatusException error, HttpServletRequest request) {
        String message = error.getReason() == null
                ? RelayLanguage.text(language(request), "请求失败", "Request failed.") : error.getReason();
        return ResponseEntity.status(error.getStatusCode()).body(Map.of("message", message));
    }

    private static String language(HttpServletRequest request) {
        String requested = request.getParameter("lang");
        // Preserve the existing Chinese response for callers that have not
        // adopted the language parameter yet. Explicit lang=en is localized.
        return requested == null ? RelayLanguage.ZH : RelayLanguage.normalize(requested);
    }
}
