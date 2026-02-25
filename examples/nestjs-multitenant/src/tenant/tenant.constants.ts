export const TENANT_MODULE_OPTIONS = Symbol("TENANT_MODULE_OPTIONS");

export interface TenantModuleOptions {
  /**
   * HTTP header name to extract the tenant ID from.
   * @default "x-tenant-id"
   */
  headerName?: string;

  /**
   * Default tenant ID when no header is present.
   * @default "public"
   */
  defaultTenant?: string;

  /**
   * Controller classes or route strings to apply the tenant middleware to.
   * Pass '*' or omit to apply to all routes.
   * @default '*'
   */
  routes?: Array<new (...args: any[]) => any> | string;
}
