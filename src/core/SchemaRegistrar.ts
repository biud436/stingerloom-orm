/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { ClazzType, ReflectManager, Logger } from "../utils";
import {
  ColumnMetadata,
  EntityScannerMetadata,
  EntityScanner,
} from "../scanner";
import Container from "typedi";
import { PostgresDriver } from "../dialects/postgres/PostgresDriver";
import { SchemaGenerator } from "./generators/SchemaGenerator";
import { NamingStrategy, DefaultNamingStrategy } from "./generators/NamingStrategy";
import { INDEX_TOKEN, IndexMetadata } from "../decorators/Indexer";
import {
  UNIQUE_INDEX_TOKEN,
  UniqueIndexMetadata,
} from "../decorators/UniqueIndex";
import {
  ENTITY_TOKEN,
  MANY_TO_MANY_TOKEN,
  ManyToManyMetadata,
  COLUMN_TOKEN,
} from "../decorators";
import { EntityMetadataNotFoundError } from "../errors/EntityMetadataNotFoundError";
import { EntityNotFound } from "../dialects/EntityNotFound";
import { InvalidQueryError } from "../errors/InvalidQueryError";
import { PrimaryKeyNotFoundError } from "../errors/PrimaryKeyNotFoundError";
import { RelationMetadataResolver } from "./RelationMetadataResolver";
import { EntityManagerInternals } from "./EntityManagerInternals";

/**
 * 앱 시작 시 1회 실행되는 DDL/스키마 동기화 핸들러.
 * 런타임 CRUD와 무관합니다.
 */
export class SchemaRegistrar {
  private readonly namingStrategy: NamingStrategy;
  private readonly logger = new Logger(SchemaRegistrar.name);

  constructor(
    private readonly resolver: RelationMetadataResolver,
    private readonly ctx: EntityManagerInternals,
    namingStrategy?: NamingStrategy,
  ) {
    this.namingStrategy = namingStrategy ?? new DefaultNamingStrategy();
  }

  async registerEntities() {
    const entityScanner = Container.get(EntityScanner);
    const entities = entityScanner.makeEntities();

    let entity: IteratorResult<EntityScannerMetadata>;

    const syncOption = this.ctx.getSynchronize();
    const synchronize = !!syncOption; // truthy for true, 'safe', 'dry-run'
    const isDryRun = syncOption === "dry-run";

    // PostgreSQL: 스키마가 존재하지 않으면 자동으로 생성합니다.
    if (synchronize && !isDryRun && this.ctx.isPostgres() && this.ctx.getDriver()) {
      const pgDriver = this.ctx.getDriver() as PostgresDriver;
      const hasSchema = await pgDriver.hasSchema();
      if (!hasSchema || hasSchema.length === 0) {
        await pgDriver.createSchema();
        await pgDriver.setSearchPath();
      }
    }

    // 1패스: 모든 테이블을 먼저 생성합니다 (FK 생성 전에 참조 대상 테이블이 존재해야 함).
    const entityList: Array<{
      TargetEntity: ClazzType<any>;
      tableName: string;
      metadata: EntityScannerMetadata;
    }> = [];

    while ((entity = entities.next())) {
      if (entity.done) {
        break;
      }

      const metadata = entity.value as EntityScannerMetadata;
      const TargetEntity = metadata.target as ClazzType<any>;

      // Multi-DB: 이 EntityManager에 속하지 않은 엔티티는 건너뜀
      const scopedEntities = this.ctx.getEntities();
      if (scopedEntities.length > 0 && !scopedEntities.includes(TargetEntity)) {
        continue;
      }

      let tableName = metadata.name;
      if (!tableName) {
        tableName = this.ctx.getNameStrategy(TargetEntity);
      }

      if (!ReflectManager.isEntity(TargetEntity)) {
        throw new EntityMetadataNotFoundError(tableName ?? "Unknown");
      }

      // PK validation: every entity must have at least one primary key column
      const hasPrimaryKey = metadata.columns.some(
        (col: any) => col.options?.primary,
      );
      if (!hasPrimaryKey) {
        throw new PrimaryKeyNotFoundError(tableName ?? "Unknown");
      }

      const driver = this.ctx.getDriver();
      if (synchronize) {
        const hasTable = await driver?.hasTable(tableName);
        if (!hasTable || hasTable.length === 0) {
          if (isDryRun) {
            this.logger.info(`[dry-run] Would CREATE TABLE ${tableName}`);
          } else {
            await driver?.createTable(tableName, metadata.columns);
          }
        }
      }

      entityList.push({ TargetEntity, tableName, metadata });
    }

    // 2패스: 모든 테이블이 생성된 후 FK, 인덱스, 유니크 인덱스를 등록합니다.
    if (synchronize && !isDryRun) {
      for (const { TargetEntity, tableName } of entityList) {
        // 외래키를 생성합니다.
        await this.registerForeignKeys(TargetEntity, tableName);

        // 인덱스를 생성합니다.
        await this.registerIndex(TargetEntity, tableName);

        // 복합 유니크 인덱스를 생성합니다.
        await this.registerUniqueIndexes(TargetEntity, tableName);
      }

      // 3패스: ManyToMany 중간 테이블과 FK를 생성합니다.
      await this.registerManyToManyJoinTables(
        entityList.map((e) => e.TargetEntity),
      );
    } else if (isDryRun) {
      for (const { tableName } of entityList) {
        this.logger.info(`[dry-run] Would register FKs/indexes for ${tableName}`);
      }
    }
  }

