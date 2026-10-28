import "reflect-metadata";
import {
  Column,
  ComputedColumn,
  DiscriminatorColumn,
  DiscriminatorValue,
  Entity,
  Inheritance,
  ManyToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  RelationColumn,
} from "../../src/decorators";
import { qAlias } from "../../src/core/SelectQueryBuilder";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import {
  createInsertBuilderFor,
  createQbFor,
  Counter,
} from "./golden-sql/fixtures";
import type { DialectName } from "./golden-sql/harness";

/**
 * `InsertQueryBuilder.values(columns, query)` — what the INSERT … SELECT
 * form accepts and rejects. The rendered SQL is pinned by
 * `golden-sql/insert-select.golden.test.ts`.
 */

@Entity()
class Source {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 32 })
  name!: string;

  @Column({ type: "int" })
  amount!: number;
}

@Entity()
class Owner {
  @PrimaryGeneratedColumn()
  id!: number;
}

@Entity()
class Target {
  @PrimaryColumn({ type: "int" })
  id!: number;

  @Column({ type: "int" })
  amount!: number;

  @ComputedColumn({ expression: "amount * 2" })
  doubled!: number;

  @ManyToOne(() => Owner, (o: Owner) => o.id)
  @RelationColumn({ name: "owner_id" })
  owner!: Owner;
}

@Entity()
class UuidTarget {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "int" })
  amount!: number;
}

@Entity()
class Uuid7Target {
  @PrimaryGeneratedColumn("uuid-v7")
  id!: string;

  @Column({ type: "int" })
  amount!: number;
}

@Entity()
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "kind" })
class Shape {
  @PrimaryColumn({ type: "int" })
  id!: number;

  @Column({ type: "varchar", length: 16 })
  kind!: string;
}

@Entity()
@DiscriminatorValue("circle")
class Circle extends Shape {
  @Column({ type: "int" })
  radius!: number;
}

const s = qAlias(Source, "s");

function sourceQuery(dialect: DialectName = "postgres") {
  return createQbFor(Source, "s", dialect).select([s.id.as("id"), s.amount.as("amount")]);
}

function errorOf(fn: () => unknown): OrmError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(OrmError);
    return error as OrmError;
  }
  throw new Error("expected the call to throw");
}

