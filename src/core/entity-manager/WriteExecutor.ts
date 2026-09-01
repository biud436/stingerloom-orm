import { randomUUID } from "node:crypto";
import { ClazzType, Logger, resolveEntityGlobs, generateUUIDv7 } from "../../utils";
import { ColumnMetadata, EntityScannerMetadata } from "../../scanner";
import { ISqlDriver } from "../../dialects/SqlDriver";
import { TransactionSessionManager } from "../../dialects/TransactionSessionManager";
import { FindOption, LockMode, UpdateData, UpdateManyOptions, WhereClause } from "../../dialects/FindOption";
import { resolveWhereClause } from "../WhereResolver";
import sql, { Sql, join, raw, type RawValue } from "../../utils/sqlTag";
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
import { createDialectExpression } from "../../dialects/DialectExpression";
import { UpdateQueryBuilder } from "../UpdateQueryBuilder";
import { DmlSqlBuilder } from "./DmlSqlBuilder";
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

/**
 * Executes all write operations (INSERT / UPDATE / DELETE / UPSERT) for
 * EntityManager. Holds no schema state — reads dialect/identifier/helper
 * services from {@link EntityManagerInternals} and its injected collaborators.
 *
 * @internal Package-internal — not a public API.
 */
export class WriteExecutor {
  private readonly dmlSqlBuilder: DmlSqlBuilder;

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
  ): Promise<InstanceType<ClazzType<T>>> {
    const metadata = this.resolver.resolveEntityMetadata(entity);

    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

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
        const useReturning =
          (typeof this.driver?.supportsInsertReturning === "function" && this.driver.supportsInsertReturning()) ||
          (typeof this.driver?.supportsReturning === "function" && this.driver.supportsReturning());

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

      const updatePlan = this.buildUpdateSetPlan(op);
      const { updateMap, versionColName } = updatePlan;

      const pkWhereClauses = buildPkWhere();

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
        return this.ctx.applyWriteTransform(column, rawValue);
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
  private buildUpdateSetPlan<T>(op: SaveOperation<T>): UpdateSetPlan {
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
        return itemFields[this.ctx.propKey(column)] !== undefined;
      },
    );
    const updateMap = updatableColumns.map((column: ColumnMetadata) => {
      const rawValue = itemFields[this.ctx.propKey(column)];
      const value = this.ctx.applyWriteTransform(column, rawValue);
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

    const guardedByVersion =
      versionColName &&
      currentVersion !== undefined &&
      currentVersion !== null;

    let parentAffected: number | null = null;
    if (parentUpdateMap.length > 0) {
      const parentUpdateSql = sql`UPDATE ${raw(this.ctx.wrapTable(rootMeta.name))}
        SET ${join(parentUpdateMap, ", ")}
        WHERE ${join(pkWhereClauses, " AND ")}`;
      const parentResult = (await session.query<T>(
        parentUpdateSql,
      )) as DriverExecResult;
      parentAffected = this.ctx.isMySqlFamily()
        ? (okPacket(parentResult)?.affectedRows ?? 0)
        : (parentResult?.rowCount ?? 0);

      // Same contract as the single-table UPDATE path: a guarded parent
      // UPDATE that matched nothing is a stale @Version write (the version
      // increment always lands in parentUpdateMap, so the guard is enforced
      // here before the child statement runs); without a guard, 0 matched
      // rows means the PK doesn't exist — confirmed with the value-identical
      // probe for MySQL.
      if (parentAffected === 0) {
        if (guardedByVersion) {
          throw new OptimisticLockError(
            entity.name,
            currentVersion as number,
          );
        }
        const parentProbe = await session.query(
          sql`SELECT 1 AS "probe" FROM ${raw(this.ctx.wrapTable(rootMeta.name))} WHERE ${join(buildPkWhere(), " AND ")} LIMIT 1`,
        );
        if (resultRows(parentProbe).length === 0) {
          throw new EntityNotFoundError(
            entity.name,
            "save() attempted an UPDATE but no row matched the primary key.",
          );
        }
      }
    }

    if (childUpdateMap.length > 0) {
      // The child table has no @Version column — the optimistic-lock
      // guard baked into pkWhereClauses references the root table only,
      // so the child UPDATE filters by primary key alone. The parent
      // UPDATE above already enforced the version inside this same
      // transaction.
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
        const childAffected = this.ctx.isMySqlFamily()
          ? (okPacket(childResult)?.affectedRows ?? 0)
          : (childResult?.rowCount ?? 0);
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
  ): Promise<DriverRow | null> {
    const { entity, metadata, session, buildPkWhere } = op;

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

    let affected = 0;
    if (this.ctx.isMySqlFamily()) {
      affected = okPacket(updateResult)?.affectedRows ?? 0;
    } else {
      affected = updateResult?.rowCount ?? 0;
    }
    if (versionColName && currentVersion !== undefined && currentVersion !== null) {
      if (affected === 0) {
        throw new OptimisticLockError(entity.name, currentVersion as number);
      }
    } else if (affected === 0) {
      // 0 affected rows means no row matched the primary key — except on
      // MySQL, where affectedRows can also be 0 for a value-identical
      // UPDATE, so confirm with an existence probe before failing.
      // Without this the save was a silent no-op: afterUpdate hooks and
      // subscribers still fired and save() returned null cast as T.
      const probeResult = await session.query(
        sql`SELECT 1 AS "probe" FROM ${raw(this.ctx.wrapTable(metadata.name))} WHERE ${join(buildPkWhere(), " AND ")} LIMIT 1`,
      );
      if (resultRows(probeResult).length === 0) {
        throw new EntityNotFoundError(
          entity.name,
          "save() attempted an UPDATE but no row matched the primary key.",
        );
      }
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
        items.every((item) => {
          const pkValue = pk ? fieldsOf(item)[this.ctx.propKey(pk)] : undefined;
          return pkValue === null || pkValue === undefined;
        });

      if (canBatchInsert) {
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
        const saved = await this.saveInternal(entity, item, session);
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
  ): RawValue[] {
    const rowValues: RawValue[] = bindParams(
      insertableColumns.map((col) =>
        this.ctx.applyWriteTransform(col, itemFields[this.ctx.propKey(col)]),
      ),
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
   * All of them are written onto the items themselves, so the rows the caller
   * passed in carry what was persisted.
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
    const useReturning =
      (typeof this.driver?.supportsInsertReturning === "function" && this.driver.supportsInsertReturning()) ||
      (typeof this.driver?.supportsReturning === "function" && this.driver.supportsReturning());
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
    const useReturning =
      (typeof this.driver?.supportsInsertReturning === "function" && this.driver.supportsInsertReturning()) ||
      (typeof this.driver?.supportsReturning === "function" && this.driver.supportsReturning());
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
      const firstId = Number(okPacket(queryResult)?.insertId);
      pkValues = items.map((_, i) => firstId + i);
    } else if (this.ctx.isSqlite() && hasAutoIncrementPk) {
      if (sqliteDefaultRowIds) {
        pkValues = sqliteDefaultRowIds;
      } else {
        const lastId = Number(sqliteRunResult(queryResult)?.lastInsertRowid);
        pkValues = items.map((_, i) => lastId - items.length + 1 + i);
      }
    } else {
      // UUID — use client-generated PK values
      pkValues = items.map((item) => fieldsOf(item)[this.ctx.propKey(pk)]);
    }

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

    return this.ctx.executeInTransaction(async (session) => {
      if (this.ctx.getTenantColumnConfig()) {
        for (const item of items) {
          this.ctx.applyTenantColumnOnInsert(entity, item);
        }
      }

      const deletedAtColumn = this.resolver.getDeletedAtColumn(entity);
      const timestampTypes = new Set(["datetime", "timestamp", "date"]);
      const timestampColumns = metadata.columns.filter(
        (col: ColumnMetadata) =>
          col.options?.type &&
          timestampTypes.has(col.options.type) &&
          col.name !== deletedAtColumn,
      );
      if (timestampColumns.length > 0) {
        const now = new Date();
        for (const item of items) {
          const itemFields = fieldsOf(item);
          for (const col of timestampColumns) {
            if (itemFields[this.ctx.propKey(col)] == null) {
              itemFields[this.ctx.propKey(col)] = now;
            }
          }
        }
      }

      const versionCol = this.resolver.getVersionColumn(entity);
      if (versionCol) {
        // `versionCol` is the resolved DB column name; the value binding reads
        // the property key, so initialize via propKey (not the column name) or
        // the version lands as NULL under a transforming naming strategy.
        const versionColumn = metadata.columns.find((c) => c.name === versionCol);
        if (versionColumn) {
          const versionProp = this.ctx.propKey(versionColumn);
          for (const item of items) {
            const itemFields = fieldsOf(item);
            if (itemFields[versionProp] == null) {
              itemFields[versionProp] = 1;
            }
          }
        }
      }

      const computedColsMany = this.ctx.getComputedColumnNames(entity);
      const insertableColumns = metadata.columns.filter(
        (column: ColumnMetadata) => {
          if (computedColsMany.has(column.name)) return false;
          const isAutoIncrement = column.options?.autoIncrement;
          if (!isAutoIncrement) return true;
          return items.every((item) => {
            const value = fieldsOf(item)[this.ctx.propKey(column)];
            return value !== null && value !== undefined;
          });
        },
      );

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
        );
        return sql`(${join(rowValues, ", ")})`;
      });

      const queryStr = sql`INSERT INTO ${raw(this.ctx.wrapTable(metadata.name))} (${join(columns, ", ")}) VALUES ${join(valueRows, ", ")}`;

      const queryResult = (await session.query(queryStr)) as DriverExecResult;

      let affected = items.length;
      if (this.ctx.isMySqlFamily()) {
        affected = okPacket(queryResult)?.affectedRows ?? items.length;
      } else if (queryResult?.rowCount !== undefined) {
        affected = queryResult.rowCount;
      }

      return { affected };
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
    // from an INSERT, so MySQL produces a clear, predictable error. Prefer the
    // INSERT-specific capability (MariaDB supports INSERT RETURNING without full
    // RETURNING) and fall back to the generic flag for drivers that do not
    // distinguish the two.
    const supportsInsertReturning =
      (typeof this.driver.supportsInsertReturning === "function" &&
        this.driver.supportsInsertReturning()) ||
      (typeof this.driver.supportsReturning === "function" &&
        this.driver.supportsReturning());
    if (!supportsInsertReturning) {
      const dialect = this.ctx.getDbType() ?? "this database";
      throw new OrmError(
        OrmErrorCode.UNSUPPORTED_DATABASE,
        `insertManyAndReturn() requires INSERT ... RETURNING, unsupported by ${dialect}. ` +
          `Use saveMany() to insert and return entities one row at a time.`,
      );
    }

    return this.ctx.executeInTransaction(async (session) => {
      if (this.ctx.getTenantColumnConfig()) {
        for (const item of items) {
          this.ctx.applyTenantColumnOnInsert(entity, item);
        }
      }

      const deletedAtColumn = this.resolver.getDeletedAtColumn(entity);
      const timestampTypes = new Set(["datetime", "timestamp", "date"]);
      const timestampColumns = metadata.columns.filter(
        (col: ColumnMetadata) =>
          col.options?.type &&
          timestampTypes.has(col.options.type) &&
          col.name !== deletedAtColumn,
      );
      if (timestampColumns.length > 0) {
        const now = new Date();
        for (const item of items) {
          const itemFields = fieldsOf(item);
          for (const col of timestampColumns) {
            if (itemFields[this.ctx.propKey(col)] == null) {
              itemFields[this.ctx.propKey(col)] = now;
            }
          }
        }
      }

      const versionCol = this.resolver.getVersionColumn(entity);
      if (versionCol) {
        // `versionCol` is the resolved DB column name; the value binding reads
        // the property key, so initialize via propKey (not the column name) or
        // the version lands as NULL under a transforming naming strategy.
        const versionColumn = metadata.columns.find((c) => c.name === versionCol);
        if (versionColumn) {
          const versionProp = this.ctx.propKey(versionColumn);
          for (const item of items) {
            const itemFields = fieldsOf(item);
            if (itemFields[versionProp] == null) {
              itemFields[versionProp] = 1;
            }
          }
        }
      }

      const computedColsMany = this.ctx.getComputedColumnNames(entity);
      const insertableColumns = metadata.columns.filter(
        (column: ColumnMetadata) => {
          if (computedColsMany.has(column.name)) return false;
          const isAutoIncrement = column.options?.autoIncrement;
          if (!isAutoIncrement) return true;
          return items.every((item) => {
            const value = fieldsOf(item)[this.ctx.propKey(column)];
            return value !== null && value !== undefined;
          });
        },
      );

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
        );
        return sql`(${join(rowValues, ", ")})`;
      });

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

  async delete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult> {
    const metadata = this.resolver.resolveEntityMetadata(entity);

    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    this.ctx.validateCriteriaKeys(metadata, criteria, entity.name);

    return this.ctx.executeInTransaction(async (session) => {
      await this.cascadeHandler.runHooks(entity, criteria, "beforeDelete");
      await this.eventEmitter.emit("beforeDelete", { entity, data: criteria });
      await this.ctx.notifySubscribers(entity, "beforeDelete", {
        entityClass: entity,
        criteria,
        manager: this.ctx.getManager(),
      } as DeleteEvent<T>);

      // cascade remove — the handler issues the child deletes (and the
      // parent-PK SELECT) through the public ctx.delete/ctx.find, which only
      // join an ambient ALS session. Publish this transaction's session so
      // they reuse it instead of opening a second one: a nested BEGIN crashes
      // SQLite's single shared connection, and on pooled drivers the children
      // would commit independently of the parent delete (#414).
      await transactionStorage.run(session, () =>
        this.cascadeHandler.cascadeDeleteOneToMany(entity, criteria),
      );

      const deletePropToCol = this.ctx.buildPropertyToColumnMap(metadata);
      // #372: write criteria accept find-style operator objects
      // ({ between: [a, b] }, { gt }, { lte }, ...), arrays (IN) and
      // null (IS NULL) via the same resolver as the read paths.
      const whereMap: Sql[] = resolveWhereClause(criteria, {
        wrapColumn: (n) => this.ctx.wrap(n),
        dialect: this.ctx.getDialect(),
        dialectExpression: createDialectExpression(this.ctx.getDialect()),
        propertyToColumn: deletePropToCol,
      });

      // STI: when deleting a child entity, add the discriminator condition
      const deleteStrategy = this.inheritanceResolver.getStrategy(entity);
      if (deleteStrategy === "SINGLE_TABLE" && this.inheritanceResolver.isChildEntity(entity)) {
        const discCol = this.inheritanceResolver.getDiscriminatorColumn(entity);
        const discVal = this.inheritanceResolver.getDiscriminatorValue(entity);
        if (discCol && discVal) {
          whereMap.push(Conditions.equals(this.ctx.wrap(discCol.name), discVal));
        }
      }

      // Empty-criteria guard MUST run before we append the tenant predicate —
      // otherwise tenant scoping alone would satisfy the check and permit a
      // "delete all my rows" call. DeleteWithoutConditionsError catches that
      // class of bug and must stay gated on user-supplied criteria only.
      if (whereMap.length === 0) {
        throw new DeleteWithoutConditionsError("Delete");
      }

      // Tenant scoping is added after the guard so a delete with a user
      // criteria is safely intersected with the tenant filter.
      const tenantDeleteWhere = this.ctx.buildTenantWhereClause(entity);
      if (tenantDeleteWhere) {
        whereMap.push(tenantDeleteWhere);
      }

      const whereSql = join(whereMap, " AND ");

      // TPT: delete from the child table first, then the parent
      if (deleteStrategy === "JOINED" && this.inheritanceResolver.isChildEntity(entity)) {
        const root = this.inheritanceResolver.getRoot(entity)!;
        const rootMeta = this.resolver.resolveEntityMetadata(root);
        if (rootMeta) {
          // 1. Delete from the child table
          const childDeleteQuery = sql`DELETE FROM ${raw(this.ctx.wrapTable(metadata.name))} WHERE ${whereSql}`;
          await session.query(childDeleteQuery);

          // 2. Delete from the parent table
          const parentDeleteQuery = sql`DELETE FROM ${raw(this.ctx.wrapTable(rootMeta.name))} WHERE ${whereSql}`;
          const parentResult = (await session.query(
            parentDeleteQuery,
          )) as DriverExecResult;

          let affected = 0;
          if (this.ctx.isMySqlFamily()) {
            affected = okPacket(parentResult)?.affectedRows ?? 0;
          } else {
            affected = parentResult?.rowCount ?? 0;
          }

          await this.cascadeHandler.runHooks(entity, criteria, "afterDelete");
          await this.eventEmitter.emit("afterDelete", {
            entity,
            data: criteria,
          });
          await this.ctx.notifySubscribers(entity, "afterDelete", {
            entityClass: entity,
            criteria,
            manager: this.ctx.getManager(),
          } as DeleteEvent<T>);

          return { affected };
        }
      }

      const deleteQuery = sql`DELETE FROM ${raw(this.ctx.wrapTable(metadata.name))} WHERE ${whereSql}`;

      const deleteStart = Date.now();
      this.ctx.beginTrackQuery();
      const queryResult = (await session.query(deleteQuery)) as DriverExecResult;
      this.ctx.trackQuery(
        entity.name,
        deleteQuery.text ?? String(deleteQuery),
        Date.now() - deleteStart,
      );

      let affected = 0;
      if (this.ctx.isMySqlFamily()) {
        affected = okPacket(queryResult)?.affectedRows ?? 0;
      } else {
        affected = queryResult?.rowCount ?? 0;
      }

      await this.cascadeHandler.runHooks(entity, criteria, "afterDelete");
      await this.eventEmitter.emit("afterDelete", { entity, data: criteria });
      await this.ctx.notifySubscribers(entity, "afterDelete", {
        entityClass: entity,
        criteria,
        manager: this.ctx.getManager(),
      } as DeleteEvent<T>);

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

    return this.ctx.executeInTransaction(async (session) => {
      const placeholders = join(
        ids.map((id) => sql`${id as string | number}`),
        ", ",
      );

      // Tenant scoping — PKs may collide across tenants (e.g. autoIncrement
      // resets per schema), so `deleteMany([1, 2])` under tenant A must not
      // affect tenant B's rows with the same IDs.
      const tenantDeleteManyWhere = this.ctx.buildTenantWhereClause(entity);
      const deleteQuery = tenantDeleteManyWhere
        ? sql`DELETE FROM ${raw(this.ctx.wrapTable(metadata.name))} WHERE ${raw(this.ctx.wrap(pk.name))} IN (${placeholders}) AND ${tenantDeleteManyWhere}`
        : sql`DELETE FROM ${raw(this.ctx.wrapTable(metadata.name))} WHERE ${raw(this.ctx.wrap(pk.name))} IN (${placeholders})`;

      const queryResult = (await session.query(deleteQuery)) as DriverExecResult;

      let affected = 0;
      if (this.ctx.isMySqlFamily()) {
        affected = okPacket(queryResult)?.affectedRows ?? 0;
      } else {
        affected = queryResult?.rowCount ?? 0;
      }

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
    return this.updateMany(entity, data, { where });
  }

  async updateMany<T>(
    entity: ClazzType<T>,
    data: UpdateData<T>,
    options: UpdateManyOptions<T>,
  ): Promise<{ affected: number }> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const { where, orderBy, limit } = options;
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

    this.ctx.validateCriteriaKeys(metadata, data as WhereClause<T>, entity.name);
    this.ctx.validateCriteriaKeys(metadata, where, entity.name);

    return this.ctx.executeInTransaction(async (session) => {
      const updatePropToCol = this.ctx.buildPropertyToColumnMap(metadata);
      const dataFields = fieldsOf(data);
      const setMap: Sql[] = [];
      for (const key in data) {
        const value = dataFields[key];
        if (value !== undefined) {
          const dbCol = updatePropToCol.get(key) ?? key;
          setMap.push(sql`${raw(this.ctx.wrap(dbCol))} = ${bindParam(value)}`);
        }
      }

      // @UpdateTimestamp auto-inject
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

      if (setMap.length === 0) {
        return { affected: 0 };
      }

      // @Version: optimistic-lock counter. Criteria-based updates must bump it
      // exactly like save() does, or a later save() holding a now-stale version
      // would slip past the lock undetected. Skip when the caller sets the
      // version property explicitly. getVersionColumn returns the PROPERTY key,
      // so map it to the DB column the same way the SET keys above are mapped.
      const versionProp = this.resolver.getVersionColumn(entity);
      if (versionProp && dataFields[versionProp] === undefined) {
        const versionCol = this.ctx.wrap(
          updatePropToCol.get(versionProp) ?? versionProp,
        );
        setMap.push(sql`${raw(versionCol)} = ${raw(versionCol)} + 1`);
      }

      const whereMap: Sql[] = resolveWhereClause(where, {
        wrapColumn: (n) => this.ctx.wrap(n),
        dialect: this.ctx.getDialect(),
        dialectExpression: createDialectExpression(this.ctx.getDialect()),
        propertyToColumn: updatePropToCol,
      });

      // Tenant scoping — intersected with the user's WHERE so an updateMany
      // can never cross tenant boundaries. The empty-criteria guard above
      // runs on user input only; tenant predicate is appended here.
      const tenantUpdateWhere = this.ctx.buildTenantWhereClause(entity);
      if (tenantUpdateWhere) {
        whereMap.push(tenantUpdateWhere);
      }

      // STI: a criteria-based updateMany on a child class must touch only that
      // subtype's rows, never siblings sharing the single table — mirrors the
      // discriminator filter delete()/find() already apply.
      const updateSti =
        this.inheritanceResolver.getSingleTableChildDiscriminator(entity);
      if (updateSti) {
        whereMap.push(
          Conditions.equals(this.ctx.wrap(updateSti.columnName), updateSti.value),
        );
      }

      // Soft-delete: skip trashed rows by default (parity with find()), so a
      // bulk update never resurrects data on a logically-deleted row. Callers
      // opt back in with `withDeleted: true`. No-op without a @DeletedAt column.
      const updateDeletedAt = this.resolver.getDeletedAtColumn(entity);
      if (updateDeletedAt && !options.withDeleted) {
        whereMap.push(Conditions.isNull(this.ctx.wrap(updateDeletedAt)));
      }

      const orderBySql = this.dmlSqlBuilder.buildUpdateOrderBy(orderBy, updatePropToCol);

      const updateSql = this.dmlSqlBuilder.buildUpdateSql(
        metadata,
        entity.name,
        setMap,
        whereMap,
        orderBySql,
        limit,
      );

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

      const queryStart = Date.now();
      this.ctx.beginTrackQuery();
      const queryResult = (await session.query(updateSql)) as DriverExecResult;
      this.ctx.trackQuery(
        entity.name,
        updateSql.text ?? String(updateSql),
        Date.now() - queryStart,
      );

      let affected = 0;
      if (this.ctx.isMySqlFamily()) {
        affected = okPacket(queryResult)?.affectedRows ?? 0;
      } else {
        affected = queryResult?.rowCount ?? 0;
      }

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
  ): Promise<{ affected: number }> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }
    if (whereConditions.length === 0) {
      throw new DeleteWithoutConditionsError("Update");
    }
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

      const updateSql = this.dmlSqlBuilder.buildUpdateSql(
        metadata,
        entity.name,
        mergedSetMap,
        whereMap,
        orderBySql,
        limit,
      );

      const queryStart = Date.now();
      this.ctx.beginTrackQuery();
      const queryResult = (await session.query(updateSql)) as DriverExecResult;
      this.ctx.trackQuery(
        entity.name,
        updateSql.text ?? String(updateSql),
        Date.now() - queryStart,
      );

      let affected = 0;
      if (this.ctx.isMySqlFamily()) {
        affected = okPacket(queryResult)?.affectedRows ?? 0;
      } else {
        affected = queryResult?.rowCount ?? 0;
      }
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

      const sdPropToCol = this.ctx.buildPropertyToColumnMap(metadata);
      // #372: operator-object criteria — same resolver as the read paths.
      const whereMap: Sql[] = resolveWhereClause(criteria, {
        wrapColumn: (n) => this.ctx.wrap(n),
        dialect: this.ctx.getDialect(),
        dialectExpression: createDialectExpression(this.ctx.getDialect()),
        propertyToColumn: sdPropToCol,
      });

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
      const softDeleteSti =
        this.inheritanceResolver.getSingleTableChildDiscriminator(entity);
      if (softDeleteSti) {
        whereMap.push(
          Conditions.equals(
            this.ctx.wrap(softDeleteSti.columnName),
            softDeleteSti.value,
          ),
        );
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
      const updateQuery = sql`UPDATE ${raw(this.ctx.wrapTable(metadata.name))} SET ${raw(this.ctx.wrap(deletedAtColumn))} = ${nowExpr} WHERE ${whereSql}`;

      const queryResult = (await session.query(updateQuery)) as DriverExecResult;

      let affected = 0;
      if (this.ctx.isMySqlFamily()) {
        affected = okPacket(queryResult)?.affectedRows ?? 0;
      } else {
        affected = queryResult?.rowCount ?? 0;
      }

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

    return this.ctx.executeInTransaction(async (session) => {
      // Criteria-based restore events — symmetrical with softDelete's.
      await this.eventEmitter.emit("beforeRestore", { entity, data: criteria });
      await this.ctx.notifySubscribers(entity, "beforeRestore", {
        entityClass: entity,
        criteria,
        manager: this.ctx.getManager(),
      } as DeleteEvent<T>);

      const restorePropToCol = this.ctx.buildPropertyToColumnMap(metadata);
      // #372: operator-object criteria — same resolver as the read paths.
      const whereMap: Sql[] = resolveWhereClause(criteria, {
        wrapColumn: (n) => this.ctx.wrap(n),
        dialect: this.ctx.getDialect(),
        dialectExpression: createDialectExpression(this.ctx.getDialect()),
        propertyToColumn: restorePropToCol,
      });

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
      const restoreSti =
        this.inheritanceResolver.getSingleTableChildDiscriminator(entity);
      if (restoreSti) {
        whereMap.push(
          Conditions.equals(this.ctx.wrap(restoreSti.columnName), restoreSti.value),
        );
      }

      // Only revive rows that are actually soft-deleted. Restoring an active
      // row is a pointless write and inflates `affected` with rows that were
      // never deleted.
      whereMap.push(Conditions.isNotNull(this.ctx.wrap(deletedAtColumn)));

      const whereSql = join(whereMap, " AND ");

      const restoreQuery = sql`UPDATE ${raw(this.ctx.wrapTable(metadata.name))} SET ${raw(this.ctx.wrap(deletedAtColumn))} = NULL WHERE ${whereSql}`;

      const queryResult = (await session.query(restoreQuery)) as DriverExecResult;

      let affected = 0;
      if (this.ctx.isMySqlFamily()) {
        affected = okPacket(queryResult)?.affectedRows ?? 0;
      } else {
        affected = queryResult?.rowCount ?? 0;
      }

      await this.eventEmitter.emit("afterRestore", { entity, data: criteria });
      await this.ctx.notifySubscribers(entity, "afterRestore", {
        entityClass: entity,
        criteria,
        manager: this.ctx.getManager(),
      } as DeleteEvent<T>);

      return { affected };
    });
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

    this.ctx.applyTenantColumnOnInsert(entity, data);

    const pkColumns = metadata.columns
      .filter((col: ColumnMetadata) => col.options?.primary)
      .map((col: ColumnMetadata) => col.name);

    const resolvedConflictColumns = conflictColumns ?? pkColumns;

    if (resolvedConflictColumns.length === 0) {
      throw new PrimaryKeyNotFoundError(entity.name);
    }

    const computedColsUpsert = this.ctx.getComputedColumnNames(entity);
    const insertableColumns = metadata.columns.filter((col: ColumnMetadata) => {
      if (computedColsUpsert.has(col.name)) return false;
      const value = fieldsOf(data)[this.ctx.propKey(col)];
      if (
        col.options?.autoIncrement &&
        (value === null || value === undefined)
      ) {
        return false;
      }
      return value !== undefined;
    });

    if (insertableColumns.length === 0) {
      return { affected: 0 };
    }

    const conflictSet = new Set(resolvedConflictColumns);
    const updateColumnNames = insertableColumns
      .map((col: ColumnMetadata) => col.name)
      .filter((name) => !conflictSet.has(name));

    const wrappedColumns = insertableColumns.map((col: ColumnMetadata) =>
      this.ctx.wrap(col.name),
    );
    const wrappedConflict = resolvedConflictColumns.map((name) =>
      this.ctx.wrap(name),
    );
    const wrappedUpdate = updateColumnNames.map((name) => this.ctx.wrap(name));

    const tableName = this.ctx.wrapTable(metadata.name);

    if (wrappedUpdate.length === 0) {
      return { affected: 0 };
    }

    return this.ctx.executeInTransaction(async (session) => {
      const dataFields = fieldsOf(data);
      const columnValues = insertableColumns.map(
        (col: ColumnMetadata) => {
          const rawValue = dataFields[this.ctx.propKey(col)];
          return this.ctx.applyWriteTransform(col, rawValue);
        },
      );

      const upsertSql = this.dmlSqlBuilder.buildUpsertQuery(
        tableName,
        wrappedColumns,
        columnValues,
        wrappedConflict,
        wrappedUpdate,
      );

      const queryResult = (await session.query(upsertSql)) as DriverExecResult;
      const affected = this.ctx.isMySqlFamily()
        ? (okPacket(queryResult)?.affectedRows ?? 0)
        : (queryResult?.rowCount ?? 0);
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

    this.ctx.applyTenantColumnOnInsert(entity, data);

    const pkColumns = metadata.columns
      .filter((col: ColumnMetadata) => col.options?.primary)
      .map((col: ColumnMetadata) => col.name);

    const resolvedConflictColumns = conflictColumns ?? pkColumns;
    if (resolvedConflictColumns.length === 0) {
      throw new PrimaryKeyNotFoundError(entity.name);
    }

    const computedColsIgnore = this.ctx.getComputedColumnNames(entity);
    const insertableColumns = metadata.columns.filter((col: ColumnMetadata) => {
      if (computedColsIgnore.has(col.name)) return false;
      const value = fieldsOf(data)[this.ctx.propKey(col)];
      if (
        col.options?.autoIncrement &&
        (value === null || value === undefined)
      ) {
        return false;
      }
      return value !== undefined;
    });

    if (insertableColumns.length === 0) {
      return { affected: 0 };
    }

    const wrappedColumns = insertableColumns.map((col: ColumnMetadata) =>
      this.ctx.wrap(col.name),
    );
    const wrappedConflict = resolvedConflictColumns.map((name) =>
      this.ctx.wrap(name),
    );
    const tableName = this.ctx.wrapTable(metadata.name);

    return this.ctx.executeInTransaction(async (session) => {
      const dataFields = fieldsOf(data);
      const columnValues = insertableColumns.map((col: ColumnMetadata) => {
        const rawValue = dataFields[this.ctx.propKey(col)];
        return this.ctx.applyWriteTransform(col, rawValue);
      });

      const insertSql = this.dmlSqlBuilder.buildInsertIgnoreQuery(
        tableName,
        wrappedColumns,
        columnValues,
        wrappedConflict,
      );

      const queryResult = (await session.query(insertSql)) as DriverExecResult;
      const affected = this.ctx.isMySqlFamily()
        ? (okPacket(queryResult)?.affectedRows ?? 0)
        : (queryResult?.rowCount ?? 0);
      return { affected };
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

    if (this.ctx.getTenantColumnConfig()) {
      for (const item of items) {
        this.ctx.applyTenantColumnOnInsert(entity, item);
      }
    }

    const pkColumns = metadata.columns
      .filter((col: ColumnMetadata) => col.options?.primary)
      .map((col: ColumnMetadata) => col.name);

    const resolvedConflictColumns = conflictColumns ?? pkColumns;

    if (resolvedConflictColumns.length === 0) {
      throw new PrimaryKeyNotFoundError(entity.name);
    }

    const computedCols = this.ctx.getComputedColumnNames(entity);
    const conflictSet = new Set(resolvedConflictColumns);

    // Determine insertable columns from the union of all items' defined fields
    const insertableColumns = metadata.columns.filter((col: ColumnMetadata) => {
      if (computedCols.has(col.name)) return false;
      if (col.options?.autoIncrement) {
        // Include auto-increment column only if ALL items provide a value
        return items.every((item) => {
          const value = fieldsOf(item)[this.ctx.propKey(col)];
          return value !== null && value !== undefined;
        });
      }
      // Include column if at least one item provides a value
      return items.some(
        (item) => fieldsOf(item)[this.ctx.propKey(col)] !== undefined,
      );
    });

    if (insertableColumns.length === 0) {
      return { affected: 0 };
    }

    const updateColumnNames = insertableColumns
      .map((col: ColumnMetadata) => col.name)
      .filter((name) => !conflictSet.has(name));

    if (updateColumnNames.length === 0) {
      return { affected: 0 };
    }

    const wrappedColumns = insertableColumns.map((col: ColumnMetadata) =>
      this.ctx.wrap(col.name),
    );
    const wrappedConflict = resolvedConflictColumns.map((name) =>
      this.ctx.wrap(name),
    );
    const wrappedUpdate = updateColumnNames.map((name) => this.ctx.wrap(name));
    const tableName = this.ctx.wrapTable(metadata.name);

    return this.ctx.executeInTransaction(async (session) => {
      const valueRows = items.map((item) => {
        const itemFields = fieldsOf(item);
        const rowValues: RawValue[] = bindParams(
          insertableColumns.map((col: ColumnMetadata) => {
            const rawValue = itemFields[this.ctx.propKey(col)];
            return this.ctx.applyWriteTransform(col, rawValue) ?? null;
          }),
        );
        return sql`(${join(rowValues, ", ")})`;
      });

      const upsertSql = this.dmlSqlBuilder.buildBatchUpsertQuery(
        tableName,
        wrappedColumns,
        valueRows,
        wrappedConflict,
        wrappedUpdate,
      );

      const queryResult = (await session.query(upsertSql)) as DriverExecResult;
      const affected = this.ctx.isMySqlFamily()
        ? (okPacket(queryResult)?.affectedRows ?? 0)
        : (queryResult?.rowCount ?? 0);
      return { affected };
    });
  }

}
