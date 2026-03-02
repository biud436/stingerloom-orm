/**
 * 통합 테스트 헬퍼 모듈 인덱스
 */

export {
  createTestConnection,
  getDefaultConnectionOptions,
  dropTestTable,
  truncateTestTable,
  rawQuery,
  resetMetadata,
  type TestConnectionResult,
} from "./test-connection";

export {
  createDynamicEntity,
  createCrudTestEntity,
  generateTableName,
  type DynamicEntityResult,
  type TestColumnDef,
} from "./create-test-entity";

export {
  createOneToManyTestEntities,
  createCascadeRelationEntities,
  type RelatedEntitiesResult,
} from "./create-relation-entity";

export {
  getTestDrivers,
  getMySqlConfig,
  getPostgresConfig,
  type TestDriverType,
  type TestDriverConfig,
} from "./driver-config";

export {
  qi,
  dropTableSql,
  disableFkChecksSql,
  enableFkChecksSql,
  createJoinTableSql,
  createUniqueIndexSql,
  setAutocommitSql,
  hasTableSql,
  getColumnsSql,
  getColumnSql,
  getIndexesSql,
  getForeignKeysSql,
  getPrimaryKeyColumnsSql,
  normalizeColumns,
  normalizeIndexes,
  normalizeForeignKeys,
  type NormalizedColumn,
  type NormalizedIndex,
  type NormalizedForeignKey,
} from "./driver-helpers";
