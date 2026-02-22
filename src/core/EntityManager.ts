/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { ClazzType, Logger, ReflectManager } from "../utils";
import {
  ColumnMetadata,
  EntityScannerMetadata,
  EntityScanner,
  ManyToOneScanner,
  OneToManyScanner,
  ManyToManyScanner,
  OneToOneScanner,
} from "../scanner";
import Container from "typedi";
import { DatabaseClient } from "../DatabaseClient";
import { MySqlDriver } from "../dialects/mysql/MySqlDriver";
import { PostgresDriver } from "../dialects/postgres/PostgresDriver";
import { SqliteDriver } from "../dialects/sqlite/SqliteDriver";
import { ISqlDriver } from "../dialects/SqlDriver";
import { INDEX_TOKEN, IndexMetadata } from "../decorators/Indexer";
import { IDatabaseType } from "../dialects/mysql/MySqlConnector";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import { FindOption } from "../dialects/FindOption";
import { IDataSource } from "../dialects/IDataSource";
import { MySqlDataSource } from "../dialects/mysql/MySqlDataSource";
import { PostgresDataSource } from "../dialects/postgres/PostgresDataSource";
import { SqliteDataSource } from "../dialects/sqlite/SqliteDataSource";
import sql, { Sql, join, raw } from "sql-template-tag";
import {
  ENTITY_TOKEN,
  MANY_TO_ONE_TOKEN,
  ManyToOneMetadata,
  ONE_TO_MANY_TOKEN,
  OneToManyMetadata,
  MANY_TO_MANY_TOKEN,
  ManyToManyMetadata,
  DELETED_AT_TOKEN,
  HOOK_TOKEN,
  HookEvent,
  HookMetadata,
  ONE_TO_ONE_TOKEN,
  OneToOneMetadata,
} from "../decorators";
import { BaseRepository } from "./BaseRepository";
import { BaseEntityManager } from "./BaseEntityManager";
import { ResultSetHeader } from "mysql2";
import { EntityNotFound } from "../dialects/EntityNotFound";
import { QueryResult } from "../types/QueryResult";
import { EntityResult } from "../types/EntityResult";
import { DeleteResult } from "../types/DeleteResult";
import { RawQueryBuilderFactory } from "./RawQueryBuilderFactory";
import { Conditions } from "./Conditions";
import { ResultTransformerFactory } from "./ResultTransformerFactory";
import { DatabaseClientOptions } from "./DatabaseClientOptions";
import { MetadataContext } from "../metadata/MetadataContext";
import { injectLazyProxy } from "./LazyLoader";
import { hasCascade } from "../types/CascadeType";
import { EntityValidator } from "./EntityValidator";

export class EntityManager implements BaseEntityManager {
  private _entities: ClazzType<any>[] = [];
  private readonly logger = new Logger(EntityManager.name);
  private driver?: ISqlDriver;
  private dataSource?: IDataSource;
  private dirtyEntities: Set<InstanceType<ClazzType<any>>> = new Set();

  public async register(databaseClientOptions: DatabaseClientOptions) {
    await this.connect(databaseClientOptions);
    await this.registerEntities();
  }

  get client() {
    return DatabaseClient.getInstance();
  }

  get connection() {
    return this.client.getConnection();
  }

  public async connect(databaseClientOptions: DatabaseClientOptions) {
    const client = this.client;
    const connector = await client.connect(databaseClientOptions);

    switch (client.type as IDatabaseType) {
      case "mariadb":
      case "mysql":
        this.driver = new MySqlDriver(connector, client.type);
        this.dataSource = new MySqlDataSource(connector);
        break;
      case "postgres":
        this.driver = new PostgresDriver(
          connector,
          client.type,
          databaseClientOptions.schema,
        );
        this.dataSource = new PostgresDataSource(connector);
        break;
      case "sqlite":
        this.driver = new SqliteDriver(connector);
        this.dataSource = new SqliteDataSource(connector);
        break;
      default:
        throw new Error("Unsupported database type.");
    }
  }

  public async propagateShutdown() {
    // TODO: 나중에 추가
  }

  getNameStrategy<T>(clazz: ClazzType<T>): string {
    return clazz.name;
  }

  /**
   * 엔티티 메타데이터를 레이어 시스템을 통해 조회합니다.
   *
   * 조회 우선순위:
   * 1. EntityScanner.scan() — MetadataLayerRegistry 경유 (멀티테넌트 레이어 지원)
   * 2. Reflect.getMetadata() — 데코레이터가 클래스에 직접 부착한 정적 메타데이터 (fallback)
   *
   * 이를 통해 withTenant() 등으로 컨텍스트를 전환했을 때,
   * 해당 테넌트 레이어의 메타데이터가 올바르게 반환됩니다.
   */
  private resolveEntityMetadata<T>(
    entity: ClazzType<T>,
  ): EntityScannerMetadata | null {
    const context = MetadataContext.isActive()
      ? MetadataContext.getCurrentTenant()
      : "public";

    // 1. 레이어 시스템을 통한 조회 (멀티테넌트 지원)
    const entityScanner = Container.get(EntityScanner);
    const layeredMetadata = entityScanner.scan(entity);
    if (layeredMetadata) {
      this.logger.debug(
        `[resolveEntityMetadata] "${entity.name}" resolved via LayeredMetadataStore (context: "${context}")`,
      );
      return layeredMetadata;
    }

    // 2. Reflect fallback (데코레이터 직접 부착 — 단일 테넌트 호환)
    const reflectMetadata = Reflect.getMetadata(ENTITY_TOKEN, entity) as
      | EntityScannerMetadata
      | undefined;

    if (reflectMetadata) {
      this.logger.warn(
        `[resolveEntityMetadata] "${entity.name}" resolved via Reflect.getMetadata fallback (context: "${context}"). ` +
          `This entity was not found in the layered store.`,
      );
    } else {
      this.logger.error(
        `[resolveEntityMetadata] "${entity.name}" not found in any metadata source (context: "${context}")`,
      );
    }

    return reflectMetadata ?? null;
  }

  /**
   * @DeletedAt 데코레이터가 적용된 컬럼 이름을 반환합니다.
   * 없으면 null을 반환합니다.
   */
  private getDeletedAtColumn<T>(entity: ClazzType<T>): string | null {
    const column = Reflect.getMetadata(DELETED_AT_TOKEN, entity) as
      | string
      | undefined;
    return column ?? null;
  }

