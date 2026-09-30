import type { ColumnOption, ColumnType } from "../../decorators/Column";
import {
  ColumnDefinitionBuilder,
  createColumnDefinitionBuilder,
} from "../../dialects/ColumnDefinitionBuilder";
import type { CommonCapabilities } from "../../dialects/DialectCapabilities";
import type { DialectTypes, TypeFidelity } from "../catalog/DialectCatalog";
import { CanonicalType, sameShape } from "../SchemaIR";

/**
 * The part of an ORM column declaration that decides its SQL type — exactly
 * what the emitters write out as `type` / `length` / `precision` / … and what
 * the column definition builder reads back to render the DDL.
 */
export interface OrmColumnType {
  type: ColumnType;
  length?: number;
  precision?: number;
  scale?: number;
  enumValues?: string[];
  enumName?: string;
  arrayElementType?: ColumnType;
}

/** The ORM type chosen for a database type, and how faithful it is. */
export interface TypeChoice {
  orm: OrmColumnType;
  /** The DDL type this ORM's builder declares for {@link orm} on the dialect. */
  createdDdl: string;
  /** {@link createdDdl}, parsed back by the dialect. */
  created: CanonicalType;
  /** How faithfully {@link created} reproduces the database's type. */
  fidelity: TypeFidelity;
}

/**
 * Picks the ORM column type for a database type by asking the ORM itself.
 *
 * There is no hand-kept reverse type table. Each canonical type has a short,
 * dialect-neutral list of candidate ORM types; every candidate is rendered
 * through the dialect's real column definition builder — the code
 * `synchronize` and `migrate:generate` create tables with — and the rendered
 * DDL is parsed back with the same parser that read the catalog. The first
 * candidate whose DDL has the database type's shape wins, and the comparison
 * of the full types is the choice's fidelity.
 *
 * So a mapping cannot quietly drift from what the ORM creates: if the builder
 * changes how it spells a type, the choice and its fidelity follow, and a
 * database type the ORM cannot recreate is reported with both spellings
 * instead of being passed off as exact.
 */
export class TypeOracle {
  private readonly builder: ColumnDefinitionBuilder;

  constructor(
    private readonly types: DialectTypes,
    options: { schema?: string; capabilities?: CommonCapabilities } = {},
  ) {
    this.builder = createColumnDefinitionBuilder(
      types.dialect,
      options.schema,
      options.capabilities,
    );
  }

  /** Chooses the ORM type for `declared`, a column of `tableName`. */
  choose(
    declared: CanonicalType,
    ctx: { tableName: string; columnName: string },
  ): TypeChoice {
    const rendered: Array<{ orm: OrmColumnType; ddl: string; created: CanonicalType }> = [];
    for (const orm of candidates(declared)) {
      const result = this.tryRender(orm, ctx);
      if (!result) continue;
      rendered.push({ orm, ...result });
      if (sameShape(result.created, declared)) return this.finish(declared, rendered[rendered.length - 1]);
    }

    const equivalent = rendered.find(
      (r) => this.types.compareTypes(declared, r.created) !== "different",
    );
    const pick = equivalent ?? rendered[0] ?? this.fallback(ctx);
    return this.finish(declared, pick);
  }

  /** The type this ORM creates for `orm` on the dialect, parsed. */
  render(
    orm: OrmColumnType,
    ctx: { tableName: string; columnName: string },
  ): { ddl: string; created: CanonicalType } {
    const option: ColumnOption = { ...orm, nullable: false };
    const ddl = this.builder.buildColumnTypeExpr(option, ctx);
    // A PostgreSQL enum renders as its type name; the option says what it holds.
    const enumName = orm.enumName ?? `${ctx.tableName}_${ctx.columnName}_enum`;
    const created = this.types.parseType(ddl, (name) =>
      (orm.type === "enum" || orm.arrayElementType === "enum") && name === enumName
        ? { kind: "enum", values: orm.enumValues ?? [], name: enumName }
        : undefined,
    );
    return { ddl, created };
  }

  private tryRender(
    orm: OrmColumnType,
    ctx: { tableName: string; columnName: string },
  ): { ddl: string; created: CanonicalType } | null {
    try {
      return this.render(orm, ctx);
    } catch {
      // The builder refuses what it cannot create (an enum array element, a
      // precision past the dialect's limit); the next candidate is tried.
      return null;
    }
  }

  private fallback(ctx: { tableName: string; columnName: string }) {
    const orm: OrmColumnType = { type: "text" };
    return { orm, ...this.render(orm, ctx) };
  }

  private finish(
    declared: CanonicalType,
    pick: { orm: OrmColumnType; ddl: string; created: CanonicalType },
  ): TypeChoice {
    return {
      orm: pick.orm,
      createdDdl: pick.ddl,
      created: pick.created,
      fidelity: this.types.compareTypes(declared, pick.created),
    };
  }
}

/**
 * Candidate ORM types for a canonical type, most fitting first. Dialect
 * neutral: which candidate a dialect ends up with is decided by rendering
 * them (see {@link TypeOracle}), never by a per-dialect table here.
 *
 * Where several ORM types exist for one meaning they are all listed:
 * `datetime` and `timestamp` are the same TIMESTAMP on PostgreSQL but
 * DATETIME and TIMESTAMP on MySQL, so a wall-clock column tries `datetime`
 * first and an instant tries `timestamp` before `timestamptz`.
 */
export function candidates(t: CanonicalType): OrmColumnType[] {
  switch (t.kind) {
    case "integer":
      return [{ type: t.bytes === 8 ? "bigint" : "int" }];
    case "boolean":
      return [{ type: "boolean" }];
    case "decimal":
      return [
        t.precision === null
          ? { type: "double" }
          : { type: "double", precision: t.precision, scale: t.scale ?? 0 },
      ];
    case "float":
      // `double` is DECIMAL/NUMERIC on MySQL and PostgreSQL, so a double
      // precision float keeps floating-point semantics as `float` and is
      // reported, rather than turning into a fixed-point number.
      return t.bytes === 4 ? [{ type: "float" }] : [{ type: "float" }, { type: "double" }];
    case "string":
      if (t.length === null) return [{ type: "text" }];
      return [{ type: t.fixed ? "char" : "varchar", length: t.length }];
    case "text":
      return [{ type: t.size === "medium" || t.size === "long" ? "longtext" : "text" }];
    case "binary":
    case "blob":
      return [{ type: "blob" }];
    case "uuid":
      return [{ type: "uuid" }];
    case "json":
      return [{ type: t.binary ? "jsonb" : "json" }];
    case "date":
      return [{ type: "date" }];
    case "timestamp":
      return t.zone === "local"
        ? [{ type: "datetime" }, { type: "timestamp" }]
        : [{ type: "timestamp" }, { type: "timestamptz" }];
    case "enum":
      return [
        {
          type: "enum",
          enumValues: t.values,
          ...(t.name ? { enumName: t.name } : {}),
        },
      ];
    case "array": {
      const element =
        t.element.kind === "enum" || t.element.kind === "array"
          ? ({ type: "text" } as OrmColumnType)
          : candidates(t.element)[0];
      return [
        {
          type: "array",
          arrayElementType: element.type,
          ...(element.length !== undefined ? { length: element.length } : {}),
          ...(element.precision !== undefined
            ? { precision: element.precision, scale: element.scale ?? 0 }
            : {}),
        },
      ];
    }
    case "time":
    case "other":
      // No ORM type exists; TEXT holds any value's text form without a limit.
      return [{ type: "text" }];
  }
}
