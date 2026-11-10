/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../utils";
import { COLUMN_TOKEN } from "../../decorators/Column";
import { ColumnMetadata } from "../../scanner/ColumnScanner";
import type { ManyToOneMetadata } from "../../decorators/ManyToOne";
import type { OneToOneMetadata } from "../../decorators/OneToOne";
import {
  RELATION_COLUMN_TOKEN,
  RelationColumnMetadata,
} from "../../decorators/RelationColumn";
import type { CreateTableForeignKey } from "../../dialects/SqlDriver";
import { InheritanceResolver } from "../InheritanceResolver";
import { RelationMetadataResolver } from "../RelationMetadataResolver";
import type { NamingStrategy } from "./NamingStrategy";

/** A relation whose join column a table holds, and the class declaring it. */
export interface TableRelation<R> {
  relation: R;
  declaredBy: ClazzType<any>;
  /** A SINGLE_TABLE child's relation on the shared table: always nullable. */
  shared: boolean;
}

/** A foreign key of a table, with the entity whose table it references. */
export interface TableForeignKey extends CreateTableForeignKey {
  referencedEntity: ClazzType<any>;
}

/** A join column a relation needs that no entity column declares. */
export interface JoinColumnDef {
  name: string;
  options: { type: any; length?: number; nullable: boolean };
}

const inheritance = new InheritanceResolver();

let sharedResolver: RelationMetadataResolver | undefined;

/** The resolver the DDL-string generators share; they have no EntityManager. */
export function generatorRelationResolver(): RelationMetadataResolver {
  sharedResolver ??= new RelationMetadataResolver();
  return sharedResolver;
}

/**
 * The ManyToOne and OneToOne relations whose join columns live on `entity`'s
 * table, each with the class that declares it. A JOINED child's table holds
 * only the relations the child declares — the root's join columns are on the
 * root's table. A SINGLE_TABLE root's table also holds every child's
 * (`shared`: nullable whatever the relation says, since a row of one subtype
 * leaves the others' join columns empty).
 */
export function collectTableRelations(
  entity: ClazzType<any>,
  resolver: RelationMetadataResolver,
): {
  manyToOnes: Array<TableRelation<ManyToOneMetadata<any>>>;
  oneToOnes: Array<TableRelation<OneToOneMetadata<any>>>;
} {
  const own = (target: ClazzType<any>, shared: boolean) => ({
    manyToOnes: resolver
      .resolveManyToOneMetadata(target)
      .map((relation) => ({ relation, declaredBy: target, shared })),
    oneToOnes: resolver
      .resolveOneToOneMetadata(target)
      .map((relation) => ({ relation, declaredBy: target, shared })),
  });
  const result = own(entity, false);

  const strategy = inheritance.getStrategy(entity);
  const root = inheritance.getRoot(entity);
  if (!root) return result;
  const rootM2o = new Set(
    resolver.resolveManyToOneMetadata(root).map((r) => r.columnName),
  );
  const rootO2o = new Set(
    resolver.resolveOneToOneMetadata(root).map((r) => r.propertyKey),
  );

  if (strategy === "JOINED" && root !== entity) {
    return {
      manyToOnes: result.manyToOnes.filter(
        (r) => !rootM2o.has(r.relation.columnName),
      ),
      oneToOnes: result.oneToOnes.filter(
        (r) => !rootO2o.has(r.relation.propertyKey),
      ),
    };
  }

  if (strategy === "SINGLE_TABLE" && root === entity) {
    const joinColumns = new Set(
      [...result.manyToOnes, ...result.oneToOnes]
        .map((r) => r.relation.joinColumn)
        .filter((c): c is string => !!c),
    );
    const isNew = (joinColumn?: string) => {
      if (!joinColumn || joinColumns.has(joinColumn)) return false;
      joinColumns.add(joinColumn);
      return true;
    };
    for (const child of inheritance.getConcreteEntities(root)) {
      if (child === root) continue;
      const childRelations = own(child, true);
      for (const r of childRelations.manyToOnes) {
        if (!rootM2o.has(r.relation.columnName) && isNew(r.relation.joinColumn)) {
          result.manyToOnes.push(r);
        }
      }
      for (const r of childRelations.oneToOnes) {
        if (!rootO2o.has(r.relation.propertyKey) && isNew(r.relation.joinColumn)) {
          result.oneToOnes.push(r);
        }
      }
    }
  }
  return result;
}

/**
 * Builds a column definition for a join column that has no explicit entity
 * column, typed after the referenced entity's PK (#284) and nullable unless
 * the relation's `@RelationColumn` says otherwise.
 */
export function buildJoinColumnDef(
  joinColumn: string,
  referencedEntity: ClazzType<any>,
  owningEntity?: ClazzType<any>,
): JoinColumnDef {
  const columns = (Reflect.getMetadata(
    COLUMN_TOKEN,
    referencedEntity.prototype,
  ) ?? []) as ColumnMetadata[];
  const pkCol = columns.find((c) => c.options?.primary);

  // An explicit @RelationColumn wins over the inferred target-PK shape: it
  // is the only place the FK column's own type and NOT NULL live.
  const declared = owningEntity
    ? ((Reflect.getMetadata(RELATION_COLUMN_TOKEN, owningEntity) ??
        Reflect.getMetadata(RELATION_COLUMN_TOKEN, owningEntity.prototype) ??
        []) as RelationColumnMetadata[]).find(
        (rc) => (rc.name ?? `${rc.propertyKey}Id`) === joinColumn,
      )
    : undefined;

  return {
    name: joinColumn,
    options: {
      type: declared?.type ?? pkCol?.options?.type ?? "int",
      length: pkCol?.options?.length,
      nullable: declared?.nullable ?? true,
    },
  };
}

