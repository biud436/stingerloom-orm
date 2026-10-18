/* eslint-disable @typescript-eslint/no-explicit-any */
import { getScannerInstance } from "../scanner/ScannerContainer";
import { ColumnScanner, EntityScanner, ManyToOneScanner, OneToManyScanner, ManyToManyScanner } from "../scanner";
import { OneToOneScanner } from "../scanner/OneToOneScanner";
import { createEntityKey } from "../utils/scanner";
import { ColumnOption } from "./Column";
import { ClazzType } from "../utils";
import { ManyToOneMetadata } from "./ManyToOne";
import { OneToManyMetadata } from "./OneToMany";
import { OneToOneMetadata } from "./OneToOne";
import { ManyToManyMetadata } from "./ManyToMany";
import { ColumnMetadata } from "../scanner/ColumnScanner";
import { camelToSnakeCase } from "../utils/camelToSnakeCase";
import { INHERITANCE_TOKEN, InheritanceStrategy } from "./Inheritance";
import { DISCRIMINATOR_COLUMN_TOKEN } from "./DiscriminatorColumn";
import { DISCRIMINATOR_VALUE_TOKEN } from "./DiscriminatorValue";
import { KnownColumnType } from "./Column";
import { Logger } from "../utils/Logger";

const entityLogger = new Logger("Entity");

export interface EntityOption {
  name?: string;
  /**
   * PostgreSQL schema the table lives in.
   *
   * Pins the entity to that schema: every statement names the table as
   * `"schema"."table"` no matter which tenant context is active, and the
   * multi-tenant strategies (`search_path`, `schema_qualified`) never
   * redirect it. Use it for tables shared by every tenant — a `plans` or
   * `countries` table that stays in `public` while tenant data lives in
   * per-tenant schemas. Synchronize creates the table (and the schema, when
   * missing) there, and `PostgresTenantMigrationRunner` skips it when it
   * clones the source schema into a new tenant.
   *
   * Children of a JOINED (TPT) hierarchy inherit the root's schema unless
   * they pin their own table elsewhere; SINGLE_TABLE children share the
   * root's table and therefore its schema (their own `schema` is ignored
   * with a warning). Ignored on MySQL and SQLite.
   */
  schema?: string;
}

export const ENTITY_TOKEN = Symbol.for("STG_ENTITY");

export type EntityMetadata<T = any> = {
  target: ClazzType<T>;
  name: string;
  /** True when the user explicitly provided `@Entity({ name: "..." })`. */
  nameExplicit?: boolean;
  /**
   * PostgreSQL schema this entity is pinned to via `@Entity({ schema })`
   * (or inherited from the inheritance root). Undefined means the table
   * follows the connection's default schema and the tenant strategy.
   */
  schema?: string;
  /** Raw class name before NamingStrategy transformation. */
  rawClassName?: string;
  columns: ColumnOption[];
  manyToOnes?: ManyToOneMetadata<unknown>[];
  oneToManys?: OneToManyMetadata<unknown>[];
  oneToOnes?: OneToOneMetadata<unknown>[];
  manyToManys?: ManyToManyMetadata<unknown>[];
  options?: EntityOption;
  /** Root entity of the inheritance hierarchy (set on children). */
  inheritanceRoot?: ClazzType<any>;
  /** Inheritance strategy for this entity hierarchy. */
  inheritanceStrategy?: InheritanceStrategy;
  /** Discriminator value for this entity (STI/TPT). */
  discriminatorValue?: string;
  /** Discriminator column definition (only on root entity). */
  discriminatorColumn?: { name: string; type: KnownColumnType; length: number };
  /** Child entity classes in this inheritance hierarchy (only on root entity). */
  childEntities?: ClazzType<any>[];
};

export function Entity(options?: EntityOption): ClassDecorator {
  return function (target) {
    registerEntityMetadata(target as unknown as ClazzType<any>, {
      name: options?.name,
      schema: options?.schema,
      options,
      logger: entityLogger,
      describeSchemaOption: (schema) => `@Entity({ schema: "${schema}" })`,
    });
  };
}

/**
 * What a declaration path (`@Entity` or `EntitySchema`) hands to
 * {@link registerEntityMetadata}.
 */
