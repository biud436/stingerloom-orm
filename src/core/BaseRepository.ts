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
   * Persists the entity.
   *
   * @param item The entity to be persisted.
   * @returns A promise that resolves to the result of the persist operation.
   */
  async persist(item: T): Promise<EntityResult<T>> {
    return await this.em.save<T>(this.entity, item);
  }
}
