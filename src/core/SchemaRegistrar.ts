/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType, ReflectManager, Logger } from "../utils";
import {
  ColumnMetadata,
  EntityScannerMetadata,
  EntityScanner,
} from "../scanner";
import { getScannerInstance } from "../scanner/ScannerContainer";
import { PostgresDriver } from "../dialects/postgres/PostgresDriver";
import { SchemaGenerator, SchemaDialect } from "./generators/SchemaGenerator";
import {
  NamingStrategy,
  DefaultNamingStrategy,
} from "./generators/NamingStrategy";
import { INDEX_TOKEN, IndexMetadata } from "../decorators/Indexer";
import {
  UNIQUE_INDEX_TOKEN,
  UniqueIndexMetadata,
} from "../decorators/UniqueIndex";
import {
  ENTITY_TOKEN,
  MANY_TO_MANY_TOKEN,
  ManyToManyMetadata,
  COLUMN_TOKEN,
} from "../decorators";
import { EntityMetadataNotFoundError } from "../errors/EntityMetadataNotFoundError";
import { EntityNotFound } from "../dialects/EntityNotFound";
import { InvalidQueryError } from "../errors/InvalidQueryError";
import { PrimaryKeyNotFoundError } from "../errors/PrimaryKeyNotFoundError";
import { RelationMetadataResolver } from "./RelationMetadataResolver";
import { EntityManagerInternals } from "./EntityManagerInternals";
import {
  SchemaDiff,
  ColumnChange,
  SchemaDiffResult,
} from "./generators/SchemaDiff";
import { InheritanceResolver } from "./InheritanceResolver";
import { EntityMetadata } from "../decorators/Entity";
import {
  getTenantColumnMetadata,
  isNonTenantEntity,
} from "../decorators/TenantColumn";

/**
 * DDL / schema synchronization handler that runs once at application start.
 * It is not involved in runtime CRUD.
 */
export class SchemaRegistrar {
  private readonly namingStrategy: NamingStrategy;
  private readonly logger = new Logger(SchemaRegistrar.name);
  private readonly inheritanceResolver = new InheritanceResolver();

  constructor(
    private readonly resolver: RelationMetadataResolver,
    private readonly ctx: EntityManagerInternals,
    namingStrategy?: NamingStrategy,
  ) {
    this.namingStrategy = namingStrategy ?? new DefaultNamingStrategy();
  }

