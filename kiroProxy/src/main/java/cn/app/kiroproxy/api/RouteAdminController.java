package cn.app.kiroproxy.api;

import cn.app.kiroproxy.config.ReasoningAlertRepository;
import cn.app.kiroproxy.config.RelayHealthService;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/admin/routes")
public class RouteAdminController {
    private final ModelAdminService service;
    private final RelayHealthService health;
    private final ReasoningAlertRepository reasoningAlerts;

    public RouteAdminController(ModelAdminService service, RelayHealthService health,
                                ReasoningAlertRepository reasoningAlerts) {
        this.service = service;
        this.health = health;
        this.reasoningAlerts = reasoningAlerts;
    }

    /**
     * 推理强度不生效的路由告警。
     *
     * <p>两级严重度刻意分开：{@code REJECTED} 是已确认的事实（上游明确拒绝、已自动降级），
     * {@code IGNORED} 只是怀疑（请求了中高档位却没产生 reasoning token，也可能是模型自己
     * 判断不需要思考）。混成一条会让管理员拿着不确定的信号去做确定的配置动作。
     */
    @GetMapping("/reasoning-alerts")
    public java.util.List<ReasoningAlertRepository.AlertView> reasoningAlerts(
            @RequestParam(value = "openOnly", defaultValue = "true") boolean openOnly) {
        return reasoningAlerts.list(openOnly);
    }

    @PostMapping("/reasoning-alerts/{id}/resolve")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void resolveReasoningAlert(@PathVariable long id) {
        handle(() -> { reasoningAlerts.resolve(id); return null; });
    }

    @PutMapping("/{configurationId}/{modelId}")
    public ModelAdminService.ModelView save(@PathVariable long configurationId, @PathVariable String modelId,
            @RequestBody ModelAdminService.BindingRequest value) {
        return handle(() -> {
            var result = service.saveBinding(modelId, configurationId, value);
            health.reloadSelector();
            return result;
        });
    }

    @DeleteMapping("/{configurationId}/{modelId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable long configurationId, @PathVariable String modelId) {
        handle(() -> { service.removeBinding(modelId, configurationId); health.reloadSelector(); return null; });
    }

    @PostMapping("/bulk")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void bulk(@RequestBody ModelAdminService.BulkRouteRequest value) {
        handle(() -> { service.bulkRoutes(value); health.reloadSelector(); return null; });
    }

    @PostMapping("/bulk/unbind")
    public ModelAdminService.BulkUnbindResult bulkUnbind(
            @RequestBody ModelAdminService.BulkUnbindRequest value) {
        return handle(() -> {
            var result = service.bulkRemoveBindings(value);
            health.reloadSelector();
            return result;
        });
    }

    private static <T> T handle(java.util.concurrent.Callable<T> action) {
        try { return action.call(); }
        catch (IllegalArgumentException error) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, error.getMessage());
        } catch (Exception error) { throw new RuntimeException(error); }
    }
}
