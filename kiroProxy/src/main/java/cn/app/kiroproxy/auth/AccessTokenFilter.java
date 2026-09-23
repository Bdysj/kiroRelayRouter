package cn.app.kiroproxy.auth;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.server.ResponseStatusException;
import cn.app.kiroproxy.config.ApiPathConfig;
import cn.app.kiroproxy.i18n.RelayLanguage;

@Component
public class AccessTokenFilter extends OncePerRequestFilter {
    private final AccessTokenService tokens;
    private final InvalidTokenAttemptService attempts;
    private final ObjectMapper mapper;
    @Value("${kiro.machine-binding.required:true}")
    private boolean machineBindingRequired;

    public AccessTokenFilter(AccessTokenService tokens, InvalidTokenAttemptService attempts, ObjectMapper mapper) {
        this.tokens = tokens;
        this.attempts = attempts;
        this.mapper = mapper;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getServletPath();
        if (path.isEmpty()) path = request.getRequestURI().substring(request.getContextPath().length());
        String relayPath = ApiPathConfig.API_PREFIX + "/relay/";
        return !path.startsWith(relayPath) || path.equals(relayPath + "health");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String token = request.getHeader("x-api-key");
        String authorization = request.getHeader("authorization");
        if ((token == null || token.isBlank()) && authorization != null && authorization.regionMatches(true, 0, "Bearer ", 0, 7)) {
            token = authorization.substring(7).trim();
        }
        String machineId = request.getHeader("x-relay-machine-id");
        String legacyMachineId = request.getHeader("x-relay-legacy-machine-id");
        String language = RelayLanguage.normalize(request.getParameter("lang"));
        boolean login = "POST".equalsIgnoreCase(request.getMethod())
                && request.getRequestURI().endsWith("/relay/session");
        if (!machineBindingRequired) {
            AccessPrincipal principal = tokens.authenticate(token);
            if (principal == null) {
                unauthorized(response, RelayLanguage.text(language,
                        "访问 Token 不存在、已禁用或所属分类已禁用",
                        "The access Token does not exist, is disabled, or belongs to a disabled group."));
                return;
            }
            request.setAttribute(AccessTokenService.REQUEST_ATTRIBUTE, principal);
            chain.doFilter(request, response);
            return;
        }
        if (login && attempts.coolingDown(machineId)) {
            error(response, 429, "INVALID_TOKEN_COOLDOWN", RelayLanguage.text(language,
                    "无效 Token 尝试次数过多，请在 1 小时后重试",
                    "Too many invalid Token attempts. Please try again in 1 hour."));
            return;
        }
        AccessPrincipal principal;
        try {
            // Only an explicit login may create a new machine binding. Normal
            // API traffic must never silently re-bind a machine after the user
            // has clicked unbind in another Kiro window.
            principal = tokens.authenticate(token, machineId, legacyMachineId, login, language);
        } catch (ResponseStatusException error) {
            error(response, error.getStatusCode().value(), "MACHINE_BINDING_REJECTED", error.getReason());
            return;
        }
        if (principal == null) {
            long failed = login ? attempts.recordFailure(machineId) : 0;
            if (failed >= InvalidTokenAttemptService.MAX_ATTEMPTS) {
                error(response, 429, "INVALID_TOKEN_COOLDOWN", RelayLanguage.text(language,
                        "无效 Token 尝试次数过多，请在 1 小时后重试",
                        "Too many invalid Token attempts. Please try again in 1 hour."));
                return;
            }
            unauthorized(response, RelayLanguage.text(language,
                    "访问 Token 不存在、已禁用或所属分类已禁用",
                    "The access Token does not exist, is disabled, or belongs to a disabled group."));
            return;
        }
        if (login) attempts.clear(machineId);
        request.setAttribute(AccessTokenService.REQUEST_ATTRIBUTE, principal);
        request.setAttribute("relay.machineId", machineId.trim());
        chain.doFilter(request, response);
    }

    private void unauthorized(HttpServletResponse response, String message) throws IOException {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        mapper.writeValue(response.getOutputStream(), Map.of("message", message));
    }

    private void error(HttpServletResponse response, int status, String code, String message) throws IOException {
        response.setStatus(status);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        mapper.writeValue(response.getOutputStream(), Map.of("code", code, "message", message));
    }
}
