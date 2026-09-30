import type { ColumnType } from "../../decorators/Column";
import type { DialectTypes } from "../catalog/DialectCatalog";
import { isNumberLiteral } from "../catalog/sqlLiterals";
import type {
  EntityModel,
  EntityModelField,
  ModelColumnField,
  ModelIndex,
  ModelRelationField,
} from "../EntityModel";
import {
  ColumnIR,
  DefaultValue,
  ForeignKeyIR,
  TableIR,
  validateTableIR,
} from "../SchemaIR";
import { IntrospectionTypeMapper } from "../TypeMapper";
import {
  columnNameToPropertyName,
  fkToPropertyName,
  PropertyNamer,
  SchemaNaming,
} from "./Naming";
import { TypeChoice, TypeOracle } from "./TypeSelection";

/** What lowering one table needs to know beyond the table itself. */
export interface LoweringContext {
  types: DialectTypes;
  oracle: TypeOracle;
  naming: SchemaNaming;
  /**
   * Tables being generated. A foreign key to any other table stays a plain
   * column, since a relation would import a class that is not generated.
   * When absent every referenced table is assumed to be generated.
   */
  generatedTables?: ReadonlySet<string>;
  /** Every table read, by name — used to inspect foreign key targets. */
  tables?: ReadonlyMap<string, TableIR>;
  /** Primary keys per table, when only rows (not whole tables) were supplied. */
  primaryKeysByTable?: Record<string, string[]>;
}

const TIMESTAMP_TYPES = new Set<ColumnType>(["datetime", "timestamp", "timestamptz", "date"]);
const NUMERIC_TYPES = new Set<ColumnType>(["int", "bigint", "float", "double", "number"]);

/**
 * Lowers one table of the IR to the {@link EntityModel} both emitters print.
 *
 * Every decision that loses information — a type the ORM cannot recreate, a
 * foreign key that cannot be a relation, an index the ORM cannot declare, a
 * default a timestamp marker replaces — is recorded as a note on the field or
 * the entity. Nothing is dropped or changed without one.
 */
export function lowerTable(table: TableIR, ctx: LoweringContext): EntityModel {
  validateTableIR(table);

  const className = ctx.naming.classNameOf(table.name);
  const notes: string[] = [];
  const position = new Map(table.columns.map((c, i) => [c.name, i]));
  const columnByName = new Map(table.columns.map((c) => [c.name, c]));
  const primaryKey = new Set(table.primaryKey);

  if (table.primaryKey.length === 0) {
    notes.push(
      `Table "${table.name}" has no primary key. The ORM identifies rows by ` +
        "their primary key, so declare the column(s) that identify a row as primary.",
    );
  }

  // ── Which foreign keys become relations ─────────────────────────────────
  const relationFks: ForeignKeyIR[] = [];
  const relationColumns = new Set<string>();
  const byPosition = (fk: ForeignKeyIR) =>
    position.get(fk.columns[0]) ?? Number.MAX_SAFE_INTEGER;
  const foreignKeys = [...table.foreignKeys].sort(
    (a, b) => byPosition(a) - byPosition(b) || a.columns[0].localeCompare(b.columns[0]),
  );
  for (const fk of foreignKeys) {
    const blocked = relationBlocker(fk, table, ctx, relationColumns);
    if (blocked) {
      notes.push(blocked);
      continue;
    }
    relationFks.push(fk);
    relationColumns.add(fk.columns[0]);
  }
  // A foreign key column that is also part of the primary key (closure and
  // join tables) is declared as a primary column *and* as the relation.
  const relationOnly = new Set([...relationColumns].filter((c) => !primaryKey.has(c)));

  // ── Property names ──────────────────────────────────────────────────────
  const namer = new PropertyNamer();
  const propertyOf = new Map<string, string>();
  table.columns.forEach((col, i) => {
    if (relationOnly.has(col.name)) return;
    propertyOf.set(col.name, namer.claim(columnNameToPropertyName(col.name) || `column${i + 1}`));
  });
  const relationNames = relationFks.map((fk) =>
    namer.claim(fkToPropertyName(fk.columns[0]), columnNameToPropertyName(fk.columns[0])),
  );

  // ── Indexes ─────────────────────────────────────────────────────────────
  const classIndexes: ModelIndex[] = [];
  const propertyIndexed = new Set<string>();
  for (const idx of table.indexes) {
    if (
      idx.columns.length === table.primaryKey.length &&
      idx.columns.every((c) => primaryKey.has(c)) &&
      idx.unsupported.length === 0
    ) {
      continue;
    }
    if (idx.unsupported.length > 0) {
      notes.push(
        `Index "${idx.name}" is not declared: ${idx.unsupported.join("; ")} ` +
          "cannot be expressed with the ORM's index options. Recreate it in a migration.",
      );
      continue;
    }
    if (idx.columns.length === 0) continue;
    if (
      ctx.types.foreignKeysCreateIndexes &&
      !idx.unique &&
      table.foreignKeys.some((fk) => sameList(fk.columns, idx.columns))
    ) {
      // The engine creates this index for the foreign key by itself.
      continue;
    }
    if (!idx.unique && idx.columns.length === 1 && !relationOnly.has(idx.columns[0])) {
      propertyIndexed.add(idx.columns[0]);
      continue;
    }
    classIndexes.push({
      columns: idx.columns.map((c) => propertyOf.get(c) ?? c),
      // SQLite's implicit UNIQUE-constraint indexes carry reserved names
      // (sqlite_autoindex_<table>_<n>); re-creating one by that name fails
      // with "object name reserved for internal use".
      name: /^sqlite_autoindex_/i.test(idx.name) ? undefined : idx.name,
      unique: idx.unique,
    });
  }

  // ── Fields ──────────────────────────────────────────────────────────────
  const fields: EntityModelField[] = [];
  for (const col of table.columns) {
    if (relationOnly.has(col.name)) continue;
    fields.push(
      lowerColumn(col, table, ctx, {
        propertyName: propertyOf.get(col.name)!,
        primary: primaryKey.has(col.name),
        fkPrimary: primaryKey.has(col.name) && relationColumns.has(col.name),
        index: propertyIndexed.has(col.name),
      }),
    );
  }
  const referencedClasses = new Set<string>();
  relationFks.forEach((fk, i) => {
    const relation = lowerRelation(fk, relationNames[i], table, columnByName, ctx);
    if (!relation.selfReference) referencedClasses.add(relation.targetClass);
    fields.push(relation);
  });

  return {
    tableName: table.name,
    className,
    fields,
    classIndexes,
    referencedClasses: [...referencedClasses].sort(),
    notes,
  };
}

