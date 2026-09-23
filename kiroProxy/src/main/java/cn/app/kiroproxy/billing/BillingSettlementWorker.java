package cn.app.kiroproxy.billing;

import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.stereotype.Component;

@Component
public class BillingSettlementWorker {
    private final UsageBillingService billing;
    public BillingSettlementWorker(UsageBillingService billing) { this.billing = billing; }

    @RabbitListener(queues = "${kiro.billing.settlement-queue:billing.settlement.queue}",
            autoStartup = "${kiro.billing.messaging-enabled:true}")
    public void settle(String requestId) {
        billing.settle(requestId);
    }
}
