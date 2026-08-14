/* eslint-disable @typescript-eslint/no-explicit-any */
import { ReflectManager, Logger } from "../utils";
import { ColumnMetadata, ColumnScanner } from "../scanner/ColumnScanner";
import { getScannerInstance } from "../scanner/ScannerContainer";

const columnLogger = new Logger("Column");

/**
 * Built-in database-independent abstract column types.
 *
 * These are the 22 types that every driver supports out-of-the-box.
 * Each DB Driver's `castType()` method converts these to actual database types.
 *
 * Examples:
 * - `"datetime"` → MySQL: `DATETIME`, PostgreSQL: `TIMESTAMP`
 * - `"boolean"` → MySQL: `TINYINT(1)`, PostgreSQL: `BOOLEAN`
 * - `"blob"` → MySQL: `BLOB`, PostgreSQL: `BYTEA`
 */
export type KnownColumnType =
  | "int"
  | "number"
  | "float"
  | "double"
  /** Date */
  | "timestamp"
  | "timestamptz"
  | "date"
  | "datetime"
  /** Buffer */
  | "blob"
  /** String */
  | "text"
  | "varchar"
  | "char"
  | "boolean"
  | "enum"
  | "json"
  | "jsonb"
  | "array"
  | "bigint"
  | "longtext"
  | "uuid";

/**
 * Database-independent abstract column type.
 *
 * Autocomplete is supported for the 22 built-in KnownColumnType values,
 * and custom types registered with `ColumnTypeRegistry` are also accepted as `string`.
 *
 * @example
 * ```ts
 * // Built-in type (autocomplete supported)
 * @Column({ type: "varchar" })
 * name: string;
 *
 * // Custom type (registered via ColumnTypeRegistry)
 * @Column({ type: "geometry" })
 * location: string;
 * ```
 */
export type ColumnType = KnownColumnType | (string & {});

/**
 * Bidirectional column value transformer.
 *
 * - `to`: transforms the entity value before writing to the database (INSERT/UPDATE).
 * - `from`: transforms the raw database value when reading into the entity.
 *
 * Both directions are optional: supplying only one side keeps the other on
 * the type's default behavior. For `type: "json" | "jsonb"`, the default
 * round-trip stringifies on write and parses on read so users can assign
 * plain JS values directly.
 *
 * @example
 * ```ts
 * @Column({
 *   type: "varchar",
 *   transformer: {
 *     to: (value: string) => value.toLowerCase(),
 *     from: (raw: string) => raw.toUpperCase(),
 *   },
 * })
 * email: string;
 * ```
 */
export interface ColumnTransformer {
  to?: (entityValue: any) => any;
  from?: (dbValue: any) => any;
}

export interface ColumnOption {
  name?: string;
  length?: number;
  nullable?: boolean;

  /**
   * Uses ColumnType when it matches a known type, otherwise plain string.
   * Inferred from TypeScript's design:type metadata when omitted.
   */
  type?: ColumnType;
  primary?: boolean;
  autoIncrement?: boolean;

  /**
   * Function that converts the column value when reading from the database into the entity.
   * @deprecated Removal target: 2.0. Use `transformer` instead for
   * bidirectional transforms.
   */
  transform?: <T = any>(raw: unknown) => T;

  /**
   * Bidirectional value transformer applied on read (from) and write (to).
   * When both `transform` and `transformer` are set, `transformer.from` takes precedence.
   */
  transformer?: ColumnTransformer;

  /**
   * DB-level default value for the column.
   * - String/number/boolean values are used as literal defaults.
   * - Use a raw SQL string wrapped in parentheses for expressions: `"(CURRENT_TIMESTAMP)"`.
   *
   * @example
   * @Column({ default: 'active' })           // DEFAULT 'active'
   * @Column({ default: 0 })                  // DEFAULT 0
   * @Column({ default: true })               // DEFAULT TRUE (or 1 for MySQL)
   * @Column({ default: "(CURRENT_TIMESTAMP)" }) // DEFAULT CURRENT_TIMESTAMP
   */
  default?: string | number | boolean | null;

