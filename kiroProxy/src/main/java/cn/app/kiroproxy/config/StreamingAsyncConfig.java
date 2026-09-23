package cn.app.kiroproxy.config;

import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.web.servlet.config.annotation.AsyncSupportConfigurer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/** Dedicated bounded executor for independent long-lived streaming responses. */
@Configuration
public class StreamingAsyncConfig implements WebMvcConfigurer, DisposableBean {
    private final ThreadPoolTaskExecutor executor;
    private final Duration asyncTimeout;

    public StreamingAsyncConfig(
            @Value("${kiro.relay.streaming.core-pool-size:16}") int corePoolSize,
            @Value("${kiro.relay.streaming.max-pool-size:200}") int maxPoolSize,
            @Value("${kiro.relay.streaming.queue-capacity:0}") int queueCapacity,
            @Value("${kiro.relay.streaming.async-timeout:11m}") Duration asyncTimeout) {
        if (corePoolSize < 1 || maxPoolSize < corePoolSize || queueCapacity < 0) {
            throw new IllegalArgumentException("无效的 kiro.relay.streaming 线程池配置");
        }
        this.asyncTimeout = asyncTimeout;
        this.executor = new ThreadPoolTaskExecutor();
        this.executor.setThreadNamePrefix("relay-stream-");
        this.executor.setCorePoolSize(corePoolSize);
        this.executor.setMaxPoolSize(maxPoolSize);
        this.executor.setQueueCapacity(queueCapacity);
        this.executor.setWaitForTasksToCompleteOnShutdown(false);
        this.executor.initialize();
    }

    @Override
    public void configureAsyncSupport(AsyncSupportConfigurer configurer) {
        configurer.setTaskExecutor(executor);
        configurer.setDefaultTimeout(asyncTimeout.toMillis());
    }

    @Override
    public void destroy() {
        executor.shutdown();
    }
}
