/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils";
import { FindOption, UpdateData, WhereClause } from "../dialects/FindOption";
import { BaseRepository } from "./BaseRepository";
import { BaseRawQueryBuilder } from "./BaseRawQueryBuilder";
import { DeleteResult } from "../types/DeleteResult";
import { DatabaseClientOptions } from "./DatabaseClientOptions";
import { Sql } from "../utils/sqlTag";
import {
  CursorPaginationOption,
  CursorPaginationResult,
} from "./CursorPagination";
import {
  PagePaginationOption,
  PagePaginationResult,
} from "./PagePagination";
import { StingerloomPlugin } from "./plugin/StingerloomPlugin";

export abstract class BaseEntityManager {
  /**
   * Connects to the database and registers entities.
   * Registering entities means creating or updating their tables in the database,
   * which is called synchronization.
   *
   * This method should be called only once at application startup.
   * For RDBMS, DDL statements may be executed as part of synchronization — proceed with care.
   */
  abstract register(
    databaseClientOptions: DatabaseClientOptions,
  ): Promise<void>;

  /**
   * Connects to the database.
   * Attaches to the available database driver and creates the data source.
   */
  abstract connect(databaseClientOptions: DatabaseClientOptions): Promise<void>;

  /**
   * Destructor-style cleanup that primarily releases memory.
   * Invoked when the server shuts down for any reason.
   * In an integration-test environment this method may be called frequently.
   */
  abstract propagateShutdown(options?: {
    gracefulTimeoutMs?: number;
    closeConnections?: boolean;
  }): Promise<boolean>;