  async registerEntities() {
    const entityScanner = getScannerInstance(EntityScanner);
    const entities = entityScanner.makeEntities();

    let entity: IteratorResult<EntityScannerMetadata>;

    const syncOption = this.ctx.getSynchronize();
    const synchronize = !!syncOption; // truthy for true, 'safe', 'dry-run'
    const isDryRun = syncOption === "dry-run";
    const isSafe = syncOption === "safe";

    if (
      syncOption === true &&
      process.env.NODE_ENV === "production" &&
      process.env.STINGERLOOM_ALLOW_SYNC_IN_PROD !== "true"
    ) {
      this.logger.warn(
        "synchronize: true is enabled with NODE_ENV=production. " +
          "This will run destructive DDL (ADD/ALTER/DROP/RENAME) against the live database and can cause DATA LOSS. " +
          "Use synchronize: \"safe\" or \"dry-run\" in production, or set synchronize: false and manage schema via migrations. " +
          "Set STINGERLOOM_ALLOW_SYNC_IN_PROD=true to silence this warning.",
      );
    }

    // PostgreSQL: automatically create the schema if it does not exist.
    if (
      synchronize &&
      !isDryRun &&
      this.ctx.isPostgres() &&
      this.ctx.getDriver()
    ) {
      const pgDriver = this.ctx.getDriver() as PostgresDriver;
      const hasSchema = await pgDriver.hasSchema();
      if (!hasSchema || hasSchema.length === 0) {
        await pgDriver.createSchema();
        await pgDriver.setSearchPath();
      }
    }

    // Pass 1: create every table first (the referenced tables must exist before FKs are created).
    const entityList: Array<{
      TargetEntity: ClazzType<any>;
      tableName: string;
      metadata: EntityScannerMetadata;
      tableExisted: boolean;
    }> = [];

    while ((entity = entities.next())) {
      if (entity.done) {
        break;
      }

      const metadata = entity.value as EntityScannerMetadata;
      const TargetEntity = metadata.target as ClazzType<any>;

      // Multi-DB: skip entities that do not belong to this EntityManager
      const scopedEntities = this.ctx.getEntities();
      if (scopedEntities.length > 0 && !scopedEntities.includes(TargetEntity)) {
        continue;
      }

      let tableName = metadata.name;
      if (!tableName) {
        tableName = this.ctx.getNameStrategy(TargetEntity);
      }

      if (!ReflectManager.isEntity(TargetEntity)) {
        throw new EntityMetadataNotFoundError(tableName ?? "Unknown");
      }

      // STI: child entities do not create their own table (they share the parent's table).
      if (this.inheritanceResolver.isChildEntity(TargetEntity)) {
        const strategy = this.inheritanceResolver.getStrategy(TargetEntity);
        if (strategy === "SINGLE_TABLE") {
          continue;
        }
      }

      // TPT: child tables only include their own columns + PK in DDL (inherited columns live on the parent).
      // Note: do not mutate the original metadata.columns — EntityManager needs the full column list.
      let tptDdlColumns: any[] | undefined;
      if (this.inheritanceResolver.isChildEntity(TargetEntity)) {
        const strategy = this.inheritanceResolver.getStrategy(TargetEntity);
        if (strategy === "JOINED") {
          const ownCols = this.inheritanceResolver.getOwnColumns(TargetEntity);
          const ownColNames = new Set(
            ownCols.map((c: any) => c.propertyKey ?? c.name),
          );
          const pkColNames = new Set(
            metadata.columns
              .filter((c: any) => c.options?.primary)
              .map((c: any) => c.name ?? c.propertyKey),
          );
          tptDdlColumns = metadata.columns.filter((c: any) => {
            const key = c.propertyKey ?? c.name;
            return pkColNames.has(key) || ownColNames.has(key);
          });
        }
      }

      // Inheritance root: add the discriminator column + merge STI child columns
      if (this.inheritanceResolver.isRootEntity(TargetEntity)) {
        const strategy = this.inheritanceResolver.getStrategy(TargetEntity);
        const entityMeta = Reflect.getMetadata(ENTITY_TOKEN, TargetEntity) as EntityMetadata | undefined;
        if (entityMeta) {
          // STI/TPT: add the discriminator column (on the root table)
          if (strategy === "SINGLE_TABLE" || strategy === "JOINED") {
            const discCol = entityMeta.discriminatorColumn;
            if (discCol) {
              const alreadyHas = metadata.columns.some(
                (col: any) => col.name === discCol.name,
              );
              if (!alreadyHas) {
                metadata.columns.push({
                  name: discCol.name,
                  options: {
                    type: discCol.type,
                    length: discCol.length,
                    nullable: false,
                  },
                } as any);
              }
            }
          }

          // STI only: merge each child entity's unique columns (forcing them nullable)
          if (strategy === "SINGLE_TABLE") {
            const childEntities = entityMeta.childEntities ?? [];
            const existingColNames = new Set(
              metadata.columns.map((col: any) => col.name ?? col.propertyKey),
            );
            for (const ChildEntity of childEntities) {
              const ownCols = this.inheritanceResolver.getOwnColumns(ChildEntity);
              for (const col of ownCols) {
                const colName = col.name ?? col.propertyKey;
                if (colName && !existingColNames.has(colName)) {
                  const mergedCol = { ...col };
                  if (mergedCol.options) {
                    mergedCol.options = { ...mergedCol.options, nullable: true };
                  } else {
                    (mergedCol as any).options = { nullable: true };
                  }
                  metadata.columns.push(mergedCol as any);
                  existingColNames.add(colName!);
                }
              }
            }
          }
        }
      }

      // Auto-inject tenant column when the "tenant_column" strategy is active.
      // Skip:
      //   - entities marked @NonTenantEntity (inherently global tables)
      //   - entities that already declared @TenantColumn (user-owned property)
      //   - columns already named the same as the tenant column (defensive)
      //   - STI child entities (they share the parent's table; column lives on root)
      const tenantColumnConfig = this.ctx.getTenantColumnConfig();
      if (
        tenantColumnConfig &&
        !isNonTenantEntity(TargetEntity) &&
        !getTenantColumnMetadata(TargetEntity) &&
        !this.inheritanceResolver.isChildEntity(TargetEntity)
      ) {
        const tenantColName = tenantColumnConfig.name;
        const alreadyHas = metadata.columns.some(
          (col: any) =>
            col.name === tenantColName || col.propertyKey === tenantColName,
        );
        if (!alreadyHas) {
          const injected: any = {
            name: tenantColName,
            propertyKey: tenantColName,
            options: {
              type: tenantColumnConfig.type,
              length: tenantColumnConfig.length,
              nullable: false,
            },
          };
          metadata.columns.push(injected);
          // Also append to the Reflect metadata so downstream readers
          // (EntityManager INSERT path, SchemaDiff) see the column.
          const reflectCols = (Reflect.getMetadata(
            COLUMN_TOKEN,
            TargetEntity.prototype,
          ) ?? []) as ColumnMetadata[];
          const reflectHas = reflectCols.some(
            (c: any) =>
              c.name === tenantColName || c.propertyKey === tenantColName,
          );
          if (!reflectHas) {
            reflectCols.push({
              target: TargetEntity.prototype,
              propertyKey: tenantColName,
              name: tenantColName,
              options: {
                type: tenantColumnConfig.type,
                length: tenantColumnConfig.length,
                nullable: false,
              },
            } as any);
            Reflect.defineMetadata(
              COLUMN_TOKEN,
              reflectCols,
              TargetEntity.prototype,
            );
          }
        }
      }

      // PK validation: every entity must have at least one primary key column
      const hasPrimaryKey = metadata.columns.some(
        (col: any) => col.options?.primary,
      );
      if (!hasPrimaryKey) {
        throw new PrimaryKeyNotFoundError(tableName ?? "Unknown");
      }

      let tableExisted = false;
      const driver = this.ctx.getDriver();
      if (synchronize) {
        const hasTable = await driver?.hasTable(tableName);
        tableExisted = !!(hasTable && hasTable.length > 0);
        if (!tableExisted) {
          if (isDryRun) {
            this.logger.info(`[dry-run] Would CREATE TABLE ${tableName}`);
          } else {
            await driver?.createTable(tableName, tptDdlColumns ?? metadata.columns);
          }
        }
      }

      entityList.push({ TargetEntity, tableName, metadata, tableExisted });
    }

    // Pass 1.5: run SchemaDiff against already-existing tables to apply column changes.
    if (synchronize) {
      const existingEntities = entityList.filter((e) => e.tableExisted);
      if (existingEntities.length > 0) {
        await this.syncExistingTables(
          existingEntities.map((e) => e.TargetEntity),
          entityList,
          syncOption,
        );
      }
    }

    // Pass 2: after every table is created, register FKs, indexes, and unique indexes.
    if (synchronize && !isDryRun) {
      for (const { TargetEntity, tableName, metadata } of entityList) {
        // Create foreign keys.
        await this.registerForeignKeys(TargetEntity, tableName);

        // TPT: register a FK from the child PK to the parent PK.
        if (this.inheritanceResolver.isChildEntity(TargetEntity)) {
          const tptStrategy = this.inheritanceResolver.getStrategy(TargetEntity);
          if (tptStrategy === "JOINED") {
            const root = this.inheritanceResolver.getRoot(TargetEntity);
            if (root) {
              const rootMeta = this.resolver.resolveEntityMetadata(root);
              const pk = metadata.columns.find((c: any) => c.options?.primary);
              const rootPk = rootMeta?.columns.find(
                (c: any) => c.options?.primary,
              );
              const tptDriver = this.ctx.getDriver();
              if (pk && rootPk && rootMeta && tptDriver) {
                const rootTableName = rootMeta.name!;
                const fkName = this.namingStrategy.foreignKeyName(
                  tableName,
                  pk.name!,
                  rootTableName,
                );
                try {
                  const fkExists = await tptDriver.hasForeignKey(tableName, fkName);
                  if (!fkExists) {
                    await tptDriver.addForeignKey(
                      tableName,
                      pk.name!,
                      rootTableName,
                      rootPk.name!,
                    );
                  }
                } catch {
                  // SQLite: ALTER TABLE ADD CONSTRAINT is unsupported — skip the FK.
                  this.logger.warn(
                    `Could not create FK ${fkName} for TPT child table ${tableName} (may be unsupported by dialect)`,
                  );
                }
              }
            }
          }
        }

        // Create indexes.
        await this.registerIndex(TargetEntity, tableName);

        // Create composite unique indexes.
        await this.registerUniqueIndexes(TargetEntity, tableName);
      }

      // Pass 3: create ManyToMany join tables and their FKs.
      await this.registerManyToManyJoinTables(
        entityList.map((e) => e.TargetEntity),
      );
    } else if (isDryRun) {
      for (const { tableName } of entityList) {
        this.logger.info(
          `[dry-run] Would register FKs/indexes for ${tableName}`,
        );
      }
    }
  }

