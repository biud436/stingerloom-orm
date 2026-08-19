/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Which manager `StingerloomOrmService` shuts down, and with what options
 * (V4-T2-2).
 *
 * The pool-release behaviour itself is verified against a real application in
 * `__tests__/integration/sqlite/nestjs-shutdown-pool-release.test.ts`; this
 * suite pins the dispatch rules that are awkward to observe there — the
 * `forRootAsync` misuse sentinel, and what a failed shutdown reports.
 */
import "reflect-metadata";
import { StingerloomOrmService } from "../../src/integration/nestjs/stingerloom-orm.service";
import { StingerloomOrmCoreModule } from "../../src/integration/nestjs/stingerloom-orm-core.module";
import { MultiTenantEntityManager } from "../../src/core/MultiTenantEntityManager";

function makeEntityManager() {
  return {
    propagateShutdown: jest.fn().mockResolvedValue(true),
    getRepository: jest.fn(),
  } as any;
}

/** The value `forRootAsync` provides for the MTEM token on a non-database connection. */
async function makeMisuseSentinel(): Promise<MultiTenantEntityManager> {
  const dyn = StingerloomOrmCoreModule.forRootAsync({
    useFactory: () => ({
      type: "sqlite" as const,
      database: ":memory:",
      entities: [],
    }),
  });
  const provider = (dyn.providers as any[]).find(
    (p) => p.provide === MultiTenantEntityManager,
  );
  return provider.useFactory({
    type: "sqlite",
    database: ":memory:",
    entities: [],
  });
}

describe("StingerloomOrmService shutdown dispatch", () => {
  it("asks the EntityManager to close its connection", async () => {
    const em = makeEntityManager();

    await new StingerloomOrmService(em).onApplicationShutdown();

    expect(em.propagateShutdown).toHaveBeenCalledWith({
      closeConnections: true,
    });
  });

  it("delegates to the MultiTenantEntityManager when one is provided", async () => {
    const em = makeEntityManager();
    const mtem = new MultiTenantEntityManager();
    const mtemShutdown = jest
      .spyOn(mtem, "propagateShutdown")
      .mockResolvedValue(true);

    await new StingerloomOrmService(em, mtem).onApplicationShutdown();

    // MTEM owns the tenant EntityManagers and shuts its own default EM down;
    // going through the EntityManager token would close only the admin pool.
    expect(mtemShutdown).toHaveBeenCalledWith({ closeConnections: true });
    expect(em.propagateShutdown).not.toHaveBeenCalled();
  });

  it("ignores the forRootAsync misuse sentinel and uses the EntityManager", async () => {
    const em = makeEntityManager();
    const sentinel = await makeMisuseSentinel();

    await new StingerloomOrmService(em, sentinel).onApplicationShutdown();

    expect(em.propagateShutdown).toHaveBeenCalledWith({
      closeConnections: true,
    });
  });

  it("reports a failed shutdown instead of logging a clean disconnect", async () => {
    const em = makeEntityManager();
    em.propagateShutdown.mockRejectedValue(new Error("pool is stuck"));
    const service = new StingerloomOrmService(em, undefined, "analytics");
    const error = jest
      .spyOn((service as any).logger, "error")
      .mockImplementation(() => undefined);
    const info = jest
      .spyOn((service as any).logger, "info")
      .mockImplementation(() => undefined);

    // The failure still reaches `app.close()`; the log is what makes it
    // readable when the process is already on its way down.
    await expect(service.onApplicationShutdown()).rejects.toThrow(
      "pool is stuck",
    );

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("shutdown failed"),
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining("pool is stuck"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("analytics"));
    expect(info).not.toHaveBeenCalledWith(
      expect.stringContaining("disconnected"),
    );
  });

  it("names the connection in the disconnect log", async () => {
    const service = new StingerloomOrmService(
      makeEntityManager(),
      undefined,
      "analytics",
    );
    const info = jest
      .spyOn((service as any).logger, "info")
      .mockImplementation(() => undefined);

    await service.onApplicationShutdown();

    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('disconnected (connection "analytics")'),
    );
  });
});