  /**
   * Primary key generation strategy.
   * - `"increment"`: auto-increment integer (default for @PrimaryGeneratedColumn())
   * - `"uuid"`: UUIDv4 (PG: gen_random_uuid() DB-side, MySQL/SQLite: crypto.randomUUID() app-side)
   * - `"uuid-v7"`: UUIDv7 time-sortable (app-side on all drivers)
   */
  generationStrategy?: "increment" | "uuid" | "uuid-v7";

  precision?: number;
  scale?: number;

  /**
   * List of values for the PostgreSQL ENUM type.
   * Used together with `type: "enum"`.
   *
   * @example
   * @Column({ type: "enum", enumName: "user_role", enumValues: ["admin", "user", "guest"] })
   * role: string;
   */
  enumValues?: string[];

  /**
   * Name of the PostgreSQL user-defined ENUM type.
   * Auto-generated as `${tableName}_${columnName}_enum` when omitted.
   */
  enumName?: string;

  /**
   * Element type for `type: "array"` columns (PostgreSQL native arrays).
   * A scalar built-in type such as `"text"`, `"int"`, `"uuid"`; defaults to
   * `"text"`, so `type: "array"` alone produces a `TEXT[]` column.
   *
   * PostgreSQL only — MySQL stores `"array"` columns as JSON and SQLite as
   * TEXT, where the element type is not representable and is ignored.
   * Note: PostgreSQL introspection reports every array column as `ARRAY`,
   * so schema diffing cannot detect element-type changes, and entity
   * generation from an existing schema recovers `type: "array"` without the
   * element type.
   *
   * @example
   * @Column({ type: "array", arrayElementType: "int" }) // INTEGER[]
   * scores!: number[];
   */
  arrayElementType?: ColumnType;
}

/**
 * Fully-resolved ColumnOption with type/length/nullable guaranteed to be set.
 * Represents the option after defaults have been applied inside the Column decorator.
 */
export type ResolvedColumnOption = Required<
  Pick<ColumnOption, "type" | "length" | "nullable">
> &
  Omit<ColumnOption, "type" | "length" | "nullable">;

/**
 * Infers the default column configuration from TypeScript's design:type metadata.
 *
 * The returned type is an **abstract ColumnType**; each DB driver's castType()
 * converts it to the actual database type.
 *
 * ## TypeScript → ColumnType mapping
 * | TS type   | ColumnType | default length | nullable |
 * |-----------|-----------|----------------|----------|
 * | String    | varchar   | 255            | false    |
 * | Number    | int       | 11             | false    |
 * | Boolean   | boolean   | 1              | false    |
 * | Date      | datetime  | 0              | false    |
 * | Buffer    | blob      | 0              | true     |
 * | (other)   | text      | 0              | true     |
 *
 * ## ColumnType → concrete DB type conversion (per driver)
 *
 * **MySQL/MariaDB:**
 * - `varchar` → `VARCHAR(n)`
 * - `int` → `INT(n)` (base type, no conversion)
 * - `boolean` → `TINYINT(1)`
 * - `datetime` → `DATETIME`
 * - `blob` → `BLOB`
 * - `text` → `TEXT`
 *
 * **PostgreSQL:**
 * - `varchar` → `VARCHAR(n)`
 * - `int` / `number` → `INTEGER`
 * - `boolean` → `BOOLEAN` (native)
 * - `datetime` → `TIMESTAMP`
 * - `blob` → `BYTEA`
 * - `text` → `TEXT`
 */
export function inferColumnDefaults(
  designType: any,
  where?: string,
): Pick<ResolvedColumnOption, "type" | "length" | "nullable"> {
  return resolveColumnDefaults(designType, where, false);
}

/**
 * Shared implementation behind `inferColumnDefaults`.
 *
 * `hasExplicitType` marks columns whose `@Column({ type })` was given by the
 * user, so inference is only filling in length/nullable:
 * - no fallback warnings are emitted (the fallback type is discarded anyway)
 * - when design:type metadata is missing entirely (builds without
 *   emitDecoratorMetadata: esbuild, tsx, swc, Vite), `nullable` defaults to
 *   `false` — what tsc-built code produces for String/Number/Boolean/Date
 *   properties — instead of silently drifting to `nullable: true`.
 * When design:type metadata is present, behavior is identical in both modes
 * so tsc-compiled entities are unaffected.
 */