  /**
   * Runs SchemaDiff against already-existing tables to synchronize entity changes.
   */
  private async syncExistingTables(
    existingEntities: ClazzType<any>[],
    entityList: Array<{ TargetEntity: ClazzType<any>; tableName: string }>,
    syncOption: boolean | "safe" | "dry-run",
  ): Promise<void> {
    const connection = this.ctx.getConnection();
    if (!connection) return;

    const dialect = this.ctx.getDialect();
    const schema = this.ctx.getSchema();
    const queryRunner = { query: (s: any) => connection.query(s) };

    const schemaDiff = new SchemaDiff();

    let diff: SchemaDiffResult;
    try {
      diff = await schemaDiff.diff(
        existingEntities,
        queryRunner,
        dialect,
        schema,
      );
    } catch (err) {
      this.logger.warn(
        `[sync] SchemaDiff failed, skipping ALTER operations: ${err}`,
      );
      return;
    }

    // addTables was already handled in pass 1, so skip it here (we only process existing tables here).

    // Collect FK columns (so they can be excluded from DROP).
    const fkColumnsPerTable = new Map<string, Set<string>>();
    for (const { TargetEntity, tableName } of entityList) {
      fkColumnsPerTable.set(
        tableName.toLowerCase(),
        this.collectForeignKeyColumns(TargetEntity),
      );
    }

    await this.applySchemaDiff(diff, fkColumnsPerTable, syncOption, dialect);
  }

