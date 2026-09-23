package cn.app.kiroproxy.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.AnnotationUtils;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.config.annotation.PathMatchConfigurer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/** 为所有 RestController 统一添加 API 根路径，Controller 只声明业务路径。 */
@Configuration
public class ApiPathConfig implements WebMvcConfigurer {
    public static final String API_PREFIX = "/api";

    @Override
    public void configurePathMatch(PathMatchConfigurer configurer) {
        configurer.addPathPrefix(API_PREFIX,
                type -> AnnotationUtils.findAnnotation(type, RestController.class) != null);
    }
}
