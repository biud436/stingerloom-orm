/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../utils";
import { DeepPartial } from "../../types/DeepPartial";
import { WhereClause } from "../../dialects/FindOption";
import { ColumnMetadata } from "../../scanner";
import { DeserializerRegistry } from "../deserializer/DeserializerRegistry";
import { EntityManagerInternals } from "../EntityManagerInternals";
import { EntityMetadataNotFoundError } from "../../errors/EntityMetadataNotFoundError";
import { InvalidQueryError } from "../../errors/InvalidQueryError";

type Instance<T> = InstanceType<ClazzType<T>>;

/**
 * Returns true for values that {@link EntityFactory.merge} should recurse into
 * (deep-merge) rather than replace wholesale.
 *
 * Plain objects and class instances qualify so that a partial patch fills in
 * fields of an existing nested relation without clobbering its siblings.
 * Arrays, `Date`s, and `Buffer`s are treated as opaque leaf values and are
 * replaced as a unit — a partial array/date merge would be surprising.
 */
function isMergeableObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Date) return false;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return false;
  return true;
}

/**
 * Recursively assigns own enumerable keys of `source` onto `target`.
 *
 * `undefined` source values are skipped (they never null out an existing
 * field); an explicit `null` is assigned. When both sides of a key are
 * mergeable objects the merge recurses; otherwise the source value replaces.
 */
function deepAssign(target: any, source: any): void {
  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    if (sourceValue === undefined) continue;
    const targetValue = target[key];
    if (isMergeableObject(sourceValue) && isMergeableObject(targetValue)) {
      deepAssign(targetValue, sourceValue);
    } else {
      target[key] = sourceValue;
    }
  }
}

/**
 * Entity construction / hydration helpers for {@link EntityManager}.
 *
 * These methods never touch the database except {@link EntityFactory.preload},
 * which issues a single primary-key read. None of them persist: they build,
 * combine, or prepare entity instances that the caller later hands to
 * `save()`. This keeps the immediate-execution model intact — there is no
 * hidden unit-of-work or change tracking.
 */
export class EntityFactory {
  constructor(private readonly ctx: EntityManagerInternals) {}

  create<T>(entity: ClazzType<T>): Instance<T>;
  create<T>(entity: ClazzType<T>, data: DeepPartial<T>): Instance<T>;
  create<T>(entity: ClazzType<T>, data: DeepPartial<T>[]): Instance<T>[];
  create<T>(
    entity: ClazzType<T>,
    data?: DeepPartial<T> | DeepPartial<T>[],
  ): Instance<T> | Instance<T>[] {
    if (Array.isArray(data)) {
      return data.map((item) => this.hydrate(entity, item));
    }
    return this.hydrate(entity, data);
  }

  private hydrate<T>(
    entity: ClazzType<T>,
    data: DeepPartial<T> | undefined,
  ): Instance<T> {
    return DeserializerRegistry.getInstance().deserialize(
      entity as any,
      (data ?? {}) as any,
    ) as Instance<T>;
  }

  merge<T>(target: T, ...sources: DeepPartial<T>[]): T {
    for (const source of sources) {
      if (source === undefined || source === null) continue;
      deepAssign(target, source);
    }
    return target;
  }

  async preload<T>(
    entity: ClazzType<T>,
    partial: DeepPartial<T>,
  ): Promise<Instance<T> | undefined> {
    const metadata = this.ctx.getResolver().resolveEntityMetadata(entity);
    if (!metadata) throw new EntityMetadataNotFoundError(entity.name);

    const pkColumns = metadata.columns.filter(
      (col: ColumnMetadata) => col.options?.primary,
    );
    if (pkColumns.length === 0) {
      throw new InvalidQueryError(
        `Entity "${metadata.name}" has no primary key.`,
        "Add @PrimaryGeneratedColumn() or @PrimaryColumn() to your entity.",
      );
    }

    // A full primary key is required to locate the row. If any PK component is
    // absent, there is nothing to preload onto — mirror TypeORM and return
    // undefined rather than issuing a bogus query.
    const where: Record<string, unknown> = {};
    for (const col of pkColumns) {
      const prop = this.ctx.propKey(col);
      const value = (partial as any)[prop];
      if (value === undefined || value === null) return undefined;
      where[prop] = value;
    }

    const existing = await this.ctx.findOne<T>(entity, {
      where: where as WhereClause<T>,
    });
    if (!existing) return undefined;

    return this.merge(existing as Instance<T>, partial as DeepPartial<Instance<T>>);
  }
}