/** Why a foreign key cannot be declared as a relation, or null when it can. */
function relationBlocker(
  fk: ForeignKeyIR,
  table: TableIR,
  ctx: LoweringContext,
  taken: ReadonlySet<string>,
): string | null {
  const target = `${fk.referencedSchema ? `${fk.referencedSchema}.` : ""}${fk.referencedTable}`;
  const spelled = `(${fk.columns.join(", ")}) → ${target}(${fk.referencedColumns.join(", ")})`;
  if (fk.columns.length !== 1) {
    return (
      `Composite foreign key ${spelled} is not declared: a relation joins on a ` +
      "single column. Its columns are kept as plain columns; recreate the constraint in a migration."
    );
  }
  if (fk.referencedSchema) {
    return (
      `Foreign key ${spelled} is not declared: it references a table in another ` +
      "schema. The column is kept as a plain column."
    );
  }
  if (ctx.generatedTables && !ctx.generatedTables.has(fk.referencedTable)) {
    return (
      `Foreign key ${spelled} is not declared as a relation: "${fk.referencedTable}" ` +
      "is not among the generated tables. The column is kept as a plain column."
    );
  }
  if (taken.has(fk.columns[0])) {
    return (
      `Foreign key ${spelled} is not declared: column "${fk.columns[0]}" already ` +
      `holds another relation on "${table.name}".`
    );
  }
  return null;
}