export interface TableForeignKeyEnv {
  resolver: RelationMetadataResolver;
  namingStrategy: NamingStrategy;
  /** Table name of an entity whose metadata carries none. */
  tableNameOf?: (entity: ClazzType<any>) => string;
}

/**
 * The foreign keys of `entity`'s table and the join columns they need that
 * are not among `columns` — the one reading synchronize, the schema diff and
 * migrate:generate all create a table from. They used to read relations
 * separately, so a `joinColumn` option produced a column at boot and none in
 * a generated migration.
 *
 * A relation that opts out of the constraint
 * (`createForeignKeyConstraints: false`) still contributes its column: the
 * value is stored either way. A relation with no resolvable join column or
 * target is skipped here; synchronize reports it when it registers the keys.
 */
export function collectTableForeignKeys(
  entity: ClazzType<any>,
  tableName: string,
  columns: ReadonlyArray<{
    name?: string;
    propertyKey?: string;
    options?: { primary?: boolean };
  }>,
  env: TableForeignKeyEnv,
): { foreignKeys: TableForeignKey[]; extraColumns: JoinColumnDef[] } {
  const { resolver, namingStrategy } = env;
  const tableNameOf = env.tableNameOf ?? ((target: ClazzType<any>) => target.name);
  const foreignKeys: TableForeignKey[] = [];
  const extraColumns: JoinColumnDef[] = [];
  const existingCols = new Set(
    columns.map((c) => (c.name ?? c.propertyKey ?? "").toLowerCase()),
  );

  const pushJoinColumnIfMissing = (
    joinColumn: string,
    referencedEntity: ClazzType<any>,
    { declaredBy, shared }: Omit<TableRelation<unknown>, "relation">,
  ) => {
    const key = joinColumn.toLowerCase();
    if (existingCols.has(key)) return;
    existingCols.add(key);
    const def = buildJoinColumnDef(joinColumn, referencedEntity, declaredBy);
    if (shared) def.options.nullable = true;
    extraColumns.push(def);
  };

  const { manyToOnes, oneToOnes } = collectTableRelations(entity, resolver);

  const addRelation = (
    owned: Omit<TableRelation<unknown>, "relation">,
    joinColumn: string | undefined,
    referencedEntity: ClazzType<any> | undefined,
    option: ManyToOneMetadata<any>["option"] | OneToOneMetadata<any>["option"],
    references?: string,
  ) => {
    if (!joinColumn || !referencedEntity) return;
    const referencedMeta = resolver.resolveEntityMetadata(referencedEntity);
    if (!referencedMeta) return;
    if (option?.createForeignKeyConstraints === false) {
      pushJoinColumnIfMissing(joinColumn, referencedEntity, owned);
      return;
    }
    const referencedColumn =
      references ??
      referencedMeta.columns.find((c: any) => c.options?.primary)?.name;
    if (!referencedColumn) return;
    const referencedTable = referencedMeta.name || tableNameOf(referencedEntity);
    foreignKeys.push({
      columnName: joinColumn,
      referencedTable,
      referencedColumn,
      referencedEntity,
      constraintName: namingStrategy.foreignKeyName(
        tableName,
        joinColumn,
        referencedTable,
      ),
      onDelete: option?.onDelete,
      onUpdate: option?.onUpdate,
    });
    pushJoinColumnIfMissing(joinColumn, referencedEntity, owned);
  };

  for (const owned of manyToOnes) {
    const rel = owned.relation;
    addRelation(
      owned,
      rel.joinColumn,
      rel.getMappingEntity() as ClazzType<any> | undefined,
      rel.option,
      rel.references,
    );
  }

  // OneToOne: only the owning side has a join column.
  for (const owned of oneToOnes) {
    const rel = owned.relation;
    addRelation(
      owned,
      rel.joinColumn,
      rel.getRelatedEntity() as ClazzType<any> | undefined,
      rel.option,
    );
  }

  // TPT (JOINED) child: PK references the root table's PK.
  if (
    inheritance.isChildEntity(entity) &&
    inheritance.getStrategy(entity) === "JOINED"
  ) {
    const root = inheritance.getRoot(entity);
    const rootMeta = root ? resolver.resolveEntityMetadata(root) : undefined;
    const pk = columns.find((c) => c.options?.primary);
    const rootPk = rootMeta?.columns.find((c: any) => c.options?.primary);
    if (root && pk?.name && rootPk?.name && rootMeta?.name) {
      foreignKeys.push({
        columnName: pk.name,
        referencedTable: rootMeta.name,
        referencedColumn: rootPk.name,
        referencedEntity: root,
        constraintName: namingStrategy.foreignKeyName(
          tableName,
          pk.name,
          rootMeta.name,
        ),
      });
    }
  }

  return { foreignKeys, extraColumns };
}