  /**
   * Applies a SchemaDiffResult according to the selected mode.
   */
  private async applySchemaDiff(
    diff: SchemaDiffResult,
    fkColumnsPerTable: Map<string, Set<string>>,
    mode: boolean | "safe" | "dry-run",
    dialect: SchemaDialect,
  ): Promise<void> {
    const driver = this.ctx.getDriver();
    if (!driver) return;

    const isDryRun = mode === "dry-run";
    const isSafe = mode === "safe";
    const isFull = mode === true;

    // 1. ADD COLUMNS (runs for both true and safe modes)
    for (const col of diff.addColumns) {
      const typeDef = this.buildAddColumnTypeDef(col);
      if (isDryRun) {
        this.logger.info(
          `[dry-run] ALTER TABLE ${col.tableName} ADD COLUMN ${col.columnName} ${typeDef}`,
        );
      } else {
        this.logger.info(
          `[sync] Adding column ${col.tableName}.${col.columnName} (${typeDef})`,
        );
        await driver.addColumn(col.tableName, col.columnName, typeDef);
      }
    }

    // 2. ALTER COLUMNS (only in true mode; safe is skipped)
    if (isFull || isDryRun) {
      for (const col of diff.alterColumns) {
        const ddl = this.buildAlterColumnDDL(col, dialect);
        if (!ddl) continue; // SQLite: unsupported
        if (isDryRun) {
          this.logger.info(`[dry-run] ${ddl}`);
        } else {
          this.logger.warn(
            `[sync] Altering column ${col.tableName}.${col.columnName}: ${col.currentType} → ${col.columnType}`,
          );
          await driver.executeRaw(ddl);
        }
      }
    }

    // 3. DROP COLUMNS (only in true mode; safe is skipped)
    if (isFull || isDryRun) {
      for (const col of diff.dropColumns) {
        // FK columns are excluded from DROP (they are managed in pass 2).
        const tableFkCols = fkColumnsPerTable.get(col.tableName.toLowerCase());
        if (tableFkCols?.has(col.columnName.toLowerCase())) continue;

        if (isDryRun) {
          this.logger.info(
            `[dry-run] ALTER TABLE ${col.tableName} DROP COLUMN ${col.columnName}`,
          );
        } else {
          this.logger.warn(
            `[sync] Dropping column ${col.tableName}.${col.columnName}`,
          );
          await driver.dropColumn(col.tableName, col.columnName);
        }
      }
    }

    // 4. RENAME COLUMNS (only in true mode)
    if ((isFull || isDryRun) && diff.renamedColumns) {
      for (const rename of diff.renamedColumns) {
        const ddl = `ALTER TABLE ${this.ctx.wrap(rename.tableName)} RENAME COLUMN ${this.ctx.wrap(rename.oldColumnName)} TO ${this.ctx.wrap(rename.newColumnName)}`;
        if (isDryRun) {
          this.logger.info(`[dry-run] ${ddl}`);
        } else {
          this.logger.warn(
            `[sync] Renaming column ${rename.tableName}.${rename.oldColumnName} → ${rename.newColumnName}`,
          );
          await driver.executeRaw(ddl);
        }
      }
    }
  }

