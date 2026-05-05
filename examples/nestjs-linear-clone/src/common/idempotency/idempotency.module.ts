import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { IdempotencyKey } from "./idempotency-key.entity";
import { IdempotencyInterceptor } from "./idempotency.interceptor";

@Module({
  imports: [StingerloomOrmModule.forFeature([IdempotencyKey])],
  providers: [IdempotencyInterceptor],
  exports: [IdempotencyInterceptor],
})
export class IdempotencyModule {}
