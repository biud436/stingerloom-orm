import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const config = new DocumentBuilder()
    .setTitle("Multi-Tenant API")
    .setDescription(
      "Stingerloom ORM 기반 멀티테넌시 REST API. " +
        "x-tenant-id 헤더를 통해 테넌트를 전환합니다.",
    )
    .setVersion("1.0")
    // .addGlobalParameters({
    //   name: "x-tenant-id",
    //   in: "header",
    //   required: false,
    //   description:
    //     'Tenant identifier (e.g. "tenant_1", "tenant_2"). Defaults to "public" when unspecified.',
    //   schema: { type: "string", default: "public" },
    // })
    .addSecurity("x-tenant-id", {
      type: "apiKey",
      name: "x-tenant-id",
      in: "header",
    })
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api-docs", app, document);

  await app.listen(process.env.PORT ?? 3000);
  console.log(
    `Multi-Tenant API is running on: http://localhost:${process.env.PORT ?? 3000}`,
  );
  console.log(
    `Swagger UI: http://localhost:${process.env.PORT ?? 3000}/api-docs`,
  );
  console.log("Use x-tenant-id header to switch tenants:");
  console.log('  curl -H "x-tenant-id: tenant_1" http://localhost:3000/users');
  console.log('  curl -H "x-tenant-id: tenant_2" http://localhost:3000/posts');
}
bootstrap();