  /**
   * Produces only the pure type string from a ColumnChange.
   * Includes ENUM values, length, and precision/scale.
   * Examples: "VARCHAR(255)", "ENUM('a','b')", "DECIMAL(10,2)".
   */
  private buildColumnTypeExpr(col: ColumnChange): string {
    let type = col.columnType ?? "VARCHAR(255)";

    // For ENUM types, include the value list from enumValues.
    const isENUM = type.toUpperCase().startsWith("ENUM");
    if (isENUM && col.enumValues && col.enumValues.length > 0) {
      const values = col.enumValues
        .map((v: string) => `'${v.replace(/'/g, "''")}'`)
        .join(",");
      type = `ENUM(${values})`;
    }

    // If a length is specified and the type does not yet include parentheses, append it.
    if (col.expectedLength && !type.includes("(")) {
      type = `${type}(${col.expectedLength})`;
    }

    // If precision/scale is specified, append it.
    if (col.expectedPrecision && !type.includes("(")) {
      const scale =
        col.expectedScale !== undefined && col.expectedScale !== null
          ? `,${col.expectedScale}`
          : "";
      type = `${type}(${col.expectedPrecision}${scale})`;
    }

    return type;
  }

  /**
   * Produces the ADD COLUMN type-definition string from a ColumnChange.
   * Examples: "VARCHAR(255) NULL", "INT NOT NULL DEFAULT 0".
   *
   * For non-nullable columns being backfilled into existing rows,
   * a type-appropriate default is used (#177):
   *   - String types (VARCHAR, TEXT, CHAR, LONGTEXT) -> DEFAULT ''
   *   - Numeric types (INT, BIGINT, FLOAT, etc.) -> DEFAULT 0
   *   - Boolean -> DEFAULT FALSE (pg/sqlite) or DEFAULT 0 (mysql)
   *   - Datetime/timestamp/date -> forced NULL (no safe default)
   *   - Other types (JSON, BLOB, etc.) -> forced NULL (no safe default)
   */
  private buildAddColumnTypeDef(col: ColumnChange): string {
    const type = this.buildColumnTypeExpr(col);

    if (col.nullable !== false) {
      return `${type} NULL`;
    }

    // Type-appropriate default for NOT NULL backfill (#177)
    const upperType = type.toUpperCase();

    if (/^(VARCHAR|TEXT|CHAR|LONGTEXT|MEDIUMTEXT|TINYTEXT|ENUM)/.test(upperType)) {
      return `${type} NOT NULL DEFAULT ''`;
    }
    if (/^(INT|BIGINT|FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL|SMALLINT|TINYINT|SERIAL|INTEGER|MEDIUMINT)/.test(upperType)) {
      return `${type} NOT NULL DEFAULT 0`;
    }
    if (/^(BOOL|BOOLEAN)/.test(upperType)) {
      const defaultVal = this.ctx.isMySqlFamily() ? "0" : "FALSE";
      return `${type} NOT NULL DEFAULT ${defaultVal}`;
    }

    // Datetime/timestamp/date and other types (JSON, JSONB, BLOB, BYTEA, ARRAY, etc.)
    // cannot have a safe universal default — force nullable for existing rows
    return `${type} NULL`;
  }

  /**
   * Generates ALTER COLUMN DDL for the appropriate dialect.
   * Returns null for SQLite, which does not support ALTER COLUMN TYPE.
   */
  private buildAlterColumnDDL(
    col: ColumnChange,
    dialect: SchemaDialect,
  ): string | null {
    const typeExpr = this.buildColumnTypeExpr(col);
    const tableName = this.ctx.wrapTable(col.tableName);
    const columnName = this.ctx.wrap(col.columnName);

    if (dialect === "sqlite") {
      this.logger.warn(
        `[sync] SQLite does not support ALTER COLUMN TYPE for ${col.tableName}.${col.columnName} ` +
          `(${col.currentType} → ${typeExpr}). Skipping.`,
      );
      return null;
    }

    if (dialect === "mysql") {
      const nullable = col.nullable === false ? "NOT NULL" : "NULL";
      return `ALTER TABLE ${tableName} MODIFY COLUMN ${columnName} ${typeExpr} ${nullable}`;
    }

    // PostgreSQL
    return `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE ${typeExpr}`;
  }

  /**
   * Collects FK join-column names from the entity's @ManyToOne/@OneToOne relations.
   * Used to exclude these columns from DROP COLUMN operations.
   */
  private collectForeignKeyColumns(TargetEntity: ClazzType<any>): Set<string> {
    const fkColumns = new Set<string>();
    const m2o = this.resolver.resolveManyToOneMetadata(TargetEntity);
    for (const rel of m2o) {
      if (rel.joinColumn) fkColumns.add(rel.joinColumn.toLowerCase());
    }
    const o2o = this.resolver.resolveOneToOneMetadata(TargetEntity);
    for (const rel of o2o) {
      if (rel.joinColumn) fkColumns.add(rel.joinColumn.toLowerCase());
    }
    return fkColumns;
  }