describe("InsertQueryBuilder.values(columns, query)", () => {
  describe("one row source per statement", () => {
    it("rejects a query after VALUES rows", () => {
      const builder = createInsertBuilderFor(Target, "postgres").values({ id: 1, amount: 2 });
      const error = errorOf(() => builder.values(["id", "amount"], sourceQuery()));
      expect(error.code).toBe(OrmErrorCode.INVALID_QUERY);
      expect(error.message).toContain("already has VALUES rows");
    });

    it("rejects VALUES rows after a query", () => {
      const builder = createInsertBuilderFor(Target, "postgres").values(
        ["id", "amount"],
        sourceQuery(),
      );
      expect(errorOf(() => builder.values({ id: 1, amount: 2 })).code).toBe(
        OrmErrorCode.INVALID_QUERY,
      );
    });

    it("rejects a second query", () => {
      const builder = createInsertBuilderFor(Target, "postgres").values(
        ["id", "amount"],
        sourceQuery(),
      );
      const error = errorOf(() => builder.values(["id", "amount"], sourceQuery()));
      expect(error.message).toContain("already has a query");
    });
  });

  describe("the column list", () => {
    it("must not be empty", () => {
      const error = errorOf(() =>
        createInsertBuilderFor(Target, "postgres").values([], sourceQuery()),
      );
      expect(error.code).toBe(OrmErrorCode.INVALID_QUERY);
    });

    it("must not repeat a property", () => {
      const error = errorOf(() =>
        createInsertBuilderFor(Target, "postgres").values(["id", "id"], sourceQuery()),
      );
      expect(error.message).toContain("names 'id' twice");
    });

    it("rejects a name that is no column", () => {
      const error = errorOf(() =>
        createInsertBuilderFor(Target, "postgres")
          .values(["id", "missing" as "amount"], sourceQuery())
          .build(),
      );
      expect(error.code).toBe(OrmErrorCode.INVALID_QUERY);
      expect(error.message).toContain("'missing' is not a column of Target");
    });

    it("rejects a computed column", () => {
      const error = errorOf(() =>
        createInsertBuilderFor(Target, "postgres")
          .values(["id", "doubled"], sourceQuery())
          .build(),
      );
      expect(error.message).toContain("is a computed column");
    });

    it("writes a relation's join column", () => {
      const built = createInsertBuilderFor(Target, "postgres")
        .values(["id", "amount", "owner"], createQbFor(Source, "s", "postgres").select([
          s.id.as("id"),
          s.amount.as("amount"),
          s.id.as("owner"),
        ]))
        .build();
      expect(built.sql).toMatch(/^INSERT INTO "target" \("id", "amount", "owner_id"\) SELECT /);
    });
  });

  describe("keys the ORM generates for each row", () => {
    it.each<DialectName>(["mysql", "sqlite"])(
      "rejects an unlisted uuid key on %s",
      (dialect) => {
        const error = errorOf(() =>
          createInsertBuilderFor(UuidTarget, dialect)
            .values(["amount"], sourceQuery(dialect).select([s.amount.as("amount")]))
            .build(),
        );
        expect(error.code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);
        expect(error.message).toContain("UuidTarget.id is a uuid key");
      },
    );

    it("leaves a uuid key to its column DEFAULT on PostgreSQL", () => {
      const built = createInsertBuilderFor(UuidTarget, "postgres")
        .values(["amount"], sourceQuery().select([s.amount.as("amount")]))
        .build();
      expect(built.sql).toMatch(/^INSERT INTO "uuid_target" \("amount"\) SELECT /);
    });

    it.each<DialectName>(["postgres", "mysql", "sqlite"])(
      "rejects an unlisted uuid-v7 key on %s",
      (dialect) => {
        const error = errorOf(() =>
          createInsertBuilderFor(Uuid7Target, dialect)
            .values(["amount"], sourceQuery(dialect).select([s.amount.as("amount")]))
            .build(),
        );
        expect(error.code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);
      },
    );

    it("accepts a key the query selects", () => {
      const built = createInsertBuilderFor(Uuid7Target, "sqlite")
        .values(
          ["id", "amount"],
          sourceQuery("sqlite").select([s.name.as("id"), s.amount.as("amount")]),
        )
        .build();
      expect(built.sql).toMatch(/^INSERT INTO "uuid7target" \("id", "amount"\) SELECT /);
    });
  });

  describe("a SINGLE_TABLE child", () => {
    it("writes its discriminator after the selected columns", () => {
      const built = createInsertBuilderFor(Circle, "postgres")
        .values(
          ["id", "radius"],
          sourceQuery().select([s.id.as("id"), s.amount.as("radius")]),
        )
        .build();
      expect(built.sql).toBe(
        'INSERT INTO "shape" ("id", "radius", "kind") ' +
          'SELECT "s"."id" AS "id", "s"."amount" AS "radius", ? AS "kind" FROM "source" AS "s"',
      );
      expect(built.values).toEqual(["circle"]);
    });

    it("rejects the discriminator in the column list", () => {
      const error = errorOf(() =>
        createInsertBuilderFor(Circle, "postgres")
          .values(
            ["id", "kind"],
            sourceQuery().select([s.id.as("id"), s.name.as("kind")]),
          )
          .build(),
      );
      expect(error.code).toBe(OrmErrorCode.INVALID_QUERY);
      expect(error.message).toContain("is the discriminator of Circle");
    });
  });

  it("refuses executeAndReturn() on MySQL, which has no RETURNING", async () => {
    const builder = createInsertBuilderFor(Counter, "mysql").values(
      ["mac", "bucketStart", "records", "lastTs"],
      createQbFor(Source, "s", "mysql").select([
        s.name.as("mac"),
        s.id.as("bucketStart"),
        s.amount.as("records"),
        s.amount.as("lastTs"),
      ]),
    );
    await expect(builder.executeAndReturn()).rejects.toMatchObject({
      code: OrmErrorCode.UNSUPPORTED_OPERATION,
      message: expect.stringContaining("cannot return the rows of an INSERT … SELECT on MySQL"),
    });
  });
});
