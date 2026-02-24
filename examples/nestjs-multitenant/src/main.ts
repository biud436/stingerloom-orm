import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
  console.log(
    `Multi-Tenant API is running on: http://localhost:${process.env.PORT ?? 3000}`,
  );
  console.log("Use x-tenant-id header to switch tenants:");
  console.log('  curl -H "x-tenant-id: tenant_1" http://localhost:3000/users');
  console.log('  curl -H "x-tenant-id: tenant_2" http://localhost:3000/posts');
}
bootstrap();