  /**
   * Resolves the SQL column type for the primary key of an entity.
   * Falls back to the driver's castType("int") if no PK metadata is found.
   * Used to derive correct join column types for ManyToMany tables (#178).
   */
  private resolvePkColumnType(entityClass: ClazzType<any>): string {
    const driver = this.ctx.getDriver();
    const columns = (Reflect.getMetadata(
      COLUMN_TOKEN,
      entityClass.prototype,
    ) ?? []) as ColumnMetadata[];
    const pkCol = columns.find((c) => c.options?.primary);
    if (!pkCol || !pkCol.options?.type || !driver) {
      return driver ? driver.castType("int") : "INT";
    }
    let sqlType = driver.castType(pkCol.options.type);
    // Append length for varchar/char PK types
    const colType = pkCol.options.type;
    if (pkCol.options.length && pkCol.options.length > 0 && !sqlType.includes("(")
        && (colType === "varchar" || colType === "char")) {
      sqlType = `${sqlType}(${pkCol.options.length})`;
    }
    return sqlType;
  }

  /**
   * Registers composite unique indexes declared via the @UniqueIndex decorator.
   */
  async registerUniqueIndexes(TargetEntity: ClazzType<any>, tableName: string) {
    const uniqueIndexes = Reflect.getMetadata(
      UNIQUE_INDEX_TOKEN,
      TargetEntity,
    ) as UniqueIndexMetadata[] | undefined;

    if (!uniqueIndexes || uniqueIndexes.length === 0) return;

    const driver = this.ctx.getDriver();

    // Build property-to-column name map to resolve @UniqueIndex() property keys (#176)
    const colMeta = (Reflect.getMetadata(
      COLUMN_TOKEN,
      TargetEntity.prototype,
    ) ?? []) as ColumnMetadata[];
    const propColMap = new Map<string, string>();
    for (const col of colMeta) {
      if (col.propertyKey && col.name) {
        propColMap.set(col.propertyKey, col.name);
      }
    }

    for (const uq of uniqueIndexes) {
      // Resolve property keys to actual DB column names (#176)
      const resolvedColumns = uq.columns.map((col) => propColMap.get(col) ?? col);
      const indexName =
        uq.name ?? this.namingStrategy.uniqueIndexName(tableName, resolvedColumns);

      // Check whether it already exists.
      const indexes = (await driver?.getIndexes(tableName)) as any[];
      let isExist = false;
      for (const idx of indexes || []) {
        const existingIndexName =
          idx["Key_name"] ?? idx["Field"] ?? idx["name"];
        if (existingIndexName === indexName) {
          isExist = true;
          break;
        }
      }

      if (!isExist) {
        await driver?.addCompositeUniqueIndex(tableName, resolvedColumns, indexName);
      }
    }
  }

