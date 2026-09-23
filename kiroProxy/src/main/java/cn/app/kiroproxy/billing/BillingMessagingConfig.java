package cn.app.kiroproxy.billing;

import org.springframework.amqp.core.Binding;
import org.springframework.amqp.core.BindingBuilder;
import org.springframework.amqp.core.DirectExchange;
import org.springframework.amqp.core.Queue;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

@Configuration
@EnableScheduling
public class BillingMessagingConfig {
    @Bean
    DirectExchange billingSettlementExchange(
            @Value("${kiro.billing.settlement-exchange:billing.settlement.exchange}") String name) {
        return new DirectExchange(name, true, false);
    }

    @Bean
    Queue billingSettlementQueue(
            @Value("${kiro.billing.settlement-queue:billing.settlement.queue}") String name) {
        return new Queue(name, true, false, false);
    }

    @Bean
    Binding billingSettlementBinding(Queue billingSettlementQueue,
            DirectExchange billingSettlementExchange,
            @Value("${kiro.billing.settlement-routing-key:billing.settlement}") String routingKey) {
        return BindingBuilder.bind(billingSettlementQueue).to(billingSettlementExchange).with(routingKey);
    }
}
