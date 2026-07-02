/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Regression tests for three decorator-parity bugs in EntitySchemaRegistrar:
 *
 * 1. `manyToOne` eagerly invoked the `() => Target` thunk at registration
 *    time, breaking forward references (TDZ throw with `const`, or a
 *    permanently-captured `undefined` in CJS circular imports).
 * 2. `resolveColumnOption()` defaulted `length: 255` for every String-mapped
 *    ColumnType (text/uuid/enum/...), while @Column discards the inferred
 *    length when the type is overridden — the phantom length made MySQL
 *    SchemaDiff emit narrowing ALTERs on every boot.
 * 3. `registerEntity()` filtered columns/relations with strict `target ===`
 *    unless an `inheritance` option was set, silently dropping decorated
 *    columns inherited from a plain base class; @Entity always walks the
 *    prototype/constructor chains.
 */
import "reflect-metadata";
import { defineEntity, t, EntitySchema } from "../../src/schema";
import { Column, COLUMN_TOKEN } from "../../src/decorators/Column";
import { MANY_TO_ONE_TOKEN, ManyToOneMetadata } from "../../src/decorators/ManyToOne";
import { ENTITY_TOKEN, EntityMetadata } from "../../src/decorators/Entity";
import { ColumnMetadata } from "../../src/scanner/ColumnScanner";

describe("EntitySchemaRegistrar parity regressions", () => {
  describe("manyToOne forward references (lazy thunk)", () => {
    it("does not invoke the target thunk at registration time", () => {
      // `let` mimics the CJS circular-import case: the binding exists but is
      // still undefined when defineEntity() runs.
      let User: any;

      const Post = defineEntity("parity_regr_posts", {
        id: t.int().primary().generated(),
        author: t.manyToOne(() => User),
      });

      User = defineEntity("parity_regr_users", {
        id: t.int().primary().generated(),
      });

      const relations: ManyToOneMetadata<any>[] = Reflect.getMetadata(
        MANY_TO_ONE_TOKEN,
        Post,
      );
      expect(relations).toHaveLength(1);
      // `type` must resolve to the (now-initialized) target lazily.
      expect(relations[0].type).toBe(User);
      expect(relations[0].getMappingEntity()).toBe(User);
    });
  });

  describe("no phantom length on non-varchar columns", () => {
    function optionsOf(cls: any, key: string) {
      const columns: ColumnMetadata[] = Reflect.getMetadata(
        COLUMN_TOKEN,
        cls.prototype,
      );
      const found = columns.find((c) => c.propertyKey === key);
      expect(found?.options).toBeDefined();
      return found!.options!;
    }

    it("leaves length undefined for text/uuid/enum like @Column does", () => {
      const Doc = defineEntity("parity_regr_docs", {
        id: t.int().primary().generated(),
        body: t.text(),
        token: t.uuid(),
        state: t.enum(["draft", "live"]),
      });

      class Decorated {
        @Column({ type: "text" })
        body!: string;
        @Column({ type: "uuid" })
        token!: string;
        @Column({ type: "enum", enumValues: ["draft", "live"] })
        state!: string;
      }

      for (const key of ["body", "token", "state"]) {
        expect(optionsOf(Doc, key).length).toBe(optionsOf(Decorated, key).length);
        expect(optionsOf(Doc, key).length).toBeUndefined();
      }
    });

    it("keeps the inferred default for varchar/int/boolean and explicit lengths", () => {
      const Doc = defineEntity("parity_regr_docs2", {
        name: t.varchar(),
        code: t.varchar(100),
        count: t.int(),
        active: t.boolean(),
      });

      expect(optionsOf(Doc, "name").length).toBe(255);
      expect(optionsOf(Doc, "code").length).toBe(100);
      expect(optionsOf(Doc, "count").length).toBe(11);
      expect(optionsOf(Doc, "active").length).toBe(1);
    });
  });

  describe("inherited decorator columns on plain base classes", () => {
    it("includes @Column metadata from a non-@Inheritance base class", () => {
      class AuditedBase {
        @Column({ type: "varchar", nullable: true })
        createdBy!: string | null;
      }
      class Report extends AuditedBase {
        id!: number;
      }

      new EntitySchema<any>({
        target: Report,
        tableName: "parity_regr_reports",
        columns: {
          id: { type: "int", primary: true, autoIncrement: true },
        },
      });

      const meta: EntityMetadata = Reflect.getMetadata(ENTITY_TOKEN, Report);
      const keys = meta.columns.map((c: any) => c.propertyKey);
      expect(keys).toContain("id");
      expect(keys).toContain("createdBy");
    });
  });
});
