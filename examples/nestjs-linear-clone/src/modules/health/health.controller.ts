import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { EntityManager, sql } from "@stingerloom/orm";
import { Public } from "../../common/auth/public.decorator";

@ApiTags("Health")
@Controller()
export class HealthController {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  /**
   * Liveness — answers "is the process up?". No external dependencies, so
   * Kubernetes can use it to detect a deadlocked event loop without
   * cascading on a dead database.
   */
  @Public()
  @Get("healthz")
  @ApiOperation({ summary: "Liveness probe (no DB)" })
  liveness(): { status: "ok"; uptime: number } {
    return { status: "ok", uptime: Math.round(process.uptime()) };
  }

  /**
   * Readiness — answers "can this instance serve traffic?". A failing SELECT 1
   * trips a 503 so the load balancer pulls the pod out of rotation while
   * keeping the process alive for kubectl logs.
   */
  @Public()
  @Get("readyz")
  @ApiOperation({ summary: "Readiness probe (DB ping)" })
  async readiness(): Promise<{ status: "ok"; db: "ok" }> {
    try {
      await this.em.query(sql`SELECT 1 AS ok`);
    } catch (err) {
      throw new ServiceUnavailableException({
        status: "fail",
        db: err instanceof Error ? err.message : "unknown",
      });
    }
    return { status: "ok", db: "ok" };
  }
}
