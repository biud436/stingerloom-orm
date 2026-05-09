import "reflect-metadata";
import sql, { Sql, raw } from "sql-template-tag";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  RelationColumn,
} from "../../src/decorators";
import {
  createAliasRef,
  createEntitySqlRef,
  SqlRef,
} from "../../src/core/SqlRef";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { EntityManager } from "../../src/core/EntityManager";
import { SnakeNamingStrategy } from "../../src/core/generators/SnakeNamingStrategy";

@Entity()
class Issue { // eslint-disable-line @typescript-eslint/no-redeclare
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  title!: string;

  @Column({ type: "datetime", nullable: true })
  deletedAt?: Date | null;

  @ManyToOne(() => Issue, (i: Issue) => i.id, { joinColumn: "parent_id" })
  parent?: Issue;

  // Bare FK property — no @Column. Should still resolve via relation metadata.
  parentId?: number;
}

function pgWrap(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function mysqlWrap(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function makeRef<T>(
  entity: new (...a: any[]) => T,
  dialect: "pg" | "mysql" = "pg",
  alias?: string,
): SqlRef<T> {
  const resolver = new RelationMetadataResolver();
  const wrap = dialect === "pg" ? pgWrap : mysqlWrap;
  return createEntitySqlRef<T>(
    entity as any,
    {
      wrap,
      wrapTable: (n) => wrap(n),
      collectFkPropertyMappings: (e) => resolver.collectFkPropertyMappings(e),
    },
    alias,
  );
}

// Mirror production: SnakeNamingStrategy rewrites column names from camelCase
// to snake_case. Without it, `@Column` stores the raw propertyKey verbatim.
beforeAll(() => {
  EntityManager.applyNamingStrategyToEntities([Issue], new SnakeNamingStrategy());
});

describe("SqlRef — em.ref(Entity) sql tag helper", () => {
  test("interpolating the ref renders the wrapped table name (PostgreSQL)", () => {
    const I = makeRef(Issue, "pg");
    const q = sql`SELECT * FROM ${I}`;
    expect(q.sql).toBe(`SELECT * FROM "issue"`);
    expect(q.values).toEqual([]);
  });

  test("interpolating the ref renders the wrapped table name (MySQL backticks)", () => {
    const I = makeRef(Issue, "mysql");
    const q = sql`SELECT * FROM ${I}`;
    expect(q.sql).toBe("SELECT * FROM `issue`");
  });

  test("property access yields a bare wrapped column (no table prefix)", () => {
    const I = makeRef(Issue, "pg");
    const q = sql`SELECT ${I.id} FROM ${I}`;
    expect(q.sql).toBe(`SELECT "id" FROM "issue"`);
  });

  test("snake_case naming applied (deletedAt → deleted_at)", () => {
    const I = makeRef(Issue, "pg");
    // No NamingStrategy applied here, but @Column resolution maps propertyKey
    // to the metadata-stored name. With default decorator name === propertyKey,
    // the fallback path snake-cases the property at render time.
    const q = sql`SELECT ${I.deletedAt} FROM ${I}`;
    expect(q.sql).toBe(`SELECT "deleted_at" FROM "issue"`);
  });

  test("FK backing property resolves via relation metadata (parentId → parent_id)", () => {
    const I = makeRef(Issue, "pg");
    const q = sql`WHERE ${I.parentId} = ${42}`;
    expect(q.sql).toBe(`WHERE "parent_id" = ?`);
    expect(q.values).toEqual([42]);
  });

  test("manual c. prefix for alias disambiguation works literally", () => {
    const I = makeRef(Issue, "pg");
    const q = sql`SELECT c.${I.id} FROM ${I} c`;
    expect(q.sql).toBe(`SELECT c."id" FROM "issue" c`);
  });

  test("user values stay parameterized (escape preserved)", () => {
    const I = makeRef(Issue, "pg");
    const id = 7;
    const q = sql`UPDATE ${I} SET ${I.deletedAt} = NULL WHERE ${I.id} = ${id}`;
    expect(q.sql).toBe(
      `UPDATE "issue" SET "deleted_at" = NULL WHERE "id" = ?`,
    );
    expect(q.values).toEqual([7]);
  });

  test(".as(prop) projects with the property name as alias", () => {
    const I = makeRef(Issue, "pg");
    const q = sql`SELECT ${I.as("deletedAt")} FROM ${I}`;
    expect(q.sql).toBe(`SELECT "deleted_at" AS "deletedAt" FROM "issue"`);
  });

  test(".as(prop, asName) projects with explicit alias", () => {
    const I = makeRef(Issue, "pg");
    const q = sql`SELECT ${I.as("deletedAt", "trashed_at")} FROM ${I}`;
    expect(q.sql).toBe(
      `SELECT "deleted_at" AS "trashed_at" FROM "issue"`,
    );
  });

  test("unknown property falls back to camelToSnakeCase", () => {
    const I = makeRef(Issue, "pg") as any;
    // typed as any so we can hit the fallback path the type system would block
    const q = sql`SELECT ${I.someAdHocColumn} FROM ${I}`;
    expect(q.sql).toBe(`SELECT "some_ad_hoc_column" FROM "issue"`);
  });

  test("composes inside a recursive CTE without raw() noise", () => {
    const I = makeRef(Issue, "pg");
    const id = 100;
    const q = sql`
      WITH RECURSIVE deleted_tree(${I.id}) AS (
        SELECT ${I.id} FROM ${I}
          WHERE ${I.id} = ${id} AND ${I.deletedAt} IS NOT NULL
        UNION ALL
        SELECT c.${I.id} FROM ${I} c
          INNER JOIN deleted_tree p ON c.${I.parentId} = p.${I.id}
          WHERE c.${I.deletedAt} IS NOT NULL
      )
      SELECT ${I.id} FROM deleted_tree
    `;
    // Whitespace-normalize for stable comparison.
    const flat = q.sql.replace(/\s+/g, " ").trim();
    expect(flat).toBe(
      `WITH RECURSIVE deleted_tree("id") AS ( ` +
        `SELECT "id" FROM "issue" WHERE "id" = ? AND "deleted_at" IS NOT NULL ` +
        `UNION ALL ` +
        `SELECT c."id" FROM "issue" c ` +
        `INNER JOIN deleted_tree p ON c."parent_id" = p."id" ` +
        `WHERE c."deleted_at" IS NOT NULL ` +
        `) SELECT "id" FROM deleted_tree`,
    );
    expect(q.values).toEqual([100]);
  });

  test("ref is recognized as Sql by sql-template-tag (instanceof Sql)", () => {
    const I = makeRef(Issue, "pg");
    expect(I instanceof Sql).toBe(true);
  });

  test("throws clearly when target is not an entity", () => {
    class NotAnEntity {}
    expect(() => makeRef(NotAnEntity as any)).toThrow(/NotAnEntity/);
  });

  test("composes with raw() and join() unchanged (no regression)", () => {
    const I = makeRef(Issue, "pg");
    const ids = [1, 2, 3];
    const q = sql`UPDATE ${I} SET ${I.deletedAt} = NULL WHERE ${I.id} IN (${raw(
      ids.map(() => "?").join(","),
    )})`;
    expect(q.sql).toBe(
      `UPDATE "issue" SET "deleted_at" = NULL WHERE "id" IN (?,?,?)`,
    );
  });

  describe("with alias — em.ref(Entity, alias)", () => {
    test("table interpolation emits `\"table\" AS alias`", () => {
      const I = makeRef(Issue, "pg", "i");
      const q = sql`SELECT 1 FROM ${I}`;
      expect(q.sql).toBe(`SELECT 1 FROM "issue" AS i`);
    });

    test("column refs are alias-qualified", () => {
      const I = makeRef(Issue, "pg", "i");
      const q = sql`SELECT ${I.id}, ${I.deletedAt} FROM ${I}`;
      expect(q.sql).toBe(
        `SELECT i."id", i."deleted_at" FROM "issue" AS i`,
      );
    });

    test(".as() emits alias-qualified projection", () => {
      const I = makeRef(Issue, "pg", "i");
      const q = sql`SELECT ${I.as("deletedAt")}, ${I.as("id", "issue_id")} FROM ${I}`;
      expect(q.sql).toBe(
        `SELECT i."deleted_at" AS "deletedAt", i."id" AS "issue_id" FROM "issue" AS i`,
      );
    });

    test("FK backing property is alias-qualified", () => {
      const I = makeRef(Issue, "pg", "c");
      const q = sql`WHERE ${I.parentId} = ${42}`;
      expect(q.sql).toBe(`WHERE c."parent_id" = ?`);
      expect(q.values).toEqual([42]);
    });

    test("self-join with two aliases composes cleanly", () => {
      const c = makeRef(Issue, "pg", "c");
      const p = makeRef(Issue, "pg", "p");
      const q = sql`
        SELECT ${c.id}, ${p.id}
        FROM ${c}
        INNER JOIN ${p} ON ${c.parentId} = ${p.id}
        WHERE ${c.deletedAt} IS NULL
      `;
      const flat = q.sql.replace(/\s+/g, " ").trim();
      expect(flat).toBe(
        `SELECT c."id", p."id" ` +
          `FROM "issue" AS c ` +
          `INNER JOIN "issue" AS p ON c."parent_id" = p."id" ` +
          `WHERE c."deleted_at" IS NULL`,
      );
    });

    test("alias works with MySQL backticks", () => {
      const I = makeRef(Issue, "mysql", "i");
      const q = sql`SELECT ${I.id} FROM ${I}`;
      expect(q.sql).toBe("SELECT i.`id` FROM `issue` AS i");
    });

    test("no alias still produces the bare-column form (backward compat)", () => {
      const I = makeRef(Issue, "pg");
      const q = sql`SELECT ${I.id} FROM ${I}`;
      expect(q.sql).toBe(`SELECT "id" FROM "issue"`);
    });
  });

  describe("aliasRef — non-entity CTE refs", () => {
    test("interpolating the ref renders the bare alias name (unquoted)", () => {
      const t = createAliasRef("t", pgWrap);
      const q = sql`INNER JOIN issue_tree ${t} ON 1=1`;
      expect(q.sql).toBe(`INNER JOIN issue_tree t ON 1=1`);
    });

    test("property access yields alias-qualified wrapped column", () => {
      const t = createAliasRef("t", pgWrap);
      const q = sql`SELECT ${t.depth} FROM cte ${t}`;
      expect(q.sql).toBe(`SELECT t."depth" FROM cte t`);
    });

    test("camelCase property names are snake-cased", () => {
      const t = createAliasRef("t", pgWrap);
      const q = sql`SELECT ${t.parentCommentId} FROM cte ${t}`;
      expect(q.sql).toBe(`SELECT t."parent_comment_id" FROM cte t`);
    });

    test("composes inside a recursive CTE body for CTE-only cols", () => {
      const t = createAliasRef("t", pgWrap);
      const q = sql`WHERE ${t.depth} < ${5} AND ${t.path} LIKE 'a/%'`;
      expect(q.sql).toBe(`WHERE t."depth" < ? AND t."path" LIKE 'a/%'`);
      expect(q.values).toEqual([5]);
    });

    test("works with MySQL backticks", () => {
      const t = createAliasRef("t", mysqlWrap);
      const q = sql`SELECT ${t.depth} FROM cte ${t}`;
      expect(q.sql).toBe("SELECT t.`depth` FROM cte t");
    });

    test("ref is recognized as Sql by sql-template-tag", () => {
      const t = createAliasRef("t", pgWrap);
      expect(t instanceof Sql).toBe(true);
    });
  });
});
