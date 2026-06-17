/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { raw } from "sql-template-tag";
import { ClazzType } from "../../utils";
import { EntityManagerInternals } from "../EntityManagerInternals";
import { RelationMetadataResolver } from "../RelationMetadataResolver";
import { DmlSqlBuilder } from "./DmlSqlBuilder";
import { InvalidQueryError } from "../../errors/InvalidQueryError";

/**
 * Executes @ManyToMany relationship management (join-table attach/detach) for
 * EntityManager. Reads dialect/identifier helpers from {@link EntityManagerInternals}.
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
   * Idempotent — deleting a non-existent pair returns `{ affected: 0 }`.
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
      const deleteSql = sql`DELETE FROM ${raw(tableName)} WHERE ${raw(ownerCol)} = ${ownerId as any} AND ${raw(relatedCol)} = ${relatedId as any}`;
      const queryResult: any = await session.query(deleteSql);
      const affected = this.ctx.isMySqlFamily()
        ? (queryResult?.results?.affectedRows ?? 0)
        : (queryResult?.rowCount ?? 0);
      return { affected };
    });
  }

  /**
   * @internal Resolve the join-table descriptor for a M2M property,
   * normalizing owning-side (`joinTable`) and inverse-side (`mappedBy`)
   * declarations to the same shape: `{ tableName, ownerColumn, relatedColumn }`,
   * where `ownerColumn` is the FK back to `entity` and `relatedColumn`
   * points at the other side.
   */
  private resolveJoinTableForRelation<T>(
    entity: ClazzType<T>,
    propertyKey: keyof T & string,
  ): { tableName: string; ownerColumn: string; relatedColumn: string } {
    const relations = this.resolver.resolveManyToManyMetadata(entity);
    const meta = relations.find((r) => r.propertyKey === propertyKey);
    if (!meta) {
      throw new InvalidQueryError(
        `attachRelation/detachRelation: "${entity.name}.${propertyKey}" is not a @ManyToMany relation`,
      );
    }

    if (meta.joinTable) {
      return {
        tableName: meta.joinTable.name,
        ownerColumn: meta.joinTable.joinColumn,
        relatedColumn: meta.joinTable.inverseJoinColumn,
      };
    }

    if (meta.mappedBy) {
      const inverseEntity = meta.getRelatedEntity() as ClazzType<any>;
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
      };
    }

    throw new InvalidQueryError(
      `attachRelation/detachRelation: "${entity.name}.${propertyKey}" has no \`joinTable\` or \`mappedBy\` configured`,
    );
  }
}
