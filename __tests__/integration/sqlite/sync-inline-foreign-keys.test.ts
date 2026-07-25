/**
 * SQLite In-Memory: synchronize:true + FK 관계 통합 테스트
 *
 * SQLite는 ALTER TABLE ADD FOREIGN KEY를 지원하지 않아, 이전에는 FK가 있는
 * 관계(@ManyToOne / @OneToOne / @ManyToMany, defineEntity 포함)로
 * synchronize:true 부팅 시 UNSUPPORTED_OPERATION으로 크래시했습니다
 * (모든 기존 테스트가 createForeignKeyConstraints: false로 우회).
 *
 * 이제 supportsAlterAddForeignKey=false 다이얼렉트는 FK를 CREATE TABLE에
 * 인라인으로 임베드합니다. 검증 항목:
 * - defineEntity manyToOne → PRAGMA foreign_key_list에 FK + ON DELETE 액션
 * - 데코레이터 @ManyToOne / @OneToOne (createForeignKeyConstraints 생략) 부팅
 * - ManyToMany 조인 테이블 FK 인라인 생성
 * - 선언되지 않은 joinColumn 자동 추가 + FK
 * - createForeignKeyConstraints: false → FK 미생성 유지
 * - 동일 파일 DB 재부팅(테이블 존재) 시 크래시 없음
 */
import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToOne,
  ManyToMany,
} from "../../../src";
import { defineEntity, t } from "../../../src/schema";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import {
  ColumnScanner,
  ManyToOneScanner,
  OneToManyScanner,
  ManyToManyScanner,
} from "../../../src/scanner";
import { OneToOneScanner } from "../../../src/scanner/OneToOneScanner";

function clearScanners(): void {
  getScannerInstance(ColumnScanner).clear();
  getScannerInstance(ManyToOneScanner).clear();
  getScannerInstance(OneToManyScanner).clear();
  getScannerInstance(ManyToManyScanner).clear();
  getScannerInstance(OneToOneScanner).clear();
}

interface FkRow {
  table: string;
  from: string;
  to: string;
  on_delete: string;
  on_update: string;
}

async function fkList(
  conn: TestConnectionResult,
  table: string,
): Promise<FkRow[]> {
  return (await conn.em.query(
    `PRAGMA foreign_key_list("${table}")`,
  )) as FkRow[];
}

describe("[Integration] SQLite: synchronize inline FK — defineEntity", () => {
  let conn: TestConnectionResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Author: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Post: any;

  beforeAll(async () => {
    conn = await createTestConnection(
      { type: "sqlite", database: ":memory:", synchronize: true, logging: false },
      () => {
        // defineEntity must run inside the factory: createTestConnection
        // resets the scanner container before invoking it, which would wipe
        // registrations made at module load time.
        Author = defineEntity("ifk_authors", {
          id: t.int().primary().generated(),
          name: t.varchar(100),
        });
        Post = defineEntity("ifk_posts", {
          id: t.int().primary().generated(),
          title: t.varchar(200),
          authorId: t.int().nullable(),
          author: t.manyToOne(() => Author, {
            joinColumn: "authorId",
            onDelete: "CASCADE",
          }),
        });
        const Tag = defineEntity("ifk_tags", {
          id: t.int().primary().generated(),
          label: t.varchar(50),
          posts: t.manyToMany(() => Post, {
            joinTable: {
              name: "ifk_post_tags",
              joinColumn: "tag_id",
              inverseJoinColumn: "post_id",
            },
          }),
        });
        return { entities: [Author, Post, Tag] };
      },
    );
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("boots with FK-bearing relations without createForeignKeyConstraints: false", async () => {
    const tables = (await conn.em.query(
      "SELECT name FROM sqlite_master WHERE type='table'",
    )) as Array<{ name: string }>;
    const names = tables.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(["ifk_authors", "ifk_posts", "ifk_tags", "ifk_post_tags"]),
    );
  });

  it("embeds the ManyToOne FK with its ON DELETE action", async () => {
    const fks = await fkList(conn, "ifk_posts");
    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatchObject({
      table: "ifk_authors",
      from: "authorId",
      to: "id",
      on_delete: "CASCADE",
    });
  });

  it("embeds both join-table FKs for ManyToMany", async () => {
    const fks = await fkList(conn, "ifk_post_tags");
    const byFrom = Object.fromEntries(fks.map((f) => [f.from, f]));
    expect(byFrom["tag_id"]).toMatchObject({
      table: "ifk_tags",
      to: "id",
      on_delete: "CASCADE",
    });
    expect(byFrom["post_id"]).toMatchObject({
      table: "ifk_posts",
      to: "id",
      on_delete: "CASCADE",
    });
  });

  it("performs CRUD with eager relation loading through the FK", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const author: any = await conn.em.save(Author, { name: "Kim" });
    await conn.em.save(Post, { title: "hello", authorId: author.id });
    const posts = await conn.em.find(Post, {
      where: {},
      relations: ["author"],
    });
    expect(posts).toHaveLength(1);
    expect((posts[0] as { author?: { name?: string } }).author?.name).toBe("Kim");
  });
});

