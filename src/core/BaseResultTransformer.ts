/* eslint-disable @typescript-eslint/no-explicit-any */
import { MyClassConstructor } from "./MyClassConstructor";
import type { QueryResult } from "../types/QueryResult";

export interface BaseResultTransformer {
  /**
   * Convert SQL results into a single entity.
   */
  toEntity<T>(
    entityClass: MyClassConstructor<T>,
    result: QueryResult<any> | undefined,
  ): T | undefined;
  /**
   * Convert SQL results into an entity array.
   */
  toEntities<T>(
    entityClass: MyClassConstructor<T>,
    result: QueryResult<any> | undefined,
  ): T[];
  /**
   * Convert SQL results into an entity or an entity array.
   * Returns undefined when there are no results,
   * a single entity when there is one,
   * and an array when there are multiple.
   */
  transform<T>(
    entityClass: MyClassConstructor<T>,
    result: QueryResult<any> | undefined,
  ): T | T[] | undefined;
  /**
   * Convert SQL results into an entity or an entity array.
   */
  transformNested<T>(
    entityClass: MyClassConstructor<T>,
    result: QueryResult<any> | undefined,
    relations: { [key: string]: MyClassConstructor<any> },
  ): T | T[] | undefined;
}