export interface EntityDeclaration {
  /** Explicit table name; when omitted the snake_cased class name is used. */
  name?: string;
  /** Explicit PostgreSQL schema pin. */
  schema?: string;
  /** Stored as-is on `EntityMetadata.options`. */
  options?: EntityOption;
  /** Where the warning about an STI child's ignored `schema` goes. */
  logger: Logger;
  /** How that warning names the option the user wrote. */
  describeSchemaOption: (schema: string) => string;
}

/**
 * Builds the entity metadata shared by `@Entity` and `EntitySchema` and
 * registers it on the entity scanner and on the class.
 *
 * Columns and relations declared on the class and its ancestors are
 * included; the inheritance fields come from {@link resolveInheritanceMetadata}.
 */
export function registerEntityMetadata(
  target: ClazzType<any>,
  declaration: EntityDeclaration,
): void {
  const scanner = getScannerInstance(EntityScanner);
  const columnScanner = getScannerInstance(ColumnScanner);
  const manyToOneScanner = getScannerInstance(ManyToOneScanner);
  const oneToManyScanner = getScannerInstance(OneToManyScanner);
  const oneToOneScanner = getScannerInstance(OneToOneScanner);
  const manyToManyScanner = getScannerInstance(ManyToManyScanner);

  // Target-based filtering: collect metadata from this class and its ancestors (inheritance support).
  // @Column target is the prototype; @ManyToOne/@OneToMany/@OneToOne/@ManyToMany targets are constructors.
  const protoChain: object[] = [];
  let current = target.prototype;
  while (current && current !== Object.prototype) {
    protoChain.push(current);
    current = Object.getPrototypeOf(current);
  }

  const constructorChain: Function[] = [];
  let ctor: Function = target;
  while (ctor && ctor !== Function.prototype && ctor !== Object) {
    constructorChain.push(ctor);
    ctor = Object.getPrototypeOf(ctor);
  }

  const inheritance = resolveInheritanceMetadata(
    target,
    constructorChain,
    declaration,
  );

  const columns = columnScanner
    .allMetadata<ColumnMetadata>()
    .filter((c) => protoChain.includes(c.target as object));
  const manyToOnes = manyToOneScanner
    .allMetadata<ManyToOneMetadata<unknown>>()
    .filter((m) => constructorChain.includes(m.target as Function));
  const oneToManys = oneToManyScanner
    .allMetadata<OneToManyMetadata<unknown>>()
    .filter((m) => constructorChain.includes(m.target as Function));
  const oneToOnes = oneToOneScanner
    .allMetadata<OneToOneMetadata<unknown>>()
    .filter((m) => constructorChain.includes(m.target as Function));
  const manyToManys = manyToManyScanner
    .allMetadata<ManyToManyMetadata<unknown>>()
    .filter((m) => constructorChain.includes(m.target as Function));

  const metadata: EntityMetadata = {
    target,
    columns,
    manyToOnes,
    oneToManys,
    oneToOnes,
    manyToManys,
    options: declaration.options,
    name: inheritance.name,
    nameExplicit: !!declaration.name,
    ...(inheritance.schema !== undefined ? { schema: inheritance.schema } : {}),
    rawClassName: target.name,
    inheritanceRoot: inheritance.inheritanceRoot,
    inheritanceStrategy: inheritance.inheritanceStrategy,
    discriminatorValue: inheritance.discriminatorValue,
    discriminatorColumn: inheritance.discriminatorColumn,
    childEntities: inheritance.childEntities,
  };

  // Scanner key must be unique per class — use the class's own name,
  // NOT the table name (which may be shared in STI hierarchies).
  const scannerKey = createEntityKey(camelToSnakeCase(target.name));
  scanner.setOnPublic(scannerKey, metadata);

  Reflect.defineMetadata(ENTITY_TOKEN, metadata, target);
}

type ResolvedInheritance = Pick<
  EntityMetadata,
  | "name"
  | "schema"
  | "inheritanceRoot"
  | "inheritanceStrategy"
  | "discriminatorValue"
  | "discriminatorColumn"
  | "childEntities"
>;

/**
 * Resolves the class's place in an inheritance hierarchy, together with the
 * table name and schema that place implies.
 *
 * A child is also appended to its root's `childEntities`, so the root must
 * be registered first — which decorator and `EntitySchema` order guarantee.
 */
