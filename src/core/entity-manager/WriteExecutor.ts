import { randomUUID } from "node:crypto";
import { ClazzType, Logger, resolveEntityGlobs, generateUUIDv7 } from "../../utils";
import { ColumnMetadata, EntityScannerMetadata } from "../../scanner";
import { ISqlDriver } from "../../dialects/SqlDriver";
import { TransactionSessionManager } from "../../dialects/TransactionSessionManager";
import { FindOption, LockMode, UpdateData, UpdateManyOptions, WhereClause } from "../../dialects/FindOption";
import { resolveWhereClause } from "../WhereResolver";
import sql, { Sql, join, raw, isSqlFragment, type RawValue } from "../../utils/sqlTag";
import { DeleteResult } from "../../types/DeleteResult";
import { Conditions } from "../Conditions";
import { ResultTransformerFactory } from "../ResultTransformerFactory";
import { EntityValidator } from "../EntityValidator";
import {
  EntityEventEmitter,
  EntityEventType,
  EntityEventListener,
} from "../EntityEventEmitter";
import { EntityMetadataNotFoundError } from "../../errors/EntityMetadataNotFoundError";
import { EntityNotFoundError } from "../../errors/EntityNotFoundError";
import { InvalidQueryError } from "../../errors/InvalidQueryError";
import { OptimisticLockError } from "../../errors/OptimisticLockError";
import { PrimaryKeyNotFoundError } from "../../errors/PrimaryKeyNotFoundError";
import { DeleteWithoutConditionsError } from "../../errors/DeleteWithoutConditionsError";
import {
  EntitySubscriber,
  InsertEvent,
  UpdateEvent,
  DeleteEvent,
} from "../EntitySubscriber";
import { EntityManagerInternals } from "../EntityManagerInternals";
import type { ManyToOneMetadata } from "../../decorators/ManyToOne";
import { RelationMetadataResolver } from "../RelationMetadataResolver";
import { CascadeHandler } from "../CascadeHandler";
import { transactionStorage } from "../../decorators/Transactional";
import type { InheritanceStrategy } from "../../decorators/Inheritance";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import { DefaultNamingStrategy, NamingStrategy } from "../generators/NamingStrategy";
import { InheritanceResolver } from "../InheritanceResolver";
import { isTpcPolymorphicRoot, resolveTpcTables } from "../TpcUnionSource";
import { DEFAULT_BIGINT_MODE, normalizeBigintValue } from "../BigintColumnTransformer";
import { assertScalarBindValue } from "../BindValueGuard";
import { createDialectExpression } from "../../dialects/DialectExpression";
import { UpdateQueryBuilder } from "../UpdateQueryBuilder";
import {
  DmlSqlBuilder,
  type InsertConflictAction,
  type UpsertManagedAssignments,
} from "./DmlSqlBuilder";
import type {
  ConflictAction,
  InsertBuilderSpec,
} from "../InsertQueryBuilder";
import {
  isDeadlockError,
  isTemplateStringsArray,
} from "./internal-utils";
import {
  bindParam,
  bindParams,
  fieldsOf,
  okPacket,
  resultRows,
  sqliteRunResult,
  whereByProps,
  type DriverExecResult,
  type DriverRow,
  type EntityFields,
} from "./entity-access";

/**
 * Primary keys bound per `IN (...)` list when a TPT delete removes the rows
 * it matched — well under every dialect's bind-parameter limit.
 */
const TPT_DELETE_ID_CHUNK = 1000;

/**
 * A ManyToOne FK appended to a multi-row INSERT's column list, paired with the
 * relation metadata needed to resolve each row's value.
 */
interface FkColumnBinding {
  joinColumn: string;
  propertyName: string;
  relMeta: ManyToOneMetadata<unknown>;
}

/**
 * Per-call state shared by the saveInternal helper methods — built once at the
 * top of the transaction closure and threaded through the INSERT/UPDATE
 * helpers instead of a long positional parameter list.
 */
interface SaveOperation<T> {
  entity: ClazzType<T>;
  item: Partial<T>;
  metadata: EntityScannerMetadata;
  session: TransactionSessionManager;
  /** {@link fieldsOf} view over `item`, hoisted once per call. */
  itemFields: EntityFields;
  pkColumns: ColumnMetadata[];
  /** First PK column (composite PKs keep the full list in `pkColumns`). */
  pk: ColumnMetadata;
  hasAutoIncrementPk: boolean;
  /** The PK value present on `item` at entry (undefined on generated INSERTs). */
  primaryKeyValue: unknown;
  buildPkWhere: (pkValues?: DriverRow) => Sql[];
  buildPkFindWhere: (pkValues?: DriverRow) => WhereClause<T>;
}

/** Column/value lists staged for the single-row INSERT of saveInternal. */
interface InsertValuePlan {
  /** Metadata of the columns taken from `item` (parallel to the head of `columns`). */
  insertableColumns: ColumnMetadata[];
  /** Wrapped column identifiers; may grow beyond `insertableColumns` (discriminator, FK). */
  columns: Sql[];
  /** Bound values, parallel to `columns`. */
  values: RawValue[];
}

/** SET clauses staged for the UPDATE path of saveInternal. */
interface UpdateSetPlan {
  /** Metadata of the columns taken from `item` (parallel to the head of `updateMap`). */
  updatableColumns: ColumnMetadata[];
  /** SET clauses; may grow beyond `updatableColumns` (@UpdateTimestamp, FK, @Version). */
  updateMap: Sql[];
  /** DB column name of the @Version column, when the entity declares one. */
  versionColName: string | null;
}

/** Column lists staged for an INSERT ... ON CONFLICT statement. */
/**
 * The tenant predicate an upsert's conflict branch is guarded with, plus the
 * bare table reference MySQL's per-assignment `IF()` form needs.
 */
export interface UpsertTenantGuard {
  /** `"table"."tenant_id" = ?` — reads the row already stored. */
  predicate: Sql;
  /** Wrapped bare table name (never schema-qualified). */
  tableRef: string;
  /** Resolved tenant column name, for diagnostics. */
  columnName: string;
}

interface UpsertPlan {
  /** Metadata of the columns the INSERT names, in statement order. */
  insertableColumns: ColumnMetadata[];
  /** `@ManyToOne` join columns no `@Column` declares, named after `insertableColumns`. */
  fkColumns: FkColumnBinding[];
  /** Wrapped table identifier. */
  tableName: string;
  /** Wrapped identifiers of `insertableColumns`, then of `fkColumns`. */
  wrappedColumns: string[];
  /** Wrapped identifiers of the conflict target. */
  wrappedConflict: string[];
  /**
   * Wrapped identifiers of the caller's columns the DO UPDATE writes — the
   * primary key, conflict targets, the tenant discriminator and the managed
   * columns excluded. Empty means nothing of the caller's is written on
   * conflict: DO NOTHING, or only the soft-delete revive when `managed.reset`
   * is set.
   */
  wrappedUpdate: string[];
  /** Unwrapped names of the conflict target, in statement order. */
  conflictNames: string[];
  /** The `@UpdateTimestamp` / `@Version` / `@DeletedAt` assignments that ride along with `wrappedUpdate`. */
  managed: UpsertManagedAssignments;
}

/**
 * Executes all write operations (INSERT / UPDATE / DELETE / UPSERT) for
 * EntityManager. Holds no schema state — reads dialect/identifier/helper
 * services from {@link EntityManagerInternals} and its injected collaborators.
 *
 * @internal Package-internal — not a public API.
 */
export class WriteExecutor {
  private readonly dmlSqlBuilder: DmlSqlBuilder;
  /** Entity classes already warned that upsert ignores a stated `@Version`. */
  private readonly upsertVersionWarnedEntities = new Set<Function>();

  constructor(private readonly ctx: EntityManagerInternals) {
    this.dmlSqlBuilder = new DmlSqlBuilder(ctx);
  }

  /** Narrowable view of the connected driver (mirrors EntityManager's field). */
  private get driver(): ISqlDriver | undefined {
    return this.ctx.getDriver();
  }

  // Collaborators are read live from the ctx so that test-time reassignment of
  // `em.resolver` / `em.eventEmitter` (etc.) is reflected here too.
  private get resolver(): RelationMetadataResolver {
    return this.ctx.getResolver();
  }
  private get cascadeHandler(): CascadeHandler {
    return this.ctx.getCascadeHandler();
  }
  private get inheritanceResolver(): InheritanceResolver {
    return this.ctx.getInheritanceResolver();
  }
  private get eventEmitter(): EntityEventEmitter {
    return this.ctx.getEventEmitter();
  }

  /**
   * How many rows a DML statement touched.
   *
   * The MySQL family reports it on the OK packet; PostgreSQL and SQLite
   * expose `rowCount`. Twelve write paths carried this same two-branch read,
   * so it lives here once. `fallback` is what an unreadable result counts as
   * — 0 everywhere except the bulk INSERT, which knows how many rows it sent.
   */
  private affectedCount(
    queryResult: DriverExecResult | undefined,
    fallback = 0,
  ): number {
    if (this.ctx.isMySqlFamily()) {
      return okPacket(queryResult)?.affectedRows ?? fallback;
    }
    return queryResult?.rowCount ?? fallback;
  }