  /**
   * 엔티티 인스턴스에서 지정된 이벤트의 생명주기 훅을 실행합니다.
   * @HOOK_TOKEN 메타데이터를 읽어 해당 이벤트의 메서드를 호출합니다.
   */
  private async runHooks<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
    event: HookEvent,
  ): Promise<void> {
    const hooks = Reflect.getMetadata(HOOK_TOKEN, entity) as
      | HookMetadata[]
      | undefined;
    if (!hooks || hooks.length === 0) return;

    for (const hook of hooks) {
      if (hook.event !== event) continue;
      const method = (item as any)[hook.methodName];
      if (typeof method === "function") {
        await method.call(item);
      }
    }
  }

  /**
   * 변경 감지를 위한 프록시 객체를 생성합니다.
   */
  private createProxy<T>(entity: T): T {
    return new Proxy(entity as any, {
      set: (target: any, prop: string, value: any) => {
        target[prop] = value;

        // Set 자료구조에 변경된 엔티티를 추가합니다.
        this.dirtyEntities.add(target);
        return true;
      },
    });
  }

  private async registerEntities() {
    const entityScanner = Container.get(EntityScanner);
    const entities = entityScanner.makeEntities();

    let entity: IteratorResult<EntityScannerMetadata>;

    const { synchronize } = this.client.getOptions();

    // PostgreSQL: 스키마가 존재하지 않으면 자동으로 생성합니다.
    if (synchronize && this.isPostgres() && this.driver) {
      const pgDriver = this.driver as PostgresDriver;
      const hasSchema = await pgDriver.hasSchema();
      if (!hasSchema || hasSchema.length === 0) {
        await pgDriver.createSchema();
        await pgDriver.setSearchPath();
      }
    }

    while ((entity = entities.next())) {
      if (entity.done) {
        break;
      }

      const metadata = entity.value as EntityScannerMetadata;

      const TargetEntity = metadata.target as ClazzType<any>;
      let tableName = metadata.name;
      if (!tableName) {
        tableName = this.getNameStrategy(TargetEntity);
      }

      if (!ReflectManager.isEntity(TargetEntity)) {
        throw new Error(`${tableName} is not an Entity.`);
      }

      // 동기화 옵션이 켜져있을 경우에만 동작합니다.
      if (synchronize) {
        // DB에 테이블이 존재하지 않으면 새로운 테이블을 생성합니다.
        const hasTable = await this.driver?.hasTable(tableName);
        if (!hasTable || hasTable.length === 0) {
          await this.driver?.createTable(tableName, metadata.columns);
        }

        // 외래키를 생성합니다.
        await this.registerForeignKeys(TargetEntity, tableName);

        // 인덱스를 생성합니다.
        await this.registerIndex(TargetEntity, tableName);
      }
    }
  }

  /**
   * ManyToOne 관계 메타데이터를 레이어 시스템을 통해 조회합니다.
   *
   * 조회 우선순위:
   * 1. ManyToOneScanner — MetadataLayerRegistry 경유 (멀티테넌트 레이어 지원)
   * 2. Reflect.getMetadata() — 데코레이터가 직접 부착한 정적 메타데이터 (fallback)
   */
  private resolveManyToOneMetadata<T>(
    entity: ClazzType<T>,
  ): ManyToOneMetadata<any>[] {
    // 1. 레이어 시스템을 통한 조회 (멀티테넌트 지원)
    const manyToOneScanner = Container.get(ManyToOneScanner);
    const allRelations = manyToOneScanner
      .allMetadata<ManyToOneMetadata<any>>()
      .filter((rel) => rel.target === entity);

    if (allRelations.length > 0) {
      return allRelations;
    }

    // 2. Reflect fallback (데코레이터 직접 부착 — 단일 테넌트 호환)
    const reflectMetadata =
      (Reflect.getMetadata(MANY_TO_ONE_TOKEN, entity) as
        | ManyToOneMetadata<any>[]
        | undefined) ??
      (Reflect.getMetadata(MANY_TO_ONE_TOKEN, entity.prototype) as
        | ManyToOneMetadata<any>[]
        | undefined);

    if (reflectMetadata && reflectMetadata.length > 0) {
      this.logger.warn(
        `[resolveManyToOneMetadata] "${entity.name}" ManyToOne resolved via Reflect.getMetadata fallback.`,
      );
      return reflectMetadata;
    }

    return [];
  }

  /**
   * OneToMany 관계 메타데이터를 레이어 시스템을 통해 조회합니다.
   *
   * 조회 우선순위:
   * 1. OneToManyScanner — MetadataLayerRegistry 경유 (멀티테넌트 레이어 지원)
   * 2. Reflect.getMetadata() — 데코레이터가 직접 부착한 정적 메타데이터 (fallback)
   */
  private resolveOneToManyMetadata<T>(
    entity: ClazzType<T>,
  ): OneToManyMetadata<any>[] {
    // 1. 레이어 시스템을 통한 조회 (멀티테넌트 지원)
    const oneToManyScanner = Container.get(OneToManyScanner);
    const allRelations = oneToManyScanner
      .allMetadata<OneToManyMetadata<any>>()
      .filter((rel) => rel.target === entity);

    if (allRelations.length > 0) {
      return allRelations;
    }

    // 2. Reflect fallback (데코레이터 직접 부착 — 단일 테넌트 호환)
    const reflectMetadata =
      (Reflect.getMetadata(ONE_TO_MANY_TOKEN, entity) as
        | OneToManyMetadata<any>[]
        | undefined) ??
      (Reflect.getMetadata(ONE_TO_MANY_TOKEN, entity.prototype) as
        | OneToManyMetadata<any>[]
        | undefined);

    if (reflectMetadata && reflectMetadata.length > 0) {
      this.logger.warn(
        `[resolveOneToManyMetadata] "${entity.name}" OneToMany resolved via Reflect.getMetadata fallback.`,
      );
      return reflectMetadata;
    }

    return [];
  }

  /**
   * OneToMany 관계를 별도 쿼리로 로드하여 부모 엔티티에 할당합니다.
   *
   * @param entity 부모 엔티티 클래스
   * @param parentResults 부모 쿼리 결과 (단일 또는 배열)
   * @param relations 로드할 관계 필드명 배열
   */
  private async loadOneToManyRelations<T>(
    entity: ClazzType<T>,
    parentResults: T | T[],
    relations: (keyof T)[],
  ): Promise<void> {
    const oneToManyMeta = this.resolveOneToManyMetadata(entity);
    if (oneToManyMeta.length === 0) return;

    const parentMetadata = this.resolveEntityMetadata(entity);
    if (!parentMetadata) return;

    const pk = parentMetadata.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );
    if (!pk) return;

    const parents = Array.isArray(parentResults)
      ? parentResults
      : [parentResults];

    for (const rel of oneToManyMeta) {
      // relations 배열에 해당 propertyKey가 포함된 경우에만 로드
      if (!relations.includes(rel.propertyKey as keyof T)) continue;

      const RelatedEntity = rel.getRelatedEntity();
      const relatedMetadata = this.resolveEntityMetadata(RelatedEntity);
      if (!relatedMetadata) continue;

      // mappedBy가 가리키는 ManyToOne 측의 joinColumn 찾기
      const manyToOneItems = this.resolveManyToOneMetadata(RelatedEntity);
      const matchingRelation = manyToOneItems.find(
        (m) => m.columnName === rel.mappedBy,
      );

      // joinColumn이 있으면 그것을 FK 컬럼으로, 없으면 mappedBy 자체를 FK 컬럼으로 사용
      const fkColumn = matchingRelation?.joinColumn ?? rel.mappedBy;

      for (const parent of parents) {
        const parentId = (parent as any)[pk.name!];
        if (parentId === undefined || parentId === null) continue;

        const children = await this.find(RelatedEntity, {
          where: { [fkColumn]: parentId } as any,
        });

        // 결과를 배열로 정규화하여 할당
        if (children === undefined) {
          (parent as any)[rel.propertyKey] = [];
        } else if (Array.isArray(children)) {
          (parent as any)[rel.propertyKey] = children;
        } else {
          (parent as any)[rel.propertyKey] = [children];
        }
      }
    }
  }

  /**
   * ManyToMany 관계 메타데이터를 레이어 시스템을 통해 조회합니다.
   *
   * 조회 우선순위:
   * 1. ManyToManyScanner — MetadataLayerRegistry 경유 (멀티테넌트 레이어 지원)
   * 2. Reflect.getMetadata() — 데코레이터가 직접 부착한 정적 메타데이터 (fallback)
   */
  private resolveManyToManyMetadata<T>(
    entity: ClazzType<T>,
  ): ManyToManyMetadata<any>[] {
    // 1. 레이어 시스템을 통한 조회 (멀티테넌트 지원)
    const manyToManyScanner = Container.get(ManyToManyScanner);
    const allRelations = manyToManyScanner
      .allMetadata<ManyToManyMetadata<any>>()
      .filter((rel) => rel.target === entity);

    if (allRelations.length > 0) {
      return allRelations;
    }

    // 2. Reflect fallback (데코레이터 직접 부착 — 단일 테넌트 호환)
    const reflectMetadata =
      (Reflect.getMetadata(MANY_TO_MANY_TOKEN, entity) as
        | ManyToManyMetadata<any>[]
        | undefined) ??
      (Reflect.getMetadata(MANY_TO_MANY_TOKEN, entity.prototype) as
        | ManyToManyMetadata<any>[]
        | undefined);

    if (reflectMetadata && reflectMetadata.length > 0) {
      this.logger.warn(
        `[resolveManyToManyMetadata] "${entity.name}" ManyToMany resolved via Reflect.getMetadata fallback.`,
      );
      return reflectMetadata;
    }

    return [];
  }

  /**
   * OneToOne 관계 메타데이터를 레이어 시스템을 통해 조회합니다.
   *
   * 조회 우선순위:
   * 1. OneToOneScanner — MetadataLayerRegistry 경유 (멀티테넌트 레이어 지원)
   * 2. Reflect.getMetadata() — 데코레이터가 직접 부착한 정적 메타데이터 (fallback)
   */
  private resolveOneToOneMetadata<T>(
    entity: ClazzType<T>,
  ): OneToOneMetadata<any>[] {
    // 1. 레이어 시스템을 통한 조회 (멀티테넌트 지원)
    const oneToOneScanner = Container.get(OneToOneScanner);
    const allRelations = oneToOneScanner
      .allMetadata<OneToOneMetadata<any>>()
      .filter((rel) => rel.target === entity);

    if (allRelations.length > 0) {
      return allRelations;
    }

    // 2. Reflect fallback (데코레이터 직접 부착 — 단일 테넌트 호환)
    const reflectMetadata =
      (Reflect.getMetadata(ONE_TO_ONE_TOKEN, entity) as
        | OneToOneMetadata<any>[]
        | undefined) ??
      (Reflect.getMetadata(ONE_TO_ONE_TOKEN, entity.prototype) as
        | OneToOneMetadata<any>[]
        | undefined);

    if (reflectMetadata && reflectMetadata.length > 0) {
      this.logger.warn(
        `[resolveOneToOneMetadata] "${entity.name}" OneToOne resolved via Reflect.getMetadata fallback.`,
      );
      return reflectMetadata;
    }

    return [];
  }

  /**
   * ManyToMany 관계의 joinTable 정보를 확정합니다.
   * 소유측(joinTable 있음)이면 그대로, 역방향(mappedBy)이면 상대측에서 joinTable을 가져옵니다.
   */
  private resolveManyToManyJoinTable<T>(
    rel: ManyToManyMetadata<any>,
  ): { joinTableName: string; joinColumn: string; inverseJoinColumn: string } | null {
    if (rel.joinTable) {
      return {
        joinTableName: rel.joinTable.name,
        joinColumn: rel.joinTable.joinColumn,
        inverseJoinColumn: rel.joinTable.inverseJoinColumn,
      };
    }

    // 역방향: mappedBy가 가리키는 소유측에서 joinTable을 가져온다
    if (rel.mappedBy) {
      const RelatedEntity = rel.getRelatedEntity();
      const relatedManyToMany = this.resolveManyToManyMetadata(RelatedEntity);
      const ownerRel = relatedManyToMany.find(
        (r) => r.propertyKey === rel.mappedBy && r.joinTable,
      );
      if (ownerRel?.joinTable) {
        // 역방향이므로 joinColumn과 inverseJoinColumn을 뒤집는다
        return {
          joinTableName: ownerRel.joinTable.name,
          joinColumn: ownerRel.joinTable.inverseJoinColumn,
          inverseJoinColumn: ownerRel.joinTable.joinColumn,
        };
      }
    }

    return null;
  }

  /**
   * ManyToMany 관계를 별도 쿼리로 로드하여 부모 엔티티에 할당합니다.
   *
   * 중간 테이블을 JOIN하여 대상 엔티티를 가져옵니다:
   * SELECT target.* FROM target
   * INNER JOIN join_table ON target.pk = join_table.inverseJoinColumn
   * WHERE join_table.joinColumn = :parentId
   */
  private async loadManyToManyRelations<T>(
    entity: ClazzType<T>,
    parentResults: T | T[],
    relations: (keyof T)[],
  ): Promise<void> {
    const manyToManyMeta = this.resolveManyToManyMetadata(entity);
    if (manyToManyMeta.length === 0) return;

    const parentMetadata = this.resolveEntityMetadata(entity);
    if (!parentMetadata) return;

    const pk = parentMetadata.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );
    if (!pk) return;

    const parents = Array.isArray(parentResults)
      ? parentResults
      : [parentResults];

    for (const rel of manyToManyMeta) {
      if (!relations.includes(rel.propertyKey as keyof T)) continue;

      const joinInfo = this.resolveManyToManyJoinTable(rel);
      if (!joinInfo) continue;

      const RelatedEntity = rel.getRelatedEntity();
      const relatedMetadata = this.resolveEntityMetadata(RelatedEntity);
      if (!relatedMetadata) continue;

      const relatedPk = relatedMetadata.columns.find(
        (col: any) => col.options?.primary,
      );
      if (!relatedPk) continue;

      const relatedTableName = relatedMetadata.name ?? RelatedEntity.name;

      for (const parent of parents) {
        const parentId = (parent as any)[pk.name!];
        if (parentId === undefined || parentId === null) continue;

        // 중간 테이블 JOIN 쿼리를 직접 구성
        const qb = RawQueryBuilderFactory.create();

        const selectCols = relatedMetadata.columns.map(
          (col: any) =>
            `${this.wrap(relatedTableName)}.${this.wrap(col.name!)}`,
        );

        const joinCondition = sql`${raw(this.wrap(relatedTableName))}.${raw(this.wrap(relatedPk.name!))} = ${raw(this.wrap(joinInfo.joinTableName))}.${raw(this.wrap(joinInfo.inverseJoinColumn))}`;

        const whereCondition = sql`${raw(this.wrap(joinInfo.joinTableName))}.${raw(this.wrap(joinInfo.joinColumn))} = ${parentId}`;

        qb.select(selectCols)
          .from(this.wrap(relatedTableName))
          .innerJoin(
            this.wrap(joinInfo.joinTableName),
            this.wrap(joinInfo.joinTableName),
            joinCondition,
          )
          .where([whereCondition]);

        const transactionHolder = new TransactionSessionManager();
        try {
          await transactionHolder.connect();
          await transactionHolder.startTransaction();

          if (this.isMySqlFamily()) {
            await transactionHolder.query("SET autocommit = 0");
          }

          const resultQuery = qb.build();
          const queryResult = (await transactionHolder.query(
            resultQuery,
          )) as QueryResult;

          await transactionHolder.commit();

          const resultTransformer = ResultTransformerFactory.create();
          const { results } = queryResult;

          if (!results || results.length === 0) {
            (parent as any)[rel.propertyKey] = [];
          } else {
            (parent as any)[rel.propertyKey] = resultTransformer.toEntities(
              RelatedEntity,
              queryResult,
            );
          }
        } catch (e) {
          try {
            await transactionHolder.rollback();
          } catch (rollbackError) {
            this.logger.error(
              `Failed to rollback ManyToMany transaction: ${rollbackError}`,
            );
          }
          throw e;
        } finally {
          try {
            await transactionHolder.close();
          } catch (closeError) {
            this.logger.error(
              `Failed to close ManyToMany transaction: ${closeError}`,
            );
          }
        }
      }
    }
  }

  private async registerForeignKeys(
    TargetEntity: ClazzType<any>,
    tableName: string,
  ) {
    // 엔티티 매니저를 가지고 옵니다.
    const entityScanner = Container.get(EntityScanner);

    // ManyToOne 관계를 레이어 시스템을 통해 가져옵니다.
    const manyToOneItems = this.resolveManyToOneMetadata(TargetEntity);

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
          throw new Error("Metadata for the mapping entity does not exist.");
        }

        if (!joinColumn) {
          throw new Error("JoinColumn does not exist.");
        }

        // Get the primary key of the mapping table.
        const mappingTablePrimaryKey = mappingTableMetadata.columns.find(
          (e: any) => e.options?.primary,
        )?.name;

        // Throw an error if the primary key does not exist.
        if (!mappingTablePrimaryKey) {
          throw new Error("Primary key for the mapping entity does not exist.");
        }

        const { name: mappingTableName } = mappingEntity;

        await this.driver?.addForeignKey(
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
    const oneToOneItems = this.resolveOneToOneMetadata(TargetEntity);
    for (const oneToOneItem of oneToOneItems) {
      const { joinColumn } = oneToOneItem;
      if (!joinColumn) continue; // 역방향(inverseSide)은 FK가 없음

      const RelatedEntity = oneToOneItem.getRelatedEntity();
      if (!RelatedEntity) {
        throw new EntityNotFound(RelatedEntity);
      }

      const relatedMetadata = entityScanner.scan(RelatedEntity);
      if (!relatedMetadata) {
        throw new Error("Metadata for the related entity does not exist.");
      }

      const relatedPrimaryKey = relatedMetadata.columns.find(
        (e: any) => e.options?.primary,
      )?.name;

      if (!relatedPrimaryKey) {
        throw new Error("Primary key for the related entity does not exist.");
      }

      await this.driver?.addForeignKey(
        tableName,
        joinColumn,
        RelatedEntity.name,
        relatedPrimaryKey,
      );
    }
  }

  /**
   * 인덱스를 생성합니다.
   *
   * @Index 데코레이터는 현재 Reflect.getMetadata에만 저장되므로
   * Reflect에서 직접 조회합니다.
   *
   * 인덱스 존재 여부 확인은 드라이버에 독립적인 방식으로 수행합니다:
   * - MySQL: idx["Key_name"]
   * - PostgreSQL: idx["Field"] (indexname 별칭)
   */
  private async registerIndex(TargetEntity: ClazzType<any>, tableName: string) {
    const indexer = Reflect.getMetadata(
      INDEX_TOKEN,
      TargetEntity.prototype,
    ) as IndexMetadata[];
    if (indexer) {
      for (const index of indexer) {
        const indexName = `INDEX_${tableName}_${index.name}`;

        const indexes = (await this.driver?.getIndexes(tableName)) as any[];

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
          await this.driver?.addIndex(tableName, index.name, indexName);
        }
      }
    }
  }

  /**
   * find out a single entity from the database.
   *
   * @param entity
   * @param findOption
   * @returns
   */
  async findOne<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
  ): Promise<EntityResult<T>> {
    return this.find<T>(entity, { ...findOption, limit: 1 });
  }

  /**
   * Find out entities from the database.
   *
   * @param entity
   * @param findOption
   * @returns
   */
  async find<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
  ): Promise<EntityResult<T>> {
    const { select, orderBy, where, take } = findOption;
    const { limit } = findOption;

    const transactionHolder = new TransactionSessionManager();
    const resultTransformer = ResultTransformerFactory.create();

    try {
      // 트랜잭션을 시작합니다.
      await transactionHolder.connect();
      await transactionHolder.startTransaction();

      // MySQL/MariaDB 전용: autocommit 비활성화
      // PostgreSQL은 BEGIN으로 트랜잭션을 시작하면 자동으로 autocommit이 꺼집니다.
      if (this.isMySqlFamily()) {
        await transactionHolder.query("SET autocommit = 0");
      }

      // 메타데이터를 가져옵니다 (레이어 시스템 경유).
      const metadata = this.resolveEntityMetadata(entity);

      if (!metadata) {
        throw new Error("Entity metadata does not exist.");
      }

      // factory class로부터 QueryBuilder를 생성합니다.
      const qb = RawQueryBuilderFactory.create();

      // Query Map
      const selectMap: string[] = [];
      const whereMap: Sql[] = [];
      const orderByMap: Array<{ column: string; direction: "ASC" | "DESC" }> =
        [];

      // Eager 로드할 ManyToOne 관계를 수집
      const manyToOneRelations = this.resolveManyToOneMetadata(entity);
      const eagerRelations = manyToOneRelations.filter((rel) => {
        const isEager = rel.option?.eager === true;
        const isInRelations = findOption.relations?.includes(
          rel.columnName as keyof T,
        );
        return isEager || isInRelations;
      });

      // Eager 로드할 OneToOne 관계를 수집 (소유측: joinColumn이 있는 쪽)
      const oneToOneRelations = this.resolveOneToOneMetadata(entity);
      const eagerOneToOneRelations = oneToOneRelations.filter((rel) => {
        if (!rel.joinColumn) return false; // 소유측만 eager JOIN 가능
        const isEager = rel.option?.eager === true;
        const isInRelations = findOption.relations?.includes(
          rel.propertyKey as keyof T,
        );
        return isEager || isInRelations;
      });

      // ManyToOne과 OneToOne을 합산하여 JOIN 여부를 판단
      const hasEagerJoins = eagerRelations.length > 0 || eagerOneToOneRelations.length > 0;

      const tableName = metadata.name!;

      if (!select) {
        // 메인 테이블 컬럼에 테이블 별칭 prefix 추가 (JOIN 시 충돌 방지)
        if (hasEagerJoins) {
          selectMap.push(
            ...metadata.columns.map(
              (column) =>
                `${this.wrap(tableName)}.${this.wrap(column.name!)}`,
            ),
          );
        } else {
          selectMap.push(
            ...metadata.columns.map((column) => this.wrap(column.name!)),
          );
        }
      }

      // ManyToOne Eager 관계 컬럼을 SELECT에 추가 (alias: propertyName_columnName)
      for (const rel of eagerRelations) {
        const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
        const relatedMetadata = this.resolveEntityMetadata(RelatedEntity);
        if (!relatedMetadata) continue;

        for (const col of relatedMetadata.columns) {
          const alias = `${rel.columnName}_${col.name}`;
          selectMap.push(
            `${this.wrap(RelatedEntity.name)}.${this.wrap(col.name!)} AS ${this.wrap(alias)}`,
          );
        }
      }

      // OneToOne Eager 관계 컬럼을 SELECT에 추가 (alias: propertyKey_columnName)
      for (const rel of eagerOneToOneRelations) {
        const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
        const relatedMetadata = this.resolveEntityMetadata(RelatedEntity);
        if (!relatedMetadata) continue;

        for (const col of relatedMetadata.columns) {
          const alias = `${rel.propertyKey}_${col.name}`;
          selectMap.push(
            `${this.wrap(RelatedEntity.name)}.${this.wrap(col.name!)} AS ${this.wrap(alias)}`,
          );
        }
      }

      for (const key in where) {
        const value = where[key];
        if (value) {
          if (hasEagerJoins) {
            whereMap.push(
              Conditions.equals(
                `${this.wrap(tableName)}.${this.wrap(key)}`,
                value,
              ),
            );
          } else {
            whereMap.push(Conditions.equals(this.wrap(key), value));
          }
        }
      }

      // @DeletedAt 컬럼이 있으면 자동으로 WHERE deleted_at IS NULL 조건 추가
      const deletedAtColumn = this.getDeletedAtColumn(entity);
      if (deletedAtColumn && !(findOption as any).withDeleted) {
        if (hasEagerJoins) {
          whereMap.push(
            Conditions.isNull(
              `${this.wrap(tableName)}.${this.wrap(deletedAtColumn)}`,
            ),
          );
        } else {
          whereMap.push(Conditions.isNull(this.wrap(deletedAtColumn)));
        }
      }

      for (const key in orderBy) {
        const value = orderBy[key];
        if (value) {
          orderByMap.push({ column: this.wrap(key), direction: value });
        }
      }

      // Query를 구성합니다.
      qb.select(selectMap)
        .from(this.wrap(tableName))
        .where(whereMap)
        .orderBy(orderByMap);

      // Eager 관계에 대한 LEFT JOIN 추가
      for (const rel of eagerRelations) {
        const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
        const relatedMetadata = this.resolveEntityMetadata(RelatedEntity);
        if (!relatedMetadata) continue;

        const relatedTableName = RelatedEntity.name;
        const joinColumn = rel.joinColumn ?? rel.columnName;

        // 관련 엔티티의 PK 찾기
        const relatedPk = relatedMetadata.columns.find(
          (col: any) => col.options?.primary,
        );
        if (!relatedPk) continue;

        const joinCondition = sql`${raw(this.wrap(tableName))}.${raw(this.wrap(joinColumn))} = ${raw(this.wrap(relatedTableName))}.${raw(this.wrap(relatedPk.name!))}`;
        qb.leftJoin(
          this.wrap(relatedTableName),
          this.wrap(relatedTableName),
          joinCondition,
        );
      }

      // OneToOne Eager 관계에 대한 LEFT JOIN 추가
      for (const rel of eagerOneToOneRelations) {
        const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
        const relatedMetadata = this.resolveEntityMetadata(RelatedEntity);
        if (!relatedMetadata) continue;

        const relatedTableName = RelatedEntity.name;
        const joinColumn = rel.joinColumn!;

        const relatedPk = relatedMetadata.columns.find(
          (col: any) => col.options?.primary,
        );
        if (!relatedPk) continue;

        const joinCondition = sql`${raw(this.wrap(tableName))}.${raw(this.wrap(joinColumn))} = ${raw(this.wrap(relatedTableName))}.${raw(this.wrap(relatedPk.name!))}`;
        qb.leftJoin(
          this.wrap(relatedTableName),
          this.wrap(relatedTableName),
          joinCondition,
        );
      }

      // LIMIT 쿼리가 튜플일 경우
      if (Array.isArray(limit)) {
        let [offset, count] = limit;

        if (offset < 0) {
          offset = 0;
        }

        if (count < 0) {
          count = 0;
        }

        if (count === 0) {
          count = 1;
        }

        if (take && take > 0) {
          count = take;
        }

        if (this.isMySqlFamily()) {
          qb.setDatabaseType("mysql");
        }

        qb.limit([offset, count]);
      } else {
        if (limit) {
          qb.limit(limit as number);
        }
      }

      // 최종 SQL을 생성합니다.
      const resultQuery = qb.build();

      const queryResult = (await transactionHolder.query<T>(
        resultQuery,
      )) as QueryResult;

      // 트랜잭션을 커밋합니다.
      await transactionHolder.commit();

      const { results } = queryResult;
      if (!results || results.length === 0) {
        return undefined;
      }

      const isEntityArray = results.length > 1;
      let entityResult: EntityResult<T>;
      if (hasEagerJoins) {
        // Eager 관계가 있을 경우 중첩된 결과를 변환
        entityResult = resultTransformer.transformNested(
          entity,
          queryResult,
        ) as EntityResult<T>;
      } else if (isEntityArray) {
        entityResult = resultTransformer.toEntities(entity, queryResult);
      } else {
        entityResult = resultTransformer.toEntity(entity, queryResult);
      }

      // OneToMany / ManyToMany / OneToOne(inverse) 관계 로드 (relations 옵션이 있는 경우)
      if (findOption.relations && findOption.relations.length > 0 && entityResult) {
        await this.loadOneToManyRelations(
          entity,
          entityResult as T | T[],
          findOption.relations,
        );
        await this.loadManyToManyRelations(
          entity,
          entityResult as T | T[],
          findOption.relations,
        );
        await this.loadOneToOneRelations(
          entity,
          entityResult as T | T[],
          findOption.relations,
        );
      }

      // Lazy ManyToOne 관계에 대해 Proxy 주입
      // eager가 아니면서 lazy: true인 관계를 찾아 injectLazyProxy를 적용
      const lazyRelations = manyToOneRelations.filter((rel) => {
        return rel.option?.lazy === true && rel.option?.eager !== true;
      });

      if (lazyRelations.length > 0 && entityResult) {
        const entities = Array.isArray(entityResult)
          ? entityResult
          : [entityResult];

        for (const rel of lazyRelations) {
          const joinColumn = rel.joinColumn ?? rel.columnName;
          const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;

          for (const item of entities) {
            const fkValue = (item as any)[joinColumn];
            if (fkValue === undefined || fkValue === null) continue;

            const relatedMetadata = this.resolveEntityMetadata(RelatedEntity);
            if (!relatedMetadata) continue;

            const relatedPk = relatedMetadata.columns.find(
              (col: any) => col.options?.primary,
            );
            if (!relatedPk) continue;

            // 참조를 유지하기 위해 EntityManager 인스턴스를 캡처
            const em = this;
            injectLazyProxy(item as any, rel.columnName, async () => {
              const result = await em.findOne(RelatedEntity, {
                where: { [relatedPk.name!]: fkValue } as any,
              });
              return result as any;
            });
          }
        }
      }

      return entityResult;
    } catch (e: unknown) {
      // 트랜잭션 롤백
      try {
        await transactionHolder.rollback();
      } catch (rollbackError) {
        this.logger.error(`Failed to rollback transaction: ${rollbackError}`);
      }
      throw e;
    } finally {
      // 트랜잭션 종료
      try {
        await transactionHolder.close();
      } catch (closeError) {
        this.logger.error(`Failed to close transaction: ${closeError}`);
      }
    }
  }

  /**
   * 식별자를 DB 타입에 맞게 감싸서 반환합니다.
   * MySQL/MariaDB: 백틱(`) / PostgreSQL: 큰따옴표(")
   */
  wrap(columnName: string) {
    if (this.driver && "wrap" in this.driver) {
      return (this.driver as any).wrap(columnName);
    }
    if (this.isPostgres()) {
      return `"${columnName.replace(/"/g, '""')}"`;
    }
    return `\`${columnName.replace(/`/g, "``")}\``;
  }

  private isMySqlFamily() {
    return ["mysql", "mariadb"].includes(this.client.type as IDatabaseType);
  }

  private isPostgres() {
    return this.client.type === "postgres";
  }

  /**
   * 엔티티를 저장하거나 수정합니다.
   *
   * 주의해야 할 점은 트랜잭션이 자동으로 시작되, SQL 처리 후 커밋 또는 롤백을 수행한다는 점입니다.
   */
  async save<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): Promise<InstanceType<ClazzType<T>>> {
    const metadata = this.resolveEntityMetadata(entity);

    if (!metadata) {
      throw new Error("Entity metadata does not exist.");
    }

    // 유효성 검사 (@NotNull, @MinLength, @MaxLength, @Min, @Max)
    EntityValidator.validate(entity, item);

    // Cascade: ManyToOne 관계의 부모 엔티티를 먼저 저장
    await this.cascadeSaveManyToOne(entity, item);

    const transactionManager = new TransactionSessionManager();

    try {
      await transactionManager.connect();
      await transactionManager.startTransaction();

      // MySQL/MariaDB 전용: autocommit 비활성화
      if (this.isMySqlFamily()) {
        await transactionManager.query("SET autocommit = 0");
      }

      // PostgreSQL의 SERIAL 컬럼은 INSERT 시 생략해야 자동 생성됩니다.
      // MySQL은 null을 넣으면 AUTO_INCREMENT가 동작하지만, PostgreSQL은 NOT NULL 위반이 됩니다.
      // 따라서 auto-increment 컬럼의 값이 없을 때는 INSERT 대상에서 제외합니다.
      const insertableColumns = metadata.columns.filter(
        (column: ColumnMetadata) => {
          const isAutoIncrement = column.options?.autoIncrement;
          const value = (item as any)[column.name!];
          // auto-increment 컬럼이면서 값이 없으면 제외
          if (isAutoIncrement && (value === null || value === undefined)) {
            return false;
          }
          return true;
        },
      );

      const columns = insertableColumns.map((column) => {
        return raw(this.wrap(column.name!));
      });

      const values = insertableColumns.map((column: ColumnMetadata) => {
        return (item as any)[column.name!];
      });

      const pk = metadata.columns.find(
        (column: ColumnMetadata) => column.options?.primary,
      );

      const primaryKeyValue = (item as any)[pk.name!];

      // If the primary key (PK) does not exist, create a new entity.
      if (!primaryKeyValue) {
        // @BeforeInsert 훅 실행
        await this.runHooks(entity, item, "beforeInsert");

        // PostgreSQL: INSERT ... RETURNING "id" 로 생성된 PK를 바로 반환받습니다.
        const isPostgres = this.isPostgres();
        const returningSql = isPostgres
          ? raw(` RETURNING ${this.wrap(pk.name!)}`)
          : raw("");

        const queryResult = (await transactionManager.query<T>(
          sql`
                        INSERT INTO ${raw(this.wrap(metadata.name!))}
                        (${join(columns, ", ")})
                        VALUES (${join(values, ", ")})${returningSql}
                    `,
        )) as { results: any; fields: any };

        await transactionManager.commit();

        if (this.isMySqlFamily()) {
          const result = await this.findOne(entity, {
            where: { [pk.name!]: queryResult?.results?.insertId },
          } as any);

          await this.cascadeSaveOneToMany(entity, item, queryResult?.results?.insertId);
          // @AfterInsert 훅 실행
          await this.runHooks(entity, item, "afterInsert");
          return result as T;
        }

        // PostgreSQL: RETURNING 절로 받은 PK 값으로 조회
        if (isPostgres && queryResult?.results?.length > 0) {
          const insertedId = queryResult.results[0][pk.name!];
          const result = await this.findOne(entity, {
            where: { [pk.name!]: insertedId },
          } as any);

          await this.cascadeSaveOneToMany(entity, item, insertedId);
          // @AfterInsert 훅 실행
          await this.runHooks(entity, item, "afterInsert");
          return result as T;
        }

        // @AfterInsert 훅 실행
        await this.runHooks(entity, item, "afterInsert");
        return queryResult as T;
      }

      // If the primary key (PK) exists, execute the update query.
      // @BeforeUpdate 훅 실행
      await this.runHooks(entity, item, "beforeUpdate");

      const updateMap = metadata.columns.map((column: ColumnMetadata) => {
        return sql`${raw(this.wrap(column.name!))} = ${(item as any)[column.name!]}`;
      });

      await transactionManager.query<T>(
        sql`
          UPDATE ${raw(this.wrap(metadata.name!))}
          SET ${join(updateMap, ", ")}
          WHERE ${raw(this.wrap(pk.name!))} = ${primaryKeyValue}
                `,
      );

      await transactionManager.commit();

      await this.cascadeSaveOneToMany(entity, item, primaryKeyValue);

      // @AfterUpdate 훅 실행
      await this.runHooks(entity, item, "afterUpdate");

      // Retrieve and return the updated entity.
      const result = await this.findOne(entity, {
        where: { [pk.name!]: primaryKeyValue },
      } as any);

      return result as T;
    } catch (e: unknown) {
      try {
        await transactionManager.rollback();
      } catch (rollbackError) {
        this.logger.error(`Failed to rollback transaction: ${rollbackError}`);
      }
      throw e;
    } finally {
      try {
        await transactionManager.close();
      } catch (closeError) {
        this.logger.error(`Failed to close transaction: ${closeError}`);
      }
    }
  }

  /**
   * 여러 엔티티를 PK 목록으로 일괄 삭제합니다.
   * DELETE FROM table WHERE pk IN (?, ?, ...) 단일 쿼리로 수행합니다.
   *
   * @param entity 엔티티 클래스
   * @param ids 삭제할 PK 값 배열
   * @returns 삭제된 행 수를 포함하는 DeleteResult
   */
  async deleteMany<T>(
    entity: ClazzType<T>,
    ids: any[],
  ): Promise<DeleteResult> {
    if (ids.length === 0) {
      return { affected: 0 };
    }

    const metadata = this.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new Error("Entity metadata does not exist.");
    }

    const pk = metadata.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );
    if (!pk) {
      throw new Error("Primary key column not found.");
    }

    const transactionManager = new TransactionSessionManager();

    try {
      await transactionManager.connect();
      await transactionManager.startTransaction();

      if (this.isMySqlFamily()) {
        await transactionManager.query("SET autocommit = 0");
      }

      const placeholders = join(
        ids.map((id) => sql`${id}`),
        ", ",
      );

      const deleteQuery = sql`DELETE FROM ${raw(this.wrap(metadata.name!))} WHERE ${raw(this.wrap(pk.name!))} IN (${placeholders})`;

      const queryResult = (await transactionManager.query(
        deleteQuery,
      )) as { results: any; fields: any };

      await transactionManager.commit();

      let affected = 0;
      if (this.isMySqlFamily()) {
        affected = queryResult?.results?.affectedRows ?? 0;
      } else {
        affected = queryResult?.results?.rowCount ?? 0;
      }

      return { affected };
    } catch (e: unknown) {
      try {
        await transactionManager.rollback();
      } catch (rollbackError) {
        this.logger.error(`Failed to rollback transaction: ${rollbackError}`);
      }
      throw e;
    } finally {
      try {
        await transactionManager.close();
      } catch (closeError) {
        this.logger.error(`Failed to close transaction: ${closeError}`);
      }
    }
  }

  /**
   * 여러 엔티티를 단일 트랜잭션으로 저장합니다.
   * 각 아이템에 PK가 없으면 INSERT, 있으면 UPDATE를 수행합니다.
   *
   * @param entity 엔티티 클래스
   * @param items 저장할 엔티티 배열
   * @returns 저장된 엔티티 배열
   */
  async saveMany<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
  ): Promise<InstanceType<ClazzType<T>>[]> {
    if (items.length === 0) {
      return [];
    }

    const results: InstanceType<ClazzType<T>>[] = [];
    for (const item of items) {
      const saved = await this.save(entity, item);
      results.push(saved);
    }
    return results;
  }

  /**
   * 여러 엔티티를 단일 INSERT INTO ... VALUES (...), (...) 쿼리로 삽입합니다.
   * 기존 save()와 달리 PK 존재 여부를 확인하지 않고 항상 INSERT를 수행합니다.
   * 성능 최적화를 위해 모든 행을 하나의 쿼리로 삽입합니다.
   *
   * @param entity 엔티티 클래스
   * @param items 삽입할 엔티티 배열
   * @returns 삽입된 행 수
   */
  async insertMany<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
  ): Promise<{ affected: number }> {
    if (items.length === 0) {
      return { affected: 0 };
    }

    const metadata = this.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new Error("Entity metadata does not exist.");
    }

    const transactionManager = new TransactionSessionManager();

    try {
      await transactionManager.connect();
      await transactionManager.startTransaction();

      if (this.isMySqlFamily()) {
        await transactionManager.query("SET autocommit = 0");
      }

      // auto-increment PK 컬럼을 제외한 삽입 대상 컬럼 결정
      const insertableColumns = metadata.columns.filter(
        (column: ColumnMetadata) => {
          const isAutoIncrement = column.options?.autoIncrement;
          if (!isAutoIncrement) return true;
          // auto-increment 컬럼은 모든 아이템에서 값이 없는 경우에만 제외
          return items.every(
            (item) =>
              (item as any)[column.name!] !== null &&
              (item as any)[column.name!] !== undefined,
          );
        },
      );

      const columns = insertableColumns.map((column) =>
        raw(this.wrap(column.name!)),
      );

      // 각 아이템의 값을 VALUES 절로 구성
      const valueRows = items.map((item) => {
        const rowValues = insertableColumns.map(
          (column: ColumnMetadata) => (item as any)[column.name!],
        );
        return sql`(${join(rowValues, ", ")})`;
      });

      const queryStr = sql`INSERT INTO ${raw(this.wrap(metadata.name!))} (${join(columns, ", ")}) VALUES ${join(valueRows, ", ")}`;

      const queryResult = (await transactionManager.query(
        queryStr,
      )) as { results: any; fields: any };

      await transactionManager.commit();

      let affected = items.length;
      if (this.isMySqlFamily()) {
        affected = queryResult?.results?.affectedRows ?? items.length;
      } else if (queryResult?.results?.rowCount !== undefined) {
        affected = queryResult.results.rowCount;
      }

      return { affected };
    } catch (e: unknown) {
      try {
        await transactionManager.rollback();
      } catch (rollbackError) {
        this.logger.error(`Failed to rollback transaction: ${rollbackError}`);
      }
      throw e;
    } finally {
      try {
        await transactionManager.close();
      } catch (closeError) {
        this.logger.error(`Failed to close transaction: ${closeError}`);
      }
    }
  }

  /**
   * 주어진 조건에 맞는 엔티티를 데이터베이스에서 삭제합니다.
   *
   * @param entity 삭제할 엔티티 클래스
   * @param criteria WHERE 조건
   * @returns 삭제된 행 수를 포함하는 DeleteResult
   */
  async delete<T>(
    entity: ClazzType<T>,
    criteria: { [K in keyof T]?: T[K] },
  ): Promise<DeleteResult> {
    const metadata = this.resolveEntityMetadata(entity);

    if (!metadata) {
      throw new Error("Entity metadata does not exist.");
    }

    const transactionManager = new TransactionSessionManager();

    try {
      await transactionManager.connect();
      await transactionManager.startTransaction();

      if (this.isMySqlFamily()) {
        await transactionManager.query("SET autocommit = 0");
      }

      // @BeforeDelete 훅 실행
      await this.runHooks(entity, criteria, "beforeDelete");

      // cascade remove: 자식 엔티티를 먼저 삭제합니다.
      await this.cascadeDeleteOneToMany(entity, criteria);

      const whereMap: Sql[] = [];
      for (const key in criteria) {
        const value = (criteria as any)[key];
        if (value !== undefined && value !== null) {
          whereMap.push(Conditions.equals(this.wrap(key), value));
        }
      }

      if (whereMap.length === 0) {
        throw new Error(
          "Delete without conditions is not allowed. Provide at least one criterion.",
        );
      }

      const whereSql = join(whereMap, " AND ");

      const deleteQuery = sql`DELETE FROM ${raw(this.wrap(metadata.name!))} WHERE ${whereSql}`;

      const queryResult = (await transactionManager.query(
        deleteQuery,
      )) as { results: any; fields: any };

      await transactionManager.commit();

      let affected = 0;
      if (this.isMySqlFamily()) {
        affected = queryResult?.results?.affectedRows ?? 0;
      } else {
        // PostgreSQL: rowCount is on the results object
        affected = queryResult?.results?.rowCount ?? 0;
      }

      // @AfterDelete 훅 실행
      await this.runHooks(entity, criteria, "afterDelete");

      return { affected };
    } catch (e: unknown) {
      try {
        await transactionManager.rollback();
      } catch (rollbackError) {
        this.logger.error(`Failed to rollback transaction: ${rollbackError}`);
      }
      throw e;
    } finally {
      try {
        await transactionManager.close();
      } catch (closeError) {
        this.logger.error(`Failed to close transaction: ${closeError}`);
      }
    }
  }

  /**
   * @DeletedAt 컬럼이 있는 엔티티에 대해 soft delete를 수행합니다.
   * deleted_at 컬럼을 현재 시각으로 UPDATE합니다.
   */
  async softDelete<T>(
    entity: ClazzType<T>,
    criteria: { [K in keyof T]?: T[K] },
  ): Promise<DeleteResult> {
    const metadata = this.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new Error("Entity metadata does not exist.");
    }

    const deletedAtColumn = this.getDeletedAtColumn(entity);
    if (!deletedAtColumn) {
      throw new Error(
        `Entity "${entity.name}" does not have a @DeletedAt column. Use delete() instead.`,
      );
    }

    const transactionManager = new TransactionSessionManager();

    try {
      await transactionManager.connect();
      await transactionManager.startTransaction();

      if (this.isMySqlFamily()) {
        await transactionManager.query("SET autocommit = 0");
      }

      const whereMap: Sql[] = [];
      for (const key in criteria) {
        const value = (criteria as any)[key];
        if (value !== undefined && value !== null) {
          whereMap.push(Conditions.equals(this.wrap(key), value));
        }
      }

      if (whereMap.length === 0) {
        throw new Error(
          "Soft delete without conditions is not allowed. Provide at least one criterion.",
        );
      }

      const whereSql = join(whereMap, " AND ");

      const nowExpr = this.isPostgres() ? raw("NOW()") : raw("NOW()");
      const updateQuery = sql`UPDATE ${raw(this.wrap(metadata.name!))} SET ${raw(this.wrap(deletedAtColumn))} = ${nowExpr} WHERE ${whereSql}`;

      const queryResult = (await transactionManager.query(
        updateQuery,
      )) as { results: any; fields: any };

      await transactionManager.commit();

      let affected = 0;
      if (this.isMySqlFamily()) {
        affected = queryResult?.results?.affectedRows ?? 0;
      } else {
        affected = queryResult?.results?.rowCount ?? 0;
      }

      return { affected };
    } catch (e: unknown) {
      try {
        await transactionManager.rollback();
      } catch (rollbackError) {
        this.logger.error(`Failed to rollback transaction: ${rollbackError}`);
      }
      throw e;
    } finally {
      try {
        await transactionManager.close();
      } catch (closeError) {
        this.logger.error(`Failed to close transaction: ${closeError}`);
      }
    }
  }

  /**
   * soft delete된 엔티티를 복원합니다.
   * deleted_at 컬럼을 NULL로 UPDATE합니다.
   */
  async restore<T>(
    entity: ClazzType<T>,
    criteria: { [K in keyof T]?: T[K] },
  ): Promise<DeleteResult> {
    const metadata = this.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new Error("Entity metadata does not exist.");
    }

    const deletedAtColumn = this.getDeletedAtColumn(entity);
    if (!deletedAtColumn) {
      throw new Error(
        `Entity "${entity.name}" does not have a @DeletedAt column. Cannot restore.`,
      );
    }

    const transactionManager = new TransactionSessionManager();

    try {
      await transactionManager.connect();
      await transactionManager.startTransaction();

      if (this.isMySqlFamily()) {
        await transactionManager.query("SET autocommit = 0");
      }

      const whereMap: Sql[] = [];
      for (const key in criteria) {
        const value = (criteria as any)[key];
        if (value !== undefined && value !== null) {
          whereMap.push(Conditions.equals(this.wrap(key), value));
        }
      }

      if (whereMap.length === 0) {
        throw new Error(
          "Restore without conditions is not allowed. Provide at least one criterion.",
        );
      }

      const whereSql = join(whereMap, " AND ");

      const restoreQuery = sql`UPDATE ${raw(this.wrap(metadata.name!))} SET ${raw(this.wrap(deletedAtColumn))} = NULL WHERE ${whereSql}`;

      const queryResult = (await transactionManager.query(
        restoreQuery,
      )) as { results: any; fields: any };

      await transactionManager.commit();

      let affected = 0;
      if (this.isMySqlFamily()) {
        affected = queryResult?.results?.affectedRows ?? 0;
      } else {
        affected = queryResult?.results?.rowCount ?? 0;
      }

      return { affected };
    } catch (e: unknown) {
      try {
        await transactionManager.rollback();
      } catch (rollbackError) {
        this.logger.error(`Failed to rollback transaction: ${rollbackError}`);
      }
      throw e;
    } finally {
      try {
        await transactionManager.close();
      } catch (closeError) {
        this.logger.error(`Failed to close transaction: ${closeError}`);
      }
    }
  }

  /**
   * save 시 cascade: "insert" | "update" 가 설정된 OneToMany 관계의 자식 엔티티를 재귀적으로 저장합니다.
   */
  private async cascadeSaveOneToMany<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
    savedParentId: any,
  ): Promise<void> {
    const oneToManyMeta = this.resolveOneToManyMetadata(entity);

    for (const rel of oneToManyMeta) {
      const children = (item as any)[rel.propertyKey];
      if (!children || !Array.isArray(children) || children.length === 0)
        continue;

      const RelatedEntity = rel.getRelatedEntity();

      // cascade: "insert" 또는 "update" 가 포함된 경우에만 처리
      if (!hasCascade(rel.cascade, "insert") && !hasCascade(rel.cascade, "update"))
        continue;

      // ManyToOne 측의 joinColumn 찾기
      const manyToOneItems = this.resolveManyToOneMetadata(RelatedEntity);
      const matchingRelation = manyToOneItems.find(
        (m) => m.columnName === rel.mappedBy,
      );
      const fkColumn = matchingRelation?.joinColumn ?? rel.mappedBy;

      for (const child of children) {
        // FK를 부모의 PK로 설정
        (child as any)[fkColumn] = savedParentId;
        await this.save(RelatedEntity, child);
      }
    }
  }

  /**
   * save 시 cascade: "insert" | "update" 가 설정된 ManyToOne 관계의 부모 엔티티를 먼저 저장합니다.
   */
  private async cascadeSaveManyToOne<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): Promise<void> {
    const manyToOneRelations = this.resolveManyToOneMetadata(entity);

    for (const rel of manyToOneRelations) {
      const relatedValue = (item as any)[rel.columnName];
      if (!relatedValue || typeof relatedValue !== "object") continue;

      if (!hasCascade(rel.option?.cascade, "insert") && !hasCascade(rel.option?.cascade, "update"))
        continue;

      const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
      const saved = await this.save(RelatedEntity, relatedValue);

      // 저장된 부모의 PK를 FK 컬럼에 설정
      const relatedMetadata = this.resolveEntityMetadata(RelatedEntity);
      if (relatedMetadata) {
        const relatedPk = relatedMetadata.columns.find(
          (col: any) => col.options?.primary,
        );
        if (relatedPk && rel.joinColumn) {
          (item as any)[rel.joinColumn] = (saved as any)[relatedPk.name!];
        }
      }
    }
  }

  /**
   * delete 시 cascade: "delete" (또는 "remove") 가 설정된 OneToMany 관계의 자식 엔티티를 먼저 삭제합니다.
   */
  private async cascadeDeleteOneToMany<T>(
    entity: ClazzType<T>,
    criteria: { [K in keyof T]?: T[K] },
  ): Promise<void> {
    const oneToManyMeta = this.resolveOneToManyMetadata(entity);

    for (const rel of oneToManyMeta) {
      if (!hasCascade(rel.cascade, "delete")) continue;

      const RelatedEntity = rel.getRelatedEntity();

      // 삭제 대상 부모를 조회하여 PK를 획득
      const parentMetadata = this.resolveEntityMetadata(entity);
      if (!parentMetadata) continue;

      const pk = parentMetadata.columns.find(
        (col: any) => col.options?.primary,
      );
      if (!pk) continue;

      const parents = await this.find(entity, {
        where: criteria,
      } as any);

      if (!parents) continue;

      const parentArray = Array.isArray(parents) ? parents : [parents];

      // ManyToOne 측의 FK 컬럼 찾기
      const manyToOneItems = this.resolveManyToOneMetadata(RelatedEntity);
      const matchingRelation = manyToOneItems.find(
        (m) => m.columnName === rel.mappedBy,
      );
      const fkColumn = matchingRelation?.joinColumn ?? rel.mappedBy;

      for (const parent of parentArray) {
        const parentId = (parent as any)[pk.name!];
        if (parentId === undefined || parentId === null) continue;

        await this.delete(RelatedEntity, {
          [fkColumn]: parentId,
        } as any);
      }
    }
  }

  /**
   * 집계 함수를 실행하는 내부 헬퍼입니다.
   */
  private async aggregate<T>(
    entity: ClazzType<T>,
    fn: string,
    field: string,
    where?: { [K in keyof T]?: T[K] },
  ): Promise<number> {
    const metadata = this.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new Error("Entity metadata does not exist.");
    }

    const transactionManager = new TransactionSessionManager();

    try {
      await transactionManager.connect();
      await transactionManager.startTransaction();

      if (this.isMySqlFamily()) {
        await transactionManager.query("SET autocommit = 0");
      }

      const tableName = metadata.name!;
      const selectExpr = raw(
        `${fn}(${field === "*" ? "*" : this.wrap(field)})`,
      );

      const whereMap: Sql[] = [];
      if (where) {
        for (const key in where) {
          const value = (where as any)[key];
          if (value !== undefined && value !== null) {
            whereMap.push(Conditions.equals(this.wrap(key), value));
          }
        }
      }

      let queryStr: Sql;
      if (whereMap.length > 0) {
        const whereSql = join(whereMap, " AND ");
        queryStr = sql`SELECT ${selectExpr} AS ${raw(this.wrap("result"))} FROM ${raw(this.wrap(tableName))} WHERE ${whereSql}`;
      } else {
        queryStr = sql`SELECT ${selectExpr} AS ${raw(this.wrap("result"))} FROM ${raw(this.wrap(tableName))}`;
      }

      const queryResult = (await transactionManager.query(
        queryStr,
      )) as QueryResult;

      await transactionManager.commit();

      const { results } = queryResult;
      if (!results || results.length === 0) return 0;

      const row = results[0];
      const value = row.result ?? row["result"];
      return value === null || value === undefined ? 0 : Number(value);
    } catch (e: unknown) {
      try {
        await transactionManager.rollback();
      } catch (rollbackError) {
        this.logger.error(`Failed to rollback transaction: ${rollbackError}`);
      }
      throw e;
    } finally {
      try {
        await transactionManager.close();
      } catch (closeError) {
        this.logger.error(`Failed to close transaction: ${closeError}`);
      }
    }
  }

  /**
   * 조건에 맞는 엔티티 수를 반환합니다.
   */
  async count<T>(
    entity: ClazzType<T>,
    where?: { [K in keyof T]?: T[K] },
  ): Promise<number> {
    return this.aggregate(entity, "COUNT", "*", where);
  }

  /**
   * 조건에 맞는 엔티티의 특정 필드 합계를 반환합니다.
   */
  async sum<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: { [K in keyof T]?: T[K] },
  ): Promise<number> {
    return this.aggregate(entity, "SUM", field, where);
  }

  /**
   * 조건에 맞는 엔티티의 특정 필드 평균을 반환합니다.
   */
  async avg<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: { [K in keyof T]?: T[K] },
  ): Promise<number> {
    return this.aggregate(entity, "AVG", field, where);
  }

  /**
   * 조건에 맞는 엔티티의 특정 필드 최솟값을 반환합니다.
   */
  async min<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: { [K in keyof T]?: T[K] },
  ): Promise<number> {
    return this.aggregate(entity, "MIN", field, where);
  }

  /**
   * 조건에 맞는 엔티티의 특정 필드 최댓값을 반환합니다.
   */
  async max<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: { [K in keyof T]?: T[K] },
  ): Promise<number> {
    return this.aggregate(entity, "MAX", field, where);
  }

  getRepository<T>(entity: ClazzType<T>) {
    return BaseRepository.of(entity, this);
  }

  /**
   * 특정 테넌트 컨텍스트 내에서 작업을 실행합니다.
   * AsyncLocalStorage를 사용하여 콜백 내부의 모든 메타데이터 조회가
   * 해당 테넌트의 레이어에서 수행됩니다.
   *
   * @param tenantId 테넌트 식별자
   * @param callback 테넌트 컨텍스트 내에서 실행할 비동기 작업
   * @returns 콜백의 반환값
   *
   * @example
   * ```ts
   * const result = await entityManager.withTenant("tenant_1", async (em) => {
   *   return em.find(User, { where: { id: 1 } });
   * });
   * ```
   */
  async withTenant<R>(
    tenantId: string,
    callback: (em: this) => Promise<R>,
  ): Promise<R> {
    return MetadataContext.run(tenantId, () => callback(this)) as Promise<R>;
  }
}