function lowerColumn(
  col: ColumnIR,
  table: TableIR,
  ctx: LoweringContext,
  place: { propertyName: string; primary: boolean; fkPrimary: boolean; index: boolean },
): ModelColumnField {
  const choice = ctx.oracle.choose(col.type, { tableName: table.name, columnName: col.name });
  const orm = choice.orm;
  const warnings: string[] = [];

  // A primary key is never nullable, whatever the catalog says.
  const nullable = place.primary ? false : col.nullable;
  const generated =
    place.primary &&
    table.primaryKey.length === 1 &&
    col.identity &&
    (orm.type === "int" || orm.type === "bigint");
  if (col.identity && !generated) {
    warnings.push(
      "The database generates this column's value (identity / auto-increment), " +
        "which the entity declares only for a single integer primary key.",
    );
  }

  const typeNote = describeTypeLoss(col, choice);
  if (typeNote) warnings.push(typeNote);

  const timestamp = place.primary ? undefined : timestampRole(place.propertyName, orm.type, nullable);

  let defaultLiteral: string | undefined;
  if (col.default && !generated) {
    const raw = col.rawDefault ?? describeDefault(col.default);
    if (timestamp && col.default.kind !== "null") {
      warnings.push(
        `DEFAULT ${raw} is not declared: as ${TIMESTAMP_ROLE_NAMES[timestamp]} ` +
          "the column is filled in by the ORM instead.",
      );
    } else {
      const lowered = lowerDefault(col.default, orm.type, raw);
      if (lowered.note) warnings.push(lowered.note);
      defaultLiteral = lowered.literal;
    }
  }
  if (col.onUpdate) {
    warnings.push(
      timestamp === "update"
        ? `ON UPDATE ${col.onUpdate} is not declared: as an update timestamp the column is set by the ORM on every save instead.`
        : `ON UPDATE ${col.onUpdate} is not declared — there is no column option for it.`,
    );
  }
  if (col.generatedExpression !== undefined) {
    warnings.push(
      "This is a generated column" +
        (col.generatedExpression ? ` (GENERATED ALWAYS AS (${col.generatedExpression}))` : "") +
        ", emitted as a plain column. Declare it as a computed column to keep the database computing it.",
    );
  }

  const baseTsType = timestamp ? "Date" : IntrospectionTypeMapper.toTsType(orm.type);
  const field: ModelColumnField = {
    kind: "column",
    propertyName: place.propertyName,
    columnName: col.name,
    needsNameOption: col.name !== place.propertyName,
    columnType: orm.type,
    // A nullable column really can hold null — say so, rather than handing
    // the caller a property type the database can violate.
    tsType: nullable && baseTsType !== "any" ? `${baseTsType} | null` : baseTsType,
    nullable,
    primary: place.primary,
    generated,
    fkPrimary: place.fkPrimary,
    index: place.index,
    timestamp,
  };
  if (orm.length !== undefined) field.length = orm.length;
  if (orm.precision !== undefined) field.precision = orm.precision;
  if (orm.scale !== undefined) field.scale = orm.scale;
  if (orm.enumValues !== undefined) field.enumValues = orm.enumValues;
  if (orm.enumName !== undefined) field.enumName = orm.enumName;
  if (orm.arrayElementType !== undefined) field.arrayElementType = orm.arrayElementType;
  if (defaultLiteral !== undefined) field.defaultLiteral = defaultLiteral;
  if (warnings.length > 0) field.warnings = warnings;
  return field;
}

function lowerRelation(
  fk: ForeignKeyIR,
  propertyName: string,
  table: TableIR,
  columnByName: ReadonlyMap<string, ColumnIR>,
  ctx: LoweringContext,
): ModelRelationField {
  const columnName = fk.columns[0];
  const col = columnByName.get(columnName)!;
  const at = { tableName: table.name, columnName };
  const choice = ctx.oracle.choose(col.type, at);
  const warnings: string[] = [];

  const targetPks =
    ctx.tables?.get(fk.referencedTable)?.primaryKey ??
    ctx.primaryKeysByTable?.[fk.referencedTable];
  const referencedColumn = fk.referencedColumns[0];
  if (targetPks && !(targetPks.length === 1 && targetPks[0] === referencedColumn)) {
    warnings.push(
      `Foreign key "${columnName}" references "${fk.referencedTable}"."${referencedColumn}", ` +
        `which is not that table's primary key (${targetPks.join(", ") || "none"}). ` +
        "Schema generation always builds the constraint against the primary key, " +
        "so synchronizing this entity would create a different foreign key than " +
        "the one in the database.",
    );
  }

  // The join column is created from the relation column's type and the
  // referenced primary key's length — there is no other option for it. Only
  // checkable when the referenced table was read too.
  const target = ctx.tables?.get(fk.referencedTable);
  if (target) {
    const targetLength = targetPrimaryKeyLength(target, ctx);
    const created = ctx.oracle.render(
      { type: choice.orm.type, ...(targetLength !== undefined ? { length: targetLength } : {}) },
      at,
    );
    if (ctx.types.compareTypes(col.type, created.created) === "different") {
      warnings.push(
        `The database declares "${col.nativeType}" for "${columnName}", but the ` +
          `relation's join column is created as "${created.ddl}" — its type comes ` +
          "from the relation column and its length from the referenced primary key.",
      );
    }
  }
  if (col.default && col.default.kind !== "null") {
    warnings.push(
      `DEFAULT ${col.rawDefault ?? describeDefault(col.default)} on "${columnName}" ` +
        "is not declared — a relation's join column has no default option.",
    );
  }

  const relation: ModelRelationField = {
    kind: "manyToOne",
    propertyName,
    targetClass: ctx.naming.classNameOf(fk.referencedTable),
    selfReference: fk.referencedTable === table.name,
    fkColumn: columnName,
    fkType: choice.orm.type,
    fkNullable: col.nullable,
    referencedColumn,
  };
  if (fk.onDelete !== "NO ACTION") relation.onDelete = fk.onDelete;
  if (fk.onUpdate !== "NO ACTION") relation.onUpdate = fk.onUpdate;
  if (warnings.length > 0) relation.warnings = warnings;
  return relation;
}