  /**
   * @UniqueIndex 데코레이터로 선언된 복합 유니크 인덱스를 등록합니다.
   */
  async registerUniqueIndexes(
    TargetEntity: ClazzType<any>,
    tableName: string,
  ) {
    const uniqueIndexes = Reflect.getMetadata(
      UNIQUE_INDEX_TOKEN,
      TargetEntity,
    ) as UniqueIndexMetadata[] | undefined;

    if (!uniqueIndexes || uniqueIndexes.length === 0) return;

    const driver = this.ctx.getDriver();
    for (const uq of uniqueIndexes) {
      const indexName = uq.name ?? this.namingStrategy.uniqueIndexName(tableName, uq.columns);

      // 이미 존재하는지 확인
      const indexes = (await driver?.getIndexes(tableName)) as any[];
      let isExist = false;
      for (const idx of indexes || []) {
        const existingIndexName =
          idx["Key_name"] ?? idx["Field"] ?? idx["name"];
        if (existingIndexName === indexName) {
          isExist = true;
          break;
        }
      }

      if (!isExist) {
        await driver?.addCompositeUniqueIndex(
          tableName,
          uq.columns,
          indexName,
        );
      }
    }
  }

  /**
   * ManyToMany 중간 테이블과 FK 제약을 생성합니다.
   * joinTable 소유측 엔티티만 처리하며, 중복은 Set으로 방지합니다.
   */
  async registerManyToManyJoinTables(entities: ClazzType<any>[]) {
    const processedTables = new Set<string>();
    const driver = this.ctx.getDriver();

    for (const entity of entities) {
      const m2mMeta = (Reflect.getMetadata(MANY_TO_MANY_TOKEN, entity) ??
        []) as ManyToManyMetadata<any>[];

      for (const rel of m2mMeta) {
        if (!rel.joinTable) continue;

        const {
          name: joinTableName,
          joinColumn,
          inverseJoinColumn,
        } = rel.joinTable;
        if (processedTables.has(joinTableName)) continue;
        processedTables.add(joinTableName);

        // 엔티티 테이블 이름 조회 (@Entity name 우선)
        const ownerEntityMeta = Reflect.getMetadata(ENTITY_TOKEN, entity) as
          | { name?: string }
          | undefined;
        const ownerTable = ownerEntityMeta?.name ?? entity.name;

        const relatedEntity = rel.getRelatedEntity() as ClazzType<any>;
        const relatedEntityMeta = Reflect.getMetadata(
          ENTITY_TOKEN,
          relatedEntity,
        ) as { name?: string } | undefined;
        const relatedTable = relatedEntityMeta?.name ?? relatedEntity.name;

        // 1. 중간 테이블 생성 (IF NOT EXISTS — 재시작 시 안전)
        const hasTable = await driver?.hasTable(joinTableName);
        if (!hasTable || (hasTable as any[]).length === 0) {
          const wJoinTable = this.ctx.wrap(joinTableName);
          const wJoinCol = this.ctx.wrap(joinColumn);
          const wInvCol = this.ctx.wrap(inverseJoinColumn);
          let ddl = `CREATE TABLE IF NOT EXISTS ${wJoinTable} (${wJoinCol} INT NOT NULL, ${wInvCol} INT NOT NULL, PRIMARY KEY (${wJoinCol}, ${wInvCol}))`;
          if (this.ctx.isMySqlFamily()) ddl += " ENGINE=InnoDB";
          await driver?.executeRaw(ddl);
        }

        // 2. 소유측 PK / 역측 PK 조회
        const ownerColumns = (Reflect.getMetadata(
          COLUMN_TOKEN,
          entity.prototype,
        ) ?? []) as ColumnMetadata[];
        const ownerPk = ownerColumns.find((c) => c.options?.primary)?.name;

        const relatedColumns = (Reflect.getMetadata(
          COLUMN_TOKEN,
          relatedEntity.prototype,
        ) ?? []) as ColumnMetadata[];
        const relatedPk = relatedColumns.find((c) => c.options?.primary)?.name;

        // 3. 소유측 FK 추가
        const ownerFkName = this.namingStrategy.foreignKeyName(
          joinTableName,
          joinColumn,
          ownerTable,
        );
        if (
          ownerPk &&
          driver &&
          !(await driver.hasForeignKey(joinTableName, ownerFkName))
        ) {
          const ddl = `ALTER TABLE ${this.ctx.wrap(joinTableName)} ADD CONSTRAINT ${ownerFkName} FOREIGN KEY (${this.ctx.wrap(joinColumn)}) REFERENCES ${this.ctx.wrap(ownerTable)}(${this.ctx.wrap(ownerPk)}) ON DELETE CASCADE ON UPDATE CASCADE`;
          await driver.executeRaw(ddl);
        }

        // 4. 역측 FK 추가
        const relatedFkName = this.namingStrategy.foreignKeyName(
          joinTableName,
          inverseJoinColumn,
          relatedTable,
        );
        if (
          relatedPk &&
          driver &&
          !(await driver.hasForeignKey(joinTableName, relatedFkName))
        ) {
          const ddl = `ALTER TABLE ${this.ctx.wrap(joinTableName)} ADD CONSTRAINT ${relatedFkName} FOREIGN KEY (${this.ctx.wrap(inverseJoinColumn)}) REFERENCES ${this.ctx.wrap(relatedTable)}(${this.ctx.wrap(relatedPk)}) ON DELETE CASCADE ON UPDATE CASCADE`;
          await driver.executeRaw(ddl);
        }
      }
    }
  }

