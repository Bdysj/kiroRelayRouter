package cn.app.kiroproxy.billing;

import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.amqp.AmqpException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class BillingOutboxPublisher {
    private static final Logger log = LoggerFactory.getLogger(BillingOutboxPublisher.class);
    private final JdbcTemplate jdbc;
    private final RabbitTemplate rabbit;
    private final boolean enabled;
    private final String exchange;
    private final String routingKey;

    public BillingOutboxPublisher(JdbcTemplate jdbc, RabbitTemplate rabbit,
            @Value("${kiro.billing.messaging-enabled:true}") boolean enabled,
            @Value("${kiro.billing.settlement-exchange:billing.settlement.exchange}") String exchange,
            @Value("${kiro.billing.settlement-routing-key:billing.settlement}") String routingKey) {
        this.jdbc = jdbc;
        this.rabbit = rabbit;
        this.enabled = enabled;
        this.exchange = exchange;
        this.routingKey = routingKey;
    }

    @Scheduled(fixedDelayString = "${kiro.billing.outbox-delay-ms:1000}")
    public void publishPending() {
        if (!enabled) return;
        for (Map<String, Object> row : claimBatch()) {
            long id = ((Number) value(row, "id")).longValue();
            String requestId = value(row, "request_id").toString();
            try {
                Boolean confirmed = rabbit.invoke(operations -> {
                    operations.convertAndSend(exchange, routingKey, requestId,
                            message -> { message.getMessageProperties().setMessageId("settlement:" + requestId); return message; });
                    return operations.waitForConfirms(5000);
                });
                if (!Boolean.TRUE.equals(confirmed)) throw new AmqpException("RabbitMQ publisher confirm timed out");
                jdbc.update("""
                        update relay_billing_outbox set status='PUBLISHED', attempts=attempts+1,
                          published_at=current_timestamp, last_error=null where id=? and status='NEW'
                        """, id);
            } catch (RuntimeException error) {
                String reason = error.getClass().getSimpleName();
                jdbc.update("""
                        update relay_billing_outbox set attempts=attempts+1,
                          next_attempt_at=current_timestamp + INTERVAL '5 seconds', last_error=?
                        where id=? and status='NEW'
                        """, reason, id);
                log.warn("billing outbox publish failed request={} reason={}", requestId, reason);
            }
        }
    }

    /**
     * Leases a batch that no other instance can see, so running this publisher
     * on several nodes against one database does not send the same settlement
     * twice. {@code FOR UPDATE SKIP LOCKED} hands each node a disjoint set of
     * rows, and moving {@code next_attempt_at} beyond the lease window keeps
     * those rows out of every other node's query while this one publishes.
     * <p>
     * A single statement, therefore executed atomically without holding a
     * transaction open across the RabbitMQ round trips that follow. Losing the
     * process mid-batch delays a settlement by at most the lease window rather
     * than dropping it; the retry path below shortens the window back to five
     * seconds as soon as a publish actually fails.
     */
    private List<Map<String, Object>> claimBatch() {
        return jdbc.queryForList("""
                with claimed as (
                  select id from relay_billing_outbox
                  where status='NEW' and next_attempt_at <= current_timestamp
                  order by id limit 100
                  for update skip locked
                )
                update relay_billing_outbox outbox
                set next_attempt_at = current_timestamp + INTERVAL '60 seconds'
                from claimed where outbox.id = claimed.id
                returning outbox.id, outbox.request_id
                """);
    }

    private static Object value(Map<String, Object> row, String key) {
        Object value = row.get(key); return value == null ? row.get(key.toUpperCase()) : value;
    }
}
