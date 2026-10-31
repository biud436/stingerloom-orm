/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { raw, Sql } from "../../utils/sqlTag";
import { ClazzType } from "../../utils";
import { EntityManagerInternals } from "../EntityManagerInternals";
import { RelationMetadataResolver } from "../RelationMetadataResolver";
import { DmlSqlBuilder } from "./DmlSqlBuilder";
import { InvalidQueryError } from "../../errors/InvalidQueryError";
import { EntityNotFoundError } from "../../errors/EntityNotFoundError";
import { TransactionSessionManager } from "../../dialects/TransactionSessionManager";
import { bindParam, resultRows } from "./entity-access";

/**
 * Executes @ManyToMany relationship management (join-table attach/detach) for
 * EntityManager. Reads dialect/identifier helpers from {@link EntityManagerInternals}.
 *
 * Under `tenant_column` the join table has no tenant column of its own; a
 * link belongs to the tenant that owns both of its rows. Both writes check
 * the two ids against the active tenant before touching the join table.
 *
 * @internal Package-internal — not a public API.
 */
export class RelationExecutor {
  private readonly dmlSqlBuilder: DmlSqlBuilder;

  constructor(private readonly ctx: EntityManagerInternals) {
    this.dmlSqlBuilder = new DmlSqlBuilder(ctx);
  }

  private get resolver(): RelationMetadataResolver {
    return this.ctx.getResolver();
  }

  async attachRelation<T>(
    entity: ClazzType<T>,
    ownerId: unknown,
    propertyKey: keyof T & string,
    relatedId: unknown,
    options: { ignoreExisting?: boolean } = {},
  ): Promise<{ affected: number }> {
    const ignoreExisting = options.ignoreExisting !== false;
    const join = this.resolveJoinTableForRelation(entity, propertyKey);

    const tableName = this.ctx.wrapTable(join.tableName);
    const ownerCol = this.ctx.wrap(join.ownerColumn);
    const relatedCol = this.ctx.wrap(join.relatedColumn);

    return this.ctx.executeInTransaction(async (session) => {
      for (const [target, id] of [
        [entity, ownerId],
        [join.relatedEntity, relatedId],
      ] as const) {
        if (!(await this.isVisibleToTenant(target, id, session))) {
          throw new EntityNotFoundError(
            target.name,
            `attachRelation() found no row with primary key ${String(id)} in the active tenant, so "${entity.name}.${propertyKey}" was not linked.`,
          );
        }
      }
      const insertSql = ignoreExisting
        ? this.dmlSqlBuilder.buildInsertIgnoreJoinTableSql(
            tableName,
            ownerCol,
            relatedCol,
            ownerId,
            relatedId,
          )
        : sql`INSERT INTO ${raw(tableName)} (${raw(ownerCol)}, ${raw(relatedCol)}) VALUES (${ownerId as any}, ${relatedId as any})`;
      const queryResult: any = await session.query(insertSql);
      const affected = this.ctx.isMySqlFamily()
        ? (queryResult?.results?.affectedRows ?? 0)
        : (queryResult?.rowCount ?? 0);
      return { affected };
    });
  }

  /**
   * Delete the row in the M2M join table linking `ownerId` to `relatedId`.
   * Idempotent — deleting a non-existent pair returns `{ affected: 0 }`, as
   * does a pair with a row the active tenant cannot see.
   */
  async detachRelation<T>(
    entity: ClazzType<T>,
    ownerId: unknown,
    propertyKey: keyof T & string,
    relatedId: unknown,
  ): Promise<{ affected: number }> {
    const join = this.resolveJoinTableForRelation(entity, propertyKey);

    const tableName = this.ctx.wrapTable(join.tableName);
    const ownerCol = this.ctx.wrap(join.ownerColumn);
    const relatedCol = this.ctx.wrap(join.relatedColumn);

    return this.ctx.executeInTransaction(async (session) => {
      if (
        !(await this.isVisibleToTenant(entity, ownerId, session)) ||
        !(await this.isVisibleToTenant(join.relatedEntity, relatedId, session))
      ) {
        return { affected: 0 };
      }
      const deleteSql = sql`DELETE FROM ${raw(tableName)} WHERE ${raw(ownerCol)} = ${ownerId as any} AND ${raw(relatedCol)} = ${relatedId as any}`;
      const queryResult: any = await session.query(deleteSql);
      const affected = this.ctx.isMySqlFamily()
        ? (queryResult?.results?.affectedRows ?? 0)
        : (queryResult?.rowCount ?? 0);
      return { affected };
    });
  }

