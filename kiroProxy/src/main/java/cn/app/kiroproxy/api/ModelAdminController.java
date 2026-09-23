package cn.app.kiroproxy.api;

import jakarta.validation.Valid;
import java.util.List;
import cn.app.kiroproxy.config.RelayHealthService;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/admin/models")
public class ModelAdminController {
    private final ModelAdminService service;
    private final RelayHealthService health;
    public ModelAdminController(ModelAdminService service, RelayHealthService health) {
        this.service = service; this.health = health;
    }

    @GetMapping public List<ModelAdminService.ModelView> list() { return service.list(); }
    @PostMapping("/save") public ModelAdminService.ModelView save(@Valid @RequestBody ModelAdminService.ModelRequest value) {
        ModelAdminService.ModelView result = handle(() -> service.save(value)); health.reloadSelector(); return result;
    }
    /** 拖拽排序：按请求里的顺序整体重排 sort_order，返回重排后的完整模型列表。 */
    @PutMapping("/sort")
    public List<ModelAdminService.ModelView> reorder(@Valid @RequestBody ModelAdminService.ReorderRequest value) {
        List<ModelAdminService.ModelView> result = handle(() -> service.reorder(value));
        health.reloadSelector();
        return result;
    }
    @DeleteMapping("/{modelId}") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void disable(@PathVariable String modelId) { handle(() -> { service.disable(modelId); return null; }); health.reloadSelector(); }
    @PutMapping("/{modelId}/enabled")
    public ModelAdminService.ModelView setEnabled(@PathVariable String modelId,
            @RequestBody EnabledRequest value) {
        ModelAdminService.ModelView result = handle(() -> service.setEnabled(modelId, value.enabled()));
        health.reloadSelector();
        return result;
    }
    @PutMapping("/{modelId}/pricing")
    public ModelAdminService.ModelView savePrice(@PathVariable String modelId,
            @RequestBody ModelAdminService.PricingRequest value) {
        return handle(() -> service.savePrice(modelId, value));
    }
    @DeleteMapping("/{modelId}/pricing/{id}") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deletePrice(@PathVariable String modelId, @PathVariable long id) {
        handle(() -> { service.deletePrice(modelId, id); return null; });
    }
    public record EnabledRequest(boolean enabled) {}
    private static <T> T handle(java.util.concurrent.Callable<T> action) {
        try { return action.call(); }
        catch (IllegalArgumentException error) { throw new ResponseStatusException(HttpStatus.BAD_REQUEST, error.getMessage()); }
        catch (Exception error) { throw new RuntimeException(error); }
    }
}
