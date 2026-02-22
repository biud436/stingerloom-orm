/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { ClazzType, Logger, ReflectManager } from "../utils";
import {
  ColumnMetadata,
  EntityScannerMetadata,
  EntityScanner,
  ManyToOneScanner,
} from "../scanner";
import Container from "typedi";
import { DatabaseClient } from "../DatabaseClient";
import { MySqlDriver } from "../dialects/mysql/MySqlDriver";
import { PostgresDriver } from "../dialects/postgres/PostgresDriver";
import { ISqlDriver } from "../dialects/SqlDriver";
import { INDEX_TOKEN, IndexMetadata } from "../decorators/Indexer";
import { IDatabaseType } from "../dialects/mysql/MySqlConnector";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import { FindOption } from "../dialects/FindOption";
import { IDataSource } from "../dialects/IDataSource";
import { MySqlDataSource } from "../dialects/mysql/MySqlDataSource";
import { PostgresDataSource } from "../dialects/postgres/PostgresDataSource";
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
import { DeleteResult } from "../types/DeleteResult";
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
      case "postgres":
        this.driver = new PostgresDriver(
          connector,
          client.type,
          databaseClientOptions.schema,
        );
        this.dataSource = new PostgresDataSource(connector);
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

      if (!select) {
        selectMap.push(
          ...metadata.columns.map((column) => this.wrap(column.name!)),
        );
      }

      for (const key in where) {
        const value = where[key];
        if (value) {
          whereMap.push(Conditions.equals(this.wrap(key), value));
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
        .from(this.wrap(metadata.name!))
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

          return result as T;
        }

        // PostgreSQL: RETURNING 절로 받은 PK 값으로 조회
        if (isPostgres && queryResult?.results?.length > 0) {
          const insertedId = queryResult.results[0][pk.name!];
          const result = await this.findOne(entity, {
            where: { [pk.name!]: insertedId },
          } as any);

          return result as T;
        }

        return queryResult as T;
      }

      // If the primary key (PK) exists, execute the update query.
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
