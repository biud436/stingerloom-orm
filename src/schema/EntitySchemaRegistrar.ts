/* eslint-disable @typescript-eslint/no-explicit-any */
import { getScannerInstance } from "../scanner/ScannerContainer";
import {
  ColumnScanner,
  ManyToOneScanner,
  OneToManyScanner,
  ManyToManyScanner,
} from "../scanner";
import { OneToOneScanner } from "../scanner/OneToOneScanner";
import { Logger } from "../utils/Logger";
import { COLUMN_TOKEN, ColumnType, KnownColumnType, ResolvedColumnOption, inferColumnDefaults } from "../decorators/Column";
import { registerEntityMetadata } from "../decorators/Entity";
import { MANY_TO_ONE_TOKEN, ManyToOneMetadata } from "../decorators/ManyToOne";
import { ONE_TO_MANY_TOKEN, OneToManyMetadata } from "../decorators/OneToMany";
import { ONE_TO_ONE_TOKEN, OneToOneMetadata } from "../decorators/OneToOne";
import { MANY_TO_MANY_TOKEN, ManyToManyMetadata, validateJoinTableOption } from "../decorators/ManyToMany";
import { INDEX_TOKEN, COMPOSITE_INDEX_TOKEN, CompositeIndexMetadata } from "../decorators/Indexer";
import { UNIQUE_INDEX_TOKEN, UniqueIndexMetadata } from "../decorators/UniqueIndex";
import { VERSION_TOKEN } from "../decorators/Version";
import { CREATE_TIMESTAMP_TOKEN } from "../decorators/CreateTimestamp";
import { UPDATE_TIMESTAMP_TOKEN } from "../decorators/UpdateTimestamp";
import { DELETED_AT_TOKEN } from "../decorators/DeletedAt";
import { HOOK_TOKEN, HookMetadata } from "../decorators/Hooks";
import { VALIDATION_TOKEN, ValidationMetadata } from "../decorators/Validation";
import { INHERITANCE_TOKEN } from "../decorators/Inheritance";
import { DISCRIMINATOR_COLUMN_TOKEN } from "../decorators/DiscriminatorColumn";
import { DISCRIMINATOR_VALUE_TOKEN } from "../decorators/DiscriminatorValue";
import { ComputedColumn } from "../decorators/ComputedColumn";
import { FullTextIndex } from "../decorators/FullTextIndex";
import { JsonIndex } from "../decorators/JsonIndex";
import { RelationColumn } from "../decorators/RelationColumn";
import {
  TENANT_COLUMN_TOKEN,
  TenantColumnMetadata,
  NonTenantEntity,
} from "../decorators/TenantColumn";
import { ColumnMetadata } from "../scanner/ColumnScanner";
import { ClazzType } from "../utils/types";
import {
  EntitySchemaOptions,
  ColumnSchemaDef,
  RelationSchemaDef,
} from "./EntitySchemaTypes";

/**
 * Maps ColumnType to the JS constructor that design:type would normally produce.
 * This allows EntitySchema to work without emitDecoratorMetadata.
 */
function columnTypeToDesignType(type: ColumnType): any {
  switch (type) {
    case "int":
    case "number":
    case "float":
    case "double":
    case "bigint":
      return Number;
    case "boolean":
      return Boolean;
    case "datetime":
    case "timestamp":
    case "timestamptz":
    case "date":
      return Date;
    case "blob":
      return Buffer;
    case "varchar":
    case "char":
    case "text":
    case "longtext":
    case "enum":
    case "json":
    case "jsonb":
    case "array":
    default:
      return String;
  }
}

/**
 * Resolves column defaults from the ColumnSchemaDef type,
 * mirroring what inferColumnDefaults() does for design:type.
 */
