package cn.app.kiroproxy.api;

import cn.app.kiroproxy.config.RelayHealthService;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/admin/routes")
public class RouteAdminController {
    private final ModelAdminService service;
    private final RelayHealthService health;

    public RouteAdminController(ModelAdminService service, RelayHealthService health) {
        this.service = service;
        this.health = health;
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