function resolveColumnDefaults(
  designType: any,
  where: string | undefined,
  hasExplicitType: boolean,
): Pick<ResolvedColumnOption, "type" | "length" | "nullable"> {
  const at = where ? ` for ${where}` : "";
  switch (designType) {
    case String:
      return { type: "varchar", length: 255, nullable: false };
    case Number:
      return { type: "int", length: 11, nullable: false };
    case Boolean:
      return { type: "boolean", length: 1, nullable: false };
    case Date:
      return { type: "datetime", length: 0, nullable: false };
    case Buffer:
      return { type: "blob", length: 0, nullable: true };
    case undefined:
    case null:
      if (hasExplicitType) {
        return { type: "text", length: 0, nullable: false };
      }
      // design:type is missing entirely: the code was compiled without
      // emitDecoratorMetadata (esbuild, tsx, swc and Vite do not emit it),
      // or reflect-metadata was not imported before the entity was loaded.
      columnLogger.warn(
        `No design:type metadata${at} — falling back to "text". ` +
        `Decorator metadata is not emitted by your build tool (esbuild/tsx/swc/Vite) ` +
        `or "reflect-metadata" was imported too late. ` +
        `Fix: compile with emitDecoratorMetadata (tsc/ts-node), specify an explicit ` +
        `@Column({ type: "..." }), or define the entity with defineEntity().`,
      );
      return { type: "text", length: 0, nullable: true };
    default:
      if (!hasExplicitType) {
        columnLogger.warn(
          `Unknown design:type "${designType?.name ?? designType}"${at} — falling back to "text". ` +
          `Union and optional property types erase to Object at runtime; ` +
          `specify an explicit type in @Column({ type: "..." }) to avoid this.`,
        );
      }
      return { type: "text", length: 0, nullable: true };
  }
}

export const COLUMN_TOKEN = Symbol.for("STG_COLUMN");

/**
 * The Column decorator stores metadata for a column.
 * The metadata captures the column's name, options, and type.
 * JavaScript primitive types are set by default.
 *
 * When using a custom type, the ColumnTypeFactory must be consulted to resolve
 * the type during later object mapping.
 *
 * @param option
 * @returns
 */
export function Column(option?: ColumnOption): PropertyDecorator {
  return (target, propertyKey) => {
    const injectParam = ReflectManager.getType<any>(target, propertyKey);

    // Infer defaults from design:type, then overlay user options.
    // If the user overrides type without specifying length, discard the
    // inferred length (e.g. String → 255) because it is invalid for the new type (e.g. date).
    // With an explicit type no inference (and no missing-metadata warning) is needed.
    const where = `${target.constructor?.name ?? "?"}.${propertyKey.toString()}`;
    const defaults = resolveColumnDefaults(
      injectParam,
      where,
      option?.type !== undefined,
    );
    const typeOverridden =
      option?.type !== undefined && option.type !== defaults.type;
    const lengthNotProvided = option?.length === undefined;
    if (typeOverridden && lengthNotProvided) {
      (defaults as { length?: number }).length = undefined;
    }
    const resolvedOption: ResolvedColumnOption = {
      ...defaults,
      ...option,
    };

    const hasExplicitName = !!option?.name;
    const name = resolvedOption.name || propertyKey.toString();
    const metadata = <ColumnMetadata>{
      target,
      propertyKey: propertyKey.toString(),
      name,
      nameExplicit: hasExplicitName,
      options: resolvedOption,
      type: injectParam,
      transform: resolvedOption.transform,
      transformer: resolvedOption.transformer,
    };

    const columns: ColumnMetadata[] = Reflect.getMetadata(COLUMN_TOKEN, target) || [];
    const filtered = columns.filter((c) => c.propertyKey !== metadata.propertyKey);

    Reflect.defineMetadata(
      COLUMN_TOKEN,
      [...filtered, metadata],
      target,
    );

    const scanner = getScannerInstance(ColumnScanner);
    const uniqueKey = scanner.createUniqueKey();

    scanner.setOnPublic<ColumnMetadata>(uniqueKey, metadata);
  };
}