function resolveColumnOption(
  def: ColumnSchemaDef,
  propertyKey: string,
): ResolvedColumnOption {
  const designType = columnTypeToDesignType(def.type);

  // Mirror @Column: take the design-type defaults, but discard the inferred
  // length when the explicit column type differs from the inferred one —
  // String's varchar(255) is invalid for text/uuid/enum/..., and a phantom
  // length makes MySQL SchemaDiff emit (narrowing) ALTERs on every boot.
  const defaults = inferColumnDefaults(designType);
  if (def.type !== defaults.type && def.length === undefined) {
    (defaults as { length?: number }).length = undefined;
  }

  return {
    type: def.type,
    length: (def.length ?? defaults.length) as number,
    nullable: def.nullable ?? defaults.nullable,
    name: def.name ?? propertyKey,
    primary: def.primary,
    autoIncrement: def.autoIncrement,
    default: def.default,
    precision: def.precision,
    scale: def.scale,
    enumValues: def.enumValues,
    enumName: def.enumName,
    renamedFrom: def.renamedFrom,
    arrayElementType: def.arrayElementType,
    bigintMode: def.bigintMode,
    generationStrategy: def.generationStrategy,
    transform: def.transform as any,
    transformer: def.transformer,
  };
}

/**
 * Registers EntitySchema definitions into the same metadata stores
 * used by decorators, so the rest of the ORM (EntityManager, SchemaGenerator, etc.)
 * works transparently.
 */
const entitySchemaLogger = new Logger("EntitySchema");

export class EntitySchemaRegistrar {
  static registerColumns<T>(options: EntitySchemaOptions<T>): void {
    const proto = options.target.prototype;
    const columnScanner = getScannerInstance(ColumnScanner);

    for (const [key, def] of Object.entries<ColumnSchemaDef>(
      options.columns as Record<string, ColumnSchemaDef>,
    )) {
      const designType = columnTypeToDesignType(def.type);
      const resolvedOption = resolveColumnOption(def, key);

      // Set design:type metadata (replaces emitDecoratorMetadata)
      Reflect.defineMetadata("design:type", designType, proto, key);

      const metadata: ColumnMetadata = {
        target: proto,
        propertyKey: key,
        name: resolvedOption.name || key,
        // Mirror @Column: when the user provides an explicit name, mark it so
        // applyNamingStrategyToEntities() preserves it instead of re-deriving
        // the DB column name from the property key (#name-drift).
        nameExplicit: !!def.name,
        options: resolvedOption,
        type: designType,
        transform: resolvedOption.transform as any,
        transformer: resolvedOption.transformer,
      };

      // Store in Reflect (same as @Column)
      const existing = Reflect.getMetadata(COLUMN_TOKEN, proto) || [];
      Reflect.defineMetadata(COLUMN_TOKEN, [...existing, metadata], proto);

      // Store in Scanner (same as @Column)
      const uniqueKey = columnScanner.createUniqueKey();
      columnScanner.setOnPublic<ColumnMetadata>(uniqueKey, metadata);
    }
  }

  static registerRelations<T>(options: EntitySchemaOptions<T>): void {
    if (!options.relations) return;

    const cls = options.target;

    for (const [key, rawDef] of Object.entries(options.relations)) {
      if (!rawDef) continue;
      const def = rawDef as RelationSchemaDef;

      switch (def.kind) {
        case "manyToOne":
          this.registerManyToOne(cls, key, def);
          break;
        case "oneToMany":
          this.registerOneToMany(cls, key, def);
          break;
        case "oneToOne":
          this.registerOneToOne(cls, key, def);
          break;
        case "manyToMany":
          this.registerManyToMany(cls, key, def);
          break;
      }
    }
  }