  async registerForeignKeys(
    TargetEntity: ClazzType<any>,
    tableName: string,
  ) {
    // 엔티티 매니저를 가지고 옵니다.
    const entityScanner = Container.get(EntityScanner);
    const driver = this.ctx.getDriver();

    // ManyToOne 관계를 레이어 시스템을 통해 가져옵니다.
    const manyToOneItems = this.resolver.resolveManyToOneMetadata(TargetEntity);

    const isValidManyToOne = manyToOneItems && manyToOneItems.length > 0;

    // ManyToOne 관계가 존재할 경우, 외래키를 생성합니다.
    if (isValidManyToOne) {
      for (const manyToOneItem of manyToOneItems) {
        const { joinColumn } = manyToOneItem;

        // 매핑할 엔티티를 가져옵니다.
        const mappingEntity = manyToOneItem.getMappingEntity();
        if (!mappingEntity) {
          throw new EntityNotFound(mappingEntity);
        }
        // Search for metadata.
        const mappingTableMetadata = entityScanner.scan(mappingEntity);
        if (!mappingTableMetadata) {
          throw new EntityMetadataNotFoundError(mappingEntity.name);
        }

        if (!joinColumn) {
          throw new InvalidQueryError(
            "JoinColumn does not exist.",
            "Add { joinColumn: 'column_name' } option to your @ManyToOne() decorator.",
          );
        }

        // references 옵션이 있으면 해당 컬럼, 없으면 PK를 참조
        const mappingTablePrimaryKey = manyToOneItem.references
          ? manyToOneItem.references
          : mappingTableMetadata.columns.find(
              (e: any) => e.options?.primary,
            )?.name;

        if (!mappingTablePrimaryKey) {
          throw new PrimaryKeyNotFoundError(mappingEntity.name);
        }

        const mappingTableName =
          mappingTableMetadata.name || this.ctx.getNameStrategy(mappingEntity);

        // joinColumn 컬럼이 테이블에 없으면 먼저 추가합니다.
        if (driver) {
          const columnExists = await driver.hasColumn(
            tableName,
            joinColumn,
          );
          if (!columnExists) {
            const fkColumnType = driver.castType("int") + " NULL";
            await driver.addColumn(tableName, joinColumn, fkColumnType);
          }
        }

        // FK 제약이 이미 존재하면 중복 추가를 건너뜁니다.
        if (driver) {
          const fkName = this.namingStrategy.foreignKeyName(
            tableName,
            joinColumn,
            mappingTableName,
          );
          const fkExists = await driver.hasForeignKey(tableName, fkName);
          if (fkExists) continue;
        }

        await driver?.addForeignKey(
          // 현재 테이블 이름
          tableName,
          // 현재 테이블의 키 이름
          joinColumn,
          // 매핑할 테이블 이름
          mappingTableName,
          // 매핑할 테이블의 기본키
          mappingTablePrimaryKey,
        );
      }
    }

    // OneToOne 관계의 소유측(joinColumn이 있는 쪽)에 대해 FK를 생성합니다.
    const oneToOneItems = this.resolver.resolveOneToOneMetadata(TargetEntity);
    for (const oneToOneItem of oneToOneItems) {
      const { joinColumn } = oneToOneItem;
      if (!joinColumn) continue; // 역방향(inverseSide)은 FK가 없음

      const RelatedEntity = oneToOneItem.getRelatedEntity();
      if (!RelatedEntity) {
        throw new EntityNotFound(RelatedEntity);
      }

      const relatedMetadata = entityScanner.scan(RelatedEntity);
      if (!relatedMetadata) {
        throw new EntityMetadataNotFoundError(RelatedEntity.name);
      }

      const relatedPrimaryKey = relatedMetadata.columns.find(
        (e: any) => e.options?.primary,
      )?.name;

      if (!relatedPrimaryKey) {
        throw new PrimaryKeyNotFoundError(RelatedEntity.name);
      }

      // joinColumn 컬럼이 테이블에 없으면 먼저 추가합니다.
      if (driver) {
        const columnExists = await driver.hasColumn(tableName, joinColumn);
        if (!columnExists) {
          const fkColumnType = driver.castType("int") + " NULL";
          await driver.addColumn(tableName, joinColumn, fkColumnType);
        }
      }

      const relatedTableName =
        relatedMetadata.name || this.ctx.getNameStrategy(RelatedEntity);

      // FK 제약이 이미 존재하면 중복 추가를 건너뜁니다.
      if (driver) {
        const fkName = this.namingStrategy.foreignKeyName(
          tableName,
          joinColumn,
          relatedTableName,
        );
        const fkExists = await driver.hasForeignKey(tableName, fkName);
        if (fkExists) continue;
      }

      await driver?.addForeignKey(
        tableName,
        joinColumn,
        relatedTableName,
        relatedPrimaryKey,
      );
    }
  }

  /**
   * 인덱스를 생성합니다.
   */
  async registerIndex(TargetEntity: ClazzType<any>, tableName: string) {
    const indexer = Reflect.getMetadata(
      INDEX_TOKEN,
      TargetEntity.prototype,
    ) as IndexMetadata[];
    if (indexer) {
      const driver = this.ctx.getDriver();
      for (const index of indexer) {
        const indexName = this.namingStrategy.indexName(tableName, index.name);

        const indexes = (await driver?.getIndexes(tableName)) as any[];

        let isExist = false;
        for (const idx of indexes || []) {
          // MySQL은 "Key_name", PostgreSQL은 "Field" (indexname 별칭)를 사용합니다.
          const existingIndexName = idx["Key_name"] ?? idx["Field"];
          if (existingIndexName === indexName) {
            isExist = true;
            break;
          }
        }

        if (!isExist) {
          await driver?.addIndex(tableName, index.name, indexName);
        }
      }
    }
  }
}
