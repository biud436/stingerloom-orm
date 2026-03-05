import { Controller, Get } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { TenantContext } from "./tenant-context.service";
import { Tenant } from "./tenant.decorator";

/**
 * Controller for tenant context inspection.
 * Useful for debugging and verifying tenant configuration.
 */
@ApiTags("Tenant")
@Controller("tenant")
export class TenantController {
  constructor(private readonly tenantContext: TenantContext) {}

  /**
   * GET /tenant/current
   * Returns the current tenant information from the request context.
   */
  @Get("current")
  @ApiOperation({
    summary: "현재 테넌트 조회",
    description:
      "요청 컨텍스트에서 현재 테넌트 정보를 반환합니다. " +
      "x-tenant-id 헤더 값을 확인하는 디버깅용 엔드포인트입니다.",
  })
  @ApiResponse({
    status: 200,
    description: "현재 테넌트 정보 반환",
    schema: {
      type: "object",
      properties: {
        tenant: {
          type: "string",
          description: "현재 활성 테넌트 ID",
          example: "tenant_1",
        },
        isActive: {
          type: "boolean",
          description: "테넌트 컨텍스트 활성 여부",
          example: true,
        },
      },
    },
  })
  getCurrent(@Tenant() tenant: string) {
    return {
      tenant,
      isActive: this.tenantContext.isActive(),
    };
  }
}