  private static registerManyToOne(
    cls: ClazzType,
    propertyKey: string,
    def: { kind: "manyToOne"; target: () => ClazzType; joinColumn?: string; references?: string; eager?: boolean; cascade?: any; lazy?: boolean; onDelete?: any; onUpdate?: any; createForeignKeyConstraints?: boolean; relationColumn?: any },
  ): void {
    const scanner = getScannerInstance(ManyToOneScanner);

    // @RelationColumn equivalent — explicit FK column metadata.
    if (def.relationColumn) {
      RelationColumn(def.relationColumn)(cls.prototype, propertyKey);
    }

    const metadata: ManyToOneMetadata<any> = {
      target: cls,
      // Resolved lazily: the thunk exists so forward/circular references are
      // legal at module load time — @ManyToOne never calls it at decoration
      // time either. Eager evaluation here throws (TDZ) or captures undefined.
      get type() {
        return def.target() as any;
      },
      columnName: propertyKey,
      joinColumn: def.joinColumn,
      references: def.references,
      getMappingEntity: def.target as any,
      getMappingProperty: ((e: any) => e[propertyKey]) as any,
      option: {
        joinColumn: def.joinColumn,
        references: def.references,
        eager: def.eager,
        cascade: def.cascade,
        lazy: def.lazy,
        onDelete: def.onDelete,
        onUpdate: def.onUpdate,
        createForeignKeyConstraints: def.createForeignKeyConstraints,
      },
    };

    const existing = Reflect.getMetadata(MANY_TO_ONE_TOKEN, cls) || [];
    Reflect.defineMetadata(MANY_TO_ONE_TOKEN, [...existing, metadata], cls);

    const uniqueKey = scanner.createUniqueKey();
    scanner.setOnPublic<ManyToOneMetadata<any>>(uniqueKey, metadata);
  }

  private static registerOneToMany(
    cls: ClazzType,
    propertyKey: string,
    def: { kind: "oneToMany"; target: () => ClazzType; mappedBy: string; cascade?: any },
  ): void {
    const scanner = getScannerInstance(OneToManyScanner);

    const metadata: OneToManyMetadata<any> = {
      target: cls,
      propertyKey,
      getRelatedEntity: def.target,
      mappedBy: def.mappedBy,
      cascade: def.cascade,
    };

    const existing = Reflect.getMetadata(ONE_TO_MANY_TOKEN, cls) || [];
    Reflect.defineMetadata(ONE_TO_MANY_TOKEN, [...existing, metadata], cls);

    const uniqueKey = scanner.createUniqueKey();
    scanner.setOnPublic<OneToManyMetadata<any>>(uniqueKey, metadata);
  }

  private static registerOneToOne(
    cls: ClazzType,
    propertyKey: string,
    def: { kind: "oneToOne"; target: () => ClazzType; joinColumn?: string; inverseSide?: string; eager?: boolean; cascade?: any; onDelete?: any; onUpdate?: any; createForeignKeyConstraints?: boolean; relationColumn?: any },
  ): void {
    const scanner = getScannerInstance(OneToOneScanner);

    // @RelationColumn equivalent — explicit FK column metadata.
    if (def.relationColumn) {
      RelationColumn(def.relationColumn)(cls.prototype, propertyKey);
    }

    const metadata: OneToOneMetadata<any> = {
      target: cls,
      propertyKey,
      getRelatedEntity: def.target,
      joinColumn: def.joinColumn,
      inverseSide: def.inverseSide,
      option: {
        joinColumn: def.joinColumn,
        inverseSide: def.inverseSide,
        eager: def.eager,
        cascade: def.cascade,
        onDelete: def.onDelete,
        onUpdate: def.onUpdate,
        createForeignKeyConstraints: def.createForeignKeyConstraints,
      },
    };

    const existing = Reflect.getMetadata(ONE_TO_ONE_TOKEN, cls) || [];
    Reflect.defineMetadata(ONE_TO_ONE_TOKEN, [...existing, metadata], cls);

    const uniqueKey = scanner.createUniqueKey();
    scanner.setOnPublic<OneToOneMetadata<any>>(uniqueKey, metadata);
  }

