/**
 * SQLite In-Memory: withDeleted relation-load 통합 테스트 (Issue #363)
 *
 * 최상위 쿼리의 `withDeleted` 플래그가 relation load(eager/lazy)에도 일관되게
 * 전파되는지 검증합니다.
 *
 * 검증 항목:
 *  - OneToMany: 기본은 soft-deleted 자식 제외, withDeleted:true는 포함
 *  - eager ManyToOne: 기본은 soft-deleted 부모 → null, withDeleted:true는 포함
 *  - lazy  ManyToOne: 기본은 soft-deleted 부모 → null, withDeleted:true는 포함
 *
 * 주의: SQLite는 ALTER TABLE ADD FOREIGN KEY 미지원 → synchronize: false +
 * 수동 CREATE TABLE 방식.
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
  ManyToOne,
  OneToMany,
  DeletedAt,
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import {
  ColumnScanner,
  ManyToOneScanner,
  OneToManyScanner,
} from "../../../src/scanner";
import { DatabaseClient } from "../../../src/DatabaseClient";

function shortTableName(prefix: string): string {
  const ts = String(Date.now()).slice(-7);
  return `${prefix}_${ts}`;
}

function clearScanners(): void {
  getScannerInstance(ColumnScanner).clear();
  getScannerInstance(ManyToOneScanner).clear();
  getScannerInstance(OneToManyScanner).clear();
}

/**
 * Parent(@DeletedAt) + Child(@DeletedAt, ManyToOne→Parent) 를 만든다.
 * @param lazy true면 Child.parent를 lazy로 선언한다.
 */
async function setupSoftDeleteRelations(lazy: boolean) {
  const parentTableName = shortTableName(lazy ? "sdlp" : "sdp");
  const childTableName = shortTableName(lazy ? "sdlc" : "sdc");

  let ParentClass: new () => any;
  let ChildClass: new () => any;

  const conn = await createTestConnection(
    {
      type: "sqlite",
      database: ":memory:",
      synchronize: false,
      logging: false,
    },
    () => {
      clearScanners();

      const PC = class {} as any;
      Object.defineProperty(PC, "name", {
        value: parentTableName,
        writable: false,
      });

      Reflect.defineMetadata("design:type", Number, PC.prototype, "id");
      PrimaryGeneratedColumn()(PC.prototype, "id");

      Reflect.defineMetadata("design:type", String, PC.prototype, "name");
      Column()(PC.prototype, "name");

      Reflect.defineMetadata("design:type", Date, PC.prototype, "deletedAt");
      DeletedAt()(PC.prototype, "deletedAt");

      Reflect.defineMetadata("design:type", Array, PC.prototype, "children");
      OneToMany(() => CC, { mappedBy: "parent" })(PC.prototype, "children");

      Entity()(PC);

      const CC = class {} as any;
      Object.defineProperty(CC, "name", {
        value: childTableName,
        writable: false,
      });

      Reflect.defineMetadata("design:type", Number, CC.prototype, "id");
      PrimaryGeneratedColumn()(CC.prototype, "id");

      Reflect.defineMetadata("design:type", String, CC.prototype, "title");
      Column()(CC.prototype, "title");

      Reflect.defineMetadata("design:type", Number, CC.prototype, "parentFk");
      Column({ type: "int", nullable: true })(CC.prototype, "parentFk");

      Reflect.defineMetadata("design:type", Date, CC.prototype, "deletedAt");
      DeletedAt()(CC.prototype, "deletedAt");

      Reflect.defineMetadata("design:type", PC, CC.prototype, "parent");
      ManyToOne(() => PC, (e: any) => e.parent, {
        joinColumn: "parentFk",
        eager: !lazy,
        lazy,
      })(CC.prototype, "parent");

      Entity()(CC);

      ParentClass = PC;
      ChildClass = CC;
      return { entities: [PC, CC] };
    },
  );

  const connector = DatabaseClient.getInstance().getConnection();
  await connector.query(`
    CREATE TABLE IF NOT EXISTS "${parentTableName}" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL DEFAULT '',
      "deletedAt" DATETIME
    )
  `);
  await connector.query(`
    CREATE TABLE IF NOT EXISTS "${childTableName}" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "title" TEXT NOT NULL DEFAULT '',
      "parentFk" INTEGER,
      "deletedAt" DATETIME,
      FOREIGN KEY ("parentFk") REFERENCES "${parentTableName}"("id")
    )
  `);

  return {
    conn,
    ParentClass: ParentClass!,
    ChildClass: ChildClass!,
    parentTableName,
    childTableName,
  };
}

