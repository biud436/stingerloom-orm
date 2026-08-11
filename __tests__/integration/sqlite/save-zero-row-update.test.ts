/**
 * SQLite In-Memory: save() must not report a 0-row UPDATE as success (V4-T0-2 b).
 *
 * Before the fix, saving an entity whose primary key matched no row ran an
 * UPDATE affecting 0 rows, then still fired afterUpdate hooks/events/
 * subscribers and returned the re-fetch result (null) cast as T — a silent
 * no-op with ghost events. The affected-rows check existed only inside the
 * @Version branch (OptimisticLockError).
 *
 * The value-identical update case matters for MySQL, where affectedRows can
 * be 0 even though the row exists — the fix probes for row existence before
 * failing, so an unchanged save stays a success on every driver.
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
} from "../../../src";
import { EntityNotFoundError } from "../../../src/errors/EntityNotFoundError";
import type { EntitySubscriber } from "../../../src/core/EntitySubscriber";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";

describe("[Integration] SQLite: save() 0-row UPDATE", () => {
  let conn: TestConnectionResult;
  let User: any;
  const table = `zero_row_upd_${String(Date.now()).slice(-6)}`;

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        MetadataLayerRegistry.reset();
        getScannerInstance(ColumnScanner).clear();

        @Entity({ name: table })
        class UserEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() name!: string;
        }

        User = UserEntity;
        return { entities: [UserEntity] };
      },
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  const registered: EntitySubscriber<any>[] = [];
  function subscribe(sub: EntitySubscriber<any>): void {
    conn.em.addSubscriber(sub);
    registered.push(sub);
  }

  afterEach(() => {
    while (registered.length) conn.em.removeSubscriber(registered.pop()!);
  });

  beforeEach(async () => {
    await conn.em.query(`DELETE FROM "${table}"`);
  });

  it("존재하지 않는 PK로 save() → EntityNotFoundError (수정 전: null 반환 무음 성공)", async () => {
    await expect(
      conn.em.save(User, { id: 9999, name: "ghost" }),
    ).rejects.toThrow(EntityNotFoundError);
  });

  it("존재하지 않는 PK로 save() 시 afterUpdate 훅/구독자가 발화하면 안 된다 (수정 전: 유령 이벤트 발화)", async () => {
    const fired: string[] = [];
    subscribe({
      listenTo: () => User,
      afterUpdate: () => { fired.push("afterUpdate"); },
    });

    await conn.em.save(User, { id: 9999, name: "ghost" }).catch(() => undefined);

    expect(fired).toEqual([]);
  });

  it("값이 그대로인 save()는 여전히 성공해야 한다 (존재 프로브 — MySQL affectedRows 0 케이스)", async () => {
    const saved: any = await conn.em.save(User, { name: "same" });

    const result: any = await conn.em.save(User, { id: saved.id, name: "same" });

    expect(result).toMatchObject({ id: saved.id, name: "same" });
  });

  it("무회귀: 정상 UPDATE는 성공하고 afterUpdate가 1회 발화한다", async () => {
    const saved: any = await conn.em.save(User, { name: "before" });

    const fired: string[] = [];
    subscribe({
      listenTo: () => User,
      afterUpdate: () => { fired.push("afterUpdate"); },
    });

    const result: any = await conn.em.save(User, { id: saved.id, name: "after" });

    expect(result).toMatchObject({ id: saved.id, name: "after" });
    expect(fired).toEqual(["afterUpdate"]);
  });
});
