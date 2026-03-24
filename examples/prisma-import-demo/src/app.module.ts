import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Customer, Product, Order, OrderItem } from "./generated";
import { CustomersModule } from "./customers/customers.module";
import { ProductsModule } from "./products/products.module";
import { OrdersModule } from "./orders/orders.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    StinglerloomOrmModule.forRoot({
      type: "mysql",
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || "3306"),
      username: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "password",
      database: process.env.DB_NAME || "ecommerce_db",
      entities: [Customer, Product, Order, OrderItem],
      // synchronize: "dry-run",
      synchronize: true,
      logging: true,
    }),
    CustomersModule,
    ProductsModule,
    OrdersModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
