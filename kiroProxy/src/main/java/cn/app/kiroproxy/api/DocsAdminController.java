package cn.app.kiroproxy.api;

import cn.app.kiroproxy.docs.DocsAssetService;
import cn.app.kiroproxy.docs.DocsAssetService.AssetView;
import cn.app.kiroproxy.docs.DocsService;
import cn.app.kiroproxy.docs.DocsService.ArticleInput;
import cn.app.kiroproxy.docs.DocsService.ArticleView;
import cn.app.kiroproxy.docs.DocsService.CategoryInput;
import cn.app.kiroproxy.docs.DocsService.CategoryView;
import cn.app.kiroproxy.docs.DocsService.DocsView;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/admin/docs")
public class DocsAdminController {
    private final DocsService docs;
    private final DocsAssetService assets;

    public DocsAdminController(DocsService docs, DocsAssetService assets) {
        this.docs = docs;
        this.assets = assets;
    }

    @GetMapping public DocsView all() { return docs.adminDocs(); }

    @PostMapping("/categories")
    @ResponseStatus(HttpStatus.CREATED)
    public CategoryView createCategory(@RequestBody CategoryInput input) { return docs.createCategory(input); }

    @PutMapping("/categories/{id}")
    public CategoryView updateCategory(@PathVariable long id, @RequestBody CategoryInput input) { return docs.updateCategory(id, input); }

    @DeleteMapping("/categories/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteCategory(@PathVariable long id) { docs.deleteCategory(id); }

    @PostMapping("/articles")
    @ResponseStatus(HttpStatus.CREATED)
    public ArticleView createArticle(@RequestBody ArticleInput input) { return docs.createArticle(input); }

    @PutMapping("/articles/{id}")
    public ArticleView updateArticle(@PathVariable long id, @RequestBody ArticleInput input) { return docs.updateArticle(id, input); }

    @PostMapping("/articles/{id}/publish")
    public ArticleView publish(@PathVariable long id) { return docs.publish(id); }

    @DeleteMapping("/articles/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteArticle(@PathVariable long id) { docs.deleteArticle(id); }

    @PostMapping("/assets")
    @ResponseStatus(HttpStatus.CREATED)
    public AssetView upload(@RequestParam("file") MultipartFile file,
                            @RequestParam(required = false) Long articleId,
                            @RequestParam String uploadSessionId) {
        return assets.upload(file, articleId, uploadSessionId);
    }
}
