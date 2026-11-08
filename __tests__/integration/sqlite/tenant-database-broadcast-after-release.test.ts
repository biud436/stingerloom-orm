/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * tenantStrategy "database": a tenant whose EntityManager was released (by
 * the idle TTL or explicitly) and is resolved again gets a new
 * EntityManager, and the plugins, event listeners and subscribers registered
 * on the MultiTenantEntityManager must reach it too (SQLite :memory:).
 */

import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { MultiTenantEntityManager } from "../../../src/core/MultiTenantEntityManager";
import { EntitySubscriber } from "../../../src/core/EntitySubscriber";
import type { StingerloomPlugin } from "../../../src/core/plugin/StingerloomPlugin";

@Entity({ name: "tbr_user" })
class BroadcastUser {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

const sqliteOpts = () => ({
  type: "sqlite" as const,
  database: ":memory:",
  entities: [BroadcastUser],
  synchronize: true as const,
  logging: false,
});

async function makeMtem(override: Record<string, any> = {}) {
  const mtem = new MultiTenantEntityManager();
  await mtem.register({
    ...sqliteOpts(),
    tenantStrategy: "database",
    tenantDatabaseResolver: () => sqliteOpts(),
    ...override,
  });

  const fired = { subscriber: [] as string[], listener: [] as string[], installs: 0 };
  const subscriber: EntitySubscriber<BroadcastUser> = {
    listenTo: () => BroadcastUser,
    afterInsert: async (event: { entity: Partial<BroadcastUser> }) => {
      fired.subscriber.push(String(event.entity.name));
    },
  } as any;
  const plugin: StingerloomPlugin = {
    name: "install-counter",
    install() {
      fired.installs++;
    },
  };
  mtem.addSubscriber(subscriber);
  mtem.on("afterInsert", (payload) => {
    fired.listener.push(String((payload.data as any).name));
  });
  mtem.extend(plugin);
  return { mtem, fired };
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("[Integration] SQLite: tenant broadcasts after the tenant is released", () => {
  afterEach(async () => {
    MetadataContext.reset();
    await DatabaseClient.getInstance().close();
  });

  it("replays plugins, listeners and subscribers on the EntityManager of a released tenant", async () => {
    const { mtem, fired } = await makeMtem();
    const installsOnDefault = fired.installs;

    await MetadataContext.run("acme", () => mtem.save(BroadcastUser, { name: "before" }));
    const first = await MetadataContext.run("acme", () => mtem.pickEm());
    await mtem.getRouter().release("acme");
    await MetadataContext.run("acme", () => mtem.save(BroadcastUser, { name: "after" }));
    const second = await MetadataContext.run("acme", () => mtem.pickEm());

    expect(second).not.toBe(first);
    expect(fired.subscriber).toEqual(["before", "after"]);
    expect(fired.listener).toEqual(["before", "after"]);
    expect(fired.installs - installsOnDefault).toBe(2);
    await mtem.propagateShutdown({ closeConnections: true });
  });

  it("replays them after the idle TTL released the tenant", async () => {
    const { mtem, fired } = await makeMtem({ tenantConnectionTtlMs: 30 });

    await MetadataContext.run("acme", () => mtem.save(BroadcastUser, { name: "before" }));
    await waitFor(() => mtem.getRouter().getAll().length === 0, 2000);
    await MetadataContext.run("acme", () => mtem.save(BroadcastUser, { name: "after" }));

    expect(fired.subscriber).toEqual(["before", "after"]);
    expect(fired.listener).toEqual(["before", "after"]);
    await mtem.propagateShutdown({ closeConnections: true });
  });

  it("applies them once to an EntityManager that stays resolved", async () => {
    const { mtem, fired } = await makeMtem();

    for (const name of ["a", "b", "c"]) {
      await MetadataContext.run("acme", () => mtem.save(BroadcastUser, { name }));
    }

    expect(fired.subscriber).toEqual(["a", "b", "c"]);
    expect(fired.listener).toEqual(["a", "b", "c"]);
    await mtem.propagateShutdown({ closeConnections: true });
  });
});
