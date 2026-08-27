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
  FULLTEXT_INDEX_TOKEN,
  FullTextIndexMetadata,
} from "../decorators/FullTextIndex";
import {
  ENTITY_TOKEN,
  MANY_TO_MANY_TOKEN,
  ManyToManyMetadata,
  COLUMN_TOKEN,
} from "../decorators";
import { EntityMetadataNotFoundError } from "../errors/EntityMetadataNotFoundError";
import { EntityNotFound } from "../dialects/EntityNotFound";
import type { CreateTableForeignKey } from "../dialects/SqlDriver";
import { InvalidQueryError } from "../errors/InvalidQueryError";
import { PrimaryKeyNotFoundError } from "../errors/PrimaryKeyNotFoundError";
import { RelationMetadataResolver } from "./RelationMetadataResolver";
import { buildPropertyToColumnMap as buildSharedPropertyToColumnMap } from "./PropertyColumnMap";
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
import { escapeSqlLiteral } from "../utils/escapeSqlLiteral";
import { SynchronizePolicy } from "./DatabaseClientOptions";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";

/**
 * A schema change that `synchronize: "safe"` detected but declined to apply.
 */
interface SkippedSafeChange {
  /** Change class, used for the summary breakdown (e.g. "DROP COLUMN"). */
  kind: string;
  /** Human-readable target, e.g. `user.email`. */
  target: string;
  /** The statement that a full sync would have executed. */
  ddl: string;
}

/**
 * DDL / schema synchronization handler that runs once at application start.
 * It is not involved in runtime CRUD.
 */
export class SchemaRegistrar {
  private readonly namingStrategy: NamingStrategy;
  private readonly logger = new Logger(SchemaRegistrar.name);
  private readonly inheritanceResolver = new InheritanceResolver();

  /**
   * Active policy for the in-flight registerEntities() call.
   * Set at the top of registerEntities() and consulted by the helper DDL
   * paths (registerForeignKeys / registerIndex / registerUniqueIndexes /
   * registerFullTextIndexes / registerManyToManyJoinTables) so they all
   * honor continueOnError and logDDL without explicit threading.
   */
  private activePolicy: SynchronizePolicy = {
    mode: false,
    continueOnError: true,
    failOnDestructiveChange: false,
    logDDL: false,
  };

  constructor(
    private readonly resolver: RelationMetadataResolver,
    private readonly ctx: EntityManagerInternals,
    namingStrategy?: NamingStrategy,
  ) {
    this.namingStrategy = namingStrategy ?? new DefaultNamingStrategy();
  }

  /**
   * Reads the normalized synchronize policy from the EntityManager.
   * Falls back to bare `getSynchronize()` if the host predates the policy
   * surface — keeps third-party EM impls working.
   */
  private resolveSyncPolicy(): SynchronizePolicy {
    const ctx = this.ctx as EntityManagerInternals & {
      getSynchronizePolicy?: () => SynchronizePolicy;
    };
    if (typeof ctx.getSynchronizePolicy === "function") {
      return ctx.getSynchronizePolicy();
    }
    const mode = ctx.getSynchronize() ?? false;
    return {
      mode: mode as SynchronizePolicy["mode"],
      continueOnError: true,
      failOnDestructiveChange: false,
      logDDL: false,
    };
  }