describe("[Integration] SQLite: synchronize inline FK — decorators", () => {
  let conn: TestConnectionResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Country: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let City: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Capital: any;

  beforeAll(async () => {
    conn = await createTestConnection(
      { type: "sqlite", database: ":memory:", synchronize: true, logging: false },
      () => {
        clearScanners();

        @Entity({ name: "ifk_countries" })
        class CountryEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() name!: string;
        }

        @Entity({ name: "ifk_cities" })
        class CityEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() name!: string;
          @Column({ type: "int", nullable: true }) countryId!: number;
          // No createForeignKeyConstraints: false — the FK must be created.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          @ManyToOne(() => CountryEntity, (e: any) => e.country, {
            joinColumn: "countryId",
          })
          country!: CountryEntity;
        }

        @Entity({ name: "ifk_capitals" })
        class CapitalEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() name!: string;
          // joinColumn is NOT declared as an entity column — schema sync must
          // create the column together with the table so the FK can bind.
          @OneToOne(() => CountryEntity, { joinColumn: "countryRef" })
          country!: CountryEntity;
        }

        Country = CountryEntity;
        City = CityEntity;
        Capital = CapitalEntity;
        return { entities: [CountryEntity, CityEntity, CapitalEntity] };
      },
    );
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("creates the ManyToOne FK for a declared join column", async () => {
    const fks = await fkList(conn, "ifk_cities");
    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatchObject({
      table: "ifk_countries",
      from: "countryId",
      to: "id",
    });
  });

  it("auto-adds an undeclared join column and binds the OneToOne FK to it", async () => {
    const cols = (await conn.em.query(
      `PRAGMA table_info("ifk_capitals")`,
    )) as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("countryRef");

    const fks = await fkList(conn, "ifk_capitals");
    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatchObject({
      table: "ifk_countries",
      from: "countryRef",
      to: "id",
    });
  });

  it("writes and eager-loads through the FK", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const country: any = await conn.em.save(Country, { name: "KR" });
    await conn.em.save(City, { name: "Seoul", countryId: country.id });
    const cities = await conn.em.find(City, { where: {}, relations: ["country"] });
    expect(cities).toHaveLength(1);
    expect(cities[0].country?.name).toBe("KR");
  });
});

describe("[Integration] SQLite: synchronize inline FK — opt-out and reboot", () => {
  const dbFile = path.join(
    os.tmpdir(),
    `stingerloom-ifk-${process.pid}-${Date.now()}.sqlite`,
  );

  afterAll(() => {
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeEntities(): { entities: any[] } {
    clearScanners();

    @Entity({ name: "ifk_ro_users" })
    class UserEntity {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
    }

    @Entity({ name: "ifk_ro_notes" })
    class NoteEntity {
      @PrimaryGeneratedColumn() id!: number;
      @Column() body!: string;
      @Column({ type: "int", nullable: true }) userId!: number;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      @ManyToOne(() => UserEntity, (e: any) => e.user, {
        joinColumn: "userId",
        createForeignKeyConstraints: false,
      })
      user!: UserEntity;
    }

    return { entities: [UserEntity, NoteEntity] };
  }

  it("createForeignKeyConstraints: false still skips FK creation", async () => {
    const conn = await createTestConnection(
      { type: "sqlite", database: dbFile, synchronize: true, logging: false },
      makeEntities,
    );
    try {
      const fks = await fkList(conn, "ifk_ro_notes");
      expect(fks).toHaveLength(0);
    } finally {
      await conn.cleanup();
    }
  });

  it("re-registering against existing tables does not crash", async () => {
    const conn = await createTestConnection(
      { type: "sqlite", database: dbFile, synchronize: true, logging: false },
      makeEntities,
    );
    try {
      const rows = (await conn.em.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ifk_ro_notes'",
      )) as Array<{ name: string }>;
      expect(rows).toHaveLength(1);
    } finally {
      await conn.cleanup();
    }
  });
});
