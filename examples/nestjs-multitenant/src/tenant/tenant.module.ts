import {
  DynamicModule,
  MiddlewareConsumer,
  Module,
  NestModule,
} from "@nestjs/common";
import { TenantMiddleware } from "./tenant.middleware";
import { TenantContext } from "./tenant-context.service";
import { TenantController } from "./tenant.controller";
import {
  TENANT_MODULE_OPTIONS,
  TenantModuleOptions,
} from "./tenant.constants";

/**
 * NestJS module for automatic multi-tenancy support.
 *
 * Applies TenantMiddleware to extract tenant ID from request headers
 * and set up AsyncLocalStorage context so that all downstream ORM
 * operations use the correct tenant's metadata layer.
 *
 * @example
 * ```ts
 * // Apply to all routes (default)
 * @Module({
 *   imports: [TenantModule.forRoot()],
 * })
 * export class AppModule {}
 *
 * // Apply to specific controllers only
 * @Module({
 *   imports: [
 *     TenantModule.forRoot({
 *       routes: [UsersController, PostsController],
 *     }),
 *   ],
 * })
 * export class AppModule {}
 *
 * // Custom header name
 * @Module({
 *   imports: [
 *     TenantModule.forRoot({
 *       headerName: 'x-org-id',
 *       defaultTenant: 'default',
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Module({})
export class TenantModule implements NestModule {
  private static options: TenantModuleOptions = {};

  static forRoot(options?: TenantModuleOptions): DynamicModule {
    TenantModule.options = options || {};

    return {
      module: TenantModule,
      controllers: [TenantController],
      providers: [
        {
          provide: TENANT_MODULE_OPTIONS,
          useValue: TenantModule.options,
        },
        TenantContext,
      ],
      exports: [TenantContext, TENANT_MODULE_OPTIONS],
      global: true,
    };
  }

  configure(consumer: MiddlewareConsumer) {
    const routes = TenantModule.options.routes;

    if (!routes || routes === "*") {
      consumer.apply(TenantMiddleware).forRoutes("*");
    } else if (Array.isArray(routes)) {
      consumer.apply(TenantMiddleware).forRoutes(TenantController, ...routes);
    }
  }
}
