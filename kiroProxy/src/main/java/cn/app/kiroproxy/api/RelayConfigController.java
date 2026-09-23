package cn.app.kiroproxy.api;

import cn.app.kiroproxy.auth.AccessPrincipal;
import cn.app.kiroproxy.auth.AccessTokenService;
import cn.app.kiroproxy.config.RelayConfiguration;
import cn.app.kiroproxy.config.RelayConfigurationRepository;
import cn.app.kiroproxy.config.RelayModel;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.time.Instant;
import java.time.Duration;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestParam;

@RestController
@RequestMapping("/relay/config")
public class RelayConfigController {
    private final RelayConfigurationRepository repository;
    private final AccessTokenService tokens;

    public RelayConfigController(RelayConfigurationRepository repository, AccessTokenService tokens) {
        this.repository = repository;
        this.tokens = tokens;
    }

    @GetMapping
    public ConfigView get(HttpServletRequest request,
            @RequestParam(value = "lang", defaultValue = "en") String language) {
        RelayConfiguration config = repository.get();
        AccessPrincipal principal = principal(request);
        return ConfigView.from(tokens.restrict(config, principal), principal, tokens.walletStatus(principal),
                tokens.machineBindingStatus(principal, machineId(request)));
    }

    private static AccessPrincipal principal(HttpServletRequest request) {
        return (AccessPrincipal) request.getAttribute(AccessTokenService.REQUEST_ATTRIBUTE);
    }

    static String machineId(HttpServletRequest request) {
        return (String) request.getAttribute("relay.machineId");
    }

    public record ConfigView(boolean enabled, List<String> models, String defaultModel,
                             boolean apiKeyConfigured, boolean authenticated, TokenStatus tokenStatus,
                             AccessTokenService.WalletStatus walletStatus,
                             AccessTokenService.MachineBindingStatus machineBindingStatus) {
        static ConfigView from(RelayConfiguration value) {
            return from(value, null);
        }
        static ConfigView from(RelayConfiguration value, AccessPrincipal principal) {
            return from(value, principal, null);
        }
        static ConfigView from(RelayConfiguration value, AccessPrincipal principal,
                               AccessTokenService.WalletStatus walletStatus) {
            return from(value, principal, walletStatus, null);
        }
        static ConfigView from(RelayConfiguration value, AccessPrincipal principal,
                               AccessTokenService.WalletStatus walletStatus,
                               AccessTokenService.MachineBindingStatus machineBindingStatus) {
            List<String> displayNames = value.models().stream().map(RelayModel::displayName).toList();
            String defaultModel = value.defaultModel() == null ? "" : value.defaultModel().displayName();
            return new ConfigView(value.enabled(), displayNames, defaultModel,
                    value.apiKey() != null && !value.apiKey().isBlank(), true,
                    principal == null ? null : TokenStatus.from(principal), walletStatus, machineBindingStatus);
        }
    }

    public record TokenStatus(Instant expiresAt, boolean expired, Long remainingDays, Instant serverTime) {
        static TokenStatus from(AccessPrincipal principal) {
            Instant now = Instant.now();
            Instant expiry = principal.expiresAt();
            boolean expired = expiry != null && !expiry.isAfter(now);
            Long days = expiry == null ? null : expired ? 0L : (long) Math.ceil(Duration.between(now, expiry).toMillis() / 86_400_000.0);
            return new TokenStatus(expiry, expired, days, now);
        }
    }

}
