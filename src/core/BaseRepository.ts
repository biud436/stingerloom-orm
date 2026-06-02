/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils";
import {
  FindOption,
  UpdateData,
  UpdateManyOptions,
  WhereClause,
} from "../dialects/FindOption";
import { EntityManager } from "./EntityManager";
import { DeleteResult } from "../types/DeleteResult";
import { SelectQueryBuilder, isEntityRef } from "./SelectQueryBuilder";
import type { EntityRef } from "./SelectQueryBuilder";
import { UpdateQueryBuilder } from "./UpdateQueryBuilder";
import {
  CursorPaginationOption,
  CursorPaginationResult,
} from "./CursorPagination";
import {
  PagePaginationOption,
  PagePaginationResult,
} from "./PagePagination";
import { ExplainResult } from "./ExplainResult";

/**
 * Handle returned by {@link BaseRepository.relation} for mutating a single
 * owner's slice of a M2M join table. Both methods are idempotent across
 * supported dialects.
 */
export interface RelationHandle<T> {
  /**
   * Insert the (owner, related) pair into the join table. Defaults to
   * `ignoreExisting: true` so re-attaching is a zero-row no-op rather
   * than a duplicate-key error.
   */
  add(
    relatedId: unknown,
    options?: { ignoreExisting?: boolean },
  ): Promise<{ affected: number }>;
  /** Remove the (owner, related) pair. No-op if absent. */
  remove(relatedId: unknown): Promise<{ affected: number }>;
}

/**
 * BaseRepository class provides basic CRUD operations for an entity.
 *
 * @template T The type of the entity.
 */
export class BaseRepository<T> {
  /**
   * Constructs a new BaseRepository instance.
   *
   * @param entity The class type of the entity.
   * @param em The entity manager to handle database operations.
   */
  constructor(
    protected readonly entity: ClazzType<T>,
    protected readonly em: EntityManager,
  ) {}

  /**
   * Saves the entity.
   * If the primary key does not exist, a new entity is created.
   *
   * @param item The partial entity to be saved.
   * @returns A promise that resolves to the result of the save operation.
   */
  async save(item: Partial<T>): Promise<InstanceType<ClazzType<T>>> {
    return await this.em.save<T>(this.entity, item);
  }

  /**
   * Retrieves entities based on the specified find options.
   *
   * @param findOption The options to find entities.
   * @returns A promise that resolves to the result of the find operation.
   */
  async find(findOption?: FindOption<T>): Promise<T[]> {
    return await this.em.find<T>(this.entity, findOption);
  }

  /**
   * Retrieves all entities matching `where`. Filter-first shorthand for
   * `find({ where })`. See {@link EntityManager.findBy}.
   *
   * @param where The filter selecting rows.
   * @returns A promise that resolves to the matching entities.
   */
  async findBy(where: WhereClause<T> | WhereClause<T>[]): Promise<T[]> {
    return await this.em.findBy<T>(this.entity, where);
  }

  /**
   * Retrieves a single entity with the specified conditions.
   *
   * @param findOption Specifies the conditions for the entity to be retrieved.
   * @returns A promise that resolves to the result of the findOne operation.
   */
  async findOne(findOption: FindOption<T>): Promise<T | null> {
    return await this.em.findOne<T>(this.entity, findOption);
  }

  /**
   * Retrieves a single entity matching `where`. Filter-first shorthand for
   * `findOne({ where })`. See {@link EntityManager.findOneBy}.
   *
   * @param where The filter selecting the row.
   * @returns A promise that resolves to the matching entity or `null`.
   */
  async findOneBy(where: WhereClause<T> | WhereClause<T>[]): Promise<T | null> {
    return await this.em.findOneBy<T>(this.entity, where);
  }

  /**
   * Retrieves a single entity or throws EntityNotFoundError.
   *
   * @param findOption Specifies the conditions for the entity to be retrieved.
   * @returns A promise that resolves to the found entity.
   * @throws EntityNotFoundError if no entity matches.
   */
  async findOneOrFail(findOption: FindOption<T>): Promise<T> {
    return await this.em.findOneOrFail<T>(this.entity, findOption);
  }

  /**
   * Retrieves entities using cursor-based pagination.
   *
   * @param option Cursor pagination options.
   * @returns A promise that resolves to the paginated result.
   */
  async findWithCursor(
    option?: CursorPaginationOption<T>,
  ): Promise<CursorPaginationResult<T>> {
    return await this.em.findWithCursor<T>(this.entity, option);
  }