  /**
   * Creates ManyToMany join tables and their FK constraints.
   * Only processes the owning side (the side that declares joinTable); duplicates are prevented via a Set.
   * Join column types are derived from the actual PK types of the referenced entities (#178).
   */
  async registerManyToManyJoinTables(entities: ClazzType<any>[]) {
    const processedTables = new Set<string>();
    const driver = this.ctx.getDriver();

    for (const entity of entities) {
      const m2mMeta = (Reflect.getMetadata(MANY_TO_MANY_TOKEN, entity) ??
        []) as ManyToManyMetadata<any>[];

      for (const rel of m2mMeta) {
        if (!rel.joinTable) continue;

        const {
          name: joinTableName,
          joinColumn,
          inverseJoinColumn,
        } = rel.joinTable;
        if (processedTables.has(joinTableName)) continue;
        processedTables.add(joinTableName);

        // Look up the entity's table name (@Entity name takes priority).
        const ownerEntityMeta = Reflect.getMetadata(ENTITY_TOKEN, entity) as
          | { name?: string }
          | undefined;
        const ownerTable = ownerEntityMeta?.name ?? entity.name;

        const relatedEntity = rel.getRelatedEntity() as ClazzType<any>;
        const relatedEntityMeta = Reflect.getMetadata(
          ENTITY_TOKEN,
          relatedEntity,
        ) as { name?: string } | undefined;
        const relatedTable = relatedEntityMeta?.name ?? relatedEntity.name;

        // 1. Create the join table (IF NOT EXISTS — safe across restarts).
        const hasTable = await driver?.hasTable(joinTableName);
        if (!hasTable || (hasTable as any[]).length === 0) {
          const wJoinTable = this.ctx.wrap(joinTableName);
          const wJoinCol = this.ctx.wrap(joinColumn);
          const wInvCol = this.ctx.wrap(inverseJoinColumn);
          // Derive join column types from actual PK types (#178)
          const ownerPkType = this.resolvePkColumnType(entity);
          const relatedPkType = this.resolvePkColumnType(relatedEntity);
          let ddl = `CREATE TABLE IF NOT EXISTS ${wJoinTable} (${wJoinCol} ${ownerPkType} NOT NULL, ${wInvCol} ${relatedPkType} NOT NULL, PRIMARY KEY (${wJoinCol}, ${wInvCol}))`;
          if (this.ctx.isMySqlFamily()) ddl += " ENGINE=InnoDB";
          await driver?.executeRaw(ddl);
        }

        // 2. Look up the owning-side and inverse-side PKs.
        const ownerColumns = (Reflect.getMetadata(
          COLUMN_TOKEN,
          entity.prototype,
        ) ?? []) as ColumnMetadata[];
        const ownerPk = ownerColumns.find((c) => c.options?.primary)?.name;

        const relatedColumns = (Reflect.getMetadata(
          COLUMN_TOKEN,
          relatedEntity.prototype,
        ) ?? []) as ColumnMetadata[];
        const relatedPk = relatedColumns.find((c) => c.options?.primary)?.name;

        // 3. Add the owning-side FK.
        const ownerFkName = this.namingStrategy.foreignKeyName(
          joinTableName,
          joinColumn,
          ownerTable,
        );
        if (
          ownerPk &&
          driver &&
          !(await driver.hasForeignKey(joinTableName, ownerFkName))
        ) {
          const ddl = `ALTER TABLE ${this.ctx.wrap(joinTableName)} ADD CONSTRAINT ${ownerFkName} FOREIGN KEY (${this.ctx.wrap(joinColumn)}) REFERENCES ${this.ctx.wrap(ownerTable)}(${this.ctx.wrap(ownerPk)}) ON DELETE CASCADE ON UPDATE CASCADE`;
          await driver.executeRaw(ddl);
        }

        // 4. Add the inverse-side FK.
        const relatedFkName = this.namingStrategy.foreignKeyName(
          joinTableName,
          inverseJoinColumn,
          relatedTable,
        );
        if (
          relatedPk &&
          driver &&
          !(await driver.hasForeignKey(joinTableName, relatedFkName))
        ) {
          const ddl = `ALTER TABLE ${this.ctx.wrap(joinTableName)} ADD CONSTRAINT ${relatedFkName} FOREIGN KEY (${this.ctx.wrap(inverseJoinColumn)}) REFERENCES ${this.ctx.wrap(relatedTable)}(${this.ctx.wrap(relatedPk)}) ON DELETE CASCADE ON UPDATE CASCADE`;
          await driver.executeRaw(ddl);
        }
      }
    }
  }

