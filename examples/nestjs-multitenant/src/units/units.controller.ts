import { Controller, Get } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiSecurity } from "@nestjs/swagger";
import { UnitsService } from "./units.service";

@ApiTags("Units")
@Controller("units")
@ApiSecurity("x-tenant-id")
export class UnitsController {
  constructor(private readonly unitsService: UnitsService) {}

  @Get("inactive")
  @ApiOperation({
    summary: "비활성 유닛 조회",
    description: "active가 false인 유닛 목록을 조회합니다.",
  })
  @ApiResponse({ status: 200, description: "비활성 유닛 목록 반환" })
  findInActiveUnits() {
    return this.unitsService.findInActiveUnits();
  }
}