// ─────────────────────────────────────────────────────────
// OneToMany + eager ManyToOne
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite: withDeleted → relation loads (OneToMany / eager ManyToOne)", () => {
  let conn: TestConnectionResult;
  let ParentClass: new () => any;
  let ChildClass: new () => any;

  beforeAll(async () => {
    const setup = await setupSoftDeleteRelations(false);
    conn = setup.conn;
    ParentClass = setup.ParentClass;
    ChildClass = setup.ChildClass;
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("OneToMany: 기본 조회는 soft-deleted 자식을 제외한다", async () => {
    const { em } = conn;
    const parent = await em.save(ParentClass, { name: "P-otm-default" });
    const c1 = await em.save(ChildClass, { title: "alive", parentFk: parent.id });
    const c2 = await em.save(ChildClass, { title: "trashed", parentFk: parent.id });
    await em.softDelete(ChildClass, { id: c2.id } as any);

    const found = await em.find(ParentClass, {
      where: { id: parent.id } as any,
      relations: ["children"] as any,
    });

    expect(found.length).toBe(1);
    const titles = found[0].children.map((c: any) => c.title);
    expect(titles).toEqual(["alive"]);
    expect(found[0].children.map((c: any) => c.id)).not.toContain(c2.id);
    void c1;
  });

  it("OneToMany: withDeleted:true는 soft-deleted 자식까지 포함한다", async () => {
    const { em } = conn;
    const parent = await em.save(ParentClass, { name: "P-otm-withdel" });
    await em.save(ChildClass, { title: "alive2", parentFk: parent.id });
    const trashed = await em.save(ChildClass, { title: "trashed2", parentFk: parent.id });
    await em.softDelete(ChildClass, { id: trashed.id } as any);

    const found = await em.find(ParentClass, {
      where: { id: parent.id } as any,
      withDeleted: true,
      relations: ["children"] as any,
    } as any);

    expect(found.length).toBe(1);
    const titles = found[0].children.map((c: any) => c.title).sort();
    expect(titles).toEqual(["alive2", "trashed2"]);
  });

  it("eager ManyToOne: soft-deleted 부모는 기본 조회 시 null로 표시된다", async () => {
    const { em } = conn;
    const parent = await em.save(ParentClass, { name: "P-m2o-default" });
    const child = await em.save(ChildClass, { title: "child-default", parentFk: parent.id });
    await em.softDelete(ParentClass, { id: parent.id } as any);

    const found = await em.findOne(ChildClass, {
      where: { id: child.id } as any,
    });

    expect(found).toBeDefined();
    expect(found!.parent).toBeNull();
  });

  it("eager ManyToOne: withDeleted:true는 soft-deleted 부모를 포함한다", async () => {
    const { em } = conn;
    const parent = await em.save(ParentClass, { name: "P-m2o-withdel" });
    const child = await em.save(ChildClass, { title: "child-withdel", parentFk: parent.id });
    await em.softDelete(ParentClass, { id: parent.id } as any);

    const found = await em.findOne(ChildClass, {
      where: { id: child.id } as any,
      withDeleted: true,
    } as any);

    expect(found).toBeDefined();
    expect(found!.parent).toBeDefined();
    expect(found!.parent).not.toBeNull();
    expect(found!.parent.name).toBe("P-m2o-withdel");
  });

  it("eager ManyToOne: 부모가 살아있으면 기본 조회에서 부모는 그대로 로드된다", async () => {
    const { em } = conn;
    const parent = await em.save(ParentClass, { name: "P-m2o-alive" });
    const child = await em.save(ChildClass, { title: "child-alive", parentFk: parent.id });

    const found = await em.findOne(ChildClass, {
      where: { id: child.id } as any,
    });

    expect(found).toBeDefined();
    expect(found!.parent).not.toBeNull();
    expect(found!.parent.name).toBe("P-m2o-alive");
  });
});

// ─────────────────────────────────────────────────────────
// lazy ManyToOne
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite: withDeleted → relation loads (lazy ManyToOne)", () => {
  let conn: TestConnectionResult;
  let ParentClass: new () => any;
  let ChildClass: new () => any;

  beforeAll(async () => {
    const setup = await setupSoftDeleteRelations(true);
    conn = setup.conn;
    ParentClass = setup.ParentClass;
    ChildClass = setup.ChildClass;
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("lazy ManyToOne: soft-deleted 부모는 기본 조회 시 null로 해석된다", async () => {
    const { em } = conn;
    const parent = await em.save(ParentClass, { name: "LP-default" });
    const child = await em.save(ChildClass, { title: "lazy-default", parentFk: parent.id });
    await em.softDelete(ParentClass, { id: parent.id } as any);

    const found = await em.findOne(ChildClass, {
      where: { id: child.id } as any,
    });

    expect(found).toBeDefined();
    const resolved = await (found as any).parent;
    expect(resolved ?? null).toBeNull();
  });

  it("lazy ManyToOne: withDeleted:true는 soft-deleted 부모를 해석한다", async () => {
    const { em } = conn;
    const parent = await em.save(ParentClass, { name: "LP-withdel" });
    const child = await em.save(ChildClass, { title: "lazy-withdel", parentFk: parent.id });
    await em.softDelete(ParentClass, { id: parent.id } as any);

    const found = await em.findOne(ChildClass, {
      where: { id: child.id } as any,
      withDeleted: true,
    } as any);

    expect(found).toBeDefined();
    const resolved = await (found as any).parent;
    expect(resolved).toBeDefined();
    expect(resolved).not.toBeNull();
    expect(resolved.name).toBe("LP-withdel");
  });
});