  /**
   * The physical tables a criteria write on `entity` runs against. A
   * TABLE_PER_CLASS root owns no rows of its own — its hierarchy lives in
   * one table per concrete class — so a root-targeted delete/update/soft
   * delete/restore runs the same statement once per concrete table and sums
   * the affected counts, matching the rows find() reads through UNION ALL.
   * Every other entity writes its single table.
   */
  private resolveWriteTables<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
  ): string[] {
    if (!isTpcPolymorphicRoot(this.inheritanceResolver, entity)) {
      return [metadata.name];
    }
    return resolveTpcTables(
      { inheritanceResolver: this.inheritanceResolver, resolver: this.resolver },
      entity,
    ).map((t) => t.tableName);
  }

  /**
   * Rejects ORDER BY / LIMIT on a write that spans a TABLE_PER_CLASS
   * hierarchy: a limit applies per statement, so "the first N rows of the
   * root" has no single-statement meaning across the concrete tables.
   */
  private assertTpcWriteHasNoLimit<T>(
    entity: ClazzType<T>,
    tables: string[],
    orderBySql: Sql | undefined,
    limit: number | undefined,
    site: string,
  ): void {
    if (tables.length > 1 && (orderBySql !== undefined || limit !== undefined)) {
      throw new OrmError(
        OrmErrorCode.UNSUPPORTED_OPERATION,
        `${site} with orderBy/limit on TABLE_PER_CLASS root "${entity.name}" is not supported: the write runs once per concrete table, so a limit cannot be applied across the hierarchy.`,
        `Run the limited update on a concrete subclass, or drop orderBy/limit to update every matching row across the hierarchy.`,
      );
    }
  }

  /**
   * Runs `buildSql(table)` against each table and sums the affected rows,
   * tracking each statement under `entity`'s name.
   */
  private async executePerTable<T>(
    entity: ClazzType<T>,
    tables: string[],
    buildSql: (tableName: string) => Sql,
    session: TransactionSessionManager,
  ): Promise<number> {
    let affected = 0;
    for (const tableName of tables) {
      const statement = buildSql(tableName);
      const start = Date.now();
      this.ctx.beginTrackQuery();
      const queryResult = (await session.query(statement)) as DriverExecResult;
      this.ctx.trackQuery(
        entity.name,
        statement.text ?? String(statement),
        Date.now() - start,
      );
      affected += this.affectedCount(queryResult);
    }
    return affected;
  }

  /**
   * The WHERE clauses a criteria-based write resolves to.
   *
   * #372: write criteria accept find-style operator objects
   * ({ between: [a, b] }, { gt }, { lte }, ...), arrays (IN) and null
   * (IS NULL) — delete / softDelete / restore / updateMany all go through
   * this one resolver, the same one the read paths use.
   */
  private resolveCriteriaWhere<T>(
    criteria: WhereClause<T>,
    propertyToColumn: Map<string, string>,
  ): Sql[] {
    return resolveWhereClause(criteria, {
      wrapColumn: (n) => this.ctx.wrap(n),
      dialect: this.ctx.getDialect(),
      dialectExpression: createDialectExpression(this.ctx.getDialect()),
      propertyToColumn,
    });
  }

  /**
   * Rejects criteria that resolve to no predicate — `{}`, `{ id: undefined }`,
   * `{ OR: [] }` — before a criteria-based write runs any hook, event,
   * subscriber or cascade read.
   *
   * The builders repeat the check after resolving (delete, updateMany,
   * softDelete, restore), but by then delete() had already fired
   * beforeDelete and let the O2M cascade SELECT every parent and DELETE their
   * children; the transaction rolled the rows back, not the listeners. Resolving
   * here also surfaces an InvalidQueryError from the resolver (an undefined
   * operand, an empty OR branch) at the same point.
   */
  private assertCriteriaHasPredicate<T>(
    metadata: EntityScannerMetadata,
    criteria: WhereClause<T>,
    operation: string,
  ): void {
    const predicates = this.resolveCriteriaWhere(
      criteria,
      this.ctx.buildPropertyToColumnMap(metadata),
    );
    if (predicates.length === 0) {
      throw new DeleteWithoutConditionsError(operation);
    }
  }

  /**
   * The discriminator predicate that keeps a criteria-based write on one STI
   * subtype's rows, or null when the entity is not an STI child. Every bulk
   * write narrows this way so it can never touch siblings sharing the table.
   */
  private stiDiscriminatorClause<T>(
    entity: ClazzType<T>,
    strategy?: InheritanceStrategy | null,
  ): Sql | null {
    // A caller that already read the strategy passes it in, so the common
    // case (no inheritance at all) costs no extra metadata read.
    if (strategy !== undefined && strategy !== "SINGLE_TABLE") return null;
    const disc =
      this.inheritanceResolver.getSingleTableChildDiscriminator(entity);
    return disc
      ? Conditions.equals(this.ctx.wrap(disc.columnName), disc.value)
      : null;
  }

  async save<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): Promise<InstanceType<ClazzType<T>>> {
    return this.saveInternal(entity, item);
  }

  async saveInternal<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
    existingSession?: TransactionSessionManager,
    callerMethod = "save",
  ): Promise<InstanceType<ClazzType<T>>> {
    const metadata = this.resolver.resolveEntityMetadata(entity);

    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    // Unknown-key policy first: it must see the payload as the caller passed
    // it, before the cascade and tenant steps below add their own keys.
    this.ctx.validateWriteInputKeys(entity, metadata, [item], callerMethod);

    // Validation
    EntityValidator.validate(entity, item);

    return this.ctx.executeInTransaction(async (session) => {
      // Cascade: save the parent entity of any ManyToOne relation first.
      // Same session-escape shape as the delete path (#414): the handler
      // saves through the public ctx.save, so publish this session via ALS
      // for it to join — otherwise the parent commits in its own transaction
      // (and nested-BEGINs SQLite when saveInternal runs under an existing
      // session, e.g. the saveMany fallback or an O2M cascade child).
      await transactionStorage.run(session, () =>
        this.cascadeHandler.cascadeSaveManyToOne(entity, item),
      );

      const pkColumns = metadata.columns.filter(
        (column: ColumnMetadata) => column.options?.primary,
      );
      const pk = pkColumns[0];

      const hasAutoIncrementPk = pkColumns.some(
        (col: ColumnMetadata) => col.options?.autoIncrement,
      );
      const hasGeneratedPk = pkColumns.some(
        (col: ColumnMetadata) =>
          col.options?.autoIncrement ||
          col.options?.generationStrategy === "uuid" ||
          col.options?.generationStrategy === "uuid-v7",
      );
      const itemFields = fieldsOf(item);
      const primaryKeyValue = pk ? itemFields[this.ctx.propKey(pk)] : undefined;

      const isInsert = hasGeneratedPk
        ? !primaryKeyValue
        : true;

      const buildPkWhere = (pkValues?: DriverRow) => {
        return pkColumns.map((col: ColumnMetadata) => {
          const value = pkValues
            ? pkValues[col.name]
            : itemFields[this.ctx.propKey(col)];
          return sql`${raw(this.ctx.wrap(col.name))} = ${bindParam(value)}`;
        });
      };

      const buildPkFindWhere = (pkValues?: DriverRow): WhereClause<T> => {
        const where: Record<string, unknown> = {};
        for (const col of pkColumns) {
          where[this.ctx.propKey(col)] = pkValues
            ? pkValues[col.name]
            : itemFields[this.ctx.propKey(col)];
        }
        return whereByProps<T>(where);
      };

      const op: SaveOperation<T> = {
        entity,
        item,
        metadata,
        session,
        itemFields,
        pkColumns,
        pk,
        hasAutoIncrementPk,
        primaryKeyValue,
        buildPkWhere,
        buildPkFindWhere,
      };

      if (isInsert) {
        await this.cascadeHandler.runHooks(entity, item, "beforeInsert");
        await this.eventEmitter.emit("beforeInsert", { entity, data: item });
        await this.ctx.notifySubscribers(entity, "beforeInsert", {
          entity: item,
          manager: this.ctx.getManager(),
        } as InsertEvent<T>);

        this.ctx.applyTenantColumnOnInsert(entity, item);

        const plan = this.buildInsertValuePlan(op);
        const { insertableColumns, columns, values } = plan;

        const saveInheritanceStrategy = this.inheritanceResolver.getStrategy(entity);
        this.applyInsertDiscriminator(op, plan, saveInheritanceStrategy);
        this.applyInsertFkColumns(op, plan);

        // PostgreSQL (all versions), MariaDB 10.5+: INSERT ... RETURNING *
        const useReturning = this.supportsInsertReturning();

        // TPT child: INSERT into parent first → INSERT into child (sharing the same PK)
        if (saveInheritanceStrategy === "JOINED" && this.inheritanceResolver.isChildEntity(entity)) {
          const tpt = await this.insertTptChild(op, plan, useReturning);
          if (tpt) return tpt.result;
        }

        const returningSql = useReturning
          ? raw(` RETURNING *`)
          : raw("");

        // With every column omitted (all values undefined), `() VALUES ()` is
        // only valid on the MySQL family — PostgreSQL/SQLite need DEFAULT VALUES.
        const insertSql =
          columns.length > 0
            ? sql`
                        INSERT INTO ${raw(this.ctx.wrapTable(metadata.name))}
                        (${join(columns, ", ")})
                        VALUES (${join(values, ", ")})${returningSql}
                    `
            : sql`INSERT INTO ${raw(this.ctx.wrapTable(metadata.name))} ${raw(
                this.ctx.isMySqlFamily() ? "() VALUES ()" : "DEFAULT VALUES",
              )}${returningSql}`;
        const saveQueryStart = Date.now();
        this.ctx.beginTrackQuery();
        const queryResult = (await session.query<T>(
          insertSql,
        )) as DriverExecResult;
        this.ctx.trackQuery(
          entity.name,
          insertSql.text ?? String(insertSql),
          Date.now() - saveQueryStart,
        );

        return this.resolveInsertResult(op, queryResult, useReturning);
      }

      // UPDATE path
      //
      // Under the "tenant_column" strategy the UPDATE has to carry the tenant
      // predicate the read paths carry, or a PK from another tenant is enough
      // to rewrite that tenant's row. Resolved before anything fires so
      // `tenantOnMissingContext: "throw"` rejects a context-less save the way
      // it rejects a context-less updateMany.
      // A JOINED child's UPDATE applies the predicate to the root table,
      // which holds the column, so it is named directly.
      const tenantWhere = this.ctx.buildTenantWhereClause(
        entity,
        undefined,
        "root",
      );
      const tenantColumnName = tenantWhere
        ? this.ctx.resolveTenantColumnName(entity)
        : null;

      // Pre-read the database state when any subscriber wants it (for diff
      // audits, change-detection cache invalidation, etc.). Skipping the
      // SELECT when no subscriber listens keeps the cost of save() unchanged
      // for entities that don't opt in.
      const wantsDatabaseEntity =
        this.ctx.hasSubscriberFor(entity, "beforeUpdate") ||
        this.ctx.hasSubscriberFor(entity, "afterUpdate");
      const databaseEntity: T | null = wantsDatabaseEntity
        ? ((await this.ctx.findOneInternal(
            entity,
            { where: buildPkFindWhere() },
            session,
          )) as T | null)
        : null;

      await this.cascadeHandler.runHooks(entity, item, "beforeUpdate");
      await this.eventEmitter.emit("beforeUpdate", { entity, data: item });
      await this.ctx.notifySubscribers(entity, "beforeUpdate", {
        entity: item,
        databaseEntity,
        manager: this.ctx.getManager(),
      } as UpdateEvent<T>);

      this.ctx.assertTenantColumnOnUpdate(entity, item);

      const updatePlan = this.buildUpdateSetPlan(op, tenantColumnName);
      const { updateMap, versionColName } = updatePlan;

      const pkWhereClauses = buildPkWhere();
      if (tenantWhere) {
        pkWhereClauses.push(tenantWhere);
      }

      // @Version: Optimistic Locking
      // `versionColName` is the DB column name (applyNamingStrategyToEntities
      // rewrites the @Version token to the resolved column name), so read the
      // current value through the matching column's property key — not the
      // column name — otherwise the stale-version WHERE guard is silently
      // dropped whenever the property and column names differ.
      const versionColumn = versionColName
        ? metadata.columns.find(
            (c: ColumnMetadata) => c.name === versionColName,
          )
        : undefined;
      const currentVersion = versionColumn
        ? itemFields[this.ctx.propKey(versionColumn)]
        : undefined;
      if (versionColName) {
        updateMap.push(
          sql`${raw(this.ctx.wrap(versionColName))} = ${raw(this.ctx.wrap(versionColName))} + 1`,
        );
        if (currentVersion !== undefined && currentVersion !== null) {
          pkWhereClauses.push(
            sql`${raw(this.ctx.wrap(versionColName))} = ${bindParam(currentVersion)}`,
          );
        }
      }

      const useReturningForUpdate = typeof this.driver?.supportsReturning === "function" && this.driver.supportsReturning();
      let updateReturnedRow: DriverRow | null = null;

      // TPT child: UPDATE the parent and child tables separately
      const updateInheritanceStrategy = this.inheritanceResolver.getStrategy(entity);
      if (
        updateInheritanceStrategy === "JOINED" &&
        this.inheritanceResolver.isChildEntity(entity) &&
        updateMap.length > 0
      ) {
        const tpt = await this.updateTptChild(
          op,
          updatePlan,
          pkWhereClauses,
          currentVersion,
          databaseEntity,
          tenantWhere,
        );
        if (tpt) return tpt.result;
      }

      if (updateMap.length > 0) {
        updateReturnedRow = await this.executeSingleTableUpdate(
          op,
          updateMap,
          pkWhereClauses,
          versionColName,
          currentVersion,
          useReturningForUpdate,
          tenantWhere,
        );
      }

      await this.completeUpdate(op, databaseEntity);

      if (updateReturnedRow && !this.ctx.hasEagerRelations(entity)) {
        // #369: same column→property mapping as the INSERT RETURNING path.
        return ResultTransformerFactory.create().toEntity(entity, {
          results: [updateReturnedRow],
          fields: [],
        }) as T;
      }

      const result = await this.ctx.findOneInternal(entity, {
        where: buildPkFindWhere(),
      }, session);

      return result as T;
    }, existingSession);
  }

  /**
   * Stages the column/value lists for saveInternal's single-row INSERT:
   * selects the insertable columns (undefined omission, computed / unset
   * auto-PK exclusion), then injects the auto-populated values —
   * @CreateTimestamp / @UpdateTimestamp, @Version initialization, and
   * client-side UUID PKs (which also write back onto `op.itemFields`).
   */
  private buildInsertValuePlan<T>(op: SaveOperation<T>): InsertValuePlan {
    const { entity, metadata, itemFields } = op;

    const computedCols = this.ctx.getComputedColumnNames(entity);
    // Resolved before the filter: these columns are auto-populated below
    // (timestamps, version, client-side UUID PKs), so they must survive
    // the undefined-value omission even when the entity has no value yet.
    const createTsCol = this.resolver.getCreateTimestampColumn(entity);
    const updateTsCol = this.resolver.getUpdateTimestampColumn(entity);
    const versionCol = this.resolver.getVersionColumn(entity);
    const insertableColumns = metadata.columns.filter(
      (column: ColumnMetadata) => {
        const isComputedColumn = computedCols.has(column.name);
        if (isComputedColumn) return false;

        const value = itemFields[this.ctx.propKey(column)];
        const isUnsetAutoIncrement =
          column.options?.autoIncrement &&
          (value === null || value === undefined);
        if (isUnsetAutoIncrement) return false;

        if (value === undefined) {
          const strategy = column.options?.generationStrategy;
          const isClientGeneratedUuid =
            strategy === "uuid" || strategy === "uuid-v7";
          const isAutoManagedColumn =
            column.name === createTsCol ||
            column.name === updateTsCol ||
            column.name === versionCol;
          // Auto-populated columns (client-side UUID PKs, timestamps,
          // version) must survive the undefined-omission so the values
          // injected below are written.
          if (isClientGeneratedUuid || isAutoManagedColumn) return true;

          // #368: undefined means "not provided" — omit the column so the
          // DB-side DEFAULT (and @Column({ default })) applies. An explicit
          // null still writes NULL.
          return false;
        }
        return true;
      },
    );

    const columns = insertableColumns.map((column: ColumnMetadata) => {
      return raw(this.ctx.wrap(column.name));
    });

    const values: RawValue[] = bindParams(
      insertableColumns.map((column: ColumnMetadata) => {
        const rawValue = itemFields[this.ctx.propKey(column)];
        return this.ctx.applyWriteTransform(column, rawValue, "save()");
      }),
    );

    // Auto-inject @CreateTimestamp / @UpdateTimestamp values (on INSERT)
    const now = new Date();
    if (createTsCol) {
      const idx = insertableColumns.findIndex(
        (col: ColumnMetadata) => col.name === createTsCol,
      );
      if (idx >= 0) {
        // Read via the property key — createTsCol is the DB column name after
        // the naming strategy, so item[createTsCol] would miss a user value.
        const existing = itemFields[this.ctx.propKey(insertableColumns[idx])];
        values[idx] = bindParam(existing ?? now);
      }
    }
    if (updateTsCol) {
      const idx = insertableColumns.findIndex(
        (col: ColumnMetadata) => col.name === updateTsCol,
      );
      if (idx >= 0) {
        const existing = itemFields[this.ctx.propKey(insertableColumns[idx])];
        values[idx] = bindParam(existing ?? now);
      }
    }

    // Auto-initialize the @Version column
    if (versionCol) {
      const versionIdx = insertableColumns.findIndex(
        (col: ColumnMetadata) => col.name === versionCol,
      );
      if (versionIdx >= 0) {
        values[versionIdx] = 1;
      }
    }

    // Auto-generate UUID PKs on the application side
    for (let i = 0; i < insertableColumns.length; i++) {
      const col = insertableColumns[i];
      const strategy = col.options?.generationStrategy;
      if (!strategy || strategy === "increment") continue;
      if (values[i] !== null && values[i] !== undefined) continue;

      // PostgreSQL uuid strategy: DB generates via DEFAULT gen_random_uuid()
      if (strategy === "uuid" && this.ctx.isPostgres()) {
        // exclude column from INSERT so DEFAULT kicks in
        columns.splice(i, 1);
        values.splice(i, 1);
        insertableColumns.splice(i, 1);
        i--;
        continue;
      }

      if (strategy === "uuid") {
        values[i] = randomUUID();
        itemFields[this.ctx.propKey(col)] = values[i];
      } else if (strategy === "uuid-v7") {
        values[i] = generateUUIDv7();
        itemFields[this.ctx.propKey(col)] = values[i];
      }
    }

    return { insertableColumns, columns, values };
  }

  /**
   * STI/TPT: adds (or sets) the discriminator column value on the staged
   * INSERT. Appended entries live past the `insertableColumns` range — the
   * TPT split relies on that layout to route them to the parent table.
   */
  private applyInsertDiscriminator<T>(
    op: SaveOperation<T>,
    plan: InsertValuePlan,
    strategy: InheritanceStrategy | null,
  ): void {
    const { entity } = op;
    const { insertableColumns, columns, values } = plan;
    if (strategy === "SINGLE_TABLE" || strategy === "JOINED") {
      const discCol = this.inheritanceResolver.getDiscriminatorColumn(entity);
      const discVal = this.inheritanceResolver.getDiscriminatorValue(entity);
      if (discCol && discVal) {
        const existingDiscIdx = insertableColumns.findIndex(
          (col: ColumnMetadata) => col.name === discCol.name,
        );
        if (existingDiscIdx >= 0) {
          values[existingDiscIdx] = discVal;
        } else {
          columns.push(raw(this.ctx.wrap(discCol.name)));
          values.push(discVal);
        }
      }
    }
  }

  /**
   * Resolves each ManyToOne relation's FK value (relation object → shadow
   * `${prop}Id` accessor → explicit `option.fkProperty`) and writes it into
   * the staged INSERT, appending the join column when it isn't already staged.
   */
  private applyInsertFkColumns<T>(
    op: SaveOperation<T>,
    plan: InsertValuePlan,
  ): void {
    const { entity, itemFields } = op;
    const { insertableColumns, columns, values } = plan;

    const manyToOneRelations = this.resolver.resolveManyToOneMetadata(entity);
    for (const rel of manyToOneRelations) {
      if (!rel.joinColumn) continue;
      const existingIdx = insertableColumns.findIndex(
        (col: ColumnMetadata) => col.name === rel.joinColumn,
      );

      const fkValue = this.resolveFkValue(rel, itemFields);

      if (fkValue !== undefined) {
        if (existingIdx >= 0) {
          values[existingIdx] = bindParam(fkValue);
        } else {
          columns.push(raw(this.ctx.wrap(rel.joinColumn)));
          values.push(bindParam(fkValue));
        }
      }
    }
  }

  /**
   * TPT (JOINED) child INSERT: splits the staged columns between the root and
   * child tables, INSERTs the parent row first, then the child row sharing the
   * generated PK, and completes the save (cascade, hooks, events, read-back).
   *
   * Returns null when the root metadata cannot be resolved — the caller falls
   * through to the generic single-table INSERT.
   */
  private async insertTptChild<T>(
    op: SaveOperation<T>,
    plan: InsertValuePlan,
    useReturning: boolean,
  ): Promise<{ result: T } | null> {
    const {
      entity,
      item,
      metadata,
      session,
      itemFields,
      pkColumns,
      pk,
      primaryKeyValue,
    } = op;
    const { insertableColumns, columns, values } = plan;

    const root = this.inheritanceResolver.getRoot(entity)!;
    const rootMeta = this.resolver.resolveEntityMetadata(root);
    if (!rootMeta) return null;

    const rootColNames = new Set(
      rootMeta.columns.map((c: ColumnMetadata) => c.name),
    );
    const pkColNames = new Set(
      pkColumns.map((col: ColumnMetadata) => col.name),
    );

    // Split columns/values into parent and child buckets
    const parentCols: Sql[] = [];
    const parentVals: RawValue[] = [];
    const childCols: Sql[] = [];
    const childVals: RawValue[] = [];

    for (let i = 0; i < insertableColumns.length; i++) {
      const col = insertableColumns[i];
      const isPk = pkColNames.has(col.name);
      const isRoot = rootColNames.has(col.name);

      if (isPk || isRoot) {
        parentCols.push(columns[i]);
        parentVals.push(values[i]);
      }
      if (isPk || !isRoot) {
        childCols.push(columns[i]);
        childVals.push(values[i]);
      }
    }

    // Extra appended columns (e.g. discriminator, FK) live outside the insertableColumns range
    for (let i = insertableColumns.length; i < columns.length; i++) {
      parentCols.push(columns[i]);
      parentVals.push(values[i]);
    }

    // 1. INSERT into the parent table
    const parentTableName = rootMeta.name;
    const parentReturningSql = useReturning ? raw(` RETURNING *`) : raw("");
    const parentInsertSql = sql`INSERT INTO ${raw(this.ctx.wrapTable(parentTableName))}
      (${join(parentCols, ", ")})
      VALUES (${join(parentVals, ", ")})${parentReturningSql}`;

    const parentResult = (await session.query<T>(
      parentInsertSql,
    )) as DriverExecResult;

    // Obtain the generated PK value
    let generatedPkValue: unknown;
    const parentRows = resultRows(parentResult);
    if (useReturning && parentRows.length > 0) {
      generatedPkValue = parentRows[0][pk.name];
    } else if (this.ctx.isMySqlFamily()) {
      generatedPkValue = okPacket(parentResult)?.insertId;
    } else if (this.ctx.isSqlite()) {
      generatedPkValue = Number(
        sqliteRunResult(parentResult)?.lastInsertRowid,
      );
    }

    // 2. INSERT into the child table (reusing the same PK)
    if (generatedPkValue != null) {
      // Find the PK position via its insertableColumns index mapping
      let pkFoundInChild = false;
      for (let ci = 0, ii = 0; ii < insertableColumns.length; ii++) {
        const col = insertableColumns[ii];
        const isPk = pkColNames.has(col.name);
        const isRoot = rootColNames.has(col.name);
        if (isPk || !isRoot) {
          // This column exists in childCols
          if (isPk) {
            childVals[ci] = bindParam(generatedPkValue);
            pkFoundInChild = true;
          }
          ci++;
        }
      }
      // If the PK is missing from childCols, add it
      if (!pkFoundInChild) {
        childCols.unshift(raw(this.ctx.wrap(pk.name)));
        childVals.unshift(bindParam(generatedPkValue));
      }
    }

    if (childCols.length > 0) {
      const childInsertSql = sql`INSERT INTO ${raw(this.ctx.wrapTable(metadata.name))}
        (${join(childCols, ", ")})
        VALUES (${join(childVals, ", ")})`;
      await session.query<T>(childInsertSql);
    }

    // Read the resulting row back
    const pkVal = generatedPkValue ?? primaryKeyValue;
    itemFields[this.ctx.propKey(pk)] = pkVal;
    const result = await this.ctx.findOneInternal(
      entity,
      { where: whereByProps<T>({ [this.ctx.propKey(pk)]: pkVal }) },
      session,
    );

    await this.completeInsert(op, pkVal);
    return { result: result as T };
  }

  /**
   * The shared afterInsert tail: lifecycle hooks, event-emitter channel and
   * EntitySubscriber notification, in that order.
   */
  private async emitAfterInsertEvents<T>(op: SaveOperation<T>): Promise<void> {
    const { entity, item } = op;
    await this.cascadeHandler.runHooks(entity, item, "afterInsert");
    await this.eventEmitter.emit("afterInsert", { entity, data: item });
    await this.ctx.notifySubscribers(entity, "afterInsert", {
      entity: item,
      manager: this.ctx.getManager(),
    } as InsertEvent<T>);
  }

  /**
   * Completes a saveInternal INSERT once the PK is known: cascades O2M child
   * saves in the same session, writes the generated PK back onto `item`, then
   * fires the afterInsert hook/event/subscriber sequence.
   */
  private async completeInsert<T>(
    op: SaveOperation<T>,
    cascadeId: unknown,
  ): Promise<void> {
    const { entity, item, session, pk } = op;
    await this.cascadeHandler.cascadeSaveOneToMany(entity, item, cascadeId, session);
    this.assignGeneratedPk(item, this.ctx.propKey(pk), cascadeId);
    await this.emitAfterInsertEvents(op);
  }

  /**
   * Resolves the saved entity after the generic single-table INSERT, per
   * driver capability: MySQL-family insertId look-up, RETURNING-row
   * deserialization (PostgreSQL / MariaDB 10.5+), SQLite lastInsertRowid
   * look-up, and a raw-result fallback for anything else. Each branch also
   * completes the insert (cascade + PK write-back + afterInsert sequence).
   */
  private async resolveInsertResult<T>(
    op: SaveOperation<T>,
    queryResult: DriverExecResult,
    useReturning: boolean,
  ): Promise<T> {
    const {
      entity,
      session,
      pk,
      hasAutoIncrementPk,
      primaryKeyValue,
      buildPkFindWhere,
    } = op;

    const returnedRows = resultRows(queryResult);

    // MariaDB 10.5+ returns rows via RETURNING; fall through to the generic
    // `useReturning && results.length > 0` branch below instead of the insertId path.
    const mariaDbReturned =
      useReturning && this.ctx.isMySqlFamily() && returnedRows.length > 0;

    if (this.ctx.isMySqlFamily() && !mariaDbReturned) {
      const findWhere = hasAutoIncrementPk
        ? whereByProps<T>({
            [this.ctx.propKey(pk)]: okPacket(queryResult)?.insertId,
          })
        : buildPkFindWhere();
      const result = await this.ctx.findOneInternal(entity, {
        where: findWhere,
      }, session);

      const cascadeId = hasAutoIncrementPk
        ? okPacket(queryResult)?.insertId
        : primaryKeyValue;
      await this.completeInsert(op, cascadeId);
      return result as T;
    }

    // Drivers that support RETURNING *: deserialize directly from the returned row (when there are no eager relations)
    if (useReturning && returnedRows.length > 0) {
      const returnedRow = returnedRows[0];
      const cascadeId = returnedRow[pk.name];
      await this.completeInsert(op, cascadeId);

      const hasEagerRelations = this.ctx.hasEagerRelations(entity);
      if (!hasEagerRelations) {
        // #369: route the RETURNING row through ResultTransformer so DB
        // column names map back to property keys (explicit @Column({name})
        // and NamingStrategy) and column transformers apply on read.
        return ResultTransformerFactory.create().toEntity(entity, {
          results: [returnedRow],
          fields: [],
        }) as T;
      }
      const findWhere = buildPkFindWhere(returnedRow);
      const result = await this.ctx.findOneInternal(entity, {
        where: findWhere,
      }, session);
      return result as T;
    }

    // SQLite: look up the inserted entity via lastInsertRowid
    if (this.ctx.isSqlite()) {
      const runResult = sqliteRunResult(queryResult);
      const findWhere = hasAutoIncrementPk
        ? whereByProps<T>({
            [this.ctx.propKey(pk)]: Number(runResult?.lastInsertRowid),
          })
        : buildPkFindWhere();
      const result = await this.ctx.findOneInternal(entity, {
        where: findWhere,
      }, session);

      const cascadeId = hasAutoIncrementPk
        ? Number(runResult?.lastInsertRowid)
        : primaryKeyValue;
      await this.completeInsert(op, cascadeId);
      return result as T;
    }

    await this.emitAfterInsertEvents(op);
    return queryResult as unknown as T;
  }

  /**
   * Stages the SET clauses for saveInternal's UPDATE: selects the updatable
   * columns (PK / @Version / computed / STI discriminator excluded,
   * undefined omission), auto-injects @UpdateTimestamp, and resolves each
   * ManyToOne relation's FK value (relation object → shadow `${prop}Id`
   * accessor → explicit `option.fkProperty`) into the SET list.
   */
  private buildUpdateSetPlan<T>(
    op: SaveOperation<T>,
    tenantColumnName: string | null = null,
  ): UpdateSetPlan {
    const { entity, metadata, itemFields, pkColumns } = op;

    const versionColName = this.resolver.getVersionColumn(entity);
    const pkColumnNames = new Set(
      pkColumns.map((col: ColumnMetadata) => col.name),
    );
    const computedColsForUpdate = this.ctx.getComputedColumnNames(entity);
    // STI: the discriminator column is excluded from UPDATE
    const updateDiscCol = this.inheritanceResolver.getDiscriminatorColumn(entity);
    const updatableColumns = metadata.columns.filter(
      (column: ColumnMetadata) => {
        if (computedColsForUpdate.has(column.name)) return false;
        if (pkColumnNames.has(column.name)) return false;
        if (versionColName && column.name === versionColName) return false;
        if (updateDiscCol && column.name === updateDiscCol.name) return false;
        // The tenant discriminator is ORM-owned while a tenant predicate
        // applies: an entity that round-tripped through find() carries it, and
        // writing it back would let a save move the row to another tenant.
        if (tenantColumnName && column.name === tenantColumnName) return false;
        return itemFields[this.ctx.propKey(column)] !== undefined;
      },
    );
    const updateMap = updatableColumns.map((column: ColumnMetadata) => {
      const rawValue = itemFields[this.ctx.propKey(column)];
      const value = this.ctx.applyWriteTransform(column, rawValue, "save()");
      return sql`${raw(this.ctx.wrap(column.name))} = ${bindParam(value)}`;
    });

    // Auto-inject @UpdateTimestamp
    const updateTsColName = this.resolver.getUpdateTimestampColumn(entity);
    if (updateTsColName) {
      const existingIdx = updatableColumns.findIndex(
        (col: ColumnMetadata) => col.name === updateTsColName,
      );
      const updateNow = bindParam(new Date());
      if (existingIdx >= 0) {
        updateMap[existingIdx] =
          sql`${raw(this.ctx.wrap(updateTsColName))} = ${updateNow}`;
      } else {
        updateMap.push(
          sql`${raw(this.ctx.wrap(updateTsColName))} = ${updateNow}`,
        );
      }
    }

    const updatedColumnNames = new Set(
      updatableColumns.map((col: ColumnMetadata) => col.name),
    );

    // Add the ManyToOne FK column values to the UPDATE SET clause
    const updateManyToOneRelations = this.resolver.resolveManyToOneMetadata(entity);
    for (const rel of updateManyToOneRelations) {
      if (!rel.joinColumn) continue;
      const relatedValue = itemFields[rel.columnName];
      // Shadow-accessor fallback (mirrors INSERT path): when the relation
      // object isn't set, look for the FK on the conventional `${rel}Id`
      // shadow, then on an explicit `option.fkProperty`.
      let shadowValue: unknown = itemFields[`${rel.columnName}Id`];
      if (shadowValue === undefined && rel.option?.fkProperty) {
        shadowValue = itemFields[rel.option.fkProperty];
      }

      if (relatedValue === undefined && shadowValue === undefined) continue;

      const alreadyInSet = updatedColumnNames.has(rel.joinColumn);
      const setClause = (value: unknown) => {
        if (alreadyInSet) {
          const existingIdx = updatableColumns.findIndex(
            (col: ColumnMetadata) => col.name === rel.joinColumn,
          );
          updateMap[existingIdx] =
            sql`${raw(this.ctx.wrap(rel.joinColumn!))} = ${bindParam(value)}`;
        } else {
          updateMap.push(
            sql`${raw(this.ctx.wrap(rel.joinColumn!))} = ${bindParam(value)}`,
          );
          updatedColumnNames.add(rel.joinColumn!);
        }
      };

      if (relatedValue === null) {
        setClause(null);
      } else if (relatedValue && typeof relatedValue === "object") {
        const RelatedEntity = rel.getMappingEntity() as ClazzType<unknown>;
        const relatedMeta = this.resolver.resolveEntityMetadata(RelatedEntity);
        if (relatedMeta) {
          const relatedPk = relatedMeta.columns.find(
            (col: ColumnMetadata) => col.options?.primary,
          );
          if (relatedPk) {
            const fkValue = fieldsOf(relatedValue)[this.ctx.propKey(relatedPk)];
            if (fkValue !== undefined && fkValue !== null) {
              setClause(fkValue);
            }
          }
        }
      } else if (shadowValue !== undefined) {
        // Fall back to the shadow accessor when no relation object was set.
        // `null` clears the FK; numeric/string values set it directly.
        setClause(shadowValue);
      }
    }

    return { updatableColumns, updateMap, versionColName };
  }

  /**
   * The shared afterUpdate tail: O2M cascade in the same session, lifecycle
   * hooks, event-emitter channel and EntitySubscriber notification, in that
   * order.
   */
  private async completeUpdate<T>(
    op: SaveOperation<T>,
    databaseEntity: T | null,
  ): Promise<void> {
    const { entity, item, session, primaryKeyValue } = op;
    await this.cascadeHandler.cascadeSaveOneToMany(entity, item, primaryKeyValue, session);
    await this.cascadeHandler.runHooks(entity, item, "afterUpdate");
    await this.eventEmitter.emit("afterUpdate", { entity, data: item });
    await this.ctx.notifySubscribers(entity, "afterUpdate", {
      entity: item,
      databaseEntity,
      manager: this.ctx.getManager(),
    } as UpdateEvent<T>);
  }

  /**
   * TPT (JOINED) child UPDATE: splits the staged SET clauses between the root
   * and child tables (extra entries such as @UpdateTimestamp / @Version go to
   * the root), enforces the optimistic-lock / existence contract on the first
   * statement that runs, then completes the save (cascade, hooks, events,
   * read-back).
   *
   * Returns null when the root metadata cannot be resolved — the caller falls
   * through to the generic single-table UPDATE.
   */
  private async updateTptChild<T>(
    op: SaveOperation<T>,
    plan: UpdateSetPlan,
    pkWhereClauses: Sql[],
    currentVersion: unknown,
    databaseEntity: T | null,
    tenantWhere: Sql | null = null,
  ): Promise<{ result: T } | null> {
    const { entity, metadata, session, buildPkWhere, buildPkFindWhere } = op;
    const { updatableColumns, updateMap, versionColName } = plan;

    const root = this.inheritanceResolver.getRoot(entity)!;
    const rootMeta = this.resolver.resolveEntityMetadata(root);
    if (!rootMeta) return null;

    const rootColNames = new Set(
      rootMeta.columns.map((c: ColumnMetadata) => c.name),
    );

    const parentUpdateMap: Sql[] = [];
    const childUpdateMap: Sql[] = [];

    for (let i = 0; i < updatableColumns.length; i++) {
      if (rootColNames.has(updatableColumns[i].name)) {
        parentUpdateMap.push(updateMap[i]);
      } else {
        childUpdateMap.push(updateMap[i]);
      }
    }

    // Extra items (e.g. @UpdateTimestamp, @Version) belong on the parent table
    for (let i = updatableColumns.length; i < updateMap.length; i++) {
      parentUpdateMap.push(updateMap[i]);
    }

    let parentAffected: number | null = null;
    if (parentUpdateMap.length > 0) {
      const parentUpdateSql = sql`UPDATE ${raw(this.ctx.wrapTable(rootMeta.name))}
        SET ${join(parentUpdateMap, ", ")}
        WHERE ${join(pkWhereClauses, " AND ")}`;
      const parentResult = (await session.query<T>(
        parentUpdateSql,
      )) as DriverExecResult;
      parentAffected = this.affectedCount(parentResult);

      // Same contract as the single-table UPDATE path: a guarded parent
      // UPDATE that matched nothing is a stale @Version write (the version
      // increment always lands in parentUpdateMap, so the guard is enforced
      // here before the child statement runs); without a guard, 0 matched
      // rows means the PK doesn't exist — confirmed with the value-identical
      // probe for MySQL.
      if (parentAffected === 0) {
        await this.assertUpdateMatchedRow(op, rootMeta.name, {
          versionColName,
          currentVersion,
          tenantWhere,
        });
      }
    }

    if (childUpdateMap.length > 0) {
      // The child table has no @Version column — the optimistic-lock
      // guard baked into pkWhereClauses references the root table only,
      // so the child UPDATE filters by primary key alone. The parent
      // UPDATE above already enforced the version inside this same
      // transaction.
      // The tenant column lives on the root table, so a child-only UPDATE
      // cannot carry the predicate. When no parent statement ran to enforce
      // it, confirm the root row belongs to this tenant first — otherwise a
      // foreign PK would still reach the child table.
      if (tenantWhere && parentAffected === null) {
        const ownerProbe = await session.query(
          sql`SELECT 1 AS "probe" FROM ${raw(this.ctx.wrapTable(rootMeta.name))} WHERE ${join([...buildPkWhere(), tenantWhere], " AND ")} LIMIT 1`,
        );
        if (resultRows(ownerProbe).length === 0) {
          throw new EntityNotFoundError(
            entity.name,
            "save() attempted an UPDATE but no row matched the primary key in the active tenant.",
          );
        }
      }

      const childPkWhere = buildPkWhere();
      const childUpdateSql = sql`UPDATE ${raw(this.ctx.wrapTable(metadata.name))}
        SET ${join(childUpdateMap, ", ")}
        WHERE ${join(childPkWhere, " AND ")}`;
      const childResult = (await session.query<T>(
        childUpdateSql,
      )) as DriverExecResult;

      // Only when no parent statement ran is the child UPDATE the sole
      // existence signal (identity is anchored on the root row, which
      // shares its PK with the child row).
      if (parentAffected === null) {
        const childAffected = this.affectedCount(childResult);
        if (childAffected === 0) {
          const childProbe = await session.query(
            sql`SELECT 1 AS "probe" FROM ${raw(this.ctx.wrapTable(metadata.name))} WHERE ${join(buildPkWhere(), " AND ")} LIMIT 1`,
          );
          if (resultRows(childProbe).length === 0) {
            throw new EntityNotFoundError(
              entity.name,
              "save() attempted an UPDATE but no row matched the primary key.",
            );
          }
        }
      }
    }

    await this.completeUpdate(op, databaseEntity);

    const tptResult = await this.ctx.findOneInternal(
      entity,
      { where: buildPkFindWhere() },
      session,
    );
    return { result: tptResult as T };
  }

  /**
   * The 0-affected-rows contract shared by saveInternal's single-table UPDATE
   * and the TPT parent UPDATE.
   *
   * Without a tenant predicate the rules are the historical ones: a write
   * guarded by @Version that matched nothing is a stale version, otherwise an
   * existence probe separates a missing PK from MySQL's value-identical
   * UPDATE (which also reports 0).
   *
   * With a tenant predicate the probe runs *first* and carries that predicate:
   * a PK that exists in another tenant must read as "not found here", never as
   * a stale @Version — and the probe must be scoped, or a foreign row would
   * satisfy it and the save would go back to being a silent no-op.
   */
  private async assertUpdateMatchedRow<T>(
    op: SaveOperation<T>,
    tableName: string,
    guards: {
      versionColName: string | null;
      currentVersion: unknown;
      tenantWhere: Sql | null;
    },
  ): Promise<void> {
    const { entity, session, buildPkWhere } = op;
    const { versionColName, currentVersion, tenantWhere } = guards;
    const guardedByVersion =
      !!versionColName &&
      currentVersion !== undefined &&
      currentVersion !== null;

    const rowExists = async (extra: Sql | null): Promise<boolean> => {
      const where = buildPkWhere();
      if (extra) where.push(extra);
      const probeResult = await session.query(
        sql`SELECT 1 AS "probe" FROM ${raw(this.ctx.wrapTable(tableName))} WHERE ${join(where, " AND ")} LIMIT 1`,
      );
      return resultRows(probeResult).length > 0;
    };

    if (tenantWhere) {
      if (!(await rowExists(tenantWhere))) {
        throw new EntityNotFoundError(
          entity.name,
          "save() attempted an UPDATE but no row matched the primary key in the active tenant.",
        );
      }
      if (guardedByVersion) {
        throw new OptimisticLockError(entity.name, currentVersion as number);
      }
      return;
    }

    if (guardedByVersion) {
      throw new OptimisticLockError(entity.name, currentVersion as number);
    }

    // 0 affected rows means no row matched the primary key — except on
    // MySQL, where affectedRows can also be 0 for a value-identical
    // UPDATE, so confirm with an existence probe before failing.
    // Without this the save was a silent no-op: afterUpdate hooks and
    // subscribers still fired and save() returned null cast as T.
    if (!(await rowExists(null))) {
      throw new EntityNotFoundError(
        entity.name,
        "save() attempted an UPDATE but no row matched the primary key.",
      );
    }
  }

  /**
   * Executes saveInternal's generic single-table UPDATE and enforces the
   * 0-affected-rows contract: a guarded write that matched nothing is a stale
   * @Version (OptimisticLockError); otherwise an existence probe distinguishes
   * a missing PK (EntityNotFoundError) from MySQL's value-identical UPDATE.
   * Returns the RETURNING row when the driver supports it, else null.
   */
  private async executeSingleTableUpdate<T>(
    op: SaveOperation<T>,
    updateMap: Sql[],
    pkWhereClauses: Sql[],
    versionColName: string | null,
    currentVersion: unknown,
    useReturningForUpdate: boolean,
    tenantWhere: Sql | null = null,
  ): Promise<DriverRow | null> {
    const { entity, metadata, session } = op;

    const updateReturningSql = useReturningForUpdate
      ? raw(` RETURNING *`)
      : raw("");
    const updateSql = sql`
        UPDATE ${raw(this.ctx.wrapTable(metadata.name))}
        SET ${join(updateMap, ", ")}
        WHERE ${join(pkWhereClauses, " AND ")}${updateReturningSql}
              `;
    const updateStart = Date.now();
    this.ctx.beginTrackQuery();
    const updateResult = (await session.query<T>(
      updateSql,
    )) as DriverExecResult;
    this.ctx.trackQuery(
      entity.name,
      updateSql.text ?? String(updateSql),
      Date.now() - updateStart,
    );

    const affected = this.affectedCount(updateResult);
    if (affected === 0) {
      await this.assertUpdateMatchedRow(op, metadata.name, {
        versionColName,
        currentVersion,
        tenantWhere,
      });
    }

    const updatedRows = resultRows(updateResult);
    if (useReturningForUpdate && updatedRows.length > 0) {
      return updatedRows[0];
    }
    return null;
  }

  async saveMany<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
  ): Promise<InstanceType<ClazzType<T>>[]> {
    if (items.length === 0) {
      return [];
    }

    // #214: attempt the batch INSERT optimization
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (metadata) {
      const pkColumns = metadata.columns.filter(
        (col: ColumnMetadata) => col.options?.primary,
      );
      const pk = pkColumns[0];
      const hasGeneratedPk = pkColumns.some(
        (col: ColumnMetadata) =>
          col.options?.autoIncrement ||
          col.options?.generationStrategy === "uuid" ||
          col.options?.generationStrategy === "uuid-v7",
      );
      const canBatchInsert =
        hasGeneratedPk &&
        pkColumns.length === 1 &&
        !this.isJoinedChild(entity) &&
        items.every((item) => {
          const pkValue = pk ? fieldsOf(item)[this.ctx.propKey(pk)] : undefined;
          return pkValue === null || pkValue === undefined;
        });

      if (canBatchInsert) {
        this.ctx.validateWriteInputKeys(entity, metadata, items, "saveMany");
        for (const item of items) {
          EntityValidator.validate(entity, item);
        }

        return this.ctx.executeInTransaction(async (session) => {
          // ManyToOne cascade joins this transaction via ALS (#414) so the
          // cascade-saved parents roll back together with the batch INSERT.
          await transactionStorage.run(session, async () => {
            for (const item of items) {
              await this.cascadeHandler.cascadeSaveManyToOne(entity, item);
            }
          });
          return this.saveManyBatchInsert(entity, pk, items, session);
        });
      }
    }

    // Fallback: sequential saves
    return this.ctx.executeInTransaction(async (session) => {
      const results: InstanceType<ClazzType<T>>[] = [];
      for (const item of items) {
        const saved = await this.saveInternal(entity, item, session, "saveMany");
        results.push(saved);
      }
      return results;
    });
  }

  /**
   * #214: Batch INSERT + bulk re-read.
   * N × (INSERT+SELECT) → 1 INSERT + 1 SELECT (or PG RETURNING).
   */
  /**
   * Appends the FK columns a `@ManyToOne` owns but no `@Column` declares, and
   * returns the bindings {@link buildInsertRowValues} needs to fill them.
   *
   * Shared by every multi-row INSERT path — they each carried a copy, and the
   * copies had drifted apart.
   */
  private appendFkInsertColumns<T>(
    entity: ClazzType<T>,
    insertableColumns: ColumnMetadata[],
    columns: Sql[],
  ): FkColumnBinding[] {
    const fkColumns: FkColumnBinding[] = [];
    for (const rel of this.resolver.resolveManyToOneMetadata(entity)) {
      if (!rel.joinColumn) continue;
      if (insertableColumns.some((col) => col.name === rel.joinColumn)) continue;
      columns.push(raw(this.ctx.wrap(rel.joinColumn)));
      fkColumns.push({
        joinColumn: rel.joinColumn,
        propertyName: rel.columnName,
        relMeta: rel,
      });
    }
    return fkColumns;
  }

  /**
   * The foreign-key value an item states for one `@ManyToOne`, or `undefined`
   * when it states nothing — the single-row path uses that to leave the column
   * out entirely, the batch paths bind NULL.
   *
   * An explicit `null` means "no parent" and wins over a stale shadow
   * property. A related instance contributes its primary key. **A bare value
   * is the key itself** — that case is why this lives in one place: three of
   * the four write paths carried a near-copy of this chain, and two of them
   * treated `{ author: 7 }` as nothing to write and stored NULL. Failing
   * that, the `${property}Id` shadow (or an explicit `option.fkProperty`) is
   * the fallback, mirroring `collectFkPropertyMappings` on reads.
   */
  private resolveFkValue(
    rel: ManyToOneMetadata<unknown>,
    itemFields: EntityFields,
  ): unknown {
    const relatedValue = itemFields[rel.columnName];

    if (relatedValue === null) return null;

    if (relatedValue !== undefined) {
      if (typeof relatedValue === "object") {
        const RelatedEntity = rel.getMappingEntity() as ClazzType<unknown>;
        const relatedMeta = this.resolver.resolveEntityMetadata(RelatedEntity);
        const relatedPk = relatedMeta?.columns.find(
          (col: ColumnMetadata) => col.options?.primary,
        );
        return relatedPk
          ? (fieldsOf(relatedValue)[this.ctx.propKey(relatedPk)] ?? undefined)
          : undefined;
      }
      return relatedValue;
    }

    let idPropValue = itemFields[`${rel.columnName}Id`];
    if (idPropValue === undefined && rel.option?.fkProperty) {
      idPropValue = itemFields[rel.option.fkProperty];
    }
    return idPropValue != null ? idPropValue : undefined;
  }

  /**
   * One INSERT row: the declared column values with write transforms applied
   * (`@Column` transformer.to, registered ColumnType transformers, and the
   * mandatory JSON stringify — reads apply transformer.from either way),
   * followed by the FK columns {@link appendFkInsertColumns} added.
   */
  private buildInsertRowValues(
    insertableColumns: ColumnMetadata[],
    fkColumns: FkColumnBinding[],
    itemFields: EntityFields,
    site: string,
  ): RawValue[] {
    const rowValues: RawValue[] = bindParams(
      insertableColumns.map((col) => {
        const value = itemFields[this.ctx.propKey(col)];
        // A raw `sql` fragment stands for an expression the database
        // evaluates (NOW(), a sequence call), so it is spliced as written.
        // Running it through the column transformer would serialize the
        // fragment object itself — a JSON column would store "{}".
        return isSqlFragment(value)
          ? value
          : this.ctx.applyWriteTransform(col, value, site);
      }),
    );
    for (const fk of fkColumns) {
      const fkValue = this.resolveFkValue(fk.relMeta, itemFields);
      rowValues.push(fkValue === undefined ? null : bindParam(fkValue));
    }
    return rowValues;
  }

  /**
   * beforeInsert hooks, events and subscribers for a whole batch, followed by
   * the tenant column — applied after user hooks, which may want to inspect
   * the item as the caller built it.
   */
  private async emitBatchBeforeInsert<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
  ): Promise<void> {
    for (const item of items) {
      await this.cascadeHandler.runHooks(entity, item, "beforeInsert");
      await this.eventEmitter.emit("beforeInsert", { entity, data: item });
      await this.ctx.notifySubscribers(entity, "beforeInsert", {
        entity: item,
        manager: this.ctx.getManager(),
      } as InsertEvent<T>);
    }

    if (this.ctx.getTenantColumnConfig()) {
      for (const item of items) {
        this.ctx.applyTenantColumnOnInsert(entity, item);
      }
    }
  }

  /**
   * The columns a multi-row INSERT names.
   *
   * Generated and auto-managed columns are always named so their values can
   * be filled in; a plain column that **no** item provides is left out so the
   * database DEFAULT applies (#368). Mixed batches keep one shared column
   * set, so an item missing that column simply binds NULL there.
   */
  private selectBatchInsertColumns<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    items: Partial<T>[],
  ): ColumnMetadata[] {
    const computedCols = this.ctx.getComputedColumnNames(entity);
    const createTsCol = this.resolver.getCreateTimestampColumn(entity);
    const updateTsCol = this.resolver.getUpdateTimestampColumn(entity);
    const versionCol = this.resolver.getVersionColumn(entity);

    return metadata.columns.filter((col) => {
      if (computedCols.has(col.name)) return false;
      if (col.options?.autoIncrement) return false;
      // PostgreSQL uuid: rely on the DB DEFAULT
      if (col.options?.generationStrategy === "uuid" && this.ctx.isPostgres()) return false;
      const strategy = col.options?.generationStrategy;
      if (strategy === "uuid" || strategy === "uuid-v7") return true;
      if (
        col.name === createTsCol ||
        col.name === updateTsCol ||
        col.name === versionCol
      ) {
        return true;
      }
      return items.some(
        (item) => fieldsOf(item)[this.ctx.propKey(col)] !== undefined,
      );
    });
  }

  /**
   * Fills the values the ORM generates rather than the caller: client-side
   * UUIDs, `@CreateTimestamp` / `@UpdateTimestamp`, and the `@Version` seed.
   * All of them are written onto the items given — the caller's own rows for
   * saveMany() and the insertMany() family, so those carry what was
   * persisted; copies for the upsert family (see {@link seededUpsertRows}).
   *
   * Every write goes through the property key. The timestamp and version
   * resolvers return DB column names (the naming strategy rewrites them), but
   * VALUES bind from the property key — writing `item[columnName]` would add
   * a bogus property and leave the real column NULL.
   */
  private applyBatchGeneratedValues<T>(
    entity: ClazzType<T>,
    insertableColumns: ColumnMetadata[],
    items: Partial<T>[],
  ): void {
    const createTsCol = this.resolver.getCreateTimestampColumn(entity);
    const updateTsCol = this.resolver.getUpdateTimestampColumn(entity);
    const versionCol = this.resolver.getVersionColumn(entity);
    const now = new Date();

    const columnNamed = (name: string | null) =>
      name ? insertableColumns.find((c) => c.name === name) : undefined;
    const createTsColumn = columnNamed(createTsCol);
    const updateTsColumn = columnNamed(updateTsCol);
    const versionColumn = columnNamed(versionCol);

    for (const item of items) {
      const itemFields = fieldsOf(item);

      for (const col of insertableColumns) {
        const strategy = col.options?.generationStrategy;
        if (!strategy || strategy === "increment") continue;
        if (itemFields[this.ctx.propKey(col)] != null) continue;
        if (strategy === "uuid") {
          itemFields[this.ctx.propKey(col)] = randomUUID();
        } else if (strategy === "uuid-v7") {
          itemFields[this.ctx.propKey(col)] = generateUUIDv7();
        }
      }

      for (const col of [createTsColumn, updateTsColumn]) {
        if (col && itemFields[this.ctx.propKey(col)] == null) {
          itemFields[this.ctx.propKey(col)] = now;
        }
      }

      if (versionColumn && itemFields[this.ctx.propKey(versionColumn)] == null) {
        itemFields[this.ctx.propKey(versionColumn)] = 1;
      }
    }
  }

  /**
   * The multi-row INSERT statement, plus whether it took the all-default
   * shape.
   *
   * #373: when every insertable column is omitted for every item and there
   * are no FK columns, there is nothing to name. `() VALUES (), ()` is valid
   * only on the MySQL family and sql-template-tag's join() rejects empty
   * arrays, so each dialect gets its own form: PostgreSQL names the PK and
   * emits DEFAULT per row, SQLite falls back to single-row `DEFAULT VALUES`
   * (executed once per item in {@link executeBatchInsert}).
   */
  private buildBatchInsertStatement<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    pk: ColumnMetadata,
    insertableColumns: ColumnMetadata[],
    items: Partial<T>[],
  ): { insertSql: Sql; allDefaultRow: boolean } {
    const columns = insertableColumns.map((col) => raw(this.ctx.wrap(col.name)));
    const fkColumns = this.appendFkInsertColumns(
      entity,
      insertableColumns,
      columns,
    );

    const allDefaultRow = columns.length === 0;

    const valueRows: Sql[] = allDefaultRow
      ? []
      : items.map((item) => {
          const rowValues = this.buildInsertRowValues(
            insertableColumns,
            fkColumns,
            fieldsOf(item),
            "saveMany()",
          );
          return sql`(${join(rowValues, ", ")})`;
        });

    if (allDefaultRow && this.ctx.isPostgres()) {
      columns.push(raw(this.ctx.wrap(pk.name)));
      for (let i = 0; i < items.length; i++) {
        valueRows.push(sql`(${raw("DEFAULT")})`);
      }
    }

    // RETURNING * where the driver supports it (PostgreSQL all versions,
    // MariaDB 10.5+), so the rows come back without a second read.
    const useReturning = this.supportsInsertReturning();
    const returningSql = useReturning ? raw(` RETURNING *`) : raw("");

    const table = raw(this.ctx.wrapTable(metadata.name));
    if (allDefaultRow && this.ctx.isMySqlFamily()) {
      const emptyRows = items.map(() => "()").join(", ");
      return {
        insertSql: sql`INSERT INTO ${table} ${raw(`() VALUES ${emptyRows}`)}${returningSql}`,
        allDefaultRow,
      };
    }
    if (allDefaultRow && this.ctx.isSqlite()) {
      return {
        insertSql: sql`INSERT INTO ${table} ${raw("DEFAULT VALUES")}`,
        allDefaultRow,
      };
    }
    return {
      insertSql: sql`INSERT INTO ${table} (${join(columns, ", ")}) VALUES ${join(valueRows, ", ")}${returningSql}`,
      allDefaultRow,
    };
  }

  /**
   * Runs the batch INSERT under query tracking.
   *
   * SQLite has no DEFAULT keyword inside VALUES, so the all-default shape is
   * a single-row statement executed once per item; each rowid is kept for
   * exact PK assignment rather than derived from a range.
   */
  private async executeBatchInsert<T>(
    entity: ClazzType<T>,
    insertSql: Sql,
    items: Partial<T>[],
    allDefaultRow: boolean,
    session: TransactionSessionManager,
  ): Promise<{
    queryResult: DriverExecResult;
    sqliteDefaultRowIds: number[] | null;
  }> {
    this.ctx.beginTrackQuery();
    const queryStart = Date.now();
    const track = () =>
      this.ctx.trackQuery(
        entity.name,
        insertSql.text ?? String(insertSql),
        Date.now() - queryStart,
      );

    if (allDefaultRow && this.ctx.isSqlite()) {
      const sqliteDefaultRowIds: number[] = [];
      for (let i = 0; i < items.length; i++) {
        const res = await session.query(insertSql);
        sqliteDefaultRowIds.push(Number(sqliteRunResult(res)?.lastInsertRowid));
      }
      track();
      return { queryResult: { results: [], fields: [] }, sqliteDefaultRowIds };
    }

    const queryResult = (await session.query(insertSql)) as DriverExecResult;
    track();
    return { queryResult, sqliteDefaultRowIds: null };
  }

  /**
   * The saved entities, in the order the items were passed.
   *
   * A driver that returned the rows lets them deserialize directly; otherwise
   * the primary keys are derived per dialect (RETURNING rows, the MySQL
   * `insertId` range, SQLite rowids, or client-generated UUIDs) and re-read in
   * one `WHERE pk IN (...)`. An entity with eager relations always takes the
   * re-read, since RETURNING carries only the inserted table's columns.
   */
  private async collectBatchInsertResults<T>(
    entity: ClazzType<T>,
    pk: ColumnMetadata,
    items: Partial<T>[],
    queryResult: DriverExecResult,
    sqliteDefaultRowIds: number[] | null,
    session: TransactionSessionManager,
  ): Promise<InstanceType<ClazzType<T>>[]> {
    const hasAutoIncrementPk = pk.options?.autoIncrement === true;
    const useReturning = this.supportsInsertReturning();
    const insertedRows = resultRows(queryResult);

    if (useReturning && insertedRows.length > 0 && !this.ctx.hasEagerRelations(entity)) {
      // #369: ResultTransformer maps DB column names → property keys.
      return ResultTransformerFactory.create().toEntities(entity, {
        results: insertedRows,
        fields: [],
      }) as InstanceType<ClazzType<T>>[];
    }

    let pkValues: unknown[];
    if (useReturning && insertedRows.length > 0) {
      pkValues = insertedRows.map((row) => row[pk.name]);
    } else if (this.ctx.isMySqlFamily() && hasAutoIncrementPk) {
      // mysql2 hands an insertId beyond ±2^53 over as a string
      // (supportBigNumbers); BigInt arithmetic keeps the derived range exact.
      const firstId = BigInt(okPacket(queryResult)?.insertId ?? 0);
      pkValues = items.map((_, i) => firstId + BigInt(i));
    } else if (this.ctx.isSqlite() && hasAutoIncrementPk) {
      if (sqliteDefaultRowIds) {
        pkValues = sqliteDefaultRowIds;
      } else {
        const lastId = BigInt(sqliteRunResult(queryResult)?.lastInsertRowid ?? 0);
        pkValues = items.map((_, i) => lastId - BigInt(items.length) + 1n + BigInt(i));
      }
    } else {
      // UUID — use client-generated PK values
      pkValues = items.map((item) => fieldsOf(item)[this.ctx.propKey(pk)]);
    }
    // The re-read below is matched back to `items` by PK value, so the keys
    // must carry the same representation the hydrated entities do: the
    // column's bigintMode for bigint PKs, plain numbers for the rest.
    const pkWhere = `${entity.name}.${this.ctx.propKey(pk)}`;
    pkValues =
      pk.options?.type === "bigint"
        ? pkValues.map((v) =>
            normalizeBigintValue(v, pk.options?.bigintMode ?? DEFAULT_BIGINT_MODE, pkWhere),
          )
        : pkValues.map((v) => (typeof v === "bigint" ? Number(v) : v));

    const found = await this.ctx.findInternal(
      entity,
      { where: whereByProps<T>({ [this.ctx.propKey(pk)]: pkValues }) },
      session,
    );
    const resultArray = Array.isArray(found) ? found : found ? [found] : [];
    const resultMap = new Map<unknown, InstanceType<ClazzType<T>>>();
    for (const row of resultArray) {
      resultMap.set(
        fieldsOf(row)[this.ctx.propKey(pk)],
        row as InstanceType<ClazzType<T>>,
      );
    }
    return pkValues.map((id) => resultMap.get(id)!).filter(Boolean);
  }

  /** afterInsert hooks, events and subscribers for a whole batch. */
  private async emitBatchAfterInsert<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
  ): Promise<void> {
    for (const item of items) {
      await this.cascadeHandler.runHooks(entity, item, "afterInsert");
      await this.eventEmitter.emit("afterInsert", { entity, data: item });
      await this.ctx.notifySubscribers(entity, "afterInsert", {
        entity: item,
        manager: this.ctx.getManager(),
      } as InsertEvent<T>);
    }
  }

  private async saveManyBatchInsert<T>(
    entity: ClazzType<T>,
    pk: ColumnMetadata,
    items: Partial<T>[],
    session: TransactionSessionManager,
  ): Promise<InstanceType<ClazzType<T>>[]> {
    const metadata = this.resolver.resolveEntityMetadata(entity)!;

    await this.emitBatchBeforeInsert(entity, items);

    const insertableColumns = this.selectBatchInsertColumns(
      entity,
      metadata,
      items,
    );
    this.applyBatchGeneratedValues(entity, insertableColumns, items);

    const { insertSql, allDefaultRow } = this.buildBatchInsertStatement(
      entity,
      metadata,
      pk,
      insertableColumns,
      items,
    );

    const { queryResult, sqliteDefaultRowIds } = await this.executeBatchInsert(
      entity,
      insertSql,
      items,
      allDefaultRow,
      session,
    );

    const results = await this.collectBatchInsertResults(
      entity,
      pk,
      items,
      queryResult,
      sqliteDefaultRowIds,
      session,
    );

    // OneToMany cascade per item
    for (let i = 0; i < items.length; i++) {
      const cascadeId = results[i] ? fieldsOf(results[i])[this.ctx.propKey(pk)] : undefined;
      if (cascadeId !== undefined) {
        await this.cascadeHandler.cascadeSaveOneToMany(entity, items[i], cascadeId, session);
      }
    }

    await this.emitBatchAfterInsert(entity, items);

    return results;
  }

  /**
   * The values a bulk INSERT fills in rather than the caller: the tenant
   * column, then everything {@link applyBatchGeneratedValues} seeds —
   * client-side UUID keys, `@CreateTimestamp` / `@UpdateTimestamp` and the
   * `@Version` seed. They are written onto the items themselves, so the rows
   * the caller passed in carry what was persisted.
   *
   * The managed columns are found through their decorators, never by column
   * type: a plain `datetime` column the item left unset stays NULL (as it
   * does through save()), and a `timestamptz` timestamp is still stamped.
   */
  private applyBulkInsertDefaults<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    items: Partial<T>[],
  ): void {
    if (this.ctx.getTenantColumnConfig()) {
      for (const item of items) {
        this.ctx.applyTenantColumnOnInsert(entity, item);
      }
    }

    this.applyBatchGeneratedValues(entity, metadata.columns, items);
  }

  /**
   * The columns a bulk INSERT names: computed columns never, an
   * auto-increment PK only when *every* item states a value for it (a mixed
   * batch would otherwise bind NULL over the sequence), and any other column
   * when at least one item provides it — a column no item provides is left
   * out so the DB DEFAULT applies, as in saveMany() (#368). Items missing a
   * named column bind NULL.
   *
   * Runs after {@link applyBulkInsertDefaults}, so the tenant column and the
   * seeded managed columns always count as provided. When nothing at all is
   * provided — no declared column and no `@ManyToOne` key — the full declared
   * column set is kept, binding NULL: a multi-row INSERT has no portable
   * all-defaults form.
   */
  private selectBulkInsertColumns<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    items: Partial<T>[],
  ): ColumnMetadata[] {
    const computedCols = this.ctx.getComputedColumnNames(entity);
    const declared = metadata.columns.filter((column: ColumnMetadata) => {
      if (computedCols.has(column.name)) return false;
      const isAutoIncrement = column.options?.autoIncrement;
      if (!isAutoIncrement) return true;
      return items.every((item) => {
        const value = fieldsOf(item)[this.ctx.propKey(column)];
        return value !== null && value !== undefined;
      });
    });
    const provided = declared.filter((column: ColumnMetadata) =>
      items.some((item) => fieldsOf(item)[this.ctx.propKey(column)] !== undefined),
    );
    return provided.length > 0 || this.statesAnyForeignKey(entity, items)
      ? provided
      : declared;
  }

  /** Whether any item states a value for one of the entity's `@ManyToOne` keys. */
  private statesAnyForeignKey<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
  ): boolean {
    return this.resolver
      .resolveManyToOneMetadata(entity)
      .some(
        (rel) =>
          !!rel.joinColumn &&
          items.some(
            (item) => this.resolveFkValue(rel, fieldsOf(item)) !== undefined,
          ),
      );
  }

  /**
   * Whether `entity` is a child of a JOINED (table-per-type) hierarchy, whose
   * columns span the root's table and its own.
   */
  private isJoinedChild<T>(entity: ClazzType<T>): boolean {
    return (
      this.inheritanceResolver.getStrategy(entity) === "JOINED" &&
      this.inheritanceResolver.isChildEntity(entity)
    );
  }

  /**
   * The multi-row and upsert INSERT paths write a single table; only save()
   * splits a JOINED child between the root's table and its own. Written here,
   * a child's columns would all land in the child table — an error when a
   * root column is named, and otherwise a child row attached to whichever
   * root row happens to share its id.
   */
  private assertNotJoinedChild<T>(entity: ClazzType<T>, method: string): void {
    if (!this.isJoinedChild(entity)) return;
    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_OPERATION,
      `${method}() cannot write '${entity.name}': it is a child of a JOINED (table-per-type) hierarchy, ` +
        `whose columns span the root table and its own, and ${method}() writes a single table.`,
      `Use em.save(${entity.name}, row) for each row; save() inserts the root and child rows together.`,
    );
  }

  /** The column list and one VALUES row per item, FK columns appended. */
  private buildBulkInsertRows<T>(
    entity: ClazzType<T>,
    insertableColumns: ColumnMetadata[],
    items: Partial<T>[],
    site: string,
  ): { columns: Sql[]; valueRows: Sql[] } {
    const columns = insertableColumns.map((column) =>
      raw(this.ctx.wrap(column.name)),
    );
    const fkColumns = this.appendFkInsertColumns(
      entity,
      insertableColumns,
      columns,
    );
    const valueRows = items.map((item) => {
      const rowValues = this.buildInsertRowValues(
        insertableColumns,
        fkColumns,
        fieldsOf(item),
        site,
      );
      return sql`(${join(rowValues, ", ")})`;
    });
    return { columns, valueRows };
  }

  /**
   * Whether the driver can hand back the rows an INSERT wrote. The
   * INSERT-specific capability comes first (MariaDB supports INSERT RETURNING
   * without full RETURNING); the generic flag covers drivers that do not
   * distinguish the two.
   */
  private supportsInsertReturning(): boolean {
    return (
      (typeof this.driver?.supportsInsertReturning === "function" &&
        this.driver.supportsInsertReturning()) ||
      (typeof this.driver?.supportsReturning === "function" &&
        this.driver.supportsReturning())
    );
  }

  /**
   * Resolves an {@link InsertBuilderSpec} down to the pieces
   * {@link DmlSqlBuilder.buildInsertOnConflictSql} needs: the named columns,
   * one VALUES tuple per row, the wrapped conflict target and the rendered
   * DO UPDATE assignments.
   *
   * The defaults (`applyBulkInsertDefaults`) mutate the caller's rows, which
   * is why this runs inside the transaction on the execute path and on a
   * copy nowhere else — `insertMany()` has always behaved that way and the
   * builder is documented to match it.
   */
  private prepareBuilderInsert<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    spec: InsertBuilderSpec<T>,
    tenantGuard: UpsertTenantGuard | null = null,
  ): {
    columns: Sql[];
    valueRows: Sql[];
    conflictColumns: string[];
    action: InsertConflictAction;
  } {
    this.assertNotJoinedChild(entity, "createInsertBuilder");
    const items = spec.items as Partial<T>[];
    this.applyBulkInsertDefaults(entity, metadata, items);

    const insertableColumns = this.selectBulkInsertColumns(
      entity,
      metadata,
      items,
    );
    const { columns, valueRows } = this.buildBulkInsertRows(
      entity,
      insertableColumns,
      items,
      "createInsertBuilder()",
    );

    return {
      columns,
      valueRows,
      conflictColumns: this.resolveConflictColumns(entity, metadata, spec),
      action: this.renderConflictAction(
        entity,
        metadata,
        spec.action,
        tenantGuard,
      ),
    };
  }

  /**
   * The wrapped conflict-target columns: the properties the builder named,
   * or the primary key when it named none.
   *
   * An entity with neither is an error only where the target is actually
   * emitted — MySQL has no conflict target, and a constraint name replaces
   * the column list — so the check is deferred to the dialect layer by
   * returning an empty list here.
   */
  private resolveConflictColumns<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    spec: InsertBuilderSpec<T>,
  ): string[] {
    if (spec.target?.constraintName) return [];

    const properties = spec.target?.properties ?? [];
    if (properties.length > 0) {
      return properties.map((prop) =>
        this.ctx.wrap(this.columnNameForProperty(metadata, prop)),
      );
    }

    const pkColumns = metadata.columns
      .filter((col: ColumnMetadata) => col.options?.primary)
      .map((col: ColumnMetadata) => col.name);
    if (pkColumns.length === 0 && spec.action.kind !== "none") {
      throw new PrimaryKeyNotFoundError(entity.name);
    }
    return pkColumns.map((name) => this.ctx.wrap(name));
  }

  /** The DB column a property maps to, falling back to the property name. */
  private columnNameForProperty(
    metadata: EntityScannerMetadata,
    property: string,
  ): string {
    const column = metadata.columns.find(
      (col: ColumnMetadata) => this.ctx.propKey(col) === property,
    );
    return column?.name ?? property;
  }

  /**
   * Turns the builder's conflict action into rendered SQL assignments.
   *
   * Expression entries arrive already rendered — the builder held the alias
   * resolver and the dialect. Literal entries are bound here so the column's
   * write transformer applies, which is the reason they were left alone.
   */
  private renderConflictAction<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    action: ConflictAction,
    tenantGuard: UpsertTenantGuard | null = null,
  ): InsertConflictAction {
    if (action.kind !== "update") return action;

    const columnNames = action.set.map((entry) =>
      this.columnNameForProperty(metadata, entry.property),
    );
    // The conflict branch is an UPDATE: writing the tenant discriminator there
    // would hand the row to another tenant, which every other write path now
    // rejects.
    this.ctx.assertTenantColumnNotInSetColumns(entity, columnNames);

    const set = action.set.map((entry, i) => {
      const columnName = columnNames[i];
      const wrapped = raw(this.ctx.wrap(columnName));
      const assigned =
        entry.kind === "expression"
          ? entry.value
          : bindParam(this.transformedValue(metadata, columnName, entry.value));
      // MySQL takes no DO UPDATE predicate, so the guard folds into every
      // assignment; PostgreSQL and SQLite get it once as a WHERE below.
      if (tenantGuard && this.ctx.isMySqlFamily()) {
        return sql`${wrapped} = IF(${tenantGuard.predicate}, ${assigned}, ${raw(`${tenantGuard.tableRef}.${this.ctx.wrap(columnName)}`)})`;
      }
      return sql`${wrapped} = ${assigned}`;
    });

    if (set.length === 0) {
      throw new InvalidQueryError(
        `createInsertBuilder(${entity.name}).doUpdate() resolved to no assignments.`,
      );
    }

    let where = action.where;
    if (tenantGuard && !this.ctx.isMySqlFamily()) {
      // The caller's predicate is parenthesized: AND binds tighter than OR, so
      // a top-level OR would otherwise leave the guard applying to one arm.
      where = where
        ? sql`(${where}) AND ${tenantGuard.predicate}`
        : tenantGuard.predicate;
    }
    return { kind: "update", set, where };
  }

  /**
   * A literal conflict-assignment value with its column's write transformer
   * applied; a key with no column metadata (an FK join column) must be a
   * scalar.
   */
  private transformedValue(
    metadata: EntityScannerMetadata,
    columnName: string,
    value: unknown,
  ): unknown {
    const site = "createInsertBuilder()";
    const column = metadata.columns.find(
      (col: ColumnMetadata) => col.name === columnName,
    );
    if (column) return this.ctx.applyWriteTransform(column, value, site);
    assertScalarBindValue(
      metadata.target?.name ?? metadata.name,
      columnName,
      value,
      () => this.ctx.getDialect(),
      site,
    );
    return value;
  }

  /**
   * @internal Backs `InsertQueryBuilder.build()` — the statement without
   * tenant scoping, which is applied only on the execute path.
   */
  buildBuilderInsertSql<T>(
    entity: ClazzType<T>,
    spec: InsertBuilderSpec<T>,
  ): Sql {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }
    const prepared = this.prepareBuilderInsert(entity, metadata, spec);
    return this.dmlSqlBuilder.buildInsertOnConflictSql({
      tableName: this.ctx.wrapTable(metadata.name),
      columns: prepared.columns,
      valueRows: prepared.valueRows,
      conflictColumns: prepared.conflictColumns,
      constraintName: spec.target?.constraintName,
      indexPredicate: spec.target?.indexPredicate,
      action: prepared.action,
    });
  }

  /**
   * @internal Backs `InsertQueryBuilder.execute()`.
   *
   * Statement-level, like `executeBuilderUpdate`: no `beforeInsert` /
   * `afterInsert` events and no entity hooks. The tenant column, timestamp
   * and version defaults and column transformers are applied exactly as
   * `insertMany()` applies them.
   */
  async executeBuilderInsert<T>(
    entity: ClazzType<T>,
    spec: InsertBuilderSpec<T>,
  ): Promise<{ affected: number }> {
    if (spec.items.length === 0) {
      return { affected: 0 };
    }

    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    if (this.ctx.getTenantColumnConfig()) {
      for (const item of spec.items as Partial<T>[]) {
        this.ctx.applyTenantColumnOnInsert(entity, item);
      }
    }

    const tenantGuard = this.buildUpsertTenantGuard(entity, metadata);

    return this.ctx.executeInTransaction(async (session) => {
      const prepared = this.prepareBuilderInsert(
        entity,
        metadata,
        spec,
        tenantGuard,
      );
      const insertSql = this.dmlSqlBuilder.buildInsertOnConflictSql({
        tableName: this.ctx.wrapTable(metadata.name),
        columns: prepared.columns,
        valueRows: prepared.valueRows,
        conflictColumns: prepared.conflictColumns,
        constraintName: spec.target?.constraintName,
        indexPredicate: spec.target?.indexPredicate,
        action: prepared.action,
      });

      const queryStart = Date.now();
      this.ctx.beginTrackQuery();
      const queryResult = (await session.query(insertSql)) as DriverExecResult;
      this.ctx.trackQuery(
        entity.name,
        insertSql.text ?? String(insertSql),
        Date.now() - queryStart,
      );

      return { affected: this.affectedCount(queryResult, spec.items.length) };
    });
  }

  async insertMany<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
  ): Promise<{ affected: number }> {
    if (items.length === 0) {
      return { affected: 0 };
    }

    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    this.assertNotJoinedChild(entity, "insertMany");
    this.ctx.validateWriteInputKeys(entity, metadata, items, "insertMany");

    return this.ctx.executeInTransaction(async (session) => {
      this.applyBulkInsertDefaults(entity, metadata, items);

      const insertableColumns = this.selectBulkInsertColumns(
        entity,
        metadata,
        items,
      );
      const { columns, valueRows } = this.buildBulkInsertRows(
        entity,
        insertableColumns,
        items,
        "insertMany()",
      );

      const queryStr = sql`INSERT INTO ${raw(this.ctx.wrapTable(metadata.name))} (${join(columns, ", ")}) VALUES ${join(valueRows, ", ")}`;

      const queryResult = (await session.query(queryStr)) as DriverExecResult;

      return { affected: this.affectedCount(queryResult, items.length) };
    });
  }

  async insertManyAndReturn<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
  ): Promise<InstanceType<ClazzType<T>>[]> {
    if (items.length === 0) {
      return [];
    }

    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    if (!this.driver) {
      throw new OrmError(
        OrmErrorCode.NOT_CONNECTED,
        "Driver is not initialized. Call connect() first.",
      );
    }

    // Fail fast (before building any SQL) when the dialect cannot return rows
    // from an INSERT, so MySQL produces a clear, predictable error.
    if (!this.supportsInsertReturning()) {
      const dialect = this.ctx.getDbType() ?? "this database";
      throw new OrmError(
        OrmErrorCode.UNSUPPORTED_DATABASE,
        `insertManyAndReturn() requires INSERT ... RETURNING, unsupported by ${dialect}. ` +
          `Use saveMany() to insert and return entities one row at a time.`,
      );
    }

    this.assertNotJoinedChild(entity, "insertManyAndReturn");
    this.ctx.validateWriteInputKeys(entity, metadata, items, "insertManyAndReturn");

    return this.ctx.executeInTransaction(async (session) => {
      this.applyBulkInsertDefaults(entity, metadata, items);

      const insertableColumns = this.selectBulkInsertColumns(
        entity,
        metadata,
        items,
      );
      const { columns, valueRows } = this.buildBulkInsertRows(
        entity,
        insertableColumns,
        items,
        "insertManyAndReturn()",
      );

      // Same multi-row INSERT as insertMany(), with RETURNING * appended so the
      // generated PKs and DB defaults come back without a re-read. RETURNING *
      // is the portable form across PostgreSQL and SQLite; no driver exposes a
      // column-list returning helper, so it is emitted directly here.
      const queryStr = sql`INSERT INTO ${raw(this.ctx.wrapTable(metadata.name))} (${join(columns, ", ")}) VALUES ${join(valueRows, ", ")} RETURNING *`;

      const queryResult = (await session.query(queryStr)) as DriverExecResult;

      // PostgreSQL / SQLite (better-sqlite3 .all() on a RETURNING statement)
      // both surface the rows under `results`, in insertion (input) order.
      // #369: route them through ResultTransformer so DB column names map back
      // to property keys (explicit @Column({ name }) + NamingStrategy) and
      // column transformers apply on read — the same path find() uses.
      return ResultTransformerFactory.create().toEntities(entity, {
        results: resultRows(queryResult),
        fields: [],
      }) as InstanceType<ClazzType<T>>[];
    });
  }
  /** beforeDelete hooks, events and subscribers for a criteria-based delete. */
  private async emitBeforeDelete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<void> {
    await this.cascadeHandler.runHooks(entity, criteria, "beforeDelete");
    await this.eventEmitter.emit("beforeDelete", { entity, data: criteria });
    await this.ctx.notifySubscribers(entity, "beforeDelete", {
      entityClass: entity,
      criteria,
      manager: this.ctx.getManager(),
    } as DeleteEvent<T>);
  }

  /** afterDelete hooks, events and subscribers for a criteria-based delete. */
  private async emitAfterDelete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<void> {
    await this.cascadeHandler.runHooks(entity, criteria, "afterDelete");
    await this.eventEmitter.emit("afterDelete", { entity, data: criteria });
    await this.ctx.notifySubscribers(entity, "afterDelete", {
      entityClass: entity,
      criteria,
      manager: this.ctx.getManager(),
    } as DeleteEvent<T>);
  }

  /**
   * The WHERE a delete runs with: the user's criteria, narrowed to the STI
   * subtype and to the active tenant.
   *
   * The empty-criteria guard MUST run before the tenant predicate is
   * appended — otherwise tenant scoping alone would satisfy the check and
   * permit a "delete all my rows" call. DeleteWithoutConditionsError catches
   * that class of bug and must stay gated on user-supplied criteria only.
   */
  private buildDeleteWhereSql<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    criteria: WhereClause<T>,
    strategy: InheritanceStrategy | null,
  ): Sql {
    const deletePropToCol = this.ctx.buildPropertyToColumnMap(metadata);
    const whereMap: Sql[] = this.resolveCriteriaWhere(criteria, deletePropToCol);

    // Same rule as the tenant predicate: the STI discriminator is appended
    // by the ORM, not the caller, so it must not satisfy the guard either —
    // a criteria that resolves to nothing (`{ OR: [] }`) would otherwise
    // delete every row of the subtype.
    if (whereMap.length === 0) {
      throw new DeleteWithoutConditionsError("Delete");
    }

    const deleteSti = this.stiDiscriminatorClause(entity, strategy);
    if (deleteSti) {
      whereMap.push(deleteSti);
    }

    const tenantDeleteWhere = this.ctx.buildTenantWhereClause(entity);
    if (tenantDeleteWhere) {
      whereMap.push(tenantDeleteWhere);
    }

    return join(whereMap, " AND ");
  }

  /**
   * Whether a delete on `entity` spans the tables of a JOINED (table-per-type)
   * hierarchy: a child, whose row is split between the root table and its
   * own, or a root with subclasses, whose rows may each own a child row.
   */
  private isJoinedHierarchyDelete<T>(
    entity: ClazzType<T>,
    strategy: InheritanceStrategy | null,
  ): boolean {
    if (strategy !== "JOINED") return false;
    return (
      this.inheritanceResolver.isChildEntity(entity) ||
      this.inheritanceResolver.getConcreteEntities(entity).length > 1
    );
  }

  /**
   * TPT delete. The criteria may name columns of either table and the child
   * rows must go before the root rows they reference, so no single WHERE
   * serves every statement: the matching primary keys are read first — a
   * child through its INNER JOIN with the root, each column qualified with
   * the table that holds it, a root from its own table — and every table
   * is then deleted by those keys, child tables first. Called on the root,
   * that is every subclass table; on a child, its own table. The root
   * DELETE reports the affected count.
   *
   * Returns null when the root has no metadata, so the caller falls through
   * to the single-table delete.
   */
  private async deleteJoinedRows<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    criteria: WhereClause<T>,
    session: TransactionSessionManager,
  ): Promise<number | null> {
    const root = this.inheritanceResolver.getRoot(entity)!;
    const rootMeta = this.resolver.resolveEntityMetadata(root);
    const pk = metadata.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );
    if (!rootMeta || !pk) {
      return null;
    }

    const isChild = root !== entity;
    const rootAlias = this.ctx.wrap("tpt_root");
    const childAlias = this.ctx.wrap("tpt_child");
    const pkCol = this.ctx.wrap(pk.name);
    const rootOnlyColumns = new Set(
      rootMeta.columns
        .filter((column: ColumnMetadata) => !column.options?.primary)
        .map((column: ColumnMetadata) => column.name),
    );

    const whereMap = resolveWhereClause(criteria, {
      wrapColumn: (n) => this.ctx.wrap(n),
      dialect: this.ctx.getDialect(),
      dialectExpression: createDialectExpression(this.ctx.getDialect()),
      propertyToColumn: this.ctx.buildPropertyToColumnMap(metadata),
      qualified: true,
      qualifyColumn: (column) =>
        `${isChild && !rootOnlyColumns.has(column) ? childAlias : rootAlias}.${this.ctx.wrap(column)}`,
    });
    if (whereMap.length === 0) {
      throw new DeleteWithoutConditionsError("Delete");
    }
    // The root table holds the tenant column: name it directly.
    const tenantWhere = this.ctx.buildTenantWhereClause(
      entity,
      "tpt_root",
      "root",
    );
    if (tenantWhere) {
      whereMap.push(tenantWhere);
    }

    const from = isChild
      ? sql`${raw(this.ctx.wrapTable(metadata.name))} AS ${raw(childAlias)} INNER JOIN ${raw(this.ctx.wrapTable(rootMeta.name))} AS ${raw(rootAlias)} ON ${raw(childAlias)}.${raw(pkCol)} = ${raw(rootAlias)}.${raw(pkCol)}`
      : sql`${raw(this.ctx.wrapTable(rootMeta.name))} AS ${raw(rootAlias)}`;
    const matched = await session.query(
      sql`SELECT ${raw(rootAlias)}.${raw(pkCol)} AS ${raw(this.ctx.wrap("pk"))} FROM ${from} WHERE ${join(whereMap, " AND ")}`,
    );
    const ids = resultRows(matched).map((row) => row.pk as RawValue);
    if (ids.length === 0) {
      return 0;
    }

    const childTables = isChild
      ? [metadata.name]
      : this.inheritanceResolver
          .getConcreteEntities(entity)
          .filter((concrete) => concrete !== entity)
          .map((concrete) => this.resolver.resolveEntityMetadata(concrete)?.name)
          .filter((name): name is string => !!name);

    let affected = 0;
    for (let i = 0; i < ids.length; i += TPT_DELETE_ID_CHUNK) {
      const chunk = join(
        ids.slice(i, i + TPT_DELETE_ID_CHUNK).map((id) => sql`${id}`),
        ", ",
      );
      const byPk = (tableName: string) =>
        sql`DELETE FROM ${raw(this.ctx.wrapTable(tableName))} WHERE ${raw(pkCol)} IN (${chunk})`;
      await this.executePerTable(entity, childTables, byPk, session);
      affected += await this.executePerTable(
        entity,
        [rootMeta.name],
        byPk,
        session,
      );
    }
    return affected;
  }

  /**
   * The DELETE of a non-JOINED entity, under query tracking: one statement
   * per table `resolveWriteTables` names (one, or every concrete table of a
   * TABLE_PER_CLASS root).
   */
  private async executeDelete<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    whereSql: Sql,
    session: TransactionSessionManager,
  ): Promise<number> {
    return this.executePerTable(
      entity,
      this.resolveWriteTables(entity, metadata),
      (tableName) =>
        sql`DELETE FROM ${raw(this.ctx.wrapTable(tableName))} WHERE ${whereSql}`,
      session,
    );
  }

  async delete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult> {
    const metadata = this.resolver.resolveEntityMetadata(entity);

    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    this.ctx.validateCriteriaKeys(metadata, criteria, entity.name);
    this.assertCriteriaHasPredicate(metadata, criteria, "Delete");

    return this.ctx.executeInTransaction(async (session) => {
      await this.emitBeforeDelete(entity, criteria);

      // cascade remove — the handler issues the child deletes (and the
      // parent-PK SELECT) through the public ctx.delete/ctx.find, which only
      // join an ambient ALS session. Publish this transaction's session so
      // they reuse it instead of opening a second one: a nested BEGIN crashes
      // SQLite's single shared connection, and on pooled drivers the children
      // would commit independently of the parent delete (#414).
      await transactionStorage.run(session, () =>
        this.cascadeHandler.cascadeDeleteOneToMany(entity, criteria),
      );

      const deleteStrategy = this.inheritanceResolver.getStrategy(entity);
      const joinedAffected = this.isJoinedHierarchyDelete(entity, deleteStrategy)
        ? await this.deleteJoinedRows(entity, metadata, criteria, session)
        : null;

      const affected =
        joinedAffected ??
        (await this.executeDelete(
          entity,
          metadata,
          this.buildDeleteWhereSql(entity, metadata, criteria, deleteStrategy),
          session,
        ));

      await this.emitAfterDelete(entity, criteria);

      return { affected };
    });
  }
  async deleteMany<T>(entity: ClazzType<T>, ids: unknown[]): Promise<DeleteResult> {
    if (ids.length === 0) {
      return { affected: 0 };
    }

    for (const id of ids) {
      if (typeof id !== "string" && typeof id !== "number" && typeof id !== "bigint") {
        throw new InvalidQueryError(
          `deleteMany() expects scalar primary key values (string | number | bigint), but received ${typeof id}`,
          "Pass only primitive ID values, e.g. deleteMany(User, [1, 2, 3])",
        );
      }
    }

    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const pk = metadata.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );
    if (!pk) {
      throw new PrimaryKeyNotFoundError(entity.name);
    }

    // The criteria this bulk delete stands for, as delete() would spell it
    // — what the events report and the cascade resolves parents from.
    const criteria = { [this.ctx.propKey(pk)]: ids } as WhereClause<T>;

    return this.ctx.executeInTransaction(async (session) => {
      await this.emitBeforeDelete(entity, criteria);

      // cascade remove — same as delete(): the children go first, on this
      // transaction's session (#414). Without it a bulk delete either failed
      // on the FK or, with constraints off, orphaned every child.
      await transactionStorage.run(session, () =>
        this.cascadeHandler.cascadeDeleteOneToMany(entity, criteria),
      );

      // A TPT row spans the root table and a child table: deleting one
      // table's rows would orphan the other's, or trip the child→root FK.
      const joinedAffected = this.isJoinedHierarchyDelete(
        entity,
        this.inheritanceResolver.getStrategy(entity),
      )
        ? await this.deleteJoinedRows(entity, metadata, criteria, session)
        : null;
      if (joinedAffected !== null) {
        await this.emitAfterDelete(entity, criteria);
        return { affected: joinedAffected };
      }

      const placeholders = join(
        ids.map((id) => sql`${id as string | number}`),
        ", ",
      );

      // Tenant scoping — PKs may collide across tenants (e.g. autoIncrement
      // resets per schema), so `deleteMany([1, 2])` under tenant A must not
      // affect tenant B's rows with the same IDs.
      const tenantDeleteManyWhere = this.ctx.buildTenantWhereClause(entity);
      const affected = await this.executePerTable(
        entity,
        this.resolveWriteTables(entity, metadata),
        (tableName) =>
          tenantDeleteManyWhere
            ? sql`DELETE FROM ${raw(this.ctx.wrapTable(tableName))} WHERE ${raw(this.ctx.wrap(pk.name))} IN (${placeholders}) AND ${tenantDeleteManyWhere}`
            : sql`DELETE FROM ${raw(this.ctx.wrapTable(tableName))} WHERE ${raw(this.ctx.wrap(pk.name))} IN (${placeholders})`,
        session,
      );

      await this.emitAfterDelete(entity, criteria);

      return { affected };
    });
  }

  async clear<T>(entity: ClazzType<T>): Promise<void> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    if (!this.driver) {
      throw new OrmError(
        OrmErrorCode.NOT_CONNECTED,
        "Driver is not initialized. Call connect() first.",
      );
    }

    await this.driver.clear(metadata.name);
  }

  async update<T>(
    entity: ClazzType<T>,
    where: WhereClause<T>,
    data: UpdateData<T>,
  ): Promise<{ affected: number }> {
    // Same body as updateMany(), but the bind guard names the method the
    // caller actually called.
    return this.runUpdateMany(entity, data, { where }, "update()");
  }

  /**
   * Rejects an updateMany the ORM refuses to run: a criteria-less update
   * (which would touch every row), a nonsensical LIMIT, and unknown keys on
   * either the SET payload or the WHERE.
   */
  private validateUpdateManyInput<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    data: UpdateData<T>,
    options: UpdateManyOptions<T>,
  ): void {
    const { where, limit } = options;
    if (!where || Object.keys(where).length === 0) {
      throw new DeleteWithoutConditionsError("Update");
    }

    if (limit !== undefined) {
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) {
        throw new InvalidQueryError(
          `updateMany limit must be a non-negative integer, got ${String(limit)}`,
        );
      }
    }

    this.ctx.validateUpdateDataKeys(metadata, data, entity.name);
    this.ctx.validateCriteriaKeys(metadata, where, entity.name, "where");
    // Before updateMany's empty-SET early return, which used to answer
    // { affected: 0 } for a where that resolves to nothing.
    this.assertCriteriaHasPredicate(metadata, where, "Update");
    // A criteria update is scoped to the caller's own rows, but nothing stopped
    // it from handing one of them to another tenant.
    this.ctx.assertTenantColumnOnUpdate(entity, data as Partial<T>);
  }

  /**
   * One SET value of a criteria update — `updateMany()`, `update()` and
   * `createUpdateBuilder().set()` — ready to bind.
   *
   * A key that names a column gets the column's write transforms, as save()
   * applies them (`transformer.to`, registered column types, the JSON
   * round-trip), and the bind guard behind them. A key with no column
   * metadata — a `@ManyToOne` FK shadow property such as `ownerId` — is bound
   * as given once it is known to be a scalar. A raw `sql` fragment is spliced
   * as written.
   *
   * @internal Also backs `UpdateQueryBuilder.set()` through the callback
   *   `EntityManager.createUpdateBuilder()` injects.
   */
  criteriaSetValue(
    metadata: EntityScannerMetadata,
    entityName: string,
    key: string,
    dbCol: string,
    value: unknown,
    site: string,
  ): unknown {
    if (isSqlFragment(value)) return value;
    const column = metadata.columns.find(
      (col: ColumnMetadata) => col.name === dbCol,
    );
    if (column) return this.ctx.applyWriteTransform(column, value, site);
    assertScalarBindValue(
      entityName,
      key,
      value,
      () => this.ctx.getDialect(),
      site,
    );
    return value;
  }

  /**
   * The SET clauses for a criteria-based update: the caller's defined values
   * (through {@link criteriaSetValue}), plus `@UpdateTimestamp` unless the
   * payload sets it explicitly.
   *
   * The `@Version` bump is deliberately NOT here — it belongs after the
   * caller checks for an empty SET map, or an update with nothing to write
   * would still bump every matched row's version. See
   * {@link appendVersionIncrement}.
   */
  private buildUpdateManySetClauses<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    data: UpdateData<T>,
    propertyToColumn: Map<string, string>,
    tenantColumnName: string | null,
    site: string,
  ): Sql[] {
    const dataFields = fieldsOf(data);
    const setMap: Sql[] = [];
    for (const key in data) {
      const value = dataFields[key];
      if (value !== undefined) {
        const dbCol = propertyToColumn.get(key) ?? key;
        // Same rule as save(): while a tenant predicate applies the
        // discriminator is ORM-owned, so a payload repeating the current
        // tenant is dropped rather than rewritten (a foreign value already
        // threw in validation).
        if (tenantColumnName && dbCol === tenantColumnName) continue;
        const bound = this.criteriaSetValue(
          metadata,
          entity.name,
          key,
          dbCol,
          value,
          site,
        );
        setMap.push(sql`${raw(this.ctx.wrap(dbCol))} = ${bindParam(bound)}`);
      }
    }

    const updateTsColName = this.resolver.getUpdateTimestampColumn(entity);
    if (updateTsColName) {
      const hasExplicit = setMap.some(
        (s) => s.text?.includes(this.ctx.wrap(updateTsColName)),
      );
      if (!hasExplicit) {
        setMap.push(
          sql`${raw(this.ctx.wrap(updateTsColName))} = ${bindParam(new Date())}`,
        );
      }
    }

    return setMap;
  }

  /**
   * @Version: optimistic-lock counter. Criteria-based updates must bump it
   * exactly like save() does, or a later save() holding a now-stale version
   * would slip past the lock undetected. Skipped when the caller sets the
   * version property explicitly. getVersionColumn returns the PROPERTY key,
   * so it is mapped to the DB column the same way the SET keys are.
   */
  private appendVersionIncrement<T>(
    entity: ClazzType<T>,
    data: UpdateData<T>,
    setMap: Sql[],
    propertyToColumn: Map<string, string>,
  ): void {
    const versionProp = this.resolver.getVersionColumn(entity);
    if (versionProp && fieldsOf(data)[versionProp] === undefined) {
      const versionCol = this.ctx.wrap(
        propertyToColumn.get(versionProp) ?? versionProp,
      );
      setMap.push(sql`${raw(versionCol)} = ${raw(versionCol)} + 1`);
    }
  }

  /**
   * The WHERE a criteria-based update runs with: the caller's criteria,
   * intersected with the tenant filter (so an updateMany can never cross
   * tenant boundaries), narrowed to the STI subtype (never siblings sharing
   * the single table), and — unless `withDeleted` — limited to rows that are
   * not soft-deleted, so a bulk update never resurrects trashed data.
   *
   * The empty-criteria guard runs on user input only, in
   * {@link validateUpdateManyInput}, before any of these are appended.
   */
  private buildUpdateManyWhereClauses<T>(
    entity: ClazzType<T>,
    options: UpdateManyOptions<T>,
    propertyToColumn: Map<string, string>,
  ): Sql[] {
    const whereMap: Sql[] = this.resolveCriteriaWhere(
      options.where,
      propertyToColumn,
    );

    // The key-count check in validateUpdateManyInput cannot see a criteria
    // that resolves to no predicate at all — `{ OR: [] }`, `{ status:
    // undefined }` — and the tenant / STI / soft-delete predicates appended
    // below would then be the entire WHERE, turning the call into a
    // table-wide update. Guard on the user's predicates alone.
    if (whereMap.length === 0) {
      throw new DeleteWithoutConditionsError("Update");
    }

    const tenantUpdateWhere = this.ctx.buildTenantWhereClause(entity);
    if (tenantUpdateWhere) {
      whereMap.push(tenantUpdateWhere);
    }

    const updateSti = this.stiDiscriminatorClause(entity);
    if (updateSti) {
      whereMap.push(updateSti);
    }

    const updateDeletedAt = this.resolver.getDeletedAtColumn(entity);
    if (updateDeletedAt && !options.withDeleted) {
      whereMap.push(Conditions.isNull(this.ctx.wrap(updateDeletedAt)));
    }

    return whereMap;
  }

  async updateMany<T>(
    entity: ClazzType<T>,
    data: UpdateData<T>,
    options: UpdateManyOptions<T>,
  ): Promise<{ affected: number }> {
    return this.runUpdateMany(entity, data, options, "updateMany()");
  }

  /**
   * The criteria update both `updateMany()` and `update()` run.
   *
   * @param site - The method the caller called, for the bind-guard message.
   */
  private async runUpdateMany<T>(
    entity: ClazzType<T>,
    data: UpdateData<T>,
    options: UpdateManyOptions<T>,
    site: string,
  ): Promise<{ affected: number }> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    this.validateUpdateManyInput(entity, metadata, data, options);

    return this.ctx.executeInTransaction(async (session) => {
      const updatePropToCol = this.ctx.buildPropertyToColumnMap(metadata);

      const tenantUpdateWhere = this.ctx.buildTenantWhereClause(entity);
      const setMap = this.buildUpdateManySetClauses(
        entity,
        metadata,
        data,
        updatePropToCol,
        tenantUpdateWhere ? this.ctx.resolveTenantColumnName(entity) : null,
        site,
      );
      if (setMap.length === 0) {
        return { affected: 0 };
      }
      this.appendVersionIncrement(entity, data, setMap, updatePropToCol);

      const whereMap = this.buildUpdateManyWhereClauses(
        entity,
        options,
        updatePropToCol,
      );

      const orderBySql = this.dmlSqlBuilder.buildUpdateOrderBy(
        options.orderBy,
        updatePropToCol,
      );

      const tables = this.resolveWriteTables(entity, metadata);
      this.assertTpcWriteHasNoLimit(entity, tables, orderBySql, options.limit, site);

      // Criteria-based update events. Mirrors delete()'s eventEmitter channel:
      // listeners registered via `em.on("beforeUpdate"/"afterUpdate")` receive
      // the entity class + the SET payload. The EntitySubscriber UpdateEvent
      // channel stays save()-only because it contracts a single hydrated row
      // plus a `databaseEntity` snapshot, neither of which exists for a bulk
      // criteria update.
      await this.eventEmitter.emit("beforeUpdate", {
        entity,
        data: data as Record<string, unknown>,
      });

      const affected = await this.executePerTable(
        entity,
        tables,
        (tableName) =>
          this.dmlSqlBuilder.buildUpdateSql(
            { ...metadata, name: tableName },
            entity.name,
            setMap,
            whereMap,
            orderBySql,
            options.limit,
          ),
        session,
      );

      await this.eventEmitter.emit("afterUpdate", {
        entity,
        data: data as Record<string, unknown>,
      });

      return { affected };
    });
  }
  async increment<T>(
    entity: ClazzType<T>,
    where: WhereClause<T>,
    column: keyof T & string,
    by: number = 1,
  ): Promise<{ affected: number }> {
    return this.applyNumericDelta(entity, where, column, by, "+");
  }

  async decrement<T>(
    entity: ClazzType<T>,
    where: WhereClause<T>,
    column: keyof T & string,
    by: number = 1,
  ): Promise<{ affected: number }> {
    return this.applyNumericDelta(entity, where, column, by, "-");
  }

  /**
   * The afterInsert contract is "the entity now has its ID" — hooks,
   * subscribers, and the event payload all receive the original input
   * instance, so the DB-generated key must be written back onto it before
   * they fire. Skips app-provided keys (uuid strategies, manual PKs).
   */
  private assignGeneratedPk(
    item: unknown,
    pkProp: string,
    value: unknown,
  ): void {
    if (value == null || item == null) return;
    const record = item as Record<string, unknown>;
    if (record[pkProp] == null) record[pkProp] = value;
  }

  /**
   * Shared implementation behind {@link increment} / {@link decrement}.
   *
   * Resolves `column` to its DB column (NamingStrategy-aware) and escapes it so
   * the right-hand side references the real column — `<col> = <col> + ?` — then
   * binds `by` as a parameter via `sql-template-tag` (never string-concatenated)
   * and delegates to {@link update} for the actual statement.
   */
  private async applyNumericDelta<T>(
    entity: ClazzType<T>,
    where: WhereClause<T>,
    column: keyof T & string,
    by: number,
    operator: "+" | "-",
  ): Promise<{ affected: number }> {
    if (typeof by !== "number" || !Number.isFinite(by)) {
      throw new InvalidQueryError(
        `increment/decrement amount must be a finite number, got ${String(by)}`,
      );
    }

    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    // Map the entity property to its escaped DB column for the RHS reference.
    // update() maps the LHS key the same way, so both sides stay consistent.
    const propToCol = this.ctx.buildPropertyToColumnMap(metadata);
    const wrappedColumn = this.ctx.wrap(propToCol.get(column) ?? column);

    const expression =
      operator === "+"
        ? sql`${raw(wrappedColumn)} + ${by}`
        : sql`${raw(wrappedColumn)} - ${by}`;

    // Build the SET map as { [property]: <Sql expression> }. update() accepts
    // raw Sql values and renders them as the SET right-hand side verbatim,
    // while still applying the @Version auto-increment for versioned entities.
    const data: UpdateData<T> = {};
    (data as Record<string, Sql>)[column] = expression;

    return this.update(entity, where, data);
  }

  buildBuilderUpdateSql<T>(
    entity: ClazzType<T>,
    setMap: Sql[],
    whereConditions: Sql[],
    orderBySql: Sql | undefined,
    limit: number | undefined,
  ): Sql {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }
    if (whereConditions.length === 0) {
      throw new DeleteWithoutConditionsError("Update");
    }
    return this.dmlSqlBuilder.buildUpdateSql(
      metadata,
      entity.name,
      setMap,
      whereConditions,
      orderBySql,
      limit,
    );
  }

  async executeBuilderUpdate<T>(
    entity: ClazzType<T>,
    setEntries: Sql[],
    whereConditions: Sql[],
    orderBySql: Sql | undefined,
    limit: number | undefined,
    setColumns: readonly string[] = [],
  ): Promise<{ affected: number }> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }
    if (whereConditions.length === 0) {
      throw new DeleteWithoutConditionsError("Update");
    }
    this.ctx.assertTenantColumnNotInSetColumns(entity, setColumns);
    if (limit !== undefined) {
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) {
        throw new InvalidQueryError(
          `UpdateQueryBuilder.limit must be a non-negative integer, got ${String(limit)}`,
        );
      }
    }

    return this.ctx.executeInTransaction(async (session) => {
      let mergedSetMap = setEntries;

      // @UpdateTimestamp auto-inject (same logic as updateMany)
      const updateTsColName = this.resolver.getUpdateTimestampColumn(entity);
      if (updateTsColName) {
        const wrappedTs = this.ctx.wrap(updateTsColName);
        const hasExplicit = setEntries.some((s) =>
          s.text?.includes(wrappedTs),
        );
        if (!hasExplicit) {
          mergedSetMap = [
            ...setEntries,
            sql`${raw(wrappedTs)} = ${bindParam(new Date())}`,
          ];
        }
      }

      if (mergedSetMap.length === 0) {
        return { affected: 0 };
      }

      const whereMap = [...whereConditions];
      const tenantWhere = this.ctx.buildTenantWhereClause(entity);
      if (tenantWhere) {
        whereMap.push(tenantWhere);
      }

      const tables = this.resolveWriteTables(entity, metadata);
      this.assertTpcWriteHasNoLimit(entity, tables, orderBySql, limit, "UpdateQueryBuilder");

      const affected = await this.executePerTable(
        entity,
        tables,
        (tableName) =>
          this.dmlSqlBuilder.buildUpdateSql(
            { ...metadata, name: tableName },
            entity.name,
            mergedSetMap,
            whereMap,
            orderBySql,
            limit,
          ),
        session,
      );
      return { affected };
    });
  }

  async softDelete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const deletedAtColumn = this.resolver.getDeletedAtColumn(entity);
    if (!deletedAtColumn) {
      throw new InvalidQueryError(
        `Entity "${entity.name}" does not have a @DeletedAt column. Use delete() instead.`,
        `Add @DeletedAt() decorator to a Date column in "${entity.name}" to enable soft delete.`,
      );
    }

    this.ctx.validateCriteriaKeys(metadata, criteria, entity.name);
    this.assertCriteriaHasPredicate(metadata, criteria, "Soft delete");

    return this.ctx.executeInTransaction(async (session) => {
      // Criteria-based soft-delete events. Symmetrical with delete()'s
      // before/afterDelete: both fire the eventEmitter channel and the
      // EntitySubscriber channel with a DeleteEvent (entityClass + criteria).
      await this.eventEmitter.emit("beforeSoftDelete", { entity, data: criteria });
      await this.ctx.notifySubscribers(entity, "beforeSoftDelete", {
        entityClass: entity,
        criteria,
        manager: this.ctx.getManager(),
      } as DeleteEvent<T>);

      // cascade remove, soft-delete flavour — before the parent UPDATE, while
      // the parents still read as live. Same session publication as delete()
      // (#414) so the children roll back with the parent.
      await transactionStorage.run(session, () =>
        this.cascadeHandler.cascadeSoftDeleteOneToMany(entity, criteria),
      );

      const sdPropToCol = this.ctx.buildPropertyToColumnMap(metadata);
      const whereMap: Sql[] = this.resolveCriteriaWhere(
        criteria,
        sdPropToCol,
      );

      if (whereMap.length === 0) {
        throw new DeleteWithoutConditionsError("Soft delete");
      }

      // Tenant scoping — added after the empty-criteria guard so the user
      // still needs to specify a target, and the tenant filter narrows it.
      const tenantSoftDeleteWhere = this.ctx.buildTenantWhereClause(entity);
      if (tenantSoftDeleteWhere) {
        whereMap.push(tenantSoftDeleteWhere);
      }

      // STI: only trash rows of the requested subtype (mirrors delete()).
      const softDeleteSti = this.stiDiscriminatorClause(entity);
      if (softDeleteSti) {
        whereMap.push(softDeleteSti);
      }

      // Only stamp rows that are still active. Re-soft-deleting an already
      // trashed row would overwrite its original deleted_at timestamp, and
      // `affected` should report newly-deleted rows only.
      whereMap.push(Conditions.isNull(this.ctx.wrap(deletedAtColumn)));

      const whereSql = join(whereMap, " AND ");

      // SQLite's datetime('now') renders UTC without a zone marker, and the
      // read-side parser decodes zone-less text as local time — so the stamp
      // came back shifted by the process offset. strftime with an explicit Z
      // (and milliseconds) is the same DB clock in the format the reader
      // decodes as UTC; MySQL/PostgreSQL NOW() is already typed, so the driver
      // hands it back as a correct Date.
      const nowExpr = this.ctx.isSqlite()
        ? raw("strftime('%Y-%m-%dT%H:%M:%fZ','now')")
        : raw("NOW()");
      const affected = await this.executePerTable(
        entity,
        this.resolveWriteTables(entity, metadata),
        (tableName) =>
          sql`UPDATE ${raw(this.ctx.wrapTable(tableName))} SET ${raw(this.ctx.wrap(deletedAtColumn))} = ${nowExpr} WHERE ${whereSql}`,
        session,
      );

      await this.eventEmitter.emit("afterSoftDelete", { entity, data: criteria });
      await this.ctx.notifySubscribers(entity, "afterSoftDelete", {
        entityClass: entity,
        criteria,
        manager: this.ctx.getManager(),
      } as DeleteEvent<T>);

      return { affected };
    });
  }

  async restore<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const deletedAtColumn = this.resolver.getDeletedAtColumn(entity);
    if (!deletedAtColumn) {
      throw new InvalidQueryError(
        `Entity "${entity.name}" does not have a @DeletedAt column. Cannot restore.`,
        `Add @DeletedAt() decorator to a Date column in "${entity.name}" to enable soft delete/restore.`,
      );
    }

    this.ctx.validateCriteriaKeys(metadata, criteria, entity.name);
    this.assertCriteriaHasPredicate(metadata, criteria, "Restore");

    return this.ctx.executeInTransaction(async (session) => {
      // Criteria-based restore events — symmetrical with softDelete's.
      await this.eventEmitter.emit("beforeRestore", { entity, data: criteria });
      await this.ctx.notifySubscribers(entity, "beforeRestore", {
        entityClass: entity,
        criteria,
        manager: this.ctx.getManager(),
      } as DeleteEvent<T>);

      // Revive the children the softDelete cascade trashed — before the
      // parent UPDATE, so the handler can still tell which parents are
      // soft-deleted (see cascadeRestoreOneToMany).
      await transactionStorage.run(session, () =>
        this.cascadeHandler.cascadeRestoreOneToMany(entity, criteria),
      );

      const restorePropToCol = this.ctx.buildPropertyToColumnMap(metadata);
      const whereMap: Sql[] = this.resolveCriteriaWhere(
        criteria,
        restorePropToCol,
      );

      if (whereMap.length === 0) {
        throw new DeleteWithoutConditionsError("Restore");
      }

      // Tenant scoping — symmetrical with softDelete so restore can only
      // bring back rows belonging to the active tenant.
      const tenantRestoreWhere = this.ctx.buildTenantWhereClause(entity);
      if (tenantRestoreWhere) {
        whereMap.push(tenantRestoreWhere);
      }

      // STI: only revive rows of the requested subtype (mirrors delete()).
      const restoreSti = this.stiDiscriminatorClause(entity);
      if (restoreSti) {
        whereMap.push(restoreSti);
      }

      // Only revive rows that are actually soft-deleted. Restoring an active
      // row is a pointless write and inflates `affected` with rows that were
      // never deleted.
      whereMap.push(Conditions.isNotNull(this.ctx.wrap(deletedAtColumn)));

      const whereSql = join(whereMap, " AND ");

      const affected = await this.executePerTable(
        entity,
        this.resolveWriteTables(entity, metadata),
        (tableName) =>
          sql`UPDATE ${raw(this.ctx.wrapTable(tableName))} SET ${raw(this.ctx.wrap(deletedAtColumn))} = NULL WHERE ${whereSql}`,
        session,
      );

      await this.eventEmitter.emit("afterRestore", { entity, data: criteria });
      await this.ctx.notifySubscribers(entity, "afterRestore", {
        entityClass: entity,
        criteria,
        manager: this.ctx.getManager(),
      } as DeleteEvent<T>);

      return { affected };
    });
  }

  /**
   * The column plan an INSERT ... ON CONFLICT runs with, shared by upsert(),
   * insertIgnore() and batchUpsert().
   *
   * The conflict target defaults to the primary key; an entity without one
   * and without an explicit target cannot express a conflict at all, so that
   * throws. `isInsertable` is the only part that differs between the callers:
   * a single-row upsert asks what one payload defines, a batch asks the union
   * over its items.
   *
   * Returns null when no column is insertable — the caller reports 0 affected
   * rows rather than emitting a statement. An empty `wrappedUpdate` still
   * emits the INSERT; on conflict it writes nothing of the caller's (DO
   * NOTHING, or only the soft-delete revive).
   *
   * The primary key identifies the stored row and is never assigned, exactly
   * as in save()'s UPDATE — a seeded UUID in the SET list would replace it.
   * `@CreateTimestamp` keeps the stored creation time and `@Version` counts up
   * from the stored version whatever the payload says (the lock is not
   * checked — that is save()'s job). `@UpdateTimestamp` takes the inserted
   * row's value, and a `@DeletedAt` the payload does not state is cleared, so
   * the upserted row is live whichever branch ran. These managed assignments
   * never count as something to write on their own: a payload naming only its
   * conflict key leaves a live conflicting row untouched and only revives a
   * soft-deleted one. A `@UpdateTimestamp` or `@DeletedAt` the caller states
   * (`statedByCaller`) is the caller's column like any other — a
   * `{ key, updatedAt }` touch still updates the row.
   *
   * A `@ManyToOne` key the rows state (`statesFk`) whose join column no
   * `@Column` declares is named after the declared columns and, like them,
   * assigned on conflict unless it is part of the conflict target. A declared
   * join column needs nothing here: {@link seededUpsertRows} already filled it
   * from the relation.
   */
  private buildUpsertPlan<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    conflictColumns: string[] | undefined,
    isInsertable: (col: ColumnMetadata) => boolean,
    tenantColumnName: string | null,
    statedByCaller: (col: ColumnMetadata) => boolean,
    statesFk: (rel: ManyToOneMetadata<unknown>) => boolean,
  ): UpsertPlan | null {
    const pkColumns = metadata.columns
      .filter((col: ColumnMetadata) => col.options?.primary)
      .map((col: ColumnMetadata) => col.name);

    const resolvedConflictColumns = conflictColumns ?? pkColumns;
    if (resolvedConflictColumns.length === 0) {
      throw new PrimaryKeyNotFoundError(entity.name);
    }

    const computedCols = this.ctx.getComputedColumnNames(entity);
    const insertableColumns = metadata.columns.filter(
      (col: ColumnMetadata) =>
        !computedCols.has(col.name) && isInsertable(col),
    );
    const insertableNames = new Set(
      insertableColumns.map((col: ColumnMetadata) => col.name),
    );
    const fkColumns: FkColumnBinding[] = this.resolver
      .resolveManyToOneMetadata(entity)
      .flatMap((rel) =>
        rel.joinColumn &&
        !insertableNames.has(rel.joinColumn) &&
        statesFk(rel)
          ? [
              {
                joinColumn: rel.joinColumn,
                propertyName: rel.columnName,
                relMeta: rel,
              },
            ]
          : [],
      );
    if (insertableColumns.length === 0 && fkColumns.length === 0) {
      return null;
    }

    const conflictSet = new Set(resolvedConflictColumns);
    // A managed column the conflict branch may assign: declared, and not
    // itself part of the conflict target.
    const assignable = (name: string | null): name is string =>
      name !== null &&
      !conflictSet.has(name) &&
      metadata.columns.some((col: ColumnMetadata) => col.name === name);
    const createTsCol = this.resolver.getCreateTimestampColumn(entity);
    const versionCol = this.resolver.getVersionColumn(entity);
    const deletedAtCol = this.resolver.getDeletedAtColumn(entity);
    const updateTsColumn = metadata.columns.find(
      (col: ColumnMetadata) =>
        col.name === this.resolver.getUpdateTimestampColumn(entity),
    );
    // Refreshed by the ORM only when the caller left it to the ORM.
    const managedUpdateTs =
      updateTsColumn && !statedByCaller(updateTsColumn)
        ? updateTsColumn.name
        : null;
    const managedNames = new Set([createTsCol, managedUpdateTs, versionCol]);

    // The tenant discriminator is written on INSERT and never on conflict:
    // `tenant_id = EXCLUDED.tenant_id` is exactly how a conflicting row used
    // to change hands.
    const updateColumnNames = insertableColumns
      .filter((col: ColumnMetadata) => !col.options?.primary)
      // A UUID the ORM generated for this INSERT is not the caller's value:
      // assigning it on conflict would replace the stored one every time.
      .filter(
        (col: ColumnMetadata) =>
          !this.isClientGenerated(col) || statedByCaller(col),
      )
      .map((col: ColumnMetadata) => col.name)
      .concat(fkColumns.map((fk) => fk.joinColumn))
      .filter(
        (name) =>
          !conflictSet.has(name) &&
          name !== tenantColumnName &&
          !managedNames.has(name),
      );

    const wrapAll = (names: (string | null)[]) =>
      names.filter(assignable).map((name) => this.ctx.wrap(name));

    return {
      insertableColumns,
      fkColumns,
      tableName: this.ctx.wrapTable(metadata.name),
      wrappedColumns: insertableColumns
        .map((col: ColumnMetadata) => col.name)
        .concat(fkColumns.map((fk) => fk.joinColumn))
        .map((name) => this.ctx.wrap(name)),
      wrappedConflict: resolvedConflictColumns.map((name) =>
        this.ctx.wrap(name),
      ),
      wrappedUpdate: updateColumnNames.map((name) => this.ctx.wrap(name)),
      conflictNames: resolvedConflictColumns,
      managed: {
        existingRowRef: this.ctx.wrap(metadata.name),
        refresh: wrapAll(
          managedUpdateTs && insertableNames.has(managedUpdateTs)
            ? [managedUpdateTs]
            : [],
        ),
        increment: wrapAll([versionCol]),
        reset: wrapAll(
          deletedAtCol && !insertableNames.has(deletedAtCol)
            ? [deletedAtCol]
            : [],
        ),
      },
    };
  }

  /**
   * Plain-object copies of upsert payloads with the values the ORM fills in:
   * the tenant column, then client-side UUID keys, `@CreateTimestamp` /
   * `@UpdateTimestamp` and the `@Version` seed (see
   * {@link applyBatchGeneratedValues}).
   *
   * Unlike insertMany(), nothing is written back onto the caller's objects:
   * on conflict the stored row keeps its own key, creation time and version,
   * so a seeded `version: 1` on the payload would be a lie. Column values are
   * read through the property key, so an accessor defined on the entity's
   * prototype is captured too.
   *
   * A `@ManyToOne` whose join column is also a declared `@Column` writes
   * through that column: a row that leaves the column unset takes the key the
   * relation states, as insertMany() does.
   */
  private seededUpsertRows<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    items: Partial<T>[],
  ): Partial<T>[] {
    const declaredFks = this.resolver
      .resolveManyToOneMetadata(entity)
      .flatMap((rel) => {
        const column = metadata.columns.find(
          (col: ColumnMetadata) => col.name === rel.joinColumn,
        );
        return column ? [{ rel, key: this.ctx.propKey(column) }] : [];
      });
    const rows = items.map((item) => {
      const source = fieldsOf(item);
      const row: EntityFields = { ...source };
      for (const col of metadata.columns) {
        const key = this.ctx.propKey(col);
        if (row[key] === undefined && source[key] !== undefined) {
          row[key] = source[key];
        }
      }
      for (const { rel, key } of declaredFks) {
        if (row[key] !== undefined) continue;
        const fkValue = this.resolveFkValue(rel, row);
        if (fkValue !== undefined) row[key] = fkValue;
      }
      return row as Partial<T>;
    });
    if (this.ctx.getTenantColumnConfig()) {
      for (const row of rows) {
        this.ctx.applyTenantColumnOnInsert(entity, row);
      }
    }
    this.applyBatchGeneratedValues(entity, metadata.columns, rows);
    return rows;
  }

  /** A column whose value the ORM generates client-side (`uuid` / `uuid-v7`). */
  private isClientGenerated(col: ColumnMetadata): boolean {
    const strategy = col.options?.generationStrategy;
    return strategy === "uuid" || strategy === "uuid-v7";
  }

  /**
   * Whether any payload states a value for a declared, non-computed column or
   * a `@ManyToOne` key.
   *
   * Values the ORM fills in do not count: a payload naming nothing the upsert
   * family writes — only unknown keys, say — is reported as 0 affected rows
   * instead of inserting a row made of generated values alone.
   */
  private statesAnyUpsertColumn<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    items: Partial<T>[],
  ): boolean {
    const computedCols = this.ctx.getComputedColumnNames(entity);
    return (
      metadata.columns.some(
        (col: ColumnMetadata) =>
          !computedCols.has(col.name) &&
          items.some((item) => this.statesUpsertValue(col, item)),
      ) || this.statesAnyForeignKey(entity, items)
    );
  }

  /**
   * One upsert row's bound values, parallel to `plan.wrappedColumns`: the
   * declared columns through their write transforms, then the `@ManyToOne`
   * keys — NULL wherever a batch row states nothing.
   */
  private upsertRowValues(
    plan: UpsertPlan,
    rowFields: EntityFields,
    site: string,
  ): unknown[] {
    return plan.insertableColumns
      .map(
        (col: ColumnMetadata) =>
          this.ctx.applyWriteTransform(
            col,
            rowFields[this.ctx.propKey(col)],
            site,
          ) ?? null,
      )
      .concat(
        plan.fkColumns.map(
          (fk) => this.resolveFkValue(fk.relMeta, rowFields) ?? null,
        ),
      );
  }

  /**
   * The rows of a batch whose conflict branch can only revive soft-deleted
   * rows, with a repeated conflict key collapsed to its first row.
   *
   * That branch is a DO UPDATE, and PostgreSQL rejects a statement whose DO
   * UPDATE reaches a row the same statement already inserted ("ON CONFLICT DO
   * UPDATE command cannot affect row a second time") even when its WHERE
   * would skip the row. A repeat carries nothing of the caller's to write, so
   * dropping it changes no stored value. Rows with a NULL key never conflict
   * and are all kept.
   */
  private uniqueByConflictKey<T>(
    metadata: EntityScannerMetadata,
    plan: UpsertPlan,
    rows: Partial<T>[],
  ): Partial<T>[] {
    // A key part is read as the row binds it: a declared column through its
    // property, an undeclared `@ManyToOne` join column through the relation.
    const keyReaders = plan.conflictNames.map(
      (name): ((fields: EntityFields) => unknown) | undefined => {
        const column = metadata.columns.find(
          (col: ColumnMetadata) => col.name === name,
        );
        if (column) return (fields) => fields[this.ctx.propKey(column)];
        const fk = plan.fkColumns.find((binding) => binding.joinColumn === name);
        if (fk) return (fields) => this.resolveFkValue(fk.relMeta, fields);
        return undefined;
      },
    );
    if (keyReaders.some((read) => !read)) return rows;
    const seen = new Set<string>();
    return rows.filter((row) => {
      const fields = fieldsOf(row);
      const values = keyReaders.map((read) => read!(fields));
      if (values.some((value) => value === null || value === undefined)) {
        return true;
      }
      const key = JSON.stringify(values, (_k, value) =>
        typeof value === "bigint" ? `${value}n` : value,
      );
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Warns once per entity class when an upsert payload states a `@Version`
   * value. upsert() does not check the optimistic lock: the value is stored
   * only when the row is inserted, and a conflicting row counts up from its
   * stored version instead.
   */
  private warnIfUpsertVersionIgnored<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    items: Partial<T>[],
    method: "upsert" | "batchUpsert",
  ): void {
    if (this.upsertVersionWarnedEntities.has(entity)) return;
    const versionCol = this.resolver.getVersionColumn(entity);
    if (!versionCol) return;
    const column = metadata.columns.find(
      (col: ColumnMetadata) => col.name === versionCol,
    );
    if (!column) return;
    const key = this.ctx.propKey(column);
    if (!items.some((item) => fieldsOf(item)[key] != null)) return;

    this.upsertVersionWarnedEntities.add(entity);
    this.ctx.getLogger().warn(
      `${method}() on '${entity.name}' was given a @Version value for "${key}". ` +
        `Upserts do not check the optimistic lock: the value is used only when the row is inserted, ` +
        `and a conflicting row keeps counting from its stored version. ` +
        `Use save() to reject a stale version. Warned once per entity class.`,
    );
  }

  /**
   * The tenant guard an upsert's conflict branch runs under, or null when the
   * entity is not tenant-scoped in this context.
   *
   * `predicate` reads the *existing* row — `"orders"."tenant_id" = ?` — which
   * PostgreSQL requires to be table-qualified inside `DO UPDATE … WHERE`
   * (a bare column there is ambiguous against `excluded`), and which must use
   * the bare table name even when the table itself is schema-qualified.
   * `tableRef` is that same bare reference, for MySQL's per-assignment form.
   */
  private buildUpsertTenantGuard<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
  ): UpsertTenantGuard | null {
    const columnName = this.ctx.resolveTenantColumnName(entity);
    if (!columnName) return null;
    const predicate = this.ctx.buildTenantWhereClause(entity, metadata.name);
    if (!predicate) return null;
    return {
      predicate,
      tableRef: this.ctx.wrap(metadata.name),
      columnName,
    };
  }

  /**
   * Warns once per entity when a tenant-guarded upsert wrote fewer rows than
   * it was given — the conflicting row belongs to another tenant and was
   * skipped. PostgreSQL and SQLite report one row per write, so the shortfall
   * is a real signal there; MySQL's 0/1/2 convention conflates "blocked" with
   * "value-identical", so it is not inspected.
   */
  private warnIfUpsertSuppressed<T>(
    entity: ClazzType<T>,
    guard: UpsertTenantGuard | null,
    plan: UpsertPlan,
    affected: number,
    expected: number,
  ): void {
    if (!guard || this.ctx.isMySqlFamily()) return;
    // A statement that degraded to DO NOTHING skips a conflicting row whoever
    // owns it, so a shortfall there says nothing about tenancy.
    if (plan.wrappedUpdate.length === 0) return;
    if (affected >= expected) return;
    this.ctx.warnTenantUpsertSuppressed(entity, guard.columnName);
  }

  /**
   * Whether one row's payload states a value for a column. An auto-increment
   * column is only named when the payload gives it a real value — binding
   * NULL there would fight the sequence.
   */
  private statesUpsertValue<T>(col: ColumnMetadata, data: Partial<T>): boolean {
    const value = fieldsOf(data)[this.ctx.propKey(col)];
    if (col.options?.autoIncrement && (value === null || value === undefined)) {
      return false;
    }
    return value !== undefined;
  }

  async upsert<T>(
    entity: ClazzType<T>,
    data: Partial<T>,
    conflictColumns?: string[],
  ): Promise<{ affected: number }> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    if (!this.driver) {
      throw new OrmError(
        OrmErrorCode.NOT_CONNECTED,
        "Driver is not initialized. Call connect() first.",
      );
    }

    this.assertNotJoinedChild(entity, "upsert");
    this.ctx.validateWriteInputKeys(entity, metadata, [data], "upsert");
    if (!this.statesAnyUpsertColumn(entity, metadata, [data])) {
      return { affected: 0 };
    }
    this.warnIfUpsertVersionIgnored(entity, metadata, [data], "upsert");
    const [row] = this.seededUpsertRows(entity, metadata, [data]);

    const tenantGuard = this.buildUpsertTenantGuard(entity, metadata);
    const plan = this.buildUpsertPlan(
      entity,
      metadata,
      conflictColumns,
      (col) => this.statesUpsertValue(col, row),
      tenantGuard?.columnName ?? null,
      (col) => this.statesUpsertValue(col, data),
      (rel) => this.resolveFkValue(rel, fieldsOf(row)) !== undefined,
    );
    if (!plan) {
      return { affected: 0 };
    }

    return this.ctx.executeInTransaction(async (session) => {
      const columnValues = this.upsertRowValues(plan, fieldsOf(row), "upsert()");

      const upsertSql = this.dmlSqlBuilder.buildUpsertQuery(
        plan.tableName,
        plan.wrappedColumns,
        columnValues,
        plan.wrappedConflict,
        plan.wrappedUpdate,
        tenantGuard,
        plan.managed,
      );

      const queryResult = (await session.query(upsertSql)) as DriverExecResult;
      const affected = this.affectedCount(queryResult);
      this.warnIfUpsertSuppressed(entity, tenantGuard, plan, affected, 1);
      return { affected };
    });
  }

  async insertIgnore<T>(
    entity: ClazzType<T>,
    data: Partial<T>,
    conflictColumns?: string[],
  ): Promise<{ affected: number }> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    if (!this.driver) {
      throw new OrmError(
        OrmErrorCode.NOT_CONNECTED,
        "Driver is not initialized. Call connect() first.",
      );
    }

    this.assertNotJoinedChild(entity, "insertIgnore");
    this.ctx.validateWriteInputKeys(entity, metadata, [data], "insertIgnore");
    if (!this.statesAnyUpsertColumn(entity, metadata, [data])) {
      return { affected: 0 };
    }
    const [row] = this.seededUpsertRows(entity, metadata, [data]);

    // No DO UPDATE list here: a conflict skips the row, so a plan whose
    // insertable columns are all conflict targets is still a valid statement.
    const plan = this.buildUpsertPlan(
      entity,
      metadata,
      conflictColumns,
      (col) => this.statesUpsertValue(col, row),
      null,
      (col) => this.statesUpsertValue(col, data),
      (rel) => this.resolveFkValue(rel, fieldsOf(row)) !== undefined,
    );
    if (!plan) {
      return { affected: 0 };
    }

    return this.ctx.executeInTransaction(async (session) => {
      const columnValues = this.upsertRowValues(
        plan,
        fieldsOf(row),
        "insertIgnore()",
      );

      const insertSql = this.dmlSqlBuilder.buildInsertIgnoreQuery(
        plan.tableName,
        plan.wrappedColumns,
        columnValues,
        plan.wrappedConflict,
      );

      const queryResult = (await session.query(insertSql)) as DriverExecResult;
      return { affected: this.affectedCount(queryResult) };
    });
  }

  async batchUpsert<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
    conflictColumns?: string[],
  ): Promise<{ affected: number }> {
    if (items.length === 0) {
      return { affected: 0 };
    }

    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    if (!this.driver) {
      throw new OrmError(
        OrmErrorCode.NOT_CONNECTED,
        "Driver is not initialized. Call connect() first.",
      );
    }

    this.assertNotJoinedChild(entity, "batchUpsert");
    this.ctx.validateWriteInputKeys(entity, metadata, items, "batchUpsert");
    if (!this.statesAnyUpsertColumn(entity, metadata, items)) {
      return { affected: 0 };
    }
    this.warnIfUpsertVersionIgnored(entity, metadata, items, "batchUpsert");
    const seeded = this.seededUpsertRows(entity, metadata, items);

    // The column set is the union over the batch: an auto-increment column
    // is named only when every item supplies a value, any other column when
    // at least one does (items missing it bind NULL).
    const tenantGuard = this.buildUpsertTenantGuard(entity, metadata);
    const plan = this.buildUpsertPlan(
      entity,
      metadata,
      conflictColumns,
      (col) =>
        col.options?.autoIncrement
          ? seeded.every((row) => {
              const value = fieldsOf(row)[this.ctx.propKey(col)];
              return value !== null && value !== undefined;
            })
          : seeded.some(
              (row) => fieldsOf(row)[this.ctx.propKey(col)] !== undefined,
            ),
      tenantGuard?.columnName ?? null,
      (col) => items.some((item) => this.statesUpsertValue(col, item)),
      (rel) =>
        seeded.some(
          (row) => this.resolveFkValue(rel, fieldsOf(row)) !== undefined,
        ),
    );
    if (!plan) {
      return { affected: 0 };
    }
    const rows =
      plan.wrappedUpdate.length === 0 && plan.managed.reset.length > 0
        ? this.uniqueByConflictKey(metadata, plan, seeded)
        : seeded;

    return this.ctx.executeInTransaction(async (session) => {
      const valueRows = rows.map((row) => {
        const rowValues: RawValue[] = bindParams(
          this.upsertRowValues(plan, fieldsOf(row), "batchUpsert()"),
        );
        return sql`(${join(rowValues, ", ")})`;
      });

      const upsertSql = this.dmlSqlBuilder.buildBatchUpsertQuery(
        plan.tableName,
        plan.wrappedColumns,
        valueRows,
        plan.wrappedConflict,
        plan.wrappedUpdate,
        tenantGuard,
        plan.managed,
      );

      const queryResult = (await session.query(upsertSql)) as DriverExecResult;
      const affected = this.affectedCount(queryResult);
      this.warnIfUpsertSuppressed(entity, tenantGuard, plan, affected, items.length);
      return { affected };
    });
  }

}
