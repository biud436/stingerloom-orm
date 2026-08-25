/**
 * SQLite In-Memory: WriteBuffer — ambient 트랜잭션 롤백 후 in-memory 상태 정합.
 *
 * flush()가 바깥 em.transaction()에 조인(REQUIRED)해 성공한 뒤, 그 바깥
 * 트랜잭션이 롤백되면 DB 행은 사라진다. 이때 버퍼의 identity map /
 * tracked 상태 / 인스턴스에 write-back된 생성 PK가 남아 있으면:
 *
 *   - buf.findOne(PK)가 존재하지 않는 행을 캐시에서 반환 (팬텀 리드)
 *   - 인스턴스가 PK를 유지해 재시도 시 INSERT가 아닌 것으로 오분류
 *
 * 계약: 조인한 트랜잭션이 롤백되면 flush 실패와 동일하게 in-memory
 * 상태를 복원한다 (컬럼 상태 복원 + 1차 캐시 전체 무효화).
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { Entity, Column, PrimaryGeneratedColumn } from "../../../src";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe("[Integration] SQLite: WriteBuffer ambient 롤백 후 1차 캐시 정합", () => {
  let conn: TestConnectionResult;
  let BufUser: new () => any;
  const userTable = shortName("bar_user");

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
        plugins: [bufferPlugin()],
      },
      () => {
        getScannerInstance(ColumnScanner).clear();

        @Entity({ name: userTable })
        class BufUserEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() name!: string;
        }

        BufUser = BufUserEntity;
        return { entities: [BufUserEntity] };
      },
    );
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("조인한 바깥 트랜잭션 롤백 후 findOne이 팬텀 엔티티를 반환하지 않는다", async () => {
    const em = conn.em;
    const buf: WriteBuffer = (em as any).buffer();

    const u = new BufUser() as any;
    u.name = "ghost";
    let pk: number | undefined;

    await expect(
      em.transaction(async () => {
        buf.persist(u);
        await buf.flush(); // ambient 트랜잭션에 조인 — 여기서는 성공
        pk = u.id;
        expect(pk).toBeDefined();
        throw new Error("force outer rollback");
      }),
    ).rejects.toThrow("force outer rollback");

    // DB에는 행이 없다 (트랜잭션 롤백)
    const dbRow = await em.findOne(BufUser, { where: { id: pk } } as any);
    expect(dbRow).toBeNull();

    // 1차 캐시도 팬텀을 반환해서는 안 된다
    const cached = await buf.findOne(BufUser, { where: { id: pk } } as any);
    expect(cached).toBeNull();
  });

  it("롤백 후 인스턴스의 write-back된 생성 PK가 복원된다 (재시도 = INSERT)", async () => {
    const em = conn.em;
    const buf: WriteBuffer = (em as any).buffer();

    const u = new BufUser() as any;
    u.name = "retry-me";

    await expect(
      em.transaction(async () => {
        buf.persist(u);
        await buf.flush();
        expect(u.id).toBeDefined();
        throw new Error("force outer rollback");
      }),
    ).rejects.toThrow("force outer rollback");

    // flush 실패 경로와 동일한 계약: PK write-back이 복원되어야
    // 재시도 워크플로우(다시 persist → flush)가 INSERT로 동작한다.
    expect(u.id ?? undefined).toBeUndefined();

    const buf2: WriteBuffer = (em as any).buffer();
    buf2.persist(u);
    await buf2.flush();
    expect(u.id).toBeDefined();

    const dbRow: any = await em.findOne(BufUser, {
      where: { id: u.id },
    } as any);
    expect(dbRow?.name).toBe("retry-me");
  });

  it("커밋된 트랜잭션은 flush 결과를 그대로 유지한다 (sanity)", async () => {
    const em = conn.em;
    const buf: WriteBuffer = (em as any).buffer();

    const u = new BufUser() as any;
    u.name = "committed";

    await em.transaction(async () => {
      buf.persist(u);
      await buf.flush();
    });

    expect(u.id).toBeDefined();
    const cached: any = await buf.findOne(BufUser, {
      where: { id: u.id },
    } as any);
    expect(cached?.name).toBe("committed");
  });
});
