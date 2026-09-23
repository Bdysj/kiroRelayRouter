package cn.app.kiroproxy.api;

import cn.app.kiroproxy.docs.DocsService;
import cn.app.kiroproxy.docs.DocsService.DocsView;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/public/docs")
public class DocsPublicController {
    private final DocsService docs;

    public DocsPublicController(DocsService docs) {
        this.docs = docs;
    }

    @GetMapping
    public DocsView published() {
        return docs.publishedDocs();
    }
}
