/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Sql } from "sql-template-tag";
import sqlTag, { raw as sqlRaw } from "sql-template-tag";
import type { PluginContext } from "../PluginContext";
import type { ClazzType } from "../../../utils/types";
import type { FindOption } from "../../../dialects/FindOption";
import type { DriverQueryOptions } from "../../../types/DriverQueryOptions";
import { ENTITY_TOKEN, type EntityMetadata } from "../../../decorators/Entity";

/**
 * Options for creating a RawPipeline.
 */
export interface RawPipelineOptions<T> extends FindOption<T> {
  /** Number of rows per batch (default: 1000) */
  batchSize?: number;
}

/**
 * A mapped pipeline that yields transformed batches.
 */
export class MappedPipeline<U> {
  constructor(
    private readonly source: RawPipeline<any>,
    private readonly mapFn: (row: Record<string, unknown>) => U,
  ) {}

  /**
   * Yield mapped batches using the raw (non-entity) path.
   */
  async *raw(): AsyncGenerator<U[], void, undefined> {
    for await (const batch of this.source.raw()) {
      yield batch.map(this.mapFn);
    }
  }

  /**
   * Chain another transformation.
   */
  map<V>(fn: (row: U) => V): MappedPipeline<V> {
    const combined = (row: Record<string, unknown>) => fn(this.mapFn(row));
    return new MappedPipeline<V>(this.source, combined);
  }

  /**
   * Filter rows before yielding.
   */
  filter(predicate: (row: U) => boolean): FilteredMappedPipeline<U> {
    return new FilteredMappedPipeline(this.source, this.mapFn, predicate);
  }

  /**
   * Collect all batches into a single array.
   */
  async collect(): Promise<U[]> {
    const all: U[] = [];
    for await (const batch of this.raw()) {
      all.push(...batch);
    }
    return all;
  }
}

/**
 * A filtered + mapped pipeline.
 */
export class FilteredMappedPipeline<U> {
  constructor(
    private readonly source: RawPipeline<any>,
    private readonly mapFn: (row: Record<string, unknown>) => U,
    private readonly predicate: (row: U) => boolean,
  ) {}

  async *raw(): AsyncGenerator<U[], void, undefined> {
    for await (const batch of this.source.raw()) {
      const mapped = batch.map(this.mapFn).filter(this.predicate);
      if (mapped.length > 0) yield mapped;
    }
  }

  async collect(): Promise<U[]> {
    const all: U[] = [];
    for await (const batch of this.raw()) {
      all.push(...batch);
    }
    return all;
  }
}

/**
 * RawPipeline bypasses ORM entity transformation for large-data scenarios.
 *
 * Instead of `em.find()` which creates entity instances for every row,
 * RawPipeline uses `em.query()` (or driver-level `queryWithOptions()`)
 * to return plain objects or raw buffers directly from the database driver.
 *
 * @example
 * ```ts
 * em.extend(rawPipelinePlugin());
 *
 * const pipeline = em.pipe(User, { where: { active: true }, batchSize: 5000 });
 *
 * // Raw objects (no entity transformation)
 * for await (const rows of pipeline.raw()) {
 *   sendToGrpc(rows);
 * }
 *
 * // With transformation chain
 * for await (const rows of pipeline.map(r => ({ id: r.id })).raw()) {
 *   process(rows);
 * }
 * ```
 */
export class RawPipeline<T> {
  private readonly batchSize: number;

  constructor(
    private readonly ctx: PluginContext,
    private readonly entity: ClazzType<T>,
    private readonly options: RawPipelineOptions<T>,
  ) {
    this.batchSize = Math.max(options.batchSize ?? 1000, 1);
  }

  /**
   * Yield batches of plain objects (no entity instantiation).
   * Uses `em.query()` which already bypasses ResultTransformer.
   */
  async *raw(): AsyncGenerator<Record<string, unknown>[], void, undefined> {
    let offset = 0;

    while (true) {
      const query = this.buildQuery(offset);
      const rows = await this.ctx.em.query<Record<string, unknown>>(query);

      if (rows.length === 0) break;

      yield rows;

      if (rows.length < this.batchSize) break;
      offset += this.batchSize;
    }
  }

  /**
   * Yield batches using driver-level options (binary mode, array mode, etc).
   * Falls back to `raw()` if the driver does not support `queryWithOptions`.
   */
  async *binary(
    driverOptions: DriverQueryOptions = { binary: true },
  ): AsyncGenerator<any[], void, undefined> {
    const driver = this.ctx.driver;
    if (!driver?.queryWithOptions) {
      // Fallback: use raw() if driver doesn't support options
      yield* this.raw();
      return;
    }

    let offset = 0;

    while (true) {
      const query = this.buildQuery(offset);
      const rows = await driver.queryWithOptions(query, driverOptions);

      if (!rows || rows.length === 0) break;

      yield rows;

      if (rows.length < this.batchSize) break;
      offset += this.batchSize;
    }
  }

  /**
   * Chain a transformation function on each row.
   */
  map<U>(fn: (row: Record<string, unknown>) => U): MappedPipeline<U> {
    return new MappedPipeline(this, fn);
  }

  /**
   * Filter rows in each batch.
   */
  filter(
    predicate: (row: Record<string, unknown>) => boolean,
  ): MappedPipeline<Record<string, unknown>> {
    const pipeline = new MappedPipeline<Record<string, unknown>>(this, (r) => r);
    return new MappedPipeline<Record<string, unknown>>(
      {
        raw: async function* () {
          for await (const batch of pipeline.raw()) {
            const filtered = batch.filter(predicate);
            if (filtered.length > 0) yield filtered;
          }
        },
      } as any,
      (r) => r,
    );
  }