  /**
   * Retrieves entities using offset-based page pagination.
   *
   * @param option Page pagination options.
   * @returns A promise that resolves to the paginated result.
   */
  async findWithPage(
    option?: PagePaginationOption<T>,
  ): Promise<PagePaginationResult<T>> {
    return await this.em.findWithPage<T>(this.entity, option);
  }

  /**
   * Retrieves entities and total count matching the given find options.
   * The count ignores take/limit and returns the total number of matching entities.
   *
   * @param findOption The options to find entities.
   * @returns A promise that resolves to a tuple of [entities, totalCount].
   */
  async findAndCount(findOption?: FindOption<T>): Promise<[T[], number]> {
    return await this.em.findAndCount<T>(this.entity, findOption);
  }

  /**
   * Returns an AsyncGenerator that yields entities in batches.
   * Suitable for processing large datasets without loading all rows into memory.
   */
  async *stream(options?: FindOption<T>, batchSize?: number): AsyncGenerator<T, void, undefined> {
    yield* this.em.stream<T>(this.entity, options, batchSize);
  }

  /**
   * Returns an AsyncGenerator that yields arrays of entities in batches.
   * Each yielded value is T[] (a full batch), suitable for batch processing.
   */
  async *streamBatch(options?: FindOption<T>, batchSize?: number): AsyncGenerator<T[], void, undefined> {
    yield* this.em.streamBatch<T>(this.entity, options, batchSize);
  }

  /**
   * Creates a new instance of BaseRepository for the specified entity and entity manager.
   *
   * @param entity The class type of the entity.
   * @param em The entity manager to handle database operations.
   * @returns A new instance of BaseRepository.
   */
  static of<T>(entity: ClazzType<T>, em: EntityManager): BaseRepository<T> {
    return new BaseRepository(entity, em);
  }

  /**
   * Deletes entities matching the given criteria.
   *
   * @param criteria The conditions to match entities for deletion.
   * @returns A promise that resolves to the number of affected rows.
   */
  async delete(criteria: WhereClause<T>): Promise<DeleteResult> {
    return await this.em.delete<T>(this.entity, criteria);
  }

  /**
   * Removes a specific entity instance from the database using its primary key.
   *
   * @param item The entity instance to be removed.
   * @returns A promise that resolves to the number of affected rows.
   */
  async remove(item: T): Promise<DeleteResult> {
    return await this.em.delete<T>(this.entity, item as any);
  }

  /**
   * Soft deletes entities matching the given criteria.
   * Sets the @DeletedAt column to the current timestamp.
   *
   * @param criteria The conditions to match entities for soft deletion.
   * @returns A promise that resolves to the number of affected rows.
   */
  async softDelete(criteria: WhereClause<T>): Promise<DeleteResult> {
    return await this.em.softDelete<T>(this.entity, criteria);
  }

  /**
   * Restores soft-deleted entities matching the given criteria.
   * Sets the @DeletedAt column to NULL.
   *
   * @param criteria The conditions to match entities for restoration.
   * @returns A promise that resolves to the number of affected rows.
   */
  async restore(criteria: WhereClause<T>): Promise<DeleteResult> {
    return await this.em.restore<T>(this.entity, criteria);
  }

  /**
   * Saves multiple entities in a single transaction.
   * Each item is inserted (if no PK) or updated (if PK exists).
   *
   * @param items The partial entities to be saved.
   * @returns A promise that resolves to an array of saved entities.
   */
  async saveMany(
    items: Partial<T>[],
  ): Promise<InstanceType<ClazzType<T>>[]> {
    return await this.em.saveMany<T>(this.entity, items);
  }

  /**
   * Inserts multiple entities using a single optimized INSERT query.
   *
   * @param items The partial entities to be inserted.
   * @returns A promise that resolves to the number of affected rows.
   */
  async insertMany(items: Partial<T>[]): Promise<{ affected: number }> {
    return await this.em.insertMany<T>(this.entity, items);
  }

  /**
   * Deletes multiple entities by their primary key values using a single query.
   *
   * @param ids The primary key values of entities to delete.
   * @returns A promise that resolves to the number of affected rows.
   */
  async deleteMany(ids: unknown[]): Promise<DeleteResult> {
    return await this.em.deleteMany<T>(this.entity, ids);
  }

  /**
   * Removes all rows from the entity table (TRUNCATE or DELETE FROM).
   */
  async clear(): Promise<void> {
    return await this.em.clear<T>(this.entity);
  }