  /**
   * Runs a database query and returns a single result.
   * The query may include where, order by, and limit clauses.
   * @param entity
   * @param findOption
   */
  abstract findOne<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
  ): Promise<T | null>;

  /**
   * Retrieves a single entity or throws EntityNotFoundError.
   */
  abstract findOneOrFail<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
  ): Promise<T>;

  /**
   * Runs a database query and returns multiple results.
   * The query may include where, order by, and limit clauses.
   * @param entity
   * @param findOption
   */
  abstract find<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
  ): Promise<T[]>;

  /**
   * Retrieves entities using cursor-based pagination.
   *
   * @param entity Entity class
   * @param option Cursor pagination options
   * @returns Pagination result (data, hasNextPage, nextCursor, count)
   */
  abstract findWithCursor<T>(
    entity: ClazzType<T>,
    option?: CursorPaginationOption<T>,
  ): Promise<CursorPaginationResult<T>>;

  /**
   * Retrieves entities using offset-based page pagination.
   *
   * @param entity Entity class
   * @param option Page pagination options (page, pageSize, where, orderBy, etc.)
   * @returns Pagination result (data, total, page, pageSize, totalPages, hasNextPage, hasPreviousPage)
   */
  abstract findWithPage<T>(
    entity: ClazzType<T>,
    option?: PagePaginationOption<T>,
  ): Promise<PagePaginationResult<T>>;

  /**
   * Returns an AsyncGenerator that yields entities in batches using LIMIT/OFFSET.
   * Suitable for processing large datasets without loading all rows into memory.
   *
   * @param entity Entity class
   * @param options Find options (where, orderBy, relations, etc.)
   * @param batchSize Number of rows per internal batch (default: 1000)
   */
  abstract stream<T>(
    entity: ClazzType<T>,
    options?: FindOption<T>,
    batchSize?: number,
  ): AsyncGenerator<T, void, undefined>;

  /**
   * Saves or updates a row in the database.
   * On update the PK column must be present; when it is missing this performs an insert instead.
   *
   * This ORM does not yet have a first-level cache such as a persistence context,
   * so no dirty checking is performed on save or update.
   *
   * As a result, calling this method causes the change to be reflected in the database immediately.
   *
   * @param entity
   * @param item
   */
  abstract save<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): Promise<InstanceType<ClazzType<T>>>;

  /**
   * Deletes entities that match the given conditions from the database.
   *
   * @param entity Entity class to delete
   * @param criteria WHERE condition (same shape as FindOption.where)
   * @returns DeleteResult containing the number of affected rows
   */
  abstract delete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult>;

  /**
   * Bulk-deletes multiple entities by a list of PK values.
   * Runs a single `DELETE FROM table WHERE pk IN (?, ?, ...)` query.
   *
   * @param entity Entity class
   * @param ids Array of PK values to delete
   * @returns DeleteResult containing the number of affected rows
   */
  abstract deleteMany<T>(
    entity: ClazzType<T>,
    ids: unknown[],
  ): Promise<DeleteResult>;

  /**
   * Returns the Repository for the given Entity.
   * This ORM does not support the Active Record pattern, so callers must use
   * the Data Mapper pattern through Repositories.
   */
  /**
   * Performs a soft delete on an entity that has a @DeletedAt column.
   * Updates the deleted_at column to the current timestamp.
   *
   * @param entity Entity class
   * @param criteria WHERE condition
   * @returns DeleteResult containing the number of affected rows
   */
  abstract softDelete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult>;

  /**
   * Restores a soft-deleted entity.
   * Updates the deleted_at column back to NULL.
   *
   * @param entity Entity class
   * @param criteria WHERE condition
   * @returns DeleteResult containing the number of affected rows
   */
  abstract restore<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult>;

  /**
   * Runs an arbitrary SQL query and returns the result as a generic `T[]`.
   *
   * @param sqlQuery SQL string or a sql-template-tag Sql object to execute
   * @param params Array of parameters to bind when using a SQL string
   * @returns Query result typed as `T[]`
   */
  abstract query<T = Record<string, unknown>>(
    sqlQuery: string | Sql,
    params?: unknown[],
  ): Promise<T[]>;

  /**
   * Returns both the matching entities and their total count.
   * Produces a `[entities, totalCount]` tuple where `count` ignores take/limit.
   *
   * @param entity Entity class
   * @param findOption Find options
   * @returns Tuple of `[entities, totalCount]`
   */
  abstract findAndCount<T>(
    entity: ClazzType<T>,
    findOption?: FindOption<T>,
  ): Promise<[T[], number]>;

  abstract getRepository<T>(entity: ClazzType<T>): BaseRepository<T>;

  /**
   * Runs work inside a specific tenant context.
   * Uses AsyncLocalStorage so that every metadata lookup inside the callback
   * is resolved from that tenant's layer.
   *
   * @param tenantId Tenant identifier
   * @param callback Async work to run within the tenant context
   * @returns The callback's return value
   *
   * @example
   * ```ts
   * const result = await entityManager.withTenant("tenant_1", async (em) => {
   *   return em.find(User, { where: { id: 1 } });
   * });
   * ```
   */
  /**
   * Updates multiple entities matching the WHERE condition with the given data.
   * Returns the number of affected rows.
   */
  /**
   * Executes a callback within a database transaction.
   * Auto-commits on success, auto-rollbacks on error.
   */
  abstract transaction<R>(callback: (em: this) => Promise<R>): Promise<R>;

  abstract updateMany<T>(
    entity: ClazzType<T>,
    data: UpdateData<T>,
    options: { where: WhereClause<T> },
  ): Promise<{ affected: number }>;

  abstract withTenant<R>(
    tenantId: string,
    callback: (em: this) => Promise<R>,
  ): Promise<R>;

  /**
   * Creates a new QueryBuilder instance with the database type auto-configured.
   */
  abstract createQueryBuilder(): BaseRawQueryBuilder;

  /**
   * Install a plugin on this EntityManager instance.
   * Returns `this` with the plugin's API mixed in for chaining.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abstract extend<TApi extends Record<string, any>>(
    plugin: StingerloomPlugin<TApi>,
  ): this & TApi;

  /**
   * Check if a plugin with the given name is installed.
   */
  abstract hasPlugin(name: string): boolean;
}