  /**
   * Collect all batches into a single array (convenience method).
   * Caution: loads all data into memory.
   */
  async collect(): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    for await (const batch of this.raw()) {
      all.push(...batch);
    }
    return all;
  }

  /**
   * Count total rows matching the pipeline's where clause.
   */
  async count(): Promise<number> {
    const tableName = this.resolveTableName();
    const countSql = sqlTag`SELECT COUNT(*) as cnt FROM ${sqlRaw(tableName)}`;
    const result = await this.ctx.em.query<{ cnt: number | string }>(countSql);
    return Number(result[0]?.cnt ?? 0);
  }

  /**
   * Build the SELECT query with LIMIT/OFFSET for batch pagination.
   */
  private buildQuery(offset: number): Sql {
    const tableName = this.resolveTableName();
    const columns = this.resolveColumns();

    const parts: string[] = [`SELECT ${columns} FROM ${tableName}`];
    const values: any[] = [];

    // WHERE
    if (this.options.where) {
      const { clause, params } = this.buildWhereClause(this.options.where);
      if (clause) {
        parts.push(`WHERE ${clause}`);
        values.push(...params);
      }
    }

    // ORDER BY
    if (this.options.orderBy) {
      const orderParts: string[] = [];
      for (const [key, dir] of Object.entries(this.options.orderBy)) {
        const safeDir = dir === "DESC" ? "DESC" : "ASC";
        orderParts.push(`${this.wrapIdentifier(key)} ${safeDir}`);
      }
      if (orderParts.length > 0) {
        parts.push(`ORDER BY ${orderParts.join(", ")}`);
      }
    }

    // LIMIT/OFFSET
    parts.push(`LIMIT ?`);
    values.push(this.batchSize);
    if (offset > 0) {
      parts.push(`OFFSET ?`);
      values.push(offset);
    }

    const text = parts.join(" ");
    return {
      sql: text,
      text,
      values,
      strings: [text],
    } as unknown as Sql;
  }

  private resolveTableName(): string {
    const meta = Reflect.getMetadata(ENTITY_TOKEN, this.entity) as EntityMetadata | undefined;
    const rawName = meta?.name ?? this.entity.name;
    return this.wrapIdentifier(rawName);
  }

  private resolveColumns(): string {
    if (this.options.select && Array.isArray(this.options.select)) {
      return (this.options.select as string[])
        .map((col) => this.wrapIdentifier(col))
        .join(", ");
    }
    return "*";
  }

  private wrapIdentifier(name: string): string {
    return this.ctx.wrap(name);
  }

  private buildWhereClause(where: any): { clause: string; params: any[] } {
    const conditions: string[] = [];
    const params: any[] = [];

    // Handle OR conditions
    if (where.OR && Array.isArray(where.OR)) {
      const orParts: string[] = [];
      for (const orClause of where.OR) {
        const sub = this.buildWhereClause(orClause);
        if (sub.clause) {
          orParts.push(`(${sub.clause})`);
          params.push(...sub.params);
        }
      }
      if (orParts.length > 0) {
        conditions.push(`(${orParts.join(" OR ")})`);
      }
    }

    // Handle AND conditions (implicit from object keys)
    for (const [key, value] of Object.entries(where)) {
      if (key === "OR") continue;

      if (value === null) {
        conditions.push(`${this.wrapIdentifier(key)} IS NULL`);
      } else if (typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
        // Filter operators: { eq, ne, gt, gte, lt, lte, in, like, ... }
        const filter = value as Record<string, any>;
        for (const [op, opValue] of Object.entries(filter)) {
          switch (op) {
            case "eq":
              conditions.push(`${this.wrapIdentifier(key)} = ?`);
              params.push(opValue);
              break;
            case "ne":
              conditions.push(`${this.wrapIdentifier(key)} != ?`);
              params.push(opValue);
              break;
            case "gt":
              conditions.push(`${this.wrapIdentifier(key)} > ?`);
              params.push(opValue);
              break;
            case "gte":
              conditions.push(`${this.wrapIdentifier(key)} >= ?`);
              params.push(opValue);
              break;
            case "lt":
              conditions.push(`${this.wrapIdentifier(key)} < ?`);
              params.push(opValue);
              break;
            case "lte":
              conditions.push(`${this.wrapIdentifier(key)} <= ?`);
              params.push(opValue);
              break;
            case "in":
              if (Array.isArray(opValue) && opValue.length > 0) {
                const placeholders = opValue.map(() => "?").join(", ");
                conditions.push(`${this.wrapIdentifier(key)} IN (${placeholders})`);
                params.push(...opValue);
              }
              break;
            case "notIn":
              if (Array.isArray(opValue) && opValue.length > 0) {
                const placeholders = opValue.map(() => "?").join(", ");
                conditions.push(`${this.wrapIdentifier(key)} NOT IN (${placeholders})`);
                params.push(...opValue);
              }
              break;
            case "like":
              conditions.push(`${this.wrapIdentifier(key)} LIKE ?`);
              params.push(opValue);
              break;
            case "isNull":
              conditions.push(
                opValue
                  ? `${this.wrapIdentifier(key)} IS NULL`
                  : `${this.wrapIdentifier(key)} IS NOT NULL`,
              );
              break;
            case "between":
              if (Array.isArray(opValue) && opValue.length === 2) {
                conditions.push(`${this.wrapIdentifier(key)} BETWEEN ? AND ?`);
                params.push(opValue[0], opValue[1]);
              }
              break;
          }
        }
      } else {
        // Simple equality: { column: value }
        conditions.push(`${this.wrapIdentifier(key)} = ?`);
        params.push(value);
      }
    }

    return {
      clause: conditions.join(" AND "),
      params,
    };
  }
}