  /**
   * Returns true if at least one entity matches the given where clause.
   */
  async exists(where?: WhereClause<T>, withDeleted?: boolean): Promise<boolean> {
    return await this.em.exists<T>(this.entity, where, withDeleted);
  }

  /**
   * Finds a single entity by its primary key value.
   * For composite PKs, pass an object with PK field names as keys.
   */
  async findByPK(id: unknown): Promise<T | null> {
    return await this.em.findByPK<T>(this.entity, id);
  }

  /**
   * Finds multiple entities by their primary key values.
   */
  async findByPKs(ids: unknown[]): Promise<T[]> {
    return await this.em.findByPKs<T>(this.entity, ids);
  }

  /**
   * Returns the count of entities matching the given conditions.
   */
  async count(where?: WhereClause<T>, withDeleted?: boolean): Promise<number> {
    return await this.em.count<T>(this.entity, where, withDeleted);
  }

  /**
   * Returns the sum of a numeric field for entities matching the given conditions.
   */
  async sum(
    field: keyof T & string,
    where?: WhereClause<T>,
    withDeleted?: boolean,
  ): Promise<number> {
    return await this.em.sum<T>(this.entity, field, where, withDeleted);
  }

  /**
   * Returns the average of a numeric field for entities matching the given conditions.
   */
  async avg(
    field: keyof T & string,
    where?: WhereClause<T>,
    withDeleted?: boolean,
  ): Promise<number> {
    return await this.em.avg<T>(this.entity, field, where, withDeleted);
  }

  /**
   * Returns the minimum value of a field for entities matching the given conditions.
   */
  async min(
    field: keyof T & string,
    where?: WhereClause<T>,
    withDeleted?: boolean,
  ): Promise<number> {
    return await this.em.min<T>(this.entity, field, where, withDeleted);
  }

  /**
   * Returns the maximum value of a field for entities matching the given conditions.
   */
  async max(
    field: keyof T & string,
    where?: WhereClause<T>,
    withDeleted?: boolean,
  ): Promise<number> {
    return await this.em.max<T>(this.entity, field, where, withDeleted);
  }

  /**
   * Executes EXPLAIN on the SELECT query for the given find options.
   *
   * @param findOption The find options that would generate the SELECT query.
   * @returns A promise that resolves to the ExplainResult.
   */
  async explain(findOption?: FindOption<T>): Promise<ExplainResult> {
    return await this.em.explain<T>(this.entity, findOption);
  }

  /**
   * Updates rows matching `where` with `data`.
   *
   * Ergonomic single-call form of {@link updateMany} with the filter first —
   * mirroring `delete(criteria)`. See {@link EntityManager.update}.
   *
   * @param where The filter selecting rows to update (required, non-empty).
   * @param data The partial data to set on matching rows.
   * @returns `{ affected }` — the number of rows updated.
   */
  async update(
    where: WhereClause<T>,
    data: UpdateData<T>,
  ): Promise<{ affected: number }> {
    return await this.em.update<T>(this.entity, where, data);
  }

  /**
   * Updates multiple entities matching the WHERE condition with the given data.
   *
   * Supports `orderBy` + `limit` for capped, ordered updates. See
   * `EntityManager.updateMany` for dialect-specific behavior.
   *
   * @param data The partial data to set on matching rows.
   * @param options `where` (required) plus optional `orderBy` and `limit`.
   * @returns The number of affected rows.
   */
  async updateMany(
    data: UpdateData<T>,
    options: UpdateManyOptions<T>,
  ): Promise<{ affected: number }> {
    return await this.em.updateMany<T>(this.entity, data, options);
  }

  /**
   * Inserts or updates an entity based on conflict columns (UPSERT).
   * If conflictColumns is not provided, primary key columns are used.
   *
   * @param data The partial entity data to upsert.
   * @param conflictColumns The columns to detect conflicts on.
   */
  async upsert(
    data: Partial<T>,
    conflictColumns?: string[],
  ): Promise<void> {
    return await this.em.upsert<T>(this.entity, data, conflictColumns);
  }

  /**
   * Idempotent insert: writes the row if it does not collide on the
   * primary key (or `conflictColumns`), otherwise no-op.
   *
   * Dialect-portable wrapper over `INSERT IGNORE` (MySQL/MariaDB) and
   * `INSERT … ON CONFLICT DO NOTHING` (PostgreSQL/SQLite).
   */
  async insertIgnore(
    data: Partial<T>,
    conflictColumns?: string[],
  ): Promise<{ affected: number }> {
    return await this.em.insertIgnore<T>(this.entity, data, conflictColumns);
  }