function resolveInheritanceMetadata(
  target: ClazzType<any>,
  constructorChain: Function[],
  declaration: EntityDeclaration,
): ResolvedInheritance {
  const hasExplicitName = !!declaration.name;
  let nameKey = declaration.name || camelToSnakeCase(target.name);
  let schemaKey: string | undefined = declaration.schema || undefined;

  let inheritanceRoot: ClazzType<any> | undefined;
  let inheritanceStrategy: InheritanceStrategy | undefined;
  let discriminatorValue: string | undefined;
  let discriminatorColumn:
    | { name: string; type: KnownColumnType; length: number }
    | undefined;
  let childEntities: ClazzType<any>[] | undefined;

  // Check if THIS class is the inheritance root (use getOwnMetadata to avoid
  // finding parent's @Inheritance via prototype chain traversal)
  const inheritanceMeta = Reflect.getOwnMetadata(INHERITANCE_TOKEN, target);
  if (inheritanceMeta) {
    inheritanceStrategy = inheritanceMeta.strategy;
    const dcMeta = Reflect.getOwnMetadata(DISCRIMINATOR_COLUMN_TOKEN, target);
    discriminatorColumn = dcMeta ?? {
      name: "dtype",
      type: "varchar" as KnownColumnType,
      length: 31,
    };
    childEntities = [];
    // Root entity's own discriminator value
    discriminatorValue =
      Reflect.getOwnMetadata(DISCRIMINATOR_VALUE_TOKEN, target) ?? target.name;
  } else {
    // Walk up the constructor chain to find the ancestor with @Inheritance (the root).
    // Use getOwnMetadata so intermediate classes (B in A→B→C) don't
    // falsely match due to prototype-chain traversal.
    for (let i = 1; i < constructorChain.length; i++) {
      const parent = constructorChain[i];
      const parentInheritance = Reflect.getOwnMetadata(
        INHERITANCE_TOKEN,
        parent,
      );
      if (parentInheritance) {
        inheritanceRoot = parent as ClazzType<any>;
        inheritanceStrategy = parentInheritance.strategy;

        // Read discriminator value (default: class name)
        discriminatorValue =
          Reflect.getOwnMetadata(DISCRIMINATOR_VALUE_TOKEN, target) ??
          target.name;

        // Read discriminator column from root
        discriminatorColumn =
          Reflect.getOwnMetadata(DISCRIMINATOR_COLUMN_TOKEN, parent) ?? {
            name: "dtype",
            type: "varchar" as KnownColumnType,
            length: 31,
          };

        const rootMeta = Reflect.getOwnMetadata(ENTITY_TOKEN, parent) as
          | EntityMetadata
          | undefined;

        // For STI: use the root's table name (all subclasses share one table)
        if (inheritanceStrategy === "SINGLE_TABLE" && !hasExplicitName) {
          if (rootMeta) {
            nameKey = rootMeta.name;
          }
        }

        // Register this child in the root's metadata
        if (rootMeta?.childEntities) {
          rootMeta.childEntities.push(target);
        }
        // A TPT child references the root by FK, so it lives in the root's
        // schema unless it pins its own table elsewhere. An STI child
        // *shares* the root's table and can only be where that table is,
        // so its own `schema` is ignored (with a warning when it differs).
        if (inheritanceStrategy === "SINGLE_TABLE") {
          if (schemaKey !== undefined && schemaKey !== rootMeta?.schema) {
            declaration.logger.warn(
              `${declaration.describeSchemaOption(schemaKey)} on ${target.name} is ignored: ` +
                `it is a SINGLE_TABLE child of ${parent.name} and shares its table "${rootMeta?.name ?? nameKey}"` +
                (rootMeta?.schema
                  ? ` in schema "${rootMeta.schema}".`
                  : " in the default schema."),
            );
          }
          schemaKey = rootMeta?.schema;
        } else if (schemaKey === undefined && rootMeta?.schema) {
          schemaKey = rootMeta.schema;
        }

        break;
      }
    }
  }

  return {
    name: nameKey,
    schema: schemaKey,
    inheritanceRoot,
    inheritanceStrategy,
    discriminatorValue,
    discriminatorColumn,
    childEntities,
  };
}

/**
 * Returns the PostgreSQL schema an entity is pinned to via
 * `@Entity({ schema })` (or `schema` in `defineEntity` / `EntitySchema`),
 * or `undefined` when the table follows the connection default and the
 * tenant strategy.
 */
export function getEntitySchema(entity: Function): string | undefined {
  const meta = Reflect.getMetadata(ENTITY_TOKEN, entity) as
    | EntityMetadata
    | undefined;
  return meta?.schema;
}
