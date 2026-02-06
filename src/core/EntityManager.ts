/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { ClazzType, Logger, ReflectManager } from "../utils";
import {
  ColumnMetadata,
  EntityScannerMetadata,
  EntityScanner,
} from "../scanner";
import Container from "typedi";
import { DatabaseClient } from "../DatabaseClient";
import { MySqlDriver } from "../dialects/mysql/MySqlDriver";
import { ISqlDriver } from "../dialects/SqlDriver";
import { INDEX_TOKEN, IndexMetadata } from "../decorators/Indexer";
import { IDatabaseType } from "../dialects/mysql/MySqlConnector";
import { TransactionHolder } from "../dialects/TransactionHolder";
import { FindOption } from "../dialects/FindOption";
import { IDataSource } from "../dialects/IDataSource";
import { MySqlDataSource } from "../dialects/mysql/MySqlDataSource";
import sql, { Sql, join, raw } from "sql-template-tag";
import {
  ENTITY_TOKEN,
  MANY_TO_ONE_TOKEN,
  ManyToOneMetadata,
} from "../decorators";
import { BaseRepository } from "./BaseRepository";
import { BaseEntityManager } from "./BaseEntityManager";
import { ResultSetHeader } from "mysql2";
import { EntityNotFound } from "../dialects/EntityNotFound";
import { QueryResult } from "../types/QueryResult";
import { EntityResult } from "../types/EntityResult";
import { RawQueryBuilderFactory } from "./RawQueryBuilderFactory";
import { Conditions } from "./Conditions";
import { ResultTransformerFactory } from "./ResultTransformerFactory";
import { DatabaseClientOptions } from "./DatabaseClientOptions";
import { MetadataContext } from "../metadata/MetadataContext";

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

  private async registerForeignKeys(
    TargetEntity: ClazzType<any>,
    tableName: string,
  ) {
    // 엔티티 매니저를 가지고 옵니다.
    const entityScanner = Container.get(EntityScanner);

    // ManyToOne 관계를 가져옵니다.
    const manyToOneItems = Reflect.getMetadata(
      MANY_TO_ONE_TOKEN,
      TargetEntity.prototype,
    ) as ManyToOneMetadata<any>[];

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
  }

  /**
   * 인덱스를 생성합니다.
   *
   * @param TargetEntity
   * @param tableName
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
          if (idx["Key_name"] === indexName) {
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
    findOption: FindOption<T>,
  ): Promise<EntityResult<T>> {
    const { select, orderBy, where, take } = findOption;
    const { limit } = findOption;

    const transactionHolder = new TransactionHolder();
    const resultTransformer = ResultTransformerFactory.create();

    try {
      // 트랜잭션을 시작합니다.
      await transactionHolder.connect();
      await transactionHolder.startTransaction();
      await transactionHolder.query("SET autocommit = 0");

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

      if (!select) {
        selectMap.push(...metadata.columns.map((column) => column.name!));
      }

      for (const key in where) {
        const value = where[key];
        if (value) {
          whereMap.push(Conditions.equals(key, value));
        }
      }

      for (const key in orderBy) {
        const value = orderBy[key];
        if (value) {
          orderByMap.push({ column: key, direction: value });
        }
      }

      // Query를 구성합니다.
      qb.select(selectMap)
        .from(metadata.name!)
        .where(whereMap)
        .orderBy(orderByMap);

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
      if (isEntityArray) {
        return resultTransformer.toEntities(entity, queryResult);
      } else {
        return resultTransformer.toEntity(entity, queryResult);
      }
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
   * 백틱으로 감싸지 않은 컬럼 이름을 백틱으로 감싸서 반환합니다.
   */
  wrap(columnName: string) {
    return `\`${columnName}\``;
  }

  private isMySqlFamily() {
    return ["mysql", "mariadb"].includes(this.client.type as IDatabaseType);
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

    const transactionHolder = new TransactionHolder();

    try {
      await transactionHolder.connect();
      await transactionHolder.startTransaction();

      await transactionHolder.query("SET autocommit = 0");

      const columns = metadata.columns.map((column) => {
        return raw(column.name!);
      });

      const values = metadata.columns.map((column: ColumnMetadata) => {
        return (item as any)[column.name!];
      });

      const pk = metadata.columns.find(
        (column: ColumnMetadata) => column.options?.primary,
      );

      const primaryKeyValue = (item as any)[pk.name!];

      // If the primary key (PK) does not exist, create a new entity.
      if (!primaryKeyValue) {
        const queryResult = (await transactionHolder.query<T>(
          sql`
                        INSERT INTO ${raw(this.wrap(metadata.name!))}
                        (${join(columns, ", ")})
                        VALUES (${join(values, ", ")})
                    `,
        )) as { results: ResultSetHeader; fields: any };

        await transactionHolder.commit();

        if (this.isMySqlFamily()) {
          const result = await this.findOne(entity, {
            where: { [pk.name!]: queryResult?.results?.insertId },
          } as any);

          return result as T;
        }

        return queryResult as T;
      }

      // If the primary key (PK) exists, execute the update query.
      const updateMap = metadata.columns.map((column: ColumnMetadata) => {
        return sql`${raw(column.name!)} = ${(item as any)[column.name!]}`;
      });

      await transactionHolder.query<T>(
        sql`
                    UPDATE ${raw(this.wrap(metadata.name!))}
                    SET ${join(updateMap, ", ")}
                    WHERE ${raw(pk.name!)} = ${primaryKeyValue}
                `,
      );

      await transactionHolder.commit();

      // Retrieve and return the updated entity.
      const result = await this.findOne(entity, {
        where: { [pk.name!]: primaryKeyValue },
      } as any);

      return result as T;
    } catch (e: unknown) {
      try {
        await transactionHolder.rollback();
      } catch (rollbackError) {
        this.logger.error(`Failed to rollback transaction: ${rollbackError}`);
      }
      throw e;
    } finally {
      try {
        await transactionHolder.close();
      } catch (closeError) {
        this.logger.error(`Failed to close transaction: ${closeError}`);
      }
    }
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