/** Length of the referenced primary key as the generated target entity declares it. */
function targetPrimaryKeyLength(target: TableIR, ctx: LoweringContext): number | undefined {
  if (target.primaryKey.length !== 1) return undefined;
  const pk = target.columns.find((c) => c.name === target.primaryKey[0]);
  if (!pk) return undefined;
  return ctx.oracle.choose(pk.type, { tableName: target.name, columnName: pk.name }).orm.length;
}

function describeTypeLoss(col: ColumnIR, choice: TypeChoice): string | null {
  if (choice.fidelity !== "different") return null;
  if (col.type.kind === "other" || col.type.kind === "time") {
    return (
      `No ORM column type matches "${col.nativeType}" — mapped to "${choice.orm.type}", ` +
      `which is created as "${choice.createdDdl}". Synchronizing this entity will NOT ` +
      "recreate the original type; register a custom column type or edit this column by hand."
    );
  }
  return (
    `The database declares "${col.nativeType}", but this entity creates ` +
    `"${choice.createdDdl}" — synchronizing it would change the column.`
  );
}

const TIMESTAMP_ROLE_NAMES = {
  create: "a create timestamp",
  update: "an update timestamp",
  deletedAt: "a soft-delete marker",
} as const;

/**
 * `@CreateTimestamp` / `@UpdateTimestamp` / `@DeletedAt` (`.createTimestamp()`
 * / `.updateTimestamp()` / `.deletedAt()`) for the conventional names.
 */
function timestampRole(
  propertyName: string,
  type: ColumnType,
  nullable: boolean,
): ModelColumnField["timestamp"] {
  if (!TIMESTAMP_TYPES.has(type)) return undefined;
  if (propertyName === "createdAt" && !nullable) return "create";
  if (propertyName === "updatedAt" && !nullable) return "update";
  if (propertyName === "deletedAt" && nullable) return "deletedAt";
  return undefined;
}

/**
 * The TypeScript literal for a column default under the ORM's `default`
 * option, where a string wrapped in parentheses is raw SQL and anything else
 * is a value.
 */
function lowerDefault(
  value: DefaultValue,
  type: ColumnType,
  raw: string,
): { literal?: string; note?: string } {
  switch (value.kind) {
    case "null":
      // DEFAULT NULL is what a column without a default does anyway.
      return {};
    case "sequence":
      return {
        note: `DEFAULT ${raw} is not declared: the ORM generates values only for a single integer primary key.`,
      };
    case "expression":
      return { literal: JSON.stringify(`(${value.sql})`) };
    case "boolean":
      if (type === "boolean") return { literal: String(value.value) };
      if (NUMERIC_TYPES.has(type)) return { literal: value.value ? "1" : "0" };
      return { literal: JSON.stringify(String(value.value)) };
    case "number":
      return numberLiteral(value.value, type);
    case "string":
      if (NUMERIC_TYPES.has(type) && isNumberLiteral(value.value)) {
        return numberLiteral(value.value.trim(), type);
      }
      if (type === "boolean") {
        const flag = booleanWord(value.value);
        if (flag !== null) return { literal: String(flag) };
      }
      if (/^\(.*\)$/s.test(value.value)) {
        return {
          note:
            `DEFAULT ${raw} is not declared: the ORM reads a default string wrapped ` +
            "in parentheses as SQL, so this literal cannot be written as one.",
        };
      }
      return { literal: JSON.stringify(value.value) };
  }
}

function numberLiteral(text: string, type: ColumnType): { literal?: string; note?: string } {
  if (type === "boolean" && (text === "0" || text === "1")) {
    return { literal: text === "1" ? "true" : "false" };
  }
  if (!NUMERIC_TYPES.has(type)) return { literal: JSON.stringify(text) };
  const n = Number(text);
  // Past 2^53 a JS number no longer holds the value; the ORM passes a string
  // default through as a quoted literal, which every dialect casts back.
  if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) {
    return { literal: JSON.stringify(text.replace(/^\+/, "")) };
  }
  return { literal: String(n) };
}

function booleanWord(text: string): boolean | null {
  switch (text.trim().toLowerCase()) {
    case "t":
    case "true":
    case "1":
    case "y":
    case "yes":
    case "on":
      return true;
    case "f":
    case "false":
    case "0":
    case "n":
    case "no":
    case "off":
      return false;
    default:
      return null;
  }
}

function describeDefault(value: DefaultValue): string {
  switch (value.kind) {
    case "string":
      return `'${value.value.replace(/'/g, "''")}'`;
    case "number":
      return value.value;
    case "boolean":
      return value.value ? "TRUE" : "FALSE";
    case "null":
      return "NULL";
    case "expression":
      return value.sql;
    case "sequence":
      return "(sequence)";
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
