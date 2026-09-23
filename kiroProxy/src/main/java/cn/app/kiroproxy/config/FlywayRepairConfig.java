package cn.app.kiroproxy.config;

import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.flyway.FlywayMigrationStrategy;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Opt-in {@code flyway repair} before {@code migrate}.
 *
 * <p>Flyway 校验已执行迁移的校验和。一旦某个历史迁移脚本的内容被改过（本仓库为了开源脱敏
 * 改写过 {@code V2__seed_required_data.sql}），已经跑过旧版本的数据库在下次启动时会直接抛
 * {@code FlywayValidateException: Migration checksum mismatch}，应用起不来。
 *
 * <p>{@code flyway.repair()} 正是官方给这种情况准备的动作：它把 {@code flyway_schema_history}
 * 里已应用迁移的校验和、描述和类型重新对齐到当前解析出的脚本，不会重放任何 DDL/DML，也不
 * 触碰业务数据。修复完再正常 {@code migrate()}。
 *
 * <p><strong>默认关闭。</strong>无条件在每次启动前 repair 会把"迁移脚本被意外改动"这道安全
 * 网也一并抹掉，所以这里用 {@code kiro.flyway.repair-before-migrate} 显式开关控制：
 * 该属性缺省或为 {@code false} 时这个 bean 不注册，Spring Boot 走默认的"直接 migrate"策略，
 * 行为与不存在本类时完全一致。
 *
 * <p>典型用法：部署到一个已经跑过旧版 V2 的环境时，设一次
 * {@code KIRO_FLYWAY_REPAIR_BEFORE_MIGRATE=true} 启动，确认日志里出现 repair 结果后再把
 * 变量去掉，让校验保护回到默认状态。
 *
 * <p>Flyway validates the checksums of already-applied migrations. Because this repository
 * rewrote {@code V2__seed_required_data.sql} to strip secrets before open-sourcing, any
 * database that applied the previous V2 fails startup with a checksum mismatch.
 * {@code flyway.repair()} is the official remedy: it realigns the checksum, description and
 * type recorded in {@code flyway_schema_history} with the resolved scripts. It replays no
 * DDL or DML and never touches business data.
 *
 * <p>Disabled by default, because repairing on every boot would also remove the safety net
 * that catches accidental migration edits. Enable it for one deployment with
 * {@code KIRO_FLYWAY_REPAIR_BEFORE_MIGRATE=true}, then remove the variable again.
 */
@Configuration
@ConditionalOnProperty(name = "kiro.flyway.repair-before-migrate", havingValue = "true")
public class FlywayRepairConfig {
    private static final Logger log = LoggerFactory.getLogger(FlywayRepairConfig.class);

    @Bean
    public FlywayMigrationStrategy repairBeforeMigrate() {
        return flyway -> {
            log.warn(
                    "kiro.flyway.repair-before-migrate=true: 先执行 flyway repair 对齐历史校验和，再执行 migrate；"
                            + "确认修复完成后请移除该配置，让迁移脚本校验恢复默认保护"
                            + " | repair before migrate enabled; realigning historical checksums first,"
                            + " remove this flag once the repair is confirmed");
            var result = flyway.repair();
            if (result != null) {
                log.info(
                        "flyway repair 完成: 对齐校验和 {} 条, 标记缺失 {} 条, 移除失败记录 {} 条"
                                + " | repair done: {} checksum(s) aligned, {} marked missing,"
                                + " {} failed entries removed",
                        size(result.migrationsAligned),
                        size(result.migrationsDeleted),
                        size(result.migrationsRemoved),
                        size(result.migrationsAligned),
                        size(result.migrationsDeleted),
                        size(result.migrationsRemoved));
            }
            flyway.migrate();
        };
    }

    private static int size(List<?> list) {
        return list == null ? 0 : list.size();
    }
}