  /**
   * Single funnel for DDL-execution failures. Honors `policy.continueOnError`:
   *   - `true`  (default): logs a warning and continues — matches legacy.
   *   - `false`: rethrows as an OrmError so registerEntities() aborts boot.
   */
  private handleDdlError(
    err: unknown,
    context: string,
    policy: SynchronizePolicy,
  ): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (policy.continueOnError) {
      this.logger.warn(`[sync] ${context}: ${msg}`);
      return;
    }
    throw new OrmError(
      OrmErrorCode.SCHEMA_SYNC_FAILED,
      `[sync] ${context}: ${msg}`,
      "synchronize.continueOnError is false — fix the failing DDL or re-enable continueOnError to downgrade DDL failures to warnings.",
    );
  }

  /**
   * Throws an OrmError when a destructive operation is requested while
   * `policy.failOnDestructiveChange` is set. The thrown error names the
   * specific operation so operators can decide whether to override.
   */
  private assertDestructiveAllowed(
    op: "DROP COLUMN" | "DROP TABLE" | "ALTER COLUMN (narrowing)",
    target: string,
    policy: SynchronizePolicy,
  ): void {
    if (!policy.failOnDestructiveChange) return;
    throw new OrmError(
      OrmErrorCode.SCHEMA_SYNC_DESTRUCTIVE_CHANGE,
      `[sync] Refusing destructive ${op} on ${target} — synchronize.failOnDestructiveChange is true.`,
      `Set synchronize.failOnDestructiveChange to false to allow ${op}, or write an explicit migration for this change.`,
    );
  }

  /**
   * Best-effort narrowing detector for ALTER COLUMN TYPE.
   * Returns true when the destination type is strictly smaller / lossy than
   * the current type. Conservative on purpose — only flags well-known cases
   * (text-family → numeric, larger varchar → smaller varchar, etc.).
   */
  private isNarrowingAlter(col: ColumnChange): boolean {
    // Tightening a column to NOT NULL is destructive: it fails outright when any
    // existing row holds NULL. Gate it behind failOnDestructiveChange like the
    // other narrowing cases.
    if (col.currentNullable === true && col.nullable === false) {
      return true;
    }

    const cur = (col.currentType ?? "").toUpperCase();
    const next = (col.columnType ?? "").toUpperCase();
    if (!cur || !next) return false;

    const isTextLike = (t: string) =>
      /^(VARCHAR|TEXT|CHAR|LONGTEXT|MEDIUMTEXT|TINYTEXT|ENUM|JSON|JSONB|UUID)/.test(
        t,
      );
    const isNumeric = (t: string) =>
      /^(INT|BIGINT|FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL|SMALLINT|TINYINT|SERIAL|INTEGER|MEDIUMINT|BOOL|BOOLEAN)/.test(
        t,
      );
    const isDateLike = (t: string) =>
      /^(DATE|TIME|TIMESTAMP|DATETIME)/.test(t);

    if (isTextLike(cur) && isNumeric(next)) return true;
    if (isDateLike(cur) && isNumeric(next)) return true;
    if (isTextLike(cur) && isDateLike(next)) return true;

    // varchar(255) → varchar(64): the actual length is captured separately on
    // the ColumnChange. Only flag a true shrink — equal/grow are safe.
    if (
      typeof col.expectedLength === "number" &&
      typeof col.actualLength === "number" &&
      col.expectedLength < col.actualLength
    ) {
      return true;
    }
    return false;
  }

  async registerEntities() {
    const entityScanner = getScannerInstance(EntityScanner);
    const entities = entityScanner.makeEntities();

    let entity: IteratorResult<EntityScannerMetadata>;

    const policy = this.resolveSyncPolicy();
    this.activePolicy = policy;
    const syncOption = policy.mode;
    const synchronize = syncOption !== false;
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

    // Enum types are shared across entities (@Column({ enumName }) may name the
    // same type twice), so each one is inspected at most once per run.
    const syncedEnumTypes = new Set<string>();

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
                  // The @DiscriminatorColumn name is an explicit DB name;
                  // without this flag the NamingStrategy pass of a later
                  // register() (this push mutates shared metadata) would
                  // rewrite it via columnName(undefined).
                  nameExplicit: true,
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

      // PostgreSQL: an enum column is a reference to a named type, so that type
      // has to exist before any statement naming it runs. Applies to existing
      // tables too — that is where added enum columns and added enum values land.
      if (synchronize) {
        await this.syncEnumTypes(
          metadata.columns,
          tableName,
          policy,
          syncedEnumTypes,
        );
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
            this.logDdl(`[sync] CREATE TABLE ${tableName}`, policy);
            try {
              let createColumns = tptDdlColumns ?? metadata.columns;
              let inlineFks: CreateTableForeignKey[] | undefined;
              // SQLite cannot ALTER TABLE ADD FOREIGN KEY, so FK constraints
              // (and any join columns not declared as entity columns) must be
              // part of the CREATE TABLE statement itself.
              if (!this.driverSupportsAlterAddFk()) {
                const collected = this.collectInlineForeignKeys(
                  TargetEntity,
                  tableName,
                  createColumns,
                );
                if (collected.extraColumns.length > 0) {
                  createColumns = [...createColumns, ...collected.extraColumns];
                }
                inlineFks = collected.foreignKeys;
              }
              await driver?.createTable(tableName, createColumns, inlineFks);
            } catch (err) {
              this.handleDdlError(
                err,
                `Failed to create table ${tableName}`,
                policy,
              );
            }
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
          policy,
        );
      }
    }

    // Pass 2: after every table is created, register FKs, indexes, and unique indexes.
    if (synchronize && !isDryRun) {
      for (const { TargetEntity, tableName, metadata } of entityList) {
        // Create foreign keys.
        await this.registerForeignKeys(TargetEntity, tableName);

        // TPT: register a FK from the child PK to the parent PK.
        // Inline-FK dialects (SQLite) embed this FK at CREATE TABLE time
        // via collectInlineForeignKeys(), so the ALTER pass is skipped.
        if (
          this.inheritanceResolver.isChildEntity(TargetEntity) &&
          this.driverSupportsAlterAddFk()
        ) {
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
                const rootTableName = rootMeta.name;
                const fkName = this.namingStrategy.foreignKeyName(
                  tableName,
                  pk.name,
                  rootTableName,
                );
                try {
                  const fkExists = await tptDriver.hasForeignKey(tableName, fkName);
                  if (!fkExists) {
                    await tptDriver.addForeignKey(
                      tableName,
                      pk.name,
                      rootTableName,
                      rootPk.name,
                      fkName,
                    );
                  }
                } catch (err) {
                  // SQLite: ALTER TABLE ADD CONSTRAINT is unsupported — skip the FK.
                  this.handleDdlError(
                    err,
                    `Could not create FK ${fkName} for TPT child table ${tableName} (may be unsupported by dialect)`,
                    this.activePolicy,
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

        // Create FULLTEXT (MySQL) / GIN+to_tsvector (PostgreSQL) indexes.
        await this.registerFullTextIndexes(TargetEntity, tableName);
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
   * PostgreSQL: creates the named ENUM types an entity's columns reference and
   * adds values that the entity declares but the type does not have yet.
   *
   * A PostgreSQL enum column is a reference to a user-defined type
   * (`"schema"."table_column_enum"`), so `CREATE TYPE` has to run before the
   * CREATE TABLE / ADD COLUMN that names it. Without this pass the statement
   * fails with `type ... does not exist` and `continueOnError` (default true)
   * downgrades it to a warning — leaving the table or the column silently
   * missing, and leaving a declared enum value unusable at INSERT time.
   *
   * Mode semantics: both operations are additive (CREATE TYPE, ALTER TYPE ...
   * ADD VALUE), so `"safe"` applies them. Safe declines narrowing and
   * destructive DDL; creating a type nothing references yet, and appending a
   * value no row can hold yet, are neither — and withholding them would break
   * the CREATE TABLE / ADD COLUMN that safe mode does perform. `"dry-run"`
   * logs the statements it would run.
   *
   * Removal is not synchronized: PostgreSQL cannot drop an enum value without
   * recreating the type (and rewriting every column that uses it), so values
   * present in the database but absent from the entity are reported, never
   * dropped.
   *
   * No-ops on MySQL (native inline `ENUM(...)` column type) and SQLite
   * (stored as TEXT) — those dialects carry the values in the column
   * definition itself, which the regular CREATE/ALTER path already handles.
   */
  private async syncEnumTypes(
    columns: ColumnMetadata[],
    tableName: string,
    policy: SynchronizePolicy,
    processed: Set<string>,
  ): Promise<void> {
    if (!this.ctx.isPostgres()) return;
    const driver = this.ctx.getDriver() as PostgresDriver | undefined;
    if (!driver || typeof driver.hasEnumType !== "function") return;

    const isDryRun = policy.mode === "dry-run";

    for (const col of columns as any[]) {
      if (col.options?.type !== "enum") continue;

      const columnName = col.name ?? col.propertyKey ?? "unknown";
      const enumName: string =
        col.options.enumName ?? `${tableName}_${columnName}_enum`;
      if (processed.has(enumName)) continue;
      processed.add(enumName);

      const values: string[] = col.options.enumValues ?? [];
      if (values.length === 0) {
        this.logger.warn(
          `[sync] Column ${tableName}.${columnName} is type "enum" but declares no enumValues. ` +
            `PostgreSQL needs the value list to create type "${enumName}", so any DDL naming it will fail.`,
        );
        continue;
      }

      let exists = false;
      try {
        const rows = (await driver.hasEnumType(enumName)) as any[];
        exists = Array.isArray(rows) && rows.length > 0;
      } catch (err) {
        this.handleDdlError(
          err,
          `Failed to inspect enum type ${enumName}`,
          policy,
        );
        continue;
      }

      if (!exists) {
        const ddl = `CREATE TYPE ${enumName} AS ENUM (${values
          .map((v) => `'${escapeSqlLiteral(v)}'`)
          .join(", ")})`;
        if (isDryRun) {
          this.logger.info(`[dry-run] Would ${ddl}`);
          continue;
        }
        this.logDdl(`[sync] ${ddl}`, policy);
        try {
          await driver.createEnumType(enumName, values);
        } catch (err) {
          this.handleDdlError(
            err,
            `Failed to create enum type ${enumName}`,
            policy,
          );
        }
        continue;
      }

      let current: string[];
      try {
        const rows = await driver.listEnumValues(enumName);
        current = rows.map((r) => r.enumlabel);
      } catch (err) {
        this.handleDdlError(
          err,
          `Failed to read values of enum type ${enumName}`,
          policy,
        );
        continue;
      }

      // Keep the declared order: a new value is inserted BEFORE the nearest
      // already-present value that follows it in the entity, so ORDER BY on the
      // column keeps matching the enumValues array. `applied` tracks the live
      // order because ADD VALUE ... BEFORE needs an existing anchor.
      const applied = [...current];
      for (const value of values) {
        if (applied.includes(value)) continue;

        const successor = values
          .slice(values.indexOf(value) + 1)
          .find((v) => applied.includes(v));
        const placement = successor ? { before: successor } : undefined;

        const ddl =
          `ALTER TYPE ${enumName} ADD VALUE IF NOT EXISTS '${escapeSqlLiteral(value)}'` +
          (successor ? ` BEFORE '${escapeSqlLiteral(successor)}'` : "");
        if (isDryRun) {
          this.logger.info(`[dry-run] Would ${ddl}`);
          continue;
        }
        this.logDdl(`[sync] ${ddl}`, policy);
        try {
          await driver.addEnumValue(enumName, value, placement);
          applied.splice(
            successor ? applied.indexOf(successor) : applied.length,
            0,
            value,
          );
        } catch (err) {
          this.handleDdlError(
            err,
            `Failed to add value "${value}" to enum type ${enumName}`,
            policy,
          );
        }
      }

      const extra = current.filter((v) => !values.includes(v));
      if (extra.length > 0) {
        this.logger.warn(
          `[sync] Enum type ${enumName} still has ${extra
            .map((v) => `"${v}"`)
            .join(", ")}, which the entity no longer declares. ` +
            `PostgreSQL cannot drop an enum value in place, so it is left as is — write a migration if it must go.`,
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
    policy: SynchronizePolicy,
  ): Promise<void> {
    const connection = this.ctx.getConnection();
    if (!connection) return;

    const dialect = this.ctx.getDialect();
    const schema = this.ctx.getSchema();
    const queryRunner = { query: (s: any) => connection.query(s) };

    const schemaDiff = new SchemaDiff();

    let diff: SchemaDiffResult;
    try {
      // `detectDroppedTables` is deliberately left off: synchronize operates on
      // columns only and never drops a table, no matter the mode. A database
      // routinely holds tables this connection knows nothing about (other
      // services, other EntityManagers, migration bookkeeping), so entity
      // absence is not evidence that a table is obsolete. `diff.dropTables` is
      // therefore always empty here and has no consumer below — table removal
      // belongs to a migration the author reviewed.
      diff = await schemaDiff.diff(
        existingEntities,
        queryRunner,
        dialect,
        schema,
      );
    } catch (err) {
      this.handleDdlError(err, "SchemaDiff failed, skipping ALTER operations", policy);
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

    await this.applySchemaDiff(diff, fkColumnsPerTable, policy, dialect);
  }

  /**
   * Applies a SchemaDiffResult according to the selected policy.
   */
  private async applySchemaDiff(
    diff: SchemaDiffResult,
    fkColumnsPerTable: Map<string, Set<string>>,
    policy: SynchronizePolicy,
    dialect: SchemaDialect,
  ): Promise<void> {
    const driver = this.ctx.getDriver();
    if (!driver) return;

    const mode = policy.mode;
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
        try {
          await driver.addColumn(col.tableName, col.columnName, typeDef);
        } catch (err) {
          // Don't abort the entire diff on a single column failure when
          // continueOnError is true — a type-incompatible column rename or a
          // NOT NULL add against a populated column should be surfaced and
          // skipped, not crash the remaining add/alter ops. When
          // continueOnError is false, handleDdlError() rethrows.
          this.handleDdlError(
            err,
            `Failed to add column ${col.tableName}.${col.columnName}`,
            policy,
          );
        }
      }
    }

    // Changes that "safe" mode declines to apply. Collected here and reported
    // once at the end so a safe-mode boot is never silent about the schema
    // drift it left in place.
    const safeSkipped: SkippedSafeChange[] = [];

    // 2. ALTER COLUMNS (only in true mode; safe reports and skips)
    if (isFull || isDryRun) {
      for (const col of diff.alterColumns) {
        const ddl = this.buildAlterColumnDDL(col, dialect);
        if (!ddl) continue; // SQLite: unsupported
        if (this.isNarrowingAlter(col)) {
          this.assertDestructiveAllowed(
            "ALTER COLUMN (narrowing)",
            `${col.tableName}.${col.columnName} (${col.currentType} → ${col.columnType})`,
            policy,
          );
        }
        const change =
          col.typeChanged === false
            ? `nullability ${col.currentNullable ? "NULL" : "NOT NULL"} → ${col.nullable === false ? "NOT NULL" : "NULL"}`
            : `${col.currentType} → ${col.columnType}`;
        if (isDryRun) {
          this.logger.info(`[dry-run] ${ddl}`);
        } else {
          this.logger.warn(
            `[sync] Altering column ${col.tableName}.${col.columnName}: ${change}`,
          );
          this.logDdl(`[sync] ${ddl}`, policy);
          try {
            await driver.executeRaw(ddl);
          } catch (err) {
            this.handleDdlError(
              err,
              `Failed to alter column ${col.tableName}.${col.columnName}`,
              policy,
            );
          }
        }
      }
    } else if (isSafe) {
      for (const col of diff.alterColumns) {
        // A null DDL means the dialect cannot express the change at all
        // (SQLite), which buildAlterColumnDDL() already warns about — it is
        // not a change the "safe" policy is holding back.
        const ddl = this.buildAlterColumnDDL(col, dialect);
        if (!ddl) continue;
        safeSkipped.push({
          kind: "ALTER COLUMN",
          target: `${col.tableName}.${col.columnName}`,
          ddl,
        });
      }
    }

    // 3. DROP COLUMNS (only in true mode; safe reports and skips)
    if (isFull || isDryRun) {
      for (const col of diff.dropColumns) {
        // FK columns are excluded from DROP (they are managed in pass 2).
        const tableFkCols = fkColumnsPerTable.get(col.tableName.toLowerCase());
        if (tableFkCols?.has(col.columnName.toLowerCase())) continue;

        this.assertDestructiveAllowed(
          "DROP COLUMN",
          `${col.tableName}.${col.columnName}`,
          policy,
        );

        if (isDryRun) {
          this.logger.info(
            `[dry-run] ALTER TABLE ${col.tableName} DROP COLUMN ${col.columnName}`,
          );
        } else {
          this.logger.warn(
            `[sync] Dropping column ${col.tableName}.${col.columnName}`,
          );
          this.logDdl(
            `[sync] ALTER TABLE ${col.tableName} DROP COLUMN ${col.columnName}`,
            policy,
          );
          try {
            await driver.dropColumn(col.tableName, col.columnName);
          } catch (err) {
            this.handleDdlError(
              err,
              `Failed to drop column ${col.tableName}.${col.columnName}`,
              policy,
            );
          }
        }
      }
    } else if (isSafe) {
      for (const col of diff.dropColumns) {
        // FK columns are never dropped by the diff pass in any mode.
        const tableFkCols = fkColumnsPerTable.get(col.tableName.toLowerCase());
        if (tableFkCols?.has(col.columnName.toLowerCase())) continue;
        safeSkipped.push({
          kind: "DROP COLUMN",
          target: `${col.tableName}.${col.columnName}`,
          ddl: `ALTER TABLE ${col.tableName} DROP COLUMN ${col.columnName}`,
        });
      }
    }

    // 4. RENAME COLUMNS (only in true mode; safe reports and skips)
    if ((isFull || isDryRun) && diff.renamedColumns) {
      for (const rename of diff.renamedColumns) {
        const ddl = `ALTER TABLE ${this.ctx.wrap(rename.tableName)} RENAME COLUMN ${this.ctx.wrap(rename.oldColumnName)} TO ${this.ctx.wrap(rename.newColumnName)}`;
        if (isDryRun) {
          this.logger.info(`[dry-run] ${ddl}`);
        } else {
          this.logger.warn(
            `[sync] Renaming column ${rename.tableName}.${rename.oldColumnName} → ${rename.newColumnName}`,
          );
          this.logDdl(`[sync] ${ddl}`, policy);
          try {
            await driver.executeRaw(ddl);
          } catch (err) {
            this.handleDdlError(
              err,
              `Failed to rename column ${rename.tableName}.${rename.oldColumnName} → ${rename.newColumnName}`,
              policy,
            );
          }
        }
      }
    } else if (isSafe && diff.renamedColumns) {
      for (const rename of diff.renamedColumns) {
        safeSkipped.push({
          kind: "RENAME COLUMN",
          target: `${rename.tableName}.${rename.oldColumnName} → ${rename.newColumnName}`,
          ddl: `ALTER TABLE ${this.ctx.wrap(rename.tableName)} RENAME COLUMN ${this.ctx.wrap(rename.oldColumnName)} TO ${this.ctx.wrap(rename.newColumnName)}`,
        });
      }
    }

    this.reportSafeModeSkips(safeSkipped, policy);
  }

  /**
   * Reports the alter/drop/rename changes that `"safe"` mode declined to apply.
   *
   * Safe mode used to drop them on the floor without a word, so a clean boot
   * log was indistinguishable from a fully synchronized schema — a shortened
   * varchar or a renamed column stayed invisible until the first INSERT failed.
   * #331 added `logDDL` for DDL visibility, but the flag only ever reached the
   * execution branches, which safe mode never enters.
   */
  private reportSafeModeSkips(
    skipped: SkippedSafeChange[],
    policy: SynchronizePolicy,
  ): void {
    if (skipped.length === 0) return;

    const countByKind = new Map<string, number>();
    for (const change of skipped) {
      countByKind.set(change.kind, (countByKind.get(change.kind) ?? 0) + 1);
    }
    const breakdown = Array.from(countByKind.entries())
      .map(([kind, count]) => `${count} ${kind}`)
      .join(", ");

    const SAMPLE_SIZE = 3;
    const sample = skipped
      .slice(0, SAMPLE_SIZE)
      .map((change) => change.target)
      .join(", ");
    const more =
      skipped.length > SAMPLE_SIZE
        ? `, +${skipped.length - SAMPLE_SIZE} more`
        : "";

    const hint = policy.logDDL
      ? "Apply them with synchronize.mode: true or a migration."
      : "Apply them with synchronize.mode: true or a migration; set synchronize.logDDL: true to log each skipped statement.";

    this.logger.warn(
      `[sync] safe mode skipped ${skipped.length} schema change(s): ${breakdown} (${sample}${more}). ${hint}`,
    );

    for (const change of skipped) {
      this.logDdl(`[skipped: safe mode] ${change.ddl}`, policy);
    }
  }

  /**
   * Emits a DDL log entry at info level when `policy.logDDL` is true.
   * The default mode is silent so existing tests that count info-level
   * statements are unaffected.
   */
  private logDdl(message: string, policy: SynchronizePolicy): void {
    if (policy.logDDL) {
      this.logger.info(message);
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
    // #286: escape backslashes too, not just single quotes — under MySQL's
    // default `NO_BACKSLASH_ESCAPES = OFF` mode a trailing `\` will swallow
    // the closing `'` and let the next value continue as raw DDL.
    const isENUM = type.toUpperCase().startsWith("ENUM");
    if (isENUM && col.enumValues && col.enumValues.length > 0) {
      const values = col.enumValues
        .map((v: string) => `'${escapeSqlLiteral(v)}'`)
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
   *   - Enum -> forced NULL (any default would invent a domain value)
   *   - Other types (JSON, BLOB, etc.) -> forced NULL (no safe default)
   *
   * A forced-NULL fall-through means the shipped column is weaker than the
   * entity declares, so it is reported rather than applied silently.
   */
  private buildAddColumnTypeDef(col: ColumnChange): string {
    const type = this.buildColumnTypeExpr(col);

    if (col.nullable !== false) {
      return `${type} NULL`;
    }

    // Type-appropriate default for NOT NULL backfill (#177)
    const upperType = type.toUpperCase();

    // ENUM is excluded on purpose: `''` is only a legal default when the empty
    // string is one of the declared values, so MySQL rejects
    // `ENUM('a','b') NOT NULL DEFAULT ''` outright (1067), and PostgreSQL's
    // enum arrives here as a quoted type name. Picking a real member as the
    // backfill value would silently invent data, so the column is added
    // nullable instead — see the fall-through below.
    if (/^(VARCHAR|TEXT|CHAR|LONGTEXT|MEDIUMTEXT|TINYTEXT)/.test(upperType)) {
      return `${type} NOT NULL DEFAULT ''`;
    }
    if (/^(INT|BIGINT|FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL|SMALLINT|TINYINT|SERIAL|INTEGER|MEDIUMINT)/.test(upperType)) {
      return `${type} NOT NULL DEFAULT 0`;
    }
    if (/^(BOOL|BOOLEAN)/.test(upperType)) {
      const defaultVal = this.ctx.isMySqlFamily() ? "0" : "FALSE";
      return `${type} NOT NULL DEFAULT ${defaultVal}`;
    }

    // Datetime/timestamp/date, enum, and other types (JSON, JSONB, BLOB,
    // BYTEA, ARRAY, etc.) cannot have a safe universal default — force
    // nullable so existing rows survive the ADD COLUMN.
    this.logger.warn(
      `[sync] Column ${col.tableName}.${col.columnName} is declared NOT NULL, but ${type} has no safe backfill default. ` +
        `It is added as NULL, and existing rows keep NULL. Backfill the column and enforce NOT NULL in a migration if it must be required.`,
    );
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
      const what =
        col.typeChanged === false
          ? `column nullability for ${col.tableName}.${col.columnName}`
          : `ALTER COLUMN TYPE for ${col.tableName}.${col.columnName} (${col.currentType} → ${typeExpr})`;
      this.logger.warn(`[sync] SQLite does not support ${what}. Skipping.`);
      return null;
    }

    if (dialect === "mysql") {
      // MODIFY COLUMN restates the whole definition, so it carries both the
      // type and the declared nullability — covering a type change, a
      // nullability-only change, or both at once.
      const nullable = col.nullable === false ? "NOT NULL" : "NULL";
      return `ALTER TABLE ${tableName} MODIFY COLUMN ${columnName} ${typeExpr} ${nullable}`;
    }

    // PostgreSQL: TYPE and nullability are independent ALTER actions and a
    // single ALTER TABLE may carry both. A nullability-only change
    // (typeChanged === false) skips the TYPE rewrite — `ALTER COLUMN ... TYPE`
    // forces a full table rewrite even when the type is unchanged.
    const actions: string[] = [];
    if (col.typeChanged !== false) {
      actions.push(`ALTER COLUMN ${columnName} TYPE ${typeExpr}`);
    }
    const targetNullable = col.nullable !== false;
    if (col.currentNullable !== undefined && col.currentNullable !== targetNullable) {
      actions.push(
        targetNullable
          ? `ALTER COLUMN ${columnName} DROP NOT NULL`
          : `ALTER COLUMN ${columnName} SET NOT NULL`,
      );
    }
    if (actions.length === 0) return null;
    return `ALTER TABLE ${tableName} ${actions.join(", ")}`;
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

    // Build property-to-column name map to resolve @UniqueIndex() property
    // keys (#176), including @RelationColumn FK shadow properties so an
    // index on e.g. `workspaceId` targets the real `workspace_id` column.
    const colMeta = (Reflect.getMetadata(
      COLUMN_TOKEN,
      TargetEntity.prototype,
    ) ?? []) as ColumnMetadata[];
    // ctx may be a partial mock in unit tests, so guard the resolver access.
    const propColMap = buildSharedPropertyToColumnMap(
      { target: TargetEntity, columns: colMeta },
      typeof this.ctx.getResolver === "function"
        ? this.ctx.getResolver()
        : undefined,
    );

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
        try {
          await driver?.addCompositeUniqueIndex(tableName, resolvedColumns, indexName);
        } catch (err) {
          // A schema-drift state (e.g. snake/camel column rename mid-flight)
          // can leave a UniqueIndex pointing at a column that doesn't exist
          // yet. Log and continue so a single broken constraint doesn't
          // kill app boot — registerFullTextIndexes uses the same pattern.
          this.handleDdlError(
            err,
            `Could not create unique index ${indexName} on ${tableName}(${resolvedColumns.join(", ")})`,
            this.activePolicy,
          );
        }
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

        // 1. Look up the owning-side and inverse-side PKs (needed both for
        //    inline FK clauses at CREATE time and the ALTER-based FK pass).
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

        const ownerFkName = this.namingStrategy.foreignKeyName(
          joinTableName,
          joinColumn,
          ownerTable,
        );
        const relatedFkName = this.namingStrategy.foreignKeyName(
          joinTableName,
          inverseJoinColumn,
          relatedTable,
        );

        const canAlterFk = this.driverSupportsAlterAddFk();

        // 2. Create the join table (IF NOT EXISTS — safe across restarts).
        const hasTable = await driver?.hasTable(joinTableName);
        if (!hasTable || (hasTable as any[]).length === 0) {
          const wJoinTable = this.ctx.wrap(joinTableName);
          const wJoinCol = this.ctx.wrap(joinColumn);
          const wInvCol = this.ctx.wrap(inverseJoinColumn);
          // Derive join column types from actual PK types (#178)
          const ownerPkType = this.resolvePkColumnType(entity);
          const relatedPkType = this.resolvePkColumnType(relatedEntity);
          let body = `${wJoinCol} ${ownerPkType} NOT NULL, ${wInvCol} ${relatedPkType} NOT NULL, PRIMARY KEY (${wJoinCol}, ${wInvCol})`;
          // Inline-FK dialects (SQLite) cannot ALTER TABLE ADD CONSTRAINT,
          // so the join table FKs must be part of CREATE TABLE.
          if (!canAlterFk) {
            if (ownerPk) {
              body += `, CONSTRAINT ${this.ctx.wrap(ownerFkName)} FOREIGN KEY (${wJoinCol}) REFERENCES ${this.ctx.wrap(ownerTable)}(${this.ctx.wrap(ownerPk)}) ON DELETE CASCADE ON UPDATE CASCADE`;
            }
            if (relatedPk) {
              body += `, CONSTRAINT ${this.ctx.wrap(relatedFkName)} FOREIGN KEY (${wInvCol}) REFERENCES ${this.ctx.wrap(relatedTable)}(${this.ctx.wrap(relatedPk)}) ON DELETE CASCADE ON UPDATE CASCADE`;
            }
          }
          let ddl = `CREATE TABLE IF NOT EXISTS ${wJoinTable} (${body})`;
          if (this.ctx.isMySqlFamily()) ddl += " ENGINE=InnoDB";
          await driver?.executeRaw(ddl);
        }

        // 3. Add the owning-side FK (ALTER-capable dialects only).
        if (
          canAlterFk &&
          ownerPk &&
          driver &&
          !(await driver.hasForeignKey(joinTableName, ownerFkName))
        ) {
          const ddl = `ALTER TABLE ${this.ctx.wrap(joinTableName)} ADD CONSTRAINT ${ownerFkName} FOREIGN KEY (${this.ctx.wrap(joinColumn)}) REFERENCES ${this.ctx.wrap(ownerTable)}(${this.ctx.wrap(ownerPk)}) ON DELETE CASCADE ON UPDATE CASCADE`;
          await driver.executeRaw(ddl);
        }

        // 4. Add the inverse-side FK (ALTER-capable dialects only).
        if (
          canAlterFk &&
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

  /**
   * Whether the active driver can add FK constraints after table creation.
   * SQLite cannot (`supportsAlterAddForeignKey: false`) — its FKs are embedded
   * inline at CREATE TABLE time instead, and the ALTER-based FK passes are
   * skipped. Defaults to true when the driver does not report capabilities.
   */
  private driverSupportsAlterAddFk(): boolean {
    const driver = this.ctx.getDriver();
    return driver?.getCapabilities?.().supportsAlterAddForeignKey ?? true;
  }

  /**
   * Collects the FK definitions that `registerForeignKeys()` would create via
   * ALTER TABLE, in a form that can be embedded inline into CREATE TABLE for
   * dialects without ALTER ADD FOREIGN KEY support (SQLite).
   *
   * Also returns join columns that are not declared as entity columns
   * (`extraColumns`) so they can be created together with the table — the
   * ALTER-based pass adds them afterwards, which SQLite supports, but the FK
   * clause referencing them must exist at CREATE time.
   *
   * Relations with a missing joinColumn are skipped here without error;
   * `registerForeignKeys()` still runs afterwards and raises the proper
   * validation error for that case.
   */
  private collectInlineForeignKeys(
    TargetEntity: ClazzType<any>,
    tableName: string,
    columns: Array<{ name?: string; propertyKey?: string }>,
  ): { foreignKeys: CreateTableForeignKey[]; extraColumns: any[] } {
    const entityScanner = getScannerInstance(EntityScanner);
    const foreignKeys: CreateTableForeignKey[] = [];
    const extraColumns: any[] = [];
    const existingCols = new Set(
      columns.map((c) => (c.name ?? c.propertyKey ?? "").toLowerCase()),
    );

    const pushJoinColumnIfMissing = (
      joinColumn: string,
      referencedEntity: ClazzType<any>,
    ) => {
      const key = joinColumn.toLowerCase();
      if (existingCols.has(key)) return;
      existingCols.add(key);
      extraColumns.push(this.buildJoinColumnDef(joinColumn, referencedEntity));
    };

    // ManyToOne
    const manyToOneItems =
      this.resolver.resolveManyToOneMetadata(TargetEntity) ?? [];
    for (const rel of manyToOneItems) {
      if (rel.option?.createForeignKeyConstraints === false) continue;
      if (!rel.joinColumn) continue;
      const mappingEntity = rel.getMappingEntity();
      if (!mappingEntity) continue;
      const mappingMeta = entityScanner.scan(mappingEntity);
      if (!mappingMeta) continue;
      const referencedColumn =
        rel.references ??
        mappingMeta.columns.find((c: any) => c.options?.primary)?.name;
      if (!referencedColumn) continue;
      const referencedTable =
        mappingMeta.name || this.ctx.getNameStrategy(mappingEntity);
      foreignKeys.push({
        columnName: rel.joinColumn,
        referencedTable,
        referencedColumn,
        constraintName: this.namingStrategy.foreignKeyName(
          tableName,
          rel.joinColumn,
          referencedTable,
        ),
        onDelete: rel.option?.onDelete,
        onUpdate: rel.option?.onUpdate,
      });
      pushJoinColumnIfMissing(rel.joinColumn, mappingEntity);
    }

    // OneToOne (owning side)
    const oneToOneItems =
      this.resolver.resolveOneToOneMetadata(TargetEntity) ?? [];
    for (const rel of oneToOneItems) {
      if (!rel.joinColumn) continue;
      if (rel.option?.createForeignKeyConstraints === false) continue;
      const relatedEntity = rel.getRelatedEntity();
      if (!relatedEntity) continue;
      const relatedMeta = entityScanner.scan(relatedEntity);
      if (!relatedMeta) continue;
      const referencedColumn = relatedMeta.columns.find(
        (c: any) => c.options?.primary,
      )?.name;
      if (!referencedColumn) continue;
      const referencedTable =
        relatedMeta.name || this.ctx.getNameStrategy(relatedEntity);
      foreignKeys.push({
        columnName: rel.joinColumn,
        referencedTable,
        referencedColumn,
        constraintName: this.namingStrategy.foreignKeyName(
          tableName,
          rel.joinColumn,
          referencedTable,
        ),
        onDelete: rel.option?.onDelete,
        onUpdate: rel.option?.onUpdate,
      });
      pushJoinColumnIfMissing(rel.joinColumn, relatedEntity);
    }

    // TPT (JOINED) child: PK references the root table's PK.
    if (
      this.inheritanceResolver.isChildEntity(TargetEntity) &&
      this.inheritanceResolver.getStrategy(TargetEntity) === "JOINED"
    ) {
      const root = this.inheritanceResolver.getRoot(TargetEntity);
      const rootMeta = root
        ? this.resolver.resolveEntityMetadata(root)
        : undefined;
      const pk = columns.find((c: any) => c.options?.primary) as any;
      const rootPk = rootMeta?.columns.find((c: any) => c.options?.primary);
      if (pk?.name && rootPk?.name && rootMeta?.name) {
        foreignKeys.push({
          columnName: pk.name,
          referencedTable: rootMeta.name,
          referencedColumn: rootPk.name,
          constraintName: this.namingStrategy.foreignKeyName(
            tableName,
            pk.name,
            rootMeta.name,
          ),
        });
      }
    }

    return { foreignKeys, extraColumns };
  }

  /**
   * Builds a column definition for a join column that has no explicit
   * entity column, typed after the referenced entity's PK (#284) and
   * nullable — mirroring the ALTER-based fallback in registerForeignKeys.
   */
  private buildJoinColumnDef(
    joinColumn: string,
    referencedEntity: ClazzType<any>,
  ): any {
    const columns = (Reflect.getMetadata(
      COLUMN_TOKEN,
      referencedEntity.prototype,
    ) ?? []) as ColumnMetadata[];
    const pkCol = columns.find((c) => c.options?.primary);
    return {
      name: joinColumn,
      options: {
        type: pkCol?.options?.type ?? "int",
        length: pkCol?.options?.length,
        nullable: true,
      },
    };
  }

  async registerForeignKeys(TargetEntity: ClazzType<any>, tableName: string) {
    // Fetch the entity scanner.
    const entityScanner = getScannerInstance(EntityScanner);
    const driver = this.ctx.getDriver();
    const canAlterFk = this.driverSupportsAlterAddFk();

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
            "Add { joinColumn: 'column_name' } to the relation — decorator: @ManyToOne(() => Target, { joinColumn: 'target_id' }); code-first: t.manyToOne(() => Target, { joinColumn: 'target_id' }) in defineEntity(), or the relations block of an EntitySchema.",
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
        // Derive the FK column type from the referenced entity's PK type so
        // UUID/varchar/bigint PKs aren't silently coerced to INT (#284).
        if (driver) {
          const columnExists = await driver.hasColumn(tableName, joinColumn);
          if (!columnExists) {
            const fkColumnType = this.resolvePkColumnType(mappingEntity) + " NULL";
            await driver.addColumn(tableName, joinColumn, fkColumnType);
          }
        }

        // Dialects without ALTER ADD FOREIGN KEY (SQLite) get their FKs
        // embedded inline at CREATE TABLE time — skip the ALTER-based pass.
        if (!canAlterFk) continue;

        // The NamingStrategy name is both checked for existence AND passed to
        // addForeignKey — a custom strategy previously only affected the
        // check while the DDL fell back to the hash-based name (#411).
        const m2oFkName = this.namingStrategy.foreignKeyName(
          tableName,
          joinColumn,
          mappingTableName,
        );
        if (driver) {
          const fkExists = await driver.hasForeignKey(tableName, m2oFkName);
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
          m2oFkName,
        );
      }
    }

    // Create FKs for the owning side of each OneToOne relation (the side with joinColumn).
    const oneToOneItems = this.resolver.resolveOneToOneMetadata(TargetEntity);
    for (const oneToOneItem of oneToOneItems) {
      const { joinColumn } = oneToOneItem;
      if (!joinColumn) continue; // Inverse side has no FK.
      // Skip FK creation when createForeignKeyConstraints is false, mirroring
      // the ManyToOne path above and SchemaGenerator.getForeignKeys().
      if (oneToOneItem.option?.createForeignKeyConstraints === false) continue;

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
      // Derive the FK column type from the referenced entity's PK type so
      // UUID/varchar/bigint PKs aren't silently coerced to INT (#284).
      if (driver) {
        const columnExists = await driver.hasColumn(tableName, joinColumn);
        if (!columnExists) {
          const fkColumnType = this.resolvePkColumnType(RelatedEntity) + " NULL";
          await driver.addColumn(tableName, joinColumn, fkColumnType);
        }
      }

      // Same as the ManyToOne path: inline-FK dialects skip the ALTER pass.
      if (!canAlterFk) continue;

      const relatedTableName =
        relatedMetadata.name || this.ctx.getNameStrategy(RelatedEntity);

      // Same as the ManyToOne path: check and create under the SAME
      // NamingStrategy-derived constraint name (#411).
      const o2oFkName = this.namingStrategy.foreignKeyName(
        tableName,
        joinColumn,
        relatedTableName,
      );
      if (driver) {
        const fkExists = await driver.hasForeignKey(tableName, o2oFkName);
        if (fkExists) continue;
      }

      await driver?.addForeignKey(
        tableName,
        joinColumn,
        relatedTableName,
        relatedPrimaryKey,
        o2oFkName,
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
      // Build property-to-column name map to resolve @Index() property keys
      // (#176), including @RelationColumn FK shadow properties so an index
      // on e.g. `workspaceId` targets the real `workspace_id` column.
      const columns = (Reflect.getMetadata(
        COLUMN_TOKEN,
        TargetEntity.prototype,
      ) ?? []) as ColumnMetadata[];
      // ctx may be a partial mock in unit tests, so guard the resolver access.
      const propColMap = buildSharedPropertyToColumnMap(
        { target: TargetEntity, columns },
        typeof this.ctx.getResolver === "function"
          ? this.ctx.getResolver()
          : undefined,
      );

      for (const index of indexer) {
        // index.name is the property key; resolve to actual DB column name
        const columnName = propColMap.get(index.name) ?? index.name;
        const indexName = this.namingStrategy.indexName(tableName, columnName);

        const indexes = (await driver?.getIndexes(tableName)) as any[];

        let isExist = false;
        for (const idx of indexes || []) {
          // MySQL uses "Key_name"; PostgreSQL uses "Field" (aliased from
          // indexname); SQLite's PRAGMA index_list exposes it as "name".
          // Without the "name" fallback the existence check never matches on
          // SQLite, so addIndex (CREATE INDEX, no IF NOT EXISTS) re-runs every
          // boot and throws "index already exists" on the second start.
          const existingIndexName =
            idx["Key_name"] ?? idx["Field"] ?? idx["name"];
          if (existingIndexName === indexName) {
            isExist = true;
            break;
          }
        }

        if (!isExist) {
          try {
            await driver?.addIndex(tableName, columnName, indexName);
          } catch (err) {
            // Same schema-drift tolerance as registerUniqueIndexes /
            // registerFullTextIndexes: a missing column is a deployment
            // problem to surface, not a reason to abort boot.
            this.handleDdlError(
              err,
              `Could not create index ${indexName} on ${tableName}(${columnName})`,
              this.activePolicy,
            );
          }
        }
      }
    }
  }

  /**
   * Creates FULLTEXT (MySQL) / GIN + to_tsvector (PostgreSQL) indexes
   * declared via the class-level @FullTextIndex decorator. SQLite is
   * skipped because the dialect has no equivalent index family.
   *
   * Idempotent: existing indexes (matched by name) are left alone, so
   * the pass is safe to re-run on every startup. The DDL itself is
   * produced by SchemaGenerator so the synchronize and migration
   * code paths stay in lockstep.
   */
  async registerFullTextIndexes(
    TargetEntity: ClazzType<any>,
    tableName: string,
  ) {
    if (this.ctx.getDialect() === "sqlite") return;

    const ftIndexes = Reflect.getMetadata(
      FULLTEXT_INDEX_TOKEN,
      TargetEntity,
    ) as FullTextIndexMetadata[] | undefined;
    if (!ftIndexes || ftIndexes.length === 0) return;

    const driver = this.ctx.getDriver();
    if (!driver) return;

    const generator = new SchemaGenerator({
      dialect: this.ctx.getDialect(),
      schema: this.ctx.getSchema(),
      namingStrategy: this.namingStrategy,
    });
    const ddls = generator.generateFullTextIndexDDL(TargetEntity);

    // Names parallel to ddls (same iteration order as the metadata array).
    const indexNames = ftIndexes.map(
      (ft) => ft.name ?? `fts_${tableName}_${ft.columns.join("_")}`,
    );

    const existingIndexes = (await driver.getIndexes(tableName)) as any[];
    const existingNames = new Set<string>();
    for (const idx of existingIndexes ?? []) {
      const n = idx["Key_name"] ?? idx["Field"] ?? idx["name"];
      if (typeof n === "string") existingNames.add(n);
    }

    for (let i = 0; i < ddls.length; i++) {
      const indexName = indexNames[i];
      if (existingNames.has(indexName)) continue;
      this.logDdl(`[sync] ${ddls[i]}`, this.activePolicy);
      try {
        await driver.executeRaw(ddls[i]);
      } catch (err) {
        this.handleDdlError(
          err,
          `Could not create full-text index ${indexName} on ${tableName}`,
          this.activePolicy,
        );
      }
    }
  }
}
