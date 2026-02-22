/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils";
import { FindOption } from "../dialects/FindOption";
import { EntityManager } from "./EntityManager";
import { EntityResult } from "../types/EntityResult";
import { DeleteResult } from "../types/DeleteResult";

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
    private readonly entity: ClazzType<T>,
    private readonly em: EntityManager,
  ) {}

  /**
   * Saves the entity.
   * If the primary key does not exist, a new entity is created.
   *
   * @param item The partial entity to be saved.
   * @returns A promise that resolves to the result of the save operation.
   */
  async save(item: Partial<T>): Promise<EntityResult<T>> {
    return await this.em.save<T>(this.entity, item);
  }

  /**
   * Retrieves entities based on the specified find options.
   *
   * @param findOption The options to find entities.
   * @returns A promise that resolves to the result of the find operation.
   */
  async find(findOption?: FindOption<T>): Promise<EntityResult<T>> {
    return await this.em.find<T>(this.entity, findOption);
  }

  /**
   * Retrieves a single entity with the specified conditions.
   *
   * @param findOption Specifies the conditions for the entity to be retrieved.
   * @returns A promise that resolves to the result of the findOne operation.
   */
  async findOne(findOption: FindOption<T>): Promise<EntityResult<T>> {
    return await this.em.findOne<T>(this.entity, findOption);
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
  async delete(criteria: { [K in keyof T]?: T[K] }): Promise<DeleteResult> {
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
  async softDelete(criteria: { [K in keyof T]?: T[K] }): Promise<DeleteResult> {
    return await this.em.softDelete<T>(this.entity, criteria);
  }

  /**
   * Restores soft-deleted entities matching the given criteria.
   * Sets the @DeletedAt column to NULL.
   *
   * @param criteria The conditions to match entities for restoration.
   * @returns A promise that resolves to the number of affected rows.
   */
  async restore(criteria: { [K in keyof T]?: T[K] }): Promise<DeleteResult> {
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
  async deleteMany(ids: any[]): Promise<DeleteResult> {
    return await this.em.deleteMany<T>(this.entity, ids);
  }

  /**
   * Returns the count of entities matching the given conditions.
   */
  async count(where?: { [K in keyof T]?: T[K] }): Promise<number> {
    return await this.em.count<T>(this.entity, where);
  }

  /**
   * Returns the sum of a numeric field for entities matching the given conditions.
   */
  async sum(
    field: keyof T & string,
    where?: { [K in keyof T]?: T[K] },
  ): Promise<number> {
    return await this.em.sum<T>(this.entity, field, where);
  }

  /**
   * Returns the average of a numeric field for entities matching the given conditions.
   */
  async avg(
    field: keyof T & string,
    where?: { [K in keyof T]?: T[K] },
  ): Promise<number> {
    return await this.em.avg<T>(this.entity, field, where);
  }

  /**
   * Returns the minimum value of a field for entities matching the given conditions.
   */
  async min(
    field: keyof T & string,
    where?: { [K in keyof T]?: T[K] },
  ): Promise<number> {
    return await this.em.min<T>(this.entity, field, where);
  }

  /**
   * Returns the maximum value of a field for entities matching the given conditions.
   */
  async max(
    field: keyof T & string,
    where?: { [K in keyof T]?: T[K] },
  ): Promise<number> {
    return await this.em.max<T>(this.entity, field, where);
  }

  /**
   * Persists the entity.
   *
   * @param item The entity to be persisted.
   * @returns A promise that resolves to the result of the persist operation.
   */
  async persist(item: T): Promise<EntityResult<T>> {
    return await this.em.save<T>(this.entity, item);
  }
}