  async registerForeignKeys(TargetEntity: ClazzType<any>, tableName: string) {
    // Fetch the entity scanner.
    const entityScanner = getScannerInstance(EntityScanner);
    const driver = this.ctx.getDriver();

    // Look up ManyToOne relations through the layered metadata system.
    const manyToOneItems = this.resolver.resolveManyToOneMetadata(TargetEntity);

    const isValidManyToOne = manyToOneItems && manyToOneItems.length > 0;

    // If any ManyToOne relation exists, create the foreign keys.
    if (isValidManyToOne) {
      for (const manyToOneItem of manyToOneItems) {
        // Skip FK creation when createForeignKeyConstraints is false.
        if (manyToOneItem.option?.createForeignKeyConstraints === false) continue;

        const { joinColumn } = manyToOneItem;

        // Fetch the target entity of the mapping.
        const mappingEntity = manyToOneItem.getMappingEntity();
        if (!mappingEntity) {
          throw new EntityNotFound(mappingEntity);
        }
        // Search for metadata.
        const mappingTableMetadata = entityScanner.scan(mappingEntity);
        if (!mappingTableMetadata) {
          throw new EntityMetadataNotFoundError(mappingEntity.name);
        }

        if (!joinColumn) {
          throw new InvalidQueryError(
            "JoinColumn does not exist.",
            "Add { joinColumn: 'column_name' } option to your @ManyToOne() decorator.",
          );
        }

        // Reference the given column when `references` is provided, otherwise the target PK.
        const mappingTablePrimaryKey = manyToOneItem.references
          ? manyToOneItem.references
          : mappingTableMetadata.columns.find((e: any) => e.options?.primary)
              ?.name;

        if (!mappingTablePrimaryKey) {
          throw new PrimaryKeyNotFoundError(mappingEntity.name);
        }

        const mappingTableName =
          mappingTableMetadata.name || this.ctx.getNameStrategy(mappingEntity);

        // Add the joinColumn first if the column is missing from the table.
        if (driver) {
          const columnExists = await driver.hasColumn(tableName, joinColumn);
          if (!columnExists) {
            const fkColumnType = driver.castType("int") + " NULL";
            await driver.addColumn(tableName, joinColumn, fkColumnType);
          }
        }

        // Skip adding the FK constraint if it already exists.
        if (driver) {
          const fkName = this.namingStrategy.foreignKeyName(
            tableName,
            joinColumn,
            mappingTableName,
          );
          const fkExists = await driver.hasForeignKey(tableName, fkName);
          if (fkExists) continue;
        }

        await driver?.addForeignKey(
          // Current table name
          tableName,
          // Current table's column name
          joinColumn,
          // Target table name
          mappingTableName,
          // Target table's primary key
          mappingTablePrimaryKey,
        );
      }
    }

    // Create FKs for the owning side of each OneToOne relation (the side with joinColumn).
    const oneToOneItems = this.resolver.resolveOneToOneMetadata(TargetEntity);
    for (const oneToOneItem of oneToOneItems) {
      const { joinColumn } = oneToOneItem;
      if (!joinColumn) continue; // Inverse side has no FK.

      const RelatedEntity = oneToOneItem.getRelatedEntity();
      if (!RelatedEntity) {
        throw new EntityNotFound(RelatedEntity);
      }

      const relatedMetadata = entityScanner.scan(RelatedEntity);
      if (!relatedMetadata) {
        throw new EntityMetadataNotFoundError(RelatedEntity.name);
      }

      const relatedPrimaryKey = relatedMetadata.columns.find(
        (e: any) => e.options?.primary,
      )?.name;

      if (!relatedPrimaryKey) {
        throw new PrimaryKeyNotFoundError(RelatedEntity.name);
      }

      // Add the joinColumn first if the column is missing from the table.
      if (driver) {
        const columnExists = await driver.hasColumn(tableName, joinColumn);
        if (!columnExists) {
          const fkColumnType = driver.castType("int") + " NULL";
          await driver.addColumn(tableName, joinColumn, fkColumnType);
        }
      }

      const relatedTableName =
        relatedMetadata.name || this.ctx.getNameStrategy(RelatedEntity);

      // Skip adding the FK constraint if it already exists.
      if (driver) {
        const fkName = this.namingStrategy.foreignKeyName(
          tableName,
          joinColumn,
          relatedTableName,
        );
        const fkExists = await driver.hasForeignKey(tableName, fkName);
        if (fkExists) continue;
      }

      await driver?.addForeignKey(
        tableName,
        joinColumn,
        relatedTableName,
        relatedPrimaryKey,
      );
    }
  }

  /**
   * Creates indexes.
   * Resolves property keys to actual DB column names (#176).
   */
  async registerIndex(TargetEntity: ClazzType<any>, tableName: string) {
    const indexer = Reflect.getMetadata(
      INDEX_TOKEN,
      TargetEntity.prototype,
    ) as IndexMetadata[];
    if (indexer) {
      const driver = this.ctx.getDriver();
      // Build property-to-column name map to resolve @Index() property keys (#176)
      const columns = (Reflect.getMetadata(
        COLUMN_TOKEN,
        TargetEntity.prototype,
      ) ?? []) as ColumnMetadata[];
      const propColMap = new Map<string, string>();
      for (const col of columns) {
        if (col.propertyKey && col.name) {
          propColMap.set(col.propertyKey, col.name);
        }
      }

      for (const index of indexer) {
        // index.name is the property key; resolve to actual DB column name
        const columnName = propColMap.get(index.name) ?? index.name;
        const indexName = this.namingStrategy.indexName(tableName, columnName);

        const indexes = (await driver?.getIndexes(tableName)) as any[];

        let isExist = false;
        for (const idx of indexes || []) {
          // MySQL uses "Key_name"; PostgreSQL uses "Field" (aliased from indexname).
          const existingIndexName = idx["Key_name"] ?? idx["Field"];
          if (existingIndexName === indexName) {
            isExist = true;
            break;
          }
        }

        if (!isExist) {
          await driver?.addIndex(tableName, columnName, indexName);
        }
      }
    }
  }
}