  private static registerManyToMany(
    cls: ClazzType,
    propertyKey: string,
    def: { kind: "manyToMany"; target: () => ClazzType; joinTable?: any; mappedBy?: string; cascade?: any },
  ): void {
    // Plain-JS consumers bypass the JoinTableOption compile-time shape —
    // fail fast with a clear error instead of a TypeError during schema sync.
    validateJoinTableOption(def.joinTable, cls.name, propertyKey);

    const scanner = getScannerInstance(ManyToManyScanner);

    const metadata: ManyToManyMetadata<any> = {
      target: cls,
      propertyKey,
      getRelatedEntity: def.target,
      joinTable: def.joinTable,
      mappedBy: def.mappedBy,
      cascade: def.cascade,
    };

    const existing = Reflect.getMetadata(MANY_TO_MANY_TOKEN, cls) || [];
    Reflect.defineMetadata(MANY_TO_MANY_TOKEN, [...existing, metadata], cls);

    const uniqueKey = scanner.createUniqueKey();
    scanner.setOnPublic<ManyToManyMetadata<any>>(uniqueKey, metadata);
  }

  static registerSpecialTokens<T>(options: EntitySchemaOptions<T>): void {
    const cls = options.target;

    for (const [key, def] of Object.entries<ColumnSchemaDef>(
      options.columns as Record<string, ColumnSchemaDef>,
    )) {
      if (def.version) {
        Reflect.defineMetadata(VERSION_TOKEN, key, cls);
      }
      if (def.createTimestamp) {
        Reflect.defineMetadata(CREATE_TIMESTAMP_TOKEN, key, cls);
      }
      if (def.updateTimestamp) {
        Reflect.defineMetadata(UPDATE_TIMESTAMP_TOKEN, key, cls);
      }
      if (def.deletedAt) {
        Reflect.defineMetadata(DELETED_AT_TOKEN, key, cls);
      }
      // @TenantColumn equivalent — marks the column readable as the tenant
      // discriminator. The column itself is already declared in `columns`.
      if (def.tenant) {
        const metadata: TenantColumnMetadata = {
          propertyKey: key,
          name: def.name,
          type: (def.type ?? "varchar") as KnownColumnType,
          length: def.length,
        };
        Reflect.defineMetadata(TENANT_COLUMN_TOKEN, metadata, cls);
      }
    }

    // @NonTenantEntity equivalent — opt this entity out of tenant scoping.
    if (options.nonTenant) {
      NonTenantEntity()(cls as any);
    }
  }

  /**
   * Registers `@ComputedColumn` equivalents. Stored on the prototype under
   * COMPUTED_COLUMN_TOKEN — the same location the decorator uses — so
   * SchemaGenerator and EntityManager pick them up transparently.
   */
  static registerComputedColumns<T>(options: EntitySchemaOptions<T>): void {
    if (!options.computedColumns) return;

    const proto = options.target.prototype;
    for (const [key, opt] of Object.entries(options.computedColumns)) {
      if (!opt) continue;
      ComputedColumn(opt as any)(proto, key);
    }
  }

  static registerIndexes<T>(options: EntitySchemaOptions<T>): void {
    const proto = options.target.prototype;
    const cls = options.target;

    // Per-column indexes
    for (const [key, def] of Object.entries<ColumnSchemaDef>(
      options.columns as Record<string, ColumnSchemaDef>,
    )) {
      if (def.index) {
        const designType = columnTypeToDesignType(def.type);
        const existing = Reflect.getMetadata(INDEX_TOKEN, proto) || [];
        Reflect.defineMetadata(
          INDEX_TOKEN,
          [...existing, { target: proto, name: key, type: designType }],
          proto,
        );
      }
      // @JsonIndex equivalent — JSON/JSONB expression index on this column.
      if (def.jsonIndex) {
        JsonIndex(def.jsonIndex)(proto, key);
      }
    }

    // Composite unique indexes
    if (options.uniqueIndexes) {
      const existing: UniqueIndexMetadata[] =
        Reflect.getMetadata(UNIQUE_INDEX_TOKEN, cls) ?? [];
      Reflect.defineMetadata(
        UNIQUE_INDEX_TOKEN,
        [...existing, ...options.uniqueIndexes],
        cls,
      );
    }

    // Composite non-unique indexes (advanced options preserved)
    if (options.indexes) {
      const existing: CompositeIndexMetadata[] =
        Reflect.getMetadata(COMPOSITE_INDEX_TOKEN, cls) ?? [];
      Reflect.defineMetadata(
        COMPOSITE_INDEX_TOKEN,
        [
          ...existing,
          ...options.indexes.map((idx) => ({
            columns: idx.columns,
            name: idx.name ?? idx.options?.name,
            options: idx.options,
          })),
        ],
        cls,
      );
    }

    // @FullTextIndex equivalent
    if (options.fullTextIndexes) {
      for (const ft of options.fullTextIndexes) {
        FullTextIndex(ft.columns, { name: ft.name, language: ft.language })(
          cls as any,
        );
      }
    }
  }