  /**
   * Whether the row of `entity` with primary key `id` belongs to the active
   * tenant — the predicate `find()` scopes `entity` by, so the missing-context
   * policy, `@NonTenantEntity()` and a JOINED child's root-held tenant column
   * apply alike. True when no predicate applies (another strategy, an
   * unscoped or `"public"` context). A join column always references the
   * primary key.
   */
  private async isVisibleToTenant(
    entity: ClazzType<any>,
    id: unknown,
    session: TransactionSessionManager,
  ): Promise<boolean> {
    const tenantWhere: Sql | null = this.ctx.buildTenantWhereClause(entity);
    if (!tenantWhere) return true;
    const metadata = this.resolver.resolveEntityMetadata(entity);
    const pk = metadata?.columns.find((column) => column.options?.primary);
    if (!metadata || !pk) return true;
    const probe = sql`SELECT 1 FROM ${raw(this.ctx.wrapTable(metadata.name))} WHERE ${raw(this.ctx.wrap(pk.name))} = ${bindParam(id)} AND ${tenantWhere} LIMIT 1`;
    return resultRows(await session.query(probe)).length > 0;
  }

  /**
   * @internal Resolve the join-table descriptor for a M2M property,
   * normalizing owning-side (`joinTable`) and inverse-side (`mappedBy`)
   * declarations to the same shape: `{ tableName, ownerColumn, relatedColumn }`,
   * where `ownerColumn` is the FK back to `entity` and `relatedColumn`
   * points at `relatedEntity`, the other side.
   */
  private resolveJoinTableForRelation<T>(
    entity: ClazzType<T>,
    propertyKey: keyof T & string,
  ): {
    tableName: string;
    ownerColumn: string;
    relatedColumn: string;
    relatedEntity: ClazzType<any>;
  } {
    const relations = this.resolver.resolveManyToManyMetadata(entity);
    const meta = relations.find((r) => r.propertyKey === propertyKey);
    if (!meta) {
      throw new InvalidQueryError(
        `attachRelation/detachRelation: "${entity.name}.${propertyKey}" is not a @ManyToMany relation`,
      );
    }

    const relatedEntity = meta.getRelatedEntity() as ClazzType<any>;
    if (meta.joinTable) {
      return {
        tableName: meta.joinTable.name,
        ownerColumn: meta.joinTable.joinColumn,
        relatedColumn: meta.joinTable.inverseJoinColumn,
        relatedEntity,
      };
    }

    if (meta.mappedBy) {
      const inverseEntity = relatedEntity;
      const inverseRelations =
        this.resolver.resolveManyToManyMetadata(inverseEntity);
      const owning = inverseRelations.find(
        (r) => r.propertyKey === meta.mappedBy && r.joinTable,
      );
      if (!owning?.joinTable) {
        throw new InvalidQueryError(
          `attachRelation/detachRelation: "${entity.name}.${propertyKey}" is the inverse side of a @ManyToMany but the owning side "${inverseEntity.name}.${meta.mappedBy}" does not declare \`joinTable\``,
        );
      }
      // The owning side names the columns from its own perspective; from
      // the inverse side, the FK back to `entity` is `inverseJoinColumn`.
      return {
        tableName: owning.joinTable.name,
        ownerColumn: owning.joinTable.inverseJoinColumn,
        relatedColumn: owning.joinTable.joinColumn,
        relatedEntity,
      };
    }

    throw new InvalidQueryError(
      `attachRelation/detachRelation: "${entity.name}.${propertyKey}" has no \`joinTable\` or \`mappedBy\` configured`,
    );
  }
}
