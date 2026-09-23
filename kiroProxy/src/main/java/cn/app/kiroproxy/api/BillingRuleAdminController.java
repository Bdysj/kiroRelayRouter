package cn.app.kiroproxy.api;

import cn.app.kiroproxy.billing.BillingRuleService;
import cn.app.kiroproxy.billing.BillingRuleService.BillingRule;
import cn.app.kiroproxy.billing.BillingRuleService.Simulation;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotNull;
import java.math.BigDecimal;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/admin/billing-rule")
public class BillingRuleAdminController {
    private final BillingRuleService rules;

    public BillingRuleAdminController(BillingRuleService rules) {
        this.rules = rules;
    }

    @GetMapping("/current")
    public BillingRule current() {
        return rules.current();
    }

    @GetMapping("/history")
    public List<BillingRule> history(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "5") int pageSize) {
        if (page < 1) throw new IllegalArgumentException("page 必须大于 0");
        if (pageSize < 1 || pageSize > 50) {
            throw new IllegalArgumentException("pageSize 必须在 1 到 50 之间");
        }
        return rules.history(page, pageSize);
    }

    @PostMapping
    public BillingRule update(@Valid @RequestBody UpdateRuleRequest request) {
        return rules.createVersion(request.pointsPerUsd());
    }

    @PostMapping("/simulate")
    public Simulation simulate(@Valid @RequestBody SimulationRequest request) {
        return rules.simulate(request.providerCostUsd(), request.billingMultiplier());
    }

    public record UpdateRuleRequest(
            @NotNull @DecimalMin(value = "0", inclusive = false) BigDecimal pointsPerUsd) {}

    public record SimulationRequest(
            @NotNull @DecimalMin("0") BigDecimal providerCostUsd,
            @NotNull @DecimalMin(value = "0", inclusive = false) BigDecimal billingMultiplier) {}
}