  /**
   * Batch upsert: inserts or updates multiple entities in a single query.
   * Uses multi-row VALUES with ON CONFLICT / ON DUPLICATE KEY UPDATE.
   *
   * @param items The array of partial entity data to upsert.
   * @param conflictColumns The columns to detect conflicts on.
   */
  async batchUpsert(
    items: Partial<T>[],
    conflictColumns?: string[],
  ): Promise<void> {
    return await this.em.batchUpsert<T>(this.entity, items, conflictColumns);
  }

  /**
   * Returns a typed handle for mutating a M2M join table on this entity.
   *
   * Removes the need to hand-roll dialect-specific `INSERT IGNORE` /
   * `ON CONFLICT DO NOTHING` SQL when adding/removing rows in the join
   * table — the helper picks the right spelling per dialect.
   *
   * @example
   * ```ts
   * const r = issueRepo.relation(issueId, "labels");
   * await r.add(labelId);          // idempotent: no error if pair exists
   * await r.remove(labelId);       // idempotent: no error if pair missing
   * ```
   */
  relation(ownerId: unknown, propertyKey: keyof T & string): RelationHandle<T> {
    return {
      add: (relatedId, options) =>
        this.em.attachRelation<T>(
          this.entity,
          ownerId,
          propertyKey,
          relatedId,
          options,
        ),
      remove: (relatedId) =>
        this.em.detachRelation<T>(
          this.entity,
          ownerId,
          propertyKey,
          relatedId,
        ),
    };
  }

  /**
   * Persists the entity.
   *
   * @param item The entity to be persisted.
   * @returns A promise that resolves to the result of the persist operation.
   */
  async persist(item: T): Promise<InstanceType<ClazzType<T>>> {
    return await this.em.save<T>(this.entity, item);
  }

  /**
   * Creates a type-safe SelectQueryBuilder for this entity.
   * Column references enjoy `keyof T` auto-completion.
   *
   * @param alias Table alias used in the generated SQL.
   * @returns A new SelectQueryBuilder instance.
   *
   * @example
   * ```ts
   * const users = await userRepo
   *   .createQueryBuilder("u")
   *   .select(["id", "name"])
   *   .where("status", "active")
   *   .orderBy({ createdAt: "DESC" })
   *   .limit(10)
   *   .getMany();
   * ```
   */
  createQueryBuilder(alias: string): SelectQueryBuilder<T, T>;
  createQueryBuilder(ref: EntityRef<T>): SelectQueryBuilder<T, T>;
  createQueryBuilder(aliasOrRef: string | EntityRef<T>): SelectQueryBuilder<T, T> {
    if (isEntityRef(aliasOrRef)) {
      return this.em.createQueryBuilder<T>(aliasOrRef);
    }
    return this.em.createQueryBuilder<T>(this.entity, aliasOrRef);
  }

  /**
   * Creates a type-safe `UpdateQueryBuilder` for this entity. Mirrors the
   * SELECT-side `createQueryBuilder` so a service that already has the
   * repository injected does not need to also inject `EntityManager` to
   * issue `UPDATE … ORDER BY … LIMIT n` queries.
   *
   * @param aliasOrRef Either a string alias (e.g. `"i"`) or a `qAlias()` ref.
   * @returns A new `UpdateQueryBuilder<T>` bound to this repository's entity.
   *
   * @example
   * ```ts
   * const i = qAlias(Issue, "i");
   * await issueRepo.createUpdateBuilder(i)
   *   .set({ claimedBy: workerId })
   *   .where(i.status.eq("TODO"))
   *   .orderBy(i.priority.asc())
   *   .limit(1)
   *   .execute();
   * ```
   */
  createUpdateBuilder(alias?: string): UpdateQueryBuilder<T>;
  createUpdateBuilder(ref: EntityRef<T>): UpdateQueryBuilder<T>;
  createUpdateBuilder(
    aliasOrRef?: string | EntityRef<T>,
  ): UpdateQueryBuilder<T> {
    if (aliasOrRef !== undefined && isEntityRef(aliasOrRef)) {
      return this.em.createUpdateBuilder<T>(aliasOrRef);
    }
    return this.em.createUpdateBuilder<T>(this.entity, aliasOrRef as string | undefined);
  }
}
