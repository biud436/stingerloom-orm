/* eslint-disable @typescript-eslint/no-explicit-any */
import { getScannerInstance } from "../scanner/ScannerContainer";
import {
  ColumnScanner,
  EntityScanner,
  ManyToOneScanner,
  OneToManyScanner,
  ManyToManyScanner,
} from "../scanner";
import { OneToOneScanner } from "../scanner/OneToOneScanner";
import { createEntityKey } from "../utils/scanner";
import { camelToSnakeCase } from "../utils/camelToSnakeCase";
import { COLUMN_TOKEN, ColumnType, ResolvedColumnOption } from "../decorators/Column";
import { ENTITY_TOKEN } from "../decorators/Entity";
import { MANY_TO_ONE_TOKEN, ManyToOneMetadata } from "../decorators/ManyToOne";
import { ONE_TO_MANY_TOKEN, OneToManyMetadata } from "../decorators/OneToMany";
import { ONE_TO_ONE_TOKEN, OneToOneMetadata } from "../decorators/OneToOne";
import { MANY_TO_MANY_TOKEN, ManyToManyMetadata } from "../decorators/ManyToMany";
import { INDEX_TOKEN, COMPOSITE_INDEX_TOKEN, CompositeIndexMetadata } from "../decorators/Indexer";
import { UNIQUE_INDEX_TOKEN, UniqueIndexMetadata } from "../decorators/UniqueIndex";
import { VERSION_TOKEN } from "../decorators/Version";
import { CREATE_TIMESTAMP_TOKEN } from "../decorators/CreateTimestamp";
import { UPDATE_TIMESTAMP_TOKEN } from "../decorators/UpdateTimestamp";
import { DELETED_AT_TOKEN } from "../decorators/DeletedAt";
import { HOOK_TOKEN, HookMetadata } from "../decorators/Hooks";
import { VALIDATION_TOKEN, ValidationMetadata } from "../decorators/Validation";
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

  // Base defaults from type
  let length = 0;
  let nullable = false;
  switch (designType) {
    case String:
      length = 255;
      break;
    case Number:
      length = 11;
      break;
    case Boolean:
      length = 1;
      break;
    case Buffer:
      nullable = true;
      break;
  }

  return {
    type: def.type,
    length: def.length ?? length,
    nullable: def.nullable ?? nullable,
    name: def.name ?? propertyKey,
    primary: def.primary,
    autoIncrement: def.autoIncrement,
    default: def.default,
    precision: def.precision,
    scale: def.scale,
    enumValues: def.enumValues,
    enumName: def.enumName,
    transform: def.transform as any,
  };
}

/**
 * Registers EntitySchema definitions into the same metadata stores
 * used by decorators, so the rest of the ORM (EntityManager, SchemaGenerator, etc.)
 * works transparently.
 */
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
        options: resolvedOption,
        type: designType,
        transform: resolvedOption.transform as any,
      };

      // Store in Reflect (same as @Column)
      const existing = Reflect.getMetadata(COLUMN_TOKEN, proto) || [];
      Reflect.defineMetadata(COLUMN_TOKEN, [...existing, metadata], proto);

      // Store in Scanner (same as @Column)
      const uniqueKey = columnScanner.createUniqueKey();
      columnScanner.set<ColumnMetadata>(uniqueKey, metadata);
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
    def: { kind: "manyToOne"; target: () => ClazzType; joinColumn?: string; references?: string; eager?: boolean; cascade?: any; lazy?: boolean; onDelete?: any; onUpdate?: any; createForeignKeyConstraints?: boolean },
  ): void {
    const scanner = getScannerInstance(ManyToOneScanner);

    const metadata: ManyToOneMetadata<any> = {
      target: cls,
      type: def.target() as any,
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
    scanner.set<ManyToOneMetadata<any>>(uniqueKey, metadata);
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
    scanner.set<OneToManyMetadata<any>>(uniqueKey, metadata);
  }

  private static registerOneToOne(
    cls: ClazzType,
    propertyKey: string,
    def: { kind: "oneToOne"; target: () => ClazzType; joinColumn?: string; inverseSide?: string; eager?: boolean; cascade?: any; onDelete?: any; onUpdate?: any; createForeignKeyConstraints?: boolean },
  ): void {
    const scanner = getScannerInstance(OneToOneScanner);

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
    scanner.set<OneToOneMetadata<any>>(uniqueKey, metadata);
  }

  private static registerManyToMany(
    cls: ClazzType,
    propertyKey: string,
    def: { kind: "manyToMany"; target: () => ClazzType; joinTable?: any; mappedBy?: string; cascade?: any },
  ): void {
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
    scanner.set<ManyToManyMetadata<any>>(uniqueKey, metadata);
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

    // Composite non-unique indexes
    if (options.indexes) {
      const existing: CompositeIndexMetadata[] =
        Reflect.getMetadata(COMPOSITE_INDEX_TOKEN, cls) ?? [];
      Reflect.defineMetadata(
        COMPOSITE_INDEX_TOKEN,
        [...existing, ...options.indexes.map((idx) => ({ columns: idx.columns, name: idx.name }))],
        cls,
      );
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

  static registerEntity<T>(options: EntitySchemaOptions<T>): void {
    const scanner = getScannerInstance(EntityScanner);
    const columnScanner = getScannerInstance(ColumnScanner);
    const manyToOneScanner = getScannerInstance(ManyToOneScanner);
    const oneToManyScanner = getScannerInstance(OneToManyScanner);
    const oneToOneScanner = getScannerInstance(OneToOneScanner);
    const manyToManyScanner = getScannerInstance(ManyToManyScanner);

    const cls = options.target;
    const proto = cls.prototype;

    const nameKey = options.tableName || camelToSnakeCase(cls.name);
    const name = createEntityKey(nameKey);

    // Filter metadata by target (same as @Entity decorator)
    const columns = columnScanner
      .allMetadata<ColumnMetadata>()
      .filter((c) => c.target === proto);
    const manyToOnes = manyToOneScanner
      .allMetadata<ManyToOneMetadata<unknown>>()
      .filter((m) => (m.target as Function) === cls);
    const oneToManys = oneToManyScanner
      .allMetadata<OneToManyMetadata<unknown>>()
      .filter((m) => (m.target as Function) === cls);
    const oneToOnes = oneToOneScanner
      .allMetadata<OneToOneMetadata<unknown>>()
      .filter((m) => (m.target as Function) === cls);
    const manyToManys = manyToManyScanner
      .allMetadata<ManyToManyMetadata<unknown>>()
      .filter((m) => (m.target as Function) === cls);

    const entityOption = options.tableName ? { name: options.tableName } : undefined;

    const metadata = {
      target: cls,
      columns,
      manyToOnes,
      oneToManys,
      oneToOnes,
      manyToManys,
      options: entityOption,
      name: nameKey,
    };

    scanner.set(name, metadata);
    Reflect.defineMetadata(ENTITY_TOKEN, metadata, cls);
  }
}
