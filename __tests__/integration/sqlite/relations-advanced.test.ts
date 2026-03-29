/**
 * SQLite In-Memory 고급 관계(Relations) 통합 테스트
 *
 * EntityManager를 통한 ManyToOne/OneToMany eager/lazy 로딩,
 * cascade insert, OneToOne, deep relations,
 * nullable FK, empty collections 등을 검증합니다.
 *
 * 주의: SQLite는 ALTER TABLE ADD FOREIGN KEY를 지원하지 않으므로
 * synchronize: false + 수동 CREATE TABLE (inline FK) 방식 사용.
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
 * SQLite용 관계 엔티티를 생성하고 수동으로 테이블을 만드는 헬퍼.
 * synchronize: false로 연결 후, inline FK를 포함한 CREATE TABLE을 직접 실행합니다.
 */
async function setupRelationTest() {
  const parentTableName = shortTableName("rp");
  const childTableName = shortTableName("rc");

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

      // ParentClass
      const PC = class {} as any;
      Object.defineProperty(PC, "name", {
        value: parentTableName,
        writable: false,
      });

      Reflect.defineMetadata("design:type", Number, PC.prototype, "id");
      PrimaryGeneratedColumn()(PC.prototype, "id");

      Reflect.defineMetadata("design:type", String, PC.prototype, "name");
      Column()(PC.prototype, "name");

      Reflect.defineMetadata("design:type", Array, PC.prototype, "children");
      OneToMany(() => CC, { mappedBy: "parent" })(PC.prototype, "children");

      Entity()(PC);

      // ChildClass
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

      Reflect.defineMetadata("design:type", PC, CC.prototype, "parent");
      ManyToOne(() => PC, (e: any) => e.parent, {
        joinColumn: "parentFk",
        eager: true,
      })(CC.prototype, "parent");

      Entity()(CC);

      ParentClass = PC;
      ChildClass = CC;
      return { entities: [PC, CC] };
    },
  );

  // 수동 CREATE TABLE (inline FK)
  const connector = DatabaseClient.getInstance().getConnection();
  await connector.query(`
    CREATE TABLE IF NOT EXISTS "${parentTableName}" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL DEFAULT ''
    )
  `);
  await connector.query(`
    CREATE TABLE IF NOT EXISTS "${childTableName}" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "title" TEXT NOT NULL DEFAULT '',
      "parentFk" INTEGER,
      FOREIGN KEY ("parentFk") REFERENCES "${parentTableName}"("id") ON DELETE CASCADE
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
// ManyToOne / OneToMany
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite In-Memory: ManyToOne / OneToMany", () => {
  let conn: TestConnectionResult;
  let ParentClass: new () => any;
  let ChildClass: new () => any;

  beforeAll(async () => {
    const setup = await setupRelationTest();
    conn = setup.conn;
    ParentClass = setup.ParentClass;
    ChildClass = setup.ChildClass;
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("should save parent and child with FK", async () => {
    const { em } = conn;

    const parent = await em.save(ParentClass, { name: "Parent1" });
    expect(parent.id).toBeDefined();

    const child = await em.save(ChildClass, {
      title: "Child1",
      parentFk: parent.id,
    });
    expect(child.id).toBeDefined();
    expect(child.parentFk).toBe(parent.id);
  });

  it("should eager-load parent when finding child (ManyToOne eager=true)", async () => {
    const { em } = conn;

    const parent = await em.save(ParentClass, { name: "EagerParent" });
    await em.save(ChildClass, {
      title: "EagerChild",
      parentFk: parent.id,
    });

    const children = await em.find(ChildClass, {
      where: { title: "EagerChild" } as any,
    });

    expect(children.length).toBe(1);
    expect(children[0].parent).toBeDefined();
    expect(children[0].parent.name).toBe("EagerParent");
  });

  it("should load children via relations option (OneToMany)", async () => {
    const { em } = conn;

    const parent = await em.save(ParentClass, { name: "RelParent" });
    await em.save(ChildClass, { title: "RelChild1", parentFk: parent.id });
    await em.save(ChildClass, { title: "RelChild2", parentFk: parent.id });

    const parents = await em.find(ParentClass, {
      where: { name: "RelParent" } as any,
      relations: ["children"] as any,
    });

    expect(parents.length).toBe(1);
    expect(parents[0].children).toBeDefined();
    expect(parents[0].children.length).toBe(2);
  });

  it("should return empty array for parent with no children", async () => {
    const { em } = conn;

    await em.save(ParentClass, { name: "Lonely" });

    const parents = await em.find(ParentClass, {
      where: { name: "Lonely" } as any,
      relations: ["children"] as any,
    });

    expect(parents.length).toBe(1);
    expect(parents[0].children).toEqual([]);
  });

  it("should handle nullable FK (child with no parent)", async () => {
    const { em } = conn;

    await em.save(ChildClass, {
      title: "Orphan",
      parentFk: null,
    } as any);

    const found = await em.find(ChildClass, {
      where: { title: "Orphan" } as any,
    });

    expect(found.length).toBe(1);
    expect(found[0].parent).toBeNull();
  });

  it("findOne should return null for non-existent id", async () => {
    const { em } = conn;

    const result = await em.findOne(ParentClass, {
      where: { id: 999999 } as any,
    });

    expect(result).toBeNull();
  });

  it("should return correct count of children for each parent", async () => {
    const { em } = conn;

    const p1 = await em.save(ParentClass, { name: "Multi1" });
    const p2 = await em.save(ParentClass, { name: "Multi2" });

    await em.save(ChildClass, { title: "MC1", parentFk: p1.id });
    await em.save(ChildClass, { title: "MC2", parentFk: p1.id });
    await em.save(ChildClass, { title: "MC3", parentFk: p1.id });
    await em.save(ChildClass, { title: "MC4", parentFk: p2.id });

    const parents = await em.find(ParentClass, {
      where: { name: { in: ["Multi1", "Multi2"] } } as any,
      relations: ["children"] as any,
      orderBy: { name: "ASC" } as any,
    });

    expect(parents.length).toBe(2);
    expect(parents[0].children.length).toBe(3);
    expect(parents[1].children.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────
// OneToOne (via ManyToOne pattern)
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite In-Memory: OneToOne", () => {
  let conn: TestConnectionResult;
  let UserClass: new () => any;
  let ProfileClass: new () => any;

  beforeAll(async () => {
    const userTable = shortTableName("oo_u");
    const profileTable = shortTableName("oo_p");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: false,
        logging: false,
      },
      () => {
        clearScanners();

        const UC = class {} as any;
        Object.defineProperty(UC, "name", {
          value: userTable,
          writable: false,
        });

        Reflect.defineMetadata("design:type", Number, UC.prototype, "id");
        PrimaryGeneratedColumn()(UC.prototype, "id");

        Reflect.defineMetadata("design:type", String, UC.prototype, "name");
        Column()(UC.prototype, "name");

        Entity()(UC);

        const PC = class {} as any;
        Object.defineProperty(PC, "name", {
          value: profileTable,
          writable: false,
        });

        Reflect.defineMetadata("design:type", Number, PC.prototype, "id");
        PrimaryGeneratedColumn()(PC.prototype, "id");

        Reflect.defineMetadata("design:type", String, PC.prototype, "bio");
        Column({ nullable: true })(PC.prototype, "bio");

        Reflect.defineMetadata("design:type", Number, PC.prototype, "userFk");
        Column({ type: "int", nullable: true })(PC.prototype, "userFk");

        Reflect.defineMetadata("design:type", UC, PC.prototype, "user");
        ManyToOne(() => UC, (e: any) => e.user, {
          joinColumn: "userFk",
          eager: true,
        })(PC.prototype, "user");

        Entity()(PC);

        UserClass = UC;
        ProfileClass = PC;
        return { entities: [UC, PC] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${userTable}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "name" TEXT NOT NULL DEFAULT ''
      )
    `);
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${profileTable}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "bio" TEXT,
        "userFk" INTEGER,
        FOREIGN KEY ("userFk") REFERENCES "${userTable}"("id")
      )
    `);
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("should save profile with user FK and eager-load user", async () => {
    const { em } = conn;

    const user = await em.save(UserClass, { name: "OneToOneUser" });
    await em.save(ProfileClass, { bio: "Hello world", userFk: user.id });

    const profiles = await em.find(ProfileClass, {
      where: { bio: "Hello world" } as any,
    });

    expect(profiles.length).toBe(1);
    expect(profiles[0].user).toBeDefined();
    expect(profiles[0].user.name).toBe("OneToOneUser");
  });

  it("should handle profile with null user FK", async () => {
    const { em } = conn;

    await em.save(ProfileClass, { bio: "No user", userFk: null } as any);

    const profiles = await em.find(ProfileClass, {
      where: { bio: "No user" } as any,
    });

    expect(profiles.length).toBe(1);
    expect(profiles[0].user).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// Deep relations (3-level chain)
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite In-Memory: Deep Relations (3-level)", () => {
  let conn: TestConnectionResult;
  let AuthorClass: new () => any;
  let PostClass: new () => any;
  let CommentClass: new () => any;

  beforeAll(async () => {
    const authorTable = shortTableName("da");
    const postTable = shortTableName("dp");
    const commentTable = shortTableName("dc");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: false,
        logging: false,
      },
      () => {
        clearScanners();

        // AuthorClass
        const AC = class {} as any;
        Object.defineProperty(AC, "name", {
          value: authorTable,
          writable: false,
        });

        Reflect.defineMetadata("design:type", Number, AC.prototype, "id");
        PrimaryGeneratedColumn()(AC.prototype, "id");

        Reflect.defineMetadata("design:type", String, AC.prototype, "name");
        Column()(AC.prototype, "name");

        // PostClass
        const PC = class {} as any;
        Object.defineProperty(PC, "name", {
          value: postTable,
          writable: false,
        });

        Reflect.defineMetadata("design:type", Number, PC.prototype, "id");
        PrimaryGeneratedColumn()(PC.prototype, "id");

        Reflect.defineMetadata("design:type", String, PC.prototype, "title");
        Column()(PC.prototype, "title");

        Reflect.defineMetadata("design:type", Number, PC.prototype, "authorFk");
        Column({ type: "int", nullable: true })(PC.prototype, "authorFk");

        // CommentClass
        const CC = class {} as any;
        Object.defineProperty(CC, "name", {
          value: commentTable,
          writable: false,
        });

        Reflect.defineMetadata("design:type", Number, CC.prototype, "id");
        PrimaryGeneratedColumn()(CC.prototype, "id");

        Reflect.defineMetadata("design:type", String, CC.prototype, "body");
        Column()(CC.prototype, "body");

        Reflect.defineMetadata("design:type", Number, CC.prototype, "postFk");
        Column({ type: "int", nullable: true })(CC.prototype, "postFk");

        // Relations
        Reflect.defineMetadata("design:type", PC, CC.prototype, "post");
        ManyToOne(() => PC, (e: any) => e.post, {
          joinColumn: "postFk",
          eager: true,
        })(CC.prototype, "post");

        Reflect.defineMetadata("design:type", AC, PC.prototype, "author");
        ManyToOne(() => AC, (e: any) => e.author, {
          joinColumn: "authorFk",
          eager: true,
        })(PC.prototype, "author");

        Reflect.defineMetadata("design:type", Array, AC.prototype, "posts");
        OneToMany(() => PC, { mappedBy: "author" })(AC.prototype, "posts");

        Entity()(AC);
        Entity()(PC);
        Entity()(CC);

        AuthorClass = AC;
        PostClass = PC;
        CommentClass = CC;
        return { entities: [AC, PC, CC] };
      },
    );

    // 수동 CREATE TABLE
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${authorTable}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "name" TEXT NOT NULL DEFAULT ''
      )
    `);
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${postTable}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "title" TEXT NOT NULL DEFAULT '',
        "authorFk" INTEGER,
        FOREIGN KEY ("authorFk") REFERENCES "${authorTable}"("id")
      )
    `);
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${commentTable}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "body" TEXT NOT NULL DEFAULT '',
        "postFk" INTEGER,
        FOREIGN KEY ("postFk") REFERENCES "${postTable}"("id")
      )
    `);
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("should eager-load 1 level: Comment → Post (ManyToOne eager)", async () => {
    const { em } = conn;

    const author = await em.save(AuthorClass, { name: "DeepAuthor" });
    const post = await em.save(PostClass, {
      title: "DeepPost",
      authorFk: author.id,
    });
    await em.save(CommentClass, { body: "DeepComment", postFk: post.id });

    const comments = await em.find(CommentClass, {
      where: { body: "DeepComment" } as any,
    });

    expect(comments.length).toBe(1);
    // First-level eager: Comment → Post works
    expect(comments[0].post).toBeDefined();
    expect(comments[0].post.title).toBe("DeepPost");
    // Nested eager (Post → Author) is not auto-propagated; verify FK is present
    expect(comments[0].post.authorFk).toBe(author.id);
  });

  it("should load Author with posts via relations option", async () => {
    const { em } = conn;

    const authors = await em.find(AuthorClass, {
      where: { name: "DeepAuthor" } as any,
      relations: ["posts"] as any,
    });

    expect(authors.length).toBe(1);
    expect(authors[0].posts).toBeDefined();
    expect(authors[0].posts.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────
// Cascade Insert
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite In-Memory: Cascade Insert", () => {
  let conn: TestConnectionResult;
  let ParentClass: new () => any;
  let ChildClass: new () => any;

  beforeAll(async () => {
    const parentTable = shortTableName("cp");
    const childTable = shortTableName("cc");

    conn = await createTestConnection(
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
          value: parentTable,
          writable: false,
        });

        Reflect.defineMetadata("design:type", Number, PC.prototype, "id");
        PrimaryGeneratedColumn()(PC.prototype, "id");

        Reflect.defineMetadata("design:type", String, PC.prototype, "name");
        Column()(PC.prototype, "name");

        Reflect.defineMetadata("design:type", Array, PC.prototype, "children");
        OneToMany(() => CC, {
          mappedBy: "parent",
          cascade: ["insert"],
        })(PC.prototype, "children");

        Entity()(PC);

        const CC = class {} as any;
        Object.defineProperty(CC, "name", {
          value: childTable,
          writable: false,
        });

        Reflect.defineMetadata("design:type", Number, CC.prototype, "id");
        PrimaryGeneratedColumn()(CC.prototype, "id");

        Reflect.defineMetadata("design:type", String, CC.prototype, "title");
        Column()(CC.prototype, "title");

        Reflect.defineMetadata("design:type", Number, CC.prototype, "parentFk");
        Column({ type: "int", nullable: true })(CC.prototype, "parentFk");

        Reflect.defineMetadata("design:type", PC, CC.prototype, "parent");
        ManyToOne(() => PC, (e: any) => e.parent, {
          joinColumn: "parentFk",
        })(CC.prototype, "parent");

        Entity()(CC);

        ParentClass = PC;
        ChildClass = CC;
        return { entities: [PC, CC] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${parentTable}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "name" TEXT NOT NULL DEFAULT ''
      )
    `);
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${childTable}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "title" TEXT NOT NULL DEFAULT '',
        "parentFk" INTEGER,
        FOREIGN KEY ("parentFk") REFERENCES "${parentTable}"("id")
      )
    `);
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("should cascade-insert children when saving parent", async () => {
    const { em } = conn;

    const parent = {
      name: "CascadeParent",
      children: [{ title: "CascadeChild1" }, { title: "CascadeChild2" }],
    };

    const saved = await em.save(ParentClass, parent);
    expect(saved.id).toBeDefined();

    // Verify children were created
    const children = await em.find(ChildClass, {
      where: { parentFk: saved.id } as any,
    });

    expect(children.length).toBe(2);
  });
});
