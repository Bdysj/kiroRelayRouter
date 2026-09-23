package cn.app.kiroproxy.config;

import java.sql.Connection;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/**
 * Runs non-fatal dependency and relay-connector checks after the application is ready.
 * Credentials are never logged. Request-path model identifiers may be logged for routing and billing audits.
 */
@Component
public class StartupListener implements ApplicationListener<ApplicationReadyEvent> {
    private static final Logger log = LoggerFactory.getLogger(StartupListener.class);

    private final DataSource dataSource;
    private final RelayConfigurationRepository repository;
    private final RelayHealthService healthService;

    public StartupListener(DataSource dataSource, RelayConfigurationRepository repository,
                           RelayHealthService healthService) {
        this.dataSource = dataSource;
        this.repository = repository;
        this.healthService = healthService;
    }

    @Override
    public void onApplicationEvent(ApplicationReadyEvent event) {
        Environment env = event.getApplicationContext().getEnvironment();
        String[] profiles = env.getActiveProfiles();
        if (profiles.length == 0) {
            profiles = env.getDefaultProfiles();
        }
        String profile = String.join(",", profiles);
        String address = env.getProperty("server.address", "127.0.0.1");
        String port = env.getProperty("server.port", "8080");

        log.info("========================================");
        log.info("运行环境: {}", profile);
        log.info("监听地址: {}:{}", address, port);
        // prod 下 springdoc 已关闭，端点返回 404，不再打印入口地址避免误导。
        if (env.getProperty("springdoc.swagger-ui.enabled", Boolean.class, true)) {
            String path = env.getProperty("springdoc.swagger-ui.path", "/swagger-ui.html");
            log.info("Swagger: http://{}:{}{}", swaggerHost(address), port, path);
        } else {
            log.info("Swagger: 已在当前环境关闭（接口正常可调用）");
        }
        log.info("========================================");

        checkPostgreSql();
        checkRelayConnectors();

        log.info("=== ✅ kiroProxy 后端启动完成 ===");
        log.info("========================================");
    }

    private void checkPostgreSql() {
        try (Connection connection = dataSource.getConnection()) {
            if (!connection.isValid(3)) {
                log.error("❌ PostgreSQL 连接无效");
                return;
            }
            log.info("✅ PostgreSQL 连接成功 (user={}, database={})",
                    connection.getMetaData().getUserName(), connection.getCatalog());
        } catch (Exception error) {
            log.error("❌ PostgreSQL 连接失败: {}", safeMessage(error));
        }
    }

    private void checkRelayConnectors() {
        final RelayConfiguration config;
        try {
            config = repository.get();
        } catch (Exception error) {
            log.error("❌ 中转配置读取失败: {}", safeMessage(error));
            return;
        }

        if (!config.enabled()) log.warn("⚠️ 没有启用的中转配置");
        if (config.models().isEmpty()) {
            log.error("❌ 未配置可用模型");
        } else {
            log.info("✅ 目前有 {} 个可用模型",
                    config.models().size());
        }

        RelayHealthService.HealthSummary result = healthService.checkAllNow();
        if (result.up() > 0) log.info("✅ 中转健康检查完成: {}/{} 个配置可用", result.up(), result.configured());
        else log.error("❌ 中转健康检查完成: 0/{} 个配置可用", result.configured());
    }

    private static String swaggerHost(String address) {
        return "0.0.0.0".equals(address) || "::".equals(address) ? "localhost" : address;
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }
}
