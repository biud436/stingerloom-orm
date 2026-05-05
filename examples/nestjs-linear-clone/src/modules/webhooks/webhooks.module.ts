import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { WebhookEndpoint } from "./webhook-endpoint.entity";
import { WebhookDelivery } from "./webhook-delivery.entity";
import { WebhooksService } from "./webhooks.service";
import { WebhookDeliveryWorker } from "./webhook-worker.service";
import { WebhooksController } from "./webhooks.controller";

@Module({
  imports: [StingerloomOrmModule.forFeature([WebhookEndpoint, WebhookDelivery])],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookDeliveryWorker],
  exports: [WebhooksService],
})
export class WebhooksModule {}