  static registerHooks<T>(options: EntitySchemaOptions<T>): void {
    if (!options.hooks) return;

    const cls = options.target;
    const hooks: HookMetadata[] = [];

    for (const [event, methodName] of Object.entries(options.hooks)) {
      if (methodName) {
        hooks.push({ methodName, event: event as any });
      }
    }

    if (hooks.length > 0) {
      const existing: HookMetadata[] =
        Reflect.getMetadata(HOOK_TOKEN, cls) || [];
      Reflect.defineMetadata(HOOK_TOKEN, [...existing, ...hooks], cls);
    }
  }

  static registerValidation<T>(options: EntitySchemaOptions<T>): void {
    const cls = options.target;
    const validations: ValidationMetadata[] = [];

    for (const [key, def] of Object.entries<ColumnSchemaDef>(
      options.columns as Record<string, ColumnSchemaDef>,
    )) {
      if (!def.validation) continue;

      for (const v of def.validation) {
        validations.push({
          propertyKey: key,
          constraint: v.constraint,
          value: v.value,
          message:
            v.message || `${key} failed ${v.constraint} validation`,
        });
      }
    }

    if (validations.length > 0) {
      const existing: ValidationMetadata[] =
        Reflect.getMetadata(VALIDATION_TOKEN, cls) ?? [];
      Reflect.defineMetadata(
        VALIDATION_TOKEN,
        [...existing, ...validations],
        cls,
      );
    }
  }

  static registerInheritance<T>(options: EntitySchemaOptions<T>): void {
    const cls = options.target;

    // Root entity: set @Inheritance + @DiscriminatorColumn metadata
    if (options.inheritance) {
      Reflect.defineMetadata(
        INHERITANCE_TOKEN,
        { strategy: options.inheritance.strategy, target: cls },
        cls,
      );

      const dcMeta = {
        name: options.discriminatorColumn?.name ?? "dtype",
        type: (options.discriminatorColumn?.type ?? "varchar") as KnownColumnType,
        length: options.discriminatorColumn?.length ?? 31,
      };
      Reflect.defineMetadata(DISCRIMINATOR_COLUMN_TOKEN, dcMeta, cls);
    }

    // Child entity: set @DiscriminatorValue metadata
    if (options.discriminatorValue !== undefined) {
      Reflect.defineMetadata(
        DISCRIMINATOR_VALUE_TOKEN,
        options.discriminatorValue,
        cls,
      );
    }
  }

  static registerEntity<T>(options: EntitySchemaOptions<T>): void {
    const entityOption =
      options.tableName || options.schema
        ? {
            ...(options.tableName ? { name: options.tableName } : {}),
            ...(options.schema ? { schema: options.schema } : {}),
          }
        : undefined;

    registerEntityMetadata(options.target, {
      name: options.tableName,
      schema: options.schema,
      options: entityOption,
      logger: entitySchemaLogger,
      describeSchemaOption: (schema) => `EntitySchema { schema: "${schema}" }`,
    });
  }
}
