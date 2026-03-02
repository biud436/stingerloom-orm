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
import { MssqlDriver } from "../dialects/mssql/MssqlDriver";
import { ISqlDriver } from "../dialects/SqlDriver";
import { SchemaGenerator } from "./SchemaGenerator";
import { INDEX_TOKEN, IndexMetadata } from "../decorators/Indexer";
import {
  UNIQUE_INDEX_TOKEN,
  UniqueIndexMetadata,
} from "../decorators/UniqueIndex";
import { IDatabaseType } from "../dialects/mysql/MySqlConnector";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import { FindOption } from "../dialects/FindOption";
import { ISelectOption } from "../dialects/ISelectOption";
import { IDataSource } from "../dialects/IDataSource";
import { MySqlDataSource } from "../dialects/mysql/MySqlDataSource";
import { PostgresDataSource } from "../dialects/postgres/PostgresDataSource";
import { SqliteDataSource } from "../dialects/sqlite/SqliteDataSource";
import { MssqlDataSource } from "../dialects/mssql/MssqlDataSource";
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
  COLUMN_TOKEN,
} from "../decorators";
import { BaseRepository } from "./BaseRepository";
import { BaseEntityManager } from "./BaseEntityManager";
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
import {
  EntityEventEmitter,
  EntityEventType,
  EntityEventListener,
} from "./EntityEventEmitter";
import { EntityMetadataNotFoundError } from "../errors/EntityMetadataNotFoundError";
import { InvalidQueryError } from "../errors/InvalidQueryError";
import { PrimaryKeyNotFoundError } from "../errors/PrimaryKeyNotFoundError";
import { DeleteWithoutConditionsError } from "../errors/DeleteWithoutConditionsError";
import { NotSupportedDatabaseTypeError } from "../errors/NotSupportedDatabaseTypeError";
import {
  EntitySubscriber,
  InsertEvent,
  UpdateEvent,
  DeleteEvent,
} from "./EntitySubscriber";
import { QueryTracker, QueryLogEntry } from "./QueryTracker";
import { LoggingOptions } from "./DatabaseClientOptions";
import {
  CursorPaginationOption,
  CursorPaginationResult,
  encodeCursor,
  decodeCursor,
  normalizePageSize,
} from "./CursorPagination";
import { ExplainResult } from "./ExplainResult";
import {
  ReplicationRouter,
  ReplicationNodeConfig,
} from "../dialects/ReplicationRouter";

export class EntityManager implements BaseEntityManager {
  private _entities: ClazzType<any>[] = [];
  private readonly logger = new Logger(EntityManager.name);
  private driver?: ISqlDriver;
  private dataSource?: IDataSource;
  private dirtyEntities: Set<InstanceType<ClazzType<any>>> = new Set();
  private readonly eventEmitter = new EntityEventEmitter();
  private readonly subscribers: EntitySubscriber<any>[] = [];
  private queryTracker: QueryTracker | null = null;
  private defaultQueryTimeout: number | undefined;
  private replicationRouter: ReplicationRouter | null = null;

  /**
   * 이 EntityManager가 사용할 연결 이름.
   * 멀티 데이터베이스 환경에서 각 EntityManager 인스턴스는 서로 다른 connectionName을 가질 수 있습니다.
   * 기본값은 'default'.
   */
  private connectionName = "default";

  /**
   * 연결된 DB 타입. connect() 시 캐싱됩니다. (isMySqlFamily/isPostgres 내부 분기용)
   */
  private dbType: IDatabaseType | undefined;

  public async register(
    databaseClientOptions: DatabaseClientOptions,
    connectionName = "default",
  ) {
    await this.connect(databaseClientOptions, connectionName);
    await this.registerEntities();
  }

  get client() {
    return DatabaseClient.getInstance();
  }

  get connection() {
    // getConnection(name) 지원 여부에 따라 분기 (하위 호환)
    const c = this.client as any;
    if (typeof c.getConnection === "function") {
      return c.getConnection(this.connectionName);
    }
    return c.getConnection();
  }

  /**
   * 이 EntityManager가 사용하는 연결 이름을 반환합니다.
   */
  getConnectionName(): string {
    return this.connectionName;
  }

  public async connect(
    databaseClientOptions: DatabaseClientOptions,
    connectionName = "default",
  ) {
    this.connectionName = connectionName;

    const client = this.client as any;
    const connector = await client.connect(
      databaseClientOptions,
      connectionName,
    );
    const { schema, queryTimeout, replication } = databaseClientOptions;

    // getType()이 있으면 사용, 없으면 (레거시 mock) client.type 사용
    const dbType = (
      typeof client.getType === "function"
        ? client.getType(connectionName)
        : client.type
    ) as IDatabaseType;

    this.dbType = dbType;

    switch (dbType) {
      case "mariadb":
      case "mysql":
        this.driver = new MySqlDriver(connector, dbType);
        this.dataSource = new MySqlDataSource(connector);
        break;
      case "postgres":
        this.driver = new PostgresDriver(connector, dbType, schema);
        this.dataSource = new PostgresDataSource(connector);
        break;
      case "sqlite":
        this.driver = new SqliteDriver(connector);
        this.dataSource = new SqliteDataSource(connector);
        break;
      case "mssql":
        this.driver = new MssqlDriver(connector);
        this.dataSource = new MssqlDataSource(connector);
        break;
      default:
        throw new NotSupportedDatabaseTypeError();
    }

    // QueryTracker 초기화 (logging 옵션 기반)
    this.initQueryTracker(databaseClientOptions);

    // connection-level 쿼리 타임아웃 설정
    const isTimeoutSupported = queryTimeout && queryTimeout > 0;

    if (isTimeoutSupported) {
      this.defaultQueryTimeout = queryTimeout;
    }

    // ReplicationRouter 초기화
    if (replication) {
      this.replicationRouter = new ReplicationRouter(replication);
    }
  }

  private initQueryTracker(options: DatabaseClientOptions): void {
    const logging = options.logging;
    if (typeof logging === "object" && logging !== null) {
      const loggingOpts = logging as LoggingOptions;
      if (loggingOpts.nPlusOne || loggingOpts.slowQueryMs) {
        this.queryTracker = new QueryTracker({
          slowQueryMs: loggingOpts.slowQueryMs ?? null,
        });
      }
    }
  }

  /**
   * 현재 세션의 쿼리 실행 로그를 반환합니다.
   */
  getQueryLog(): ReadonlyArray<QueryLogEntry> {
    return this.queryTracker?.getLog() ?? [];
  }

  /**
   * 쿼리 실행을 추적합니다. QueryTracker가 활성화된 경우에만 동작합니다.
   */
  private trackQuery(
    entityName: string,
    sqlText: string,
    durationMs: number,
  ): void {
    this.queryTracker?.track(entityName, sqlText, durationMs);
  }

  /**
   * 읽기 쿼리에 사용할 노드 설정을 반환합니다.
   * replication이 설정되지 않았으면 null을 반환합니다.
   *
   * @param useMaster true이면 강제로 master 노드를 사용합니다.
   */
  getReadNode(useMaster?: boolean): ReplicationNodeConfig | null {
    if (!this.replicationRouter) return null;
    if (useMaster) return this.replicationRouter.getWriteNode();
    return this.replicationRouter.getReadNode();
  }

  /**
   * 쓰기 쿼리에 사용할 노드 설정을 반환합니다.
   * replication이 설정되지 않았으면 null을 반환합니다.
   */
  getWriteNode(): ReplicationNodeConfig | null {
    if (!this.replicationRouter) return null;
    return this.replicationRouter.getWriteNode();
  }

  /**
   * Replication이 활성화되어 있는지 확인합니다.
   */
  get isReplicationEnabled(): boolean {
    return this.replicationRouter !== null;
  }

  /**
   * Replication router에 접근합니다.
   */
  getReplicationRouter(): ReplicationRouter | null {
    return this.replicationRouter;
  }

  /**
   * 엔티티 이벤트 리스너를 등록합니다.
   */
  on(event: EntityEventType, listener: EntityEventListener): void {
    this.eventEmitter.on(event, listener);
  }

  /**
   * 엔티티 이벤트 리스너를 제거합니다.
   */
  off(event: EntityEventType, listener: EntityEventListener): void {
    this.eventEmitter.off(event, listener);
  }

  /**
   * 모든 이벤트 리스너를 제거합니다.
   */
  removeAllListeners(): void {
    this.eventEmitter.removeAllListeners();
  }

  /**
   * EntitySubscriber를 등록합니다.
   * listenTo()가 반환하는 엔티티 클래스에 해당하는 이벤트만 전달됩니다.
   */
  addSubscriber(subscriber: EntitySubscriber<any>): void {
    this.subscribers.push(subscriber);
  }

  /**
   * 등록된 EntitySubscriber를 제거합니다.
   */
  removeSubscriber(subscriber: EntitySubscriber<any>): void {
    const idx = this.subscribers.indexOf(subscriber);
    if (idx !== -1) {
      this.subscribers.splice(idx, 1);
    }
  }

  /**
   * 엔티티 클래스에 매칭되는 subscriber의 특정 메서드를 호출합니다.
   */
  private async notifySubscribers<T>(
    entityClass: new (...args: any[]) => T,
    method: keyof EntitySubscriber<T>,
    arg?: any,
  ): Promise<void> {
    for (const sub of this.subscribers) {
      if (sub.listenTo() === entityClass && typeof sub[method] === "function") {
        await (sub[method] as Function)(arg);
      }
    }
  }

  /**
   * 트랜잭션 관련 subscriber 메서드를 호출합니다 (엔티티 필터 없음).
   */
  private async notifyTransactionSubscribers(
    method: keyof EntitySubscriber<any>,
  ): Promise<void> {
    for (const sub of this.subscribers) {
      if (typeof sub[method] === "function") {
        await (sub[method] as Function)();
      }
    }
  }

  public async propagateShutdown() {
    this.removeAllListeners();
    this.subscribers.length = 0;
    this.dirtyEntities.clear();
    this.queryTracker = null;
    this.replicationRouter = null;
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
      // this.logger.debug(
      //   `[resolveEntityMetadata] "${entity.name}" resolved via LayeredMetadataStore (context: "${context}")`,
      // );
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
      let tableName = metadata.name;
      if (!tableName) {
        tableName = this.getNameStrategy(TargetEntity);
      }

      if (!ReflectManager.isEntity(TargetEntity)) {
        throw new EntityMetadataNotFoundError(tableName ?? "Unknown");
      }

      if (synchronize) {
        const hasTable = await this.driver?.hasTable(tableName);
        if (!hasTable || hasTable.length === 0) {
          await this.driver?.createTable(tableName, metadata.columns);
        }
      }

      entityList.push({ TargetEntity, tableName, metadata });
    }

    // 2패스: 모든 테이블이 생성된 후 FK, 인덱스, 유니크 인덱스를 등록합니다.
    if (synchronize) {
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
    }
  }

  /**
   * @UniqueIndex 데코레이터로 선언된 복합 유니크 인덱스를 등록합니다.
   */
  private async registerUniqueIndexes(
    TargetEntity: ClazzType<any>,
    tableName: string,
  ) {
    const uniqueIndexes = Reflect.getMetadata(
      UNIQUE_INDEX_TOKEN,
      TargetEntity,
    ) as UniqueIndexMetadata[] | undefined;

    if (!uniqueIndexes || uniqueIndexes.length === 0) return;

    for (const uq of uniqueIndexes) {
      const indexName = uq.name ?? `uq_${tableName}_${uq.columns.join("_")}`;

      // 이미 존재하는지 확인
      const indexes = (await this.driver?.getIndexes(tableName)) as any[];
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
        await this.driver?.addCompositeUniqueIndex(
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
  private async registerManyToManyJoinTables(entities: ClazzType<any>[]) {
    const processedTables = new Set<string>();

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
        const hasTable = await this.driver?.hasTable(joinTableName);
        if (!hasTable || (hasTable as any[]).length === 0) {
          const wJoinTable = this.wrap(joinTableName);
          const wJoinCol = this.wrap(joinColumn);
          const wInvCol = this.wrap(inverseJoinColumn);
          let ddl = `CREATE TABLE IF NOT EXISTS ${wJoinTable} (${wJoinCol} INT NOT NULL, ${wInvCol} INT NOT NULL, PRIMARY KEY (${wJoinCol}, ${wInvCol}))`;
          if (this.isMySqlFamily()) ddl += " ENGINE=InnoDB";
          await this.driver?.executeRaw(ddl);
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
        const ownerFkName = SchemaGenerator.generateForeignKeyName(
          joinTableName,
          joinColumn,
          ownerTable,
        );
        if (
          ownerPk &&
          this.driver &&
          !(await this.driver.hasForeignKey(joinTableName, ownerFkName))
        ) {
          const ddl = `ALTER TABLE ${this.wrap(joinTableName)} ADD CONSTRAINT ${ownerFkName} FOREIGN KEY (${this.wrap(joinColumn)}) REFERENCES ${this.wrap(ownerTable)}(${this.wrap(ownerPk)}) ON DELETE CASCADE ON UPDATE CASCADE`;
          await this.driver.executeRaw(ddl);
        }

        // 4. 역측 FK 추가
        const relatedFkName = SchemaGenerator.generateForeignKeyName(
          joinTableName,
          inverseJoinColumn,
          relatedTable,
        );
        if (
          relatedPk &&
          this.driver &&
          !(await this.driver.hasForeignKey(joinTableName, relatedFkName))
        ) {
          const ddl = `ALTER TABLE ${this.wrap(joinTableName)} ADD CONSTRAINT ${relatedFkName} FOREIGN KEY (${this.wrap(inverseJoinColumn)}) REFERENCES ${this.wrap(relatedTable)}(${this.wrap(relatedPk)}) ON DELETE CASCADE ON UPDATE CASCADE`;
          await this.driver.executeRaw(ddl);
        }
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
  private resolveManyToManyJoinTable<T>(rel: ManyToManyMetadata<any>): {
    joinTableName: string;
    joinColumn: string;
    inverseJoinColumn: string;
  } | null {
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
          const subQueryStart = Date.now();
          const queryResult = (await transactionHolder.query(
            resultQuery,
          )) as QueryResult;
          this.trackQuery(
            relatedTableName,
            resultQuery.text ?? String(resultQuery),
            Date.now() - subQueryStart,
          );

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

  /**
   * OneToOne 관계를 별도 쿼리로 로드하여 부모 엔티티에 할당합니다.
   * Eager JOIN으로 처리되지 않은 OneToOne 관계(inverseSide 등)를 relations 옵션으로 로드합니다.
   */
  private async loadOneToOneRelations<T>(
    entity: ClazzType<T>,
    parentResults: T | T[],
    relations: (keyof T)[],
  ): Promise<void> {
    const oneToOneMeta = this.resolveOneToOneMetadata(entity);
    if (oneToOneMeta.length === 0) return;

    const parentMetadata = this.resolveEntityMetadata(entity);
    if (!parentMetadata) return;

    const pk = parentMetadata.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );
    if (!pk) return;

    const parents = Array.isArray(parentResults)
      ? parentResults
      : [parentResults];

    for (const rel of oneToOneMeta) {
      if (!relations.includes(rel.propertyKey as keyof T)) continue;

      // 소유측은 eager JOIN + transformNested에서 이미 매핑됨 → 스킵
      if (rel.joinColumn) {
        continue;
      }

      const RelatedEntity = rel.getRelatedEntity();
      const relatedMetadata = this.resolveEntityMetadata(RelatedEntity);
      if (!relatedMetadata) continue;

      const relatedPk = relatedMetadata.columns.find(
        (col: any) => col.options?.primary,
      );
      if (!relatedPk) continue;

      for (const parent of parents) {
        if (rel.joinColumn) {
          // 소유측: FK 값으로 관련 엔티티를 조회
          const fkValue = (parent as any)[rel.joinColumn];
          if (fkValue === undefined || fkValue === null) {
            (parent as any)[rel.propertyKey] = null;
            continue;
          }

          const related = await this.findOne(RelatedEntity, {
            where: { [relatedPk.name!]: fkValue } as any,
          });
          (parent as any)[rel.propertyKey] = related ?? null;
        } else if (rel.inverseSide) {
          // 역방향: 상대측의 joinColumn으로 부모 PK를 검색
          const parentId = (parent as any)[pk.name!];
          if (parentId === undefined || parentId === null) {
            (parent as any)[rel.propertyKey] = null;
            continue;
          }

          // 상대측(소유측)의 OneToOne 메타데이터에서 joinColumn을 찾음
          const relatedOneToOne = this.resolveOneToOneMetadata(RelatedEntity);
          const ownerRel = relatedOneToOne.find(
            (r) => r.propertyKey === rel.inverseSide && r.joinColumn,
          );

          if (ownerRel?.joinColumn) {
            const related = await this.findOne(RelatedEntity, {
              where: { [ownerRel.joinColumn]: parentId } as any,
            });
            (parent as any)[rel.propertyKey] = related ?? null;
          } else {
            (parent as any)[rel.propertyKey] = null;
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
          throw new EntityMetadataNotFoundError(mappingEntity.name);
        }

        if (!joinColumn) {
          throw new InvalidQueryError("JoinColumn does not exist.");
        }

        // Get the primary key of the mapping table.
        const mappingTablePrimaryKey = mappingTableMetadata.columns.find(
          (e: any) => e.options?.primary,
        )?.name;

        // Throw an error if the primary key does not exist.
        if (!mappingTablePrimaryKey) {
          throw new PrimaryKeyNotFoundError(mappingEntity.name);
        }

        const mappingTableName =
          mappingTableMetadata.name || this.getNameStrategy(mappingEntity);

        // joinColumn 컬럼이 테이블에 없으면 먼저 추가합니다.
        if (this.driver) {
          const columnExists = await this.driver.hasColumn(
            tableName,
            joinColumn,
          );
          if (!columnExists) {
            const fkColumnType = this.driver.castType("int") + " NULL";
            await this.driver.addColumn(tableName, joinColumn, fkColumnType);
          }
        }

        // FK 제약이 이미 존재하면 중복 추가를 건너뜁니다.
        if (this.driver) {
          const fkName = this.driver.generateForeignKeyName(
            tableName,
            mappingTableName,
            joinColumn,
          );
          const fkExists = await this.driver.hasForeignKey(tableName, fkName);
          if (fkExists) continue;
        }

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
        throw new EntityMetadataNotFoundError(RelatedEntity.name);
      }

      const relatedPrimaryKey = relatedMetadata.columns.find(
        (e: any) => e.options?.primary,
      )?.name;

      if (!relatedPrimaryKey) {
        throw new PrimaryKeyNotFoundError(RelatedEntity.name);
      }

      // joinColumn 컬럼이 테이블에 없으면 먼저 추가합니다.
      if (this.driver) {
        const columnExists = await this.driver.hasColumn(tableName, joinColumn);
        if (!columnExists) {
          const fkColumnType = this.driver.castType("int") + " NULL";
          await this.driver.addColumn(tableName, joinColumn, fkColumnType);
        }
      }

      const relatedTableName =
        relatedMetadata.name || this.getNameStrategy(RelatedEntity);

      // FK 제약이 이미 존재하면 중복 추가를 건너뜁니다.
      if (this.driver) {
        const fkName = this.driver.generateForeignKeyName(
          tableName,
          relatedTableName,
          joinColumn,
        );
        const fkExists = await this.driver.hasForeignKey(tableName, fkName);
        if (fkExists) continue;
      }

      await this.driver?.addForeignKey(
        tableName,
        joinColumn,
        relatedTableName,
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
  ): Promise<T | null> {
    const result = await this.find<T>(entity, { ...findOption, limit: 1 });
    if (result === undefined || result === null) {
      return null;
    }
    if (Array.isArray(result)) {
      return (result[0] as T) ?? null;
    }
    return result as T;
  }

  /**
   * Executes EXPLAIN on the SELECT query that would be generated for the given
   * entity and find options. Returns a standardized ExplainResult.
   *
   * @param entity The entity class to explain the query for.
   * @param findOption The find options that would generate the SELECT query.
   * @throws InvalidQueryError if the driver does not support EXPLAIN.
   */
  async explain<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
  ): Promise<ExplainResult> {
    if (!this.driver || !this.driver.supportsExplain()) {
      throw new InvalidQueryError(
        "EXPLAIN is not supported by the current database driver.",
      );
    }

    const { select, orderBy, where, take } = findOption;
    const { limit } = findOption;

    const metadata = this.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const qb = RawQueryBuilderFactory.create();
    const selectMap: string[] = [];
    const whereMap: Sql[] = [];
    const orderByMap: Array<{ column: string; direction: "ASC" | "DESC" }> = [];

    const manyToOneRelations = this.resolveManyToOneMetadata(entity);
    const eagerRelations = manyToOneRelations.filter((rel) => {
      const isEager = rel.option?.eager === true;
      const isInRelations = findOption.relations?.includes(
        rel.columnName as keyof T,
      );
      return isEager || isInRelations;
    });

    const oneToOneRelations = this.resolveOneToOneMetadata(entity);
    const eagerOneToOneRelations = oneToOneRelations.filter((rel) => {
      if (!rel.joinColumn) return false;
      const isEager = rel.option?.eager === true;
      const isInRelations = findOption.relations?.includes(
        rel.propertyKey as keyof T,
      );
      return isEager || isInRelations;
    });

    const hasEagerJoins =
      eagerRelations.length > 0 || eagerOneToOneRelations.length > 0;
    const tableName = metadata.name!;

    if (select) {
      const selectedColumns = this.resolveSelectColumns<T>(select);
      if (hasEagerJoins) {
        selectMap.push(
          ...selectedColumns.map(
            (col) => `${this.wrap(tableName)}.${this.wrap(col)}`,
          ),
        );
      } else {
        selectMap.push(...selectedColumns.map((col) => this.wrap(col)));
      }
    } else {
      if (hasEagerJoins) {
        selectMap.push(
          ...metadata.columns.map(
            (column) => `${this.wrap(tableName)}.${this.wrap(column.name!)}`,
          ),
        );
      } else {
        selectMap.push(
          ...metadata.columns.map((column) => this.wrap(column.name!)),
        );
      }
    }

    for (const key in where) {
      const value = where[key];
      if (value !== undefined && value !== null) {
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

    qb.select(selectMap).from(this.wrap(tableName));
    qb.where(whereMap).orderBy(orderByMap);

    if (Array.isArray(limit)) {
      let [offset, count] = limit;
      if (offset < 0) offset = 0;
      if (count < 0) count = 0;
      if (count === 0) count = 1;
      if (take && take > 0) count = take;
      if (this.isMySqlFamily()) qb.setDatabaseType("mysql");
      qb.limit([offset, count]);
    } else if (limit) {
      qb.limit(limit as number);
    }

    const selectQuery = qb.build();
    // Build the EXPLAIN query as a Sql object to preserve parameterized values.
    // The driver's buildExplainSql returns the prefix (e.g., "EXPLAIN", "EXPLAIN (FORMAT JSON)")
    // which we prepend to the original parameterized SELECT query.
    const explainPrefix = this.driver.buildExplainSql("");
    const explainQuery = sql`${raw(explainPrefix)}${selectQuery}`;

    const transactionHolder = new TransactionSessionManager();
    try {
      // Replication: EXPLAIN은 읽기 전용이므로 slave로 라우팅
      const readNode = this.getReadNode(findOption.useMaster);
      if (readNode) {
        await transactionHolder.connectToNode(readNode);
      } else {
        await transactionHolder.connect();
      }
      await transactionHolder.startTransaction();
      if (this.isMySqlFamily()) {
        await transactionHolder.query("SET autocommit = 0");
      }
      const result = await transactionHolder.query(explainQuery);
      await transactionHolder.commit();
      const rawRows: Record<string, unknown>[] = (result as any)?.results ?? [];
      return this.parseExplainResult(rawRows);
    } catch (e) {
      try {
        await transactionHolder.rollback();
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      try {
        await transactionHolder.close();
      } catch {
        /* ignore */
      }
    }
  }

  private parseExplainResult(
    rawRows: Record<string, unknown>[],
  ): ExplainResult {
    if (!rawRows || rawRows.length === 0) {
      return {
        raw: [],
        rows: null,
        type: null,
        possibleKeys: null,
        key: null,
        cost: null,
      };
    }
    const firstRow = rawRows[0];
    if (firstRow && "QUERY PLAN" in firstRow) {
      return this.parsePostgresExplain(firstRow["QUERY PLAN"]);
    }
    if ("type" in firstRow || "select_type" in firstRow) {
      return this.parseMysqlExplain(rawRows);
    }
    if ("detail" in firstRow || "notused" in firstRow) {
      return this.parseSqliteExplain(rawRows);
    }
    return {
      raw: rawRows,
      rows: null,
      type: null,
      possibleKeys: null,
      key: null,
      cost: null,
    };
  }

  private parseMysqlExplain(rawRows: Record<string, unknown>[]): ExplainResult {
    const first = rawRows[0];
    const rows = first.rows != null ? Number(first.rows) : null;
    const type = first.type != null ? String(first.type) : null;
    const possibleKeysRaw = first.possible_keys;
    const possibleKeys =
      possibleKeysRaw != null
        ? String(possibleKeysRaw)
            .split(",")
            .map((k) => k.trim())
        : null;
    const key = first.key != null ? String(first.key) : null;
    const cost = first.filtered != null ? Number(first.filtered) : null;
    return { raw: rawRows, rows, type, possibleKeys, key, cost };
  }

  private parsePostgresExplain(queryPlan: unknown): ExplainResult {
    const rawArray = Array.isArray(queryPlan) ? queryPlan : [queryPlan];
    const plan = rawArray[0]?.Plan ?? rawArray[0]?.["Plan"] ?? null;
    if (!plan) {
      return {
        raw: rawArray,
        rows: null,
        type: null,
        possibleKeys: null,
        key: null,
        cost: null,
      };
    }
    const rows = plan["Plan Rows"] != null ? Number(plan["Plan Rows"]) : null;
    const type = plan["Node Type"] != null ? String(plan["Node Type"]) : null;
    const key = plan["Index Name"] != null ? String(plan["Index Name"]) : null;
    const cost = plan["Total Cost"] != null ? Number(plan["Total Cost"]) : null;
    return { raw: rawArray, rows, type, possibleKeys: null, key, cost };
  }

  private parseSqliteExplain(
    rawRows: Record<string, unknown>[],
  ): ExplainResult {
    const details = rawRows.map((r) => String(r.detail ?? ""));
    const firstDetail = details[0] ?? "";
    let type: string | null = null;
    let key: string | null = null;
    if (firstDetail.startsWith("SCAN")) type = "SCAN";
    else if (firstDetail.startsWith("SEARCH")) type = "SEARCH";
    const indexMatch = firstDetail.match(/USING (?:COVERING )?INDEX (\S+)/);
    if (indexMatch) key = indexMatch[1];
    return {
      raw: rawRows,
      rows: null,
      type,
      possibleKeys: null,
      key,
      cost: null,
    };
  }

  /**
   * 커서 기반 페이지네이션으로 엔티티를 조회합니다.
   *
   * offset 방식 대신 정렬 컬럼의 마지막 값을 커서로 사용하여
   * 대량 데이터셋에서도 일정한 성능을 보장합니다.
   *
   * @param entity 엔티티 클래스
   * @param option 커서 페이지네이션 옵션
   * @returns 페이지네이션 결과 (data, hasNextPage, nextCursor, count)
   */
  async findWithCursor<T>(
    entity: ClazzType<T>,
    option: CursorPaginationOption<T> = {},
  ): Promise<CursorPaginationResult<T>> {
    const metadata = this.resolveEntityMetadata(entity);

    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    // PK 컬럼 확인
    const pk = metadata.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );

    // 정렬 기준 컬럼 결정 (기본값: PK)
    const orderByColumn = option.orderBy ?? (pk?.name as keyof T & string);
    if (!orderByColumn) {
      throw new InvalidQueryError(
        "Cursor pagination requires an orderBy column or a primary key.",
      );
    }

    const direction = option.direction ?? "ASC";
    const pageSize = normalizePageSize(option.take);

    // 커서 디코딩
    let cursorValue: unknown = null;
    if (option.cursor) {
      cursorValue = decodeCursor(option.cursor);
      if (cursorValue === null) {
        throw new InvalidQueryError("Invalid cursor value.");
      }
    }

    // find() 옵션 구성
    const where: any = { ...(option.where ?? {}) };

    // 커서 조건: WHERE col > cursor (ASC) 또는 WHERE col < cursor (DESC)
    // find()는 단순 equality만 지원하므로 직접 쿼리를 구성합니다.
    const transactionHolder = new TransactionSessionManager();
    const resultTransformer = ResultTransformerFactory.create();

    try {
      // Replication: 읽기 쿼리는 slave로 라우팅 (useMaster가 아닌 경우)
      const readNode = this.getReadNode(option.useMaster);
      if (readNode) {
        await transactionHolder.connectToNode(readNode);
      } else {
        await transactionHolder.connect();
      }
      await transactionHolder.startTransaction();

      if (this.isMySqlFamily()) {
        await transactionHolder.query("SET autocommit = 0");
      }

      const tableName = metadata.name!;
      const qb = RawQueryBuilderFactory.create();

      // SELECT 컬럼
      const selectMap = metadata.columns.map((column) =>
        this.wrap(column.name!),
      );

      // WHERE 조건
      const whereMap: Sql[] = [];

      for (const key in where) {
        const value = where[key];
        if (value !== undefined && value !== null) {
          whereMap.push(Conditions.equals(this.wrap(key), value));
        }
      }

      // @DeletedAt 컬럼 자동 필터
      const deletedAtColumn = this.getDeletedAtColumn(entity);
      if (deletedAtColumn) {
        whereMap.push(Conditions.isNull(this.wrap(deletedAtColumn)));
      }

      // 커서 조건 추가
      if (cursorValue !== null) {
        if (direction === "ASC") {
          whereMap.push(Conditions.gt(this.wrap(orderByColumn), cursorValue));
        } else {
          whereMap.push(Conditions.lt(this.wrap(orderByColumn), cursorValue));
        }
      }

      // Query 구성: SELECT → FROM → WHERE → ORDER BY → LIMIT
      qb.select(selectMap)
        .from(this.wrap(tableName))
        .where(whereMap)
        .orderBy([{ column: this.wrap(orderByColumn), direction }]);

      // take + 1로 조회 (다음 페이지 존재 여부 확인)
      qb.limit(pageSize + 1);

      const resultQuery = qb.build();

      const queryResult = (await transactionHolder.query<T>(
        resultQuery,
      )) as QueryResult;

      await transactionHolder.commit();

      const { results } = queryResult;
      if (!results || results.length === 0) {
        return {
          data: [],
          hasNextPage: false,
          nextCursor: null,
          count: 0,
        };
      }

      // take + 1로 조회했으므로, 결과가 pageSize보다 많으면 다음 페이지 존재
      const hasNextPage = results.length > pageSize;
      const pageResults = hasNextPage ? results.slice(0, pageSize) : results;

      // 엔티티 변환
      const entities = resultTransformer.toEntities(entity, {
        results: pageResults,
        fields: queryResult.fields,
      });

      // 다음 커서: 마지막 항목의 정렬 컬럼 값
      let nextCursor: string | null = null;
      if (hasNextPage && pageResults.length > 0) {
        const lastItem = pageResults[pageResults.length - 1];
        const lastValue = lastItem[orderByColumn];
        nextCursor = encodeCursor(lastValue);
      }

      return {
        data: entities,
        hasNextPage,
        nextCursor,
        count: entities.length,
      };
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
    const { select, orderBy, where, take, groupBy, having } = findOption;
    const { limit } = findOption;

    const transactionHolder = new TransactionSessionManager();
    const resultTransformer = ResultTransformerFactory.create();

    try {
      // Replication: 읽기 쿼리는 slave로 라우팅 (useMaster가 아닌 경우)
      const readNode = this.getReadNode(findOption.useMaster);
      if (readNode) {
        await transactionHolder.connectToNode(readNode);
      } else {
        await transactionHolder.connect();
      }
      await transactionHolder.startTransaction();

      // MySQL/MariaDB 전용: autocommit 비활성화
      // PostgreSQL은 BEGIN으로 트랜잭션을 시작하면 자동으로 autocommit이 꺼집니다.
      if (this.isMySqlFamily()) {
        await transactionHolder.query("SET autocommit = 0");
      }

      // 메타데이터를 가져옵니다 (레이어 시스템 경유).
      const metadata = this.resolveEntityMetadata(entity);

      if (!metadata) {
        throw new EntityMetadataNotFoundError(entity.name);
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
      const hasEagerJoins =
        eagerRelations.length > 0 || eagerOneToOneRelations.length > 0;

      const tableName = metadata.name!;

      if (select) {
        // select 옵션이 지정된 경우 해당 컬럼만 SELECT
        const selectedColumns = this.resolveSelectColumns<T>(select);
        if (hasEagerJoins) {
          selectMap.push(
            ...selectedColumns.map(
              (col) => `${this.wrap(tableName)}.${this.wrap(col)}`,
            ),
          );
        } else {
          selectMap.push(...selectedColumns.map((col) => this.wrap(col)));
        }
      } else {
        // 메인 테이블 컬럼에 테이블 별칭 prefix 추가 (JOIN 시 충돌 방지)
        if (hasEagerJoins) {
          selectMap.push(
            ...metadata.columns.map(
              (column) => `${this.wrap(tableName)}.${this.wrap(column.name!)}`,
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

        const relatedName = relatedMetadata.name || RelatedEntity.name;
        for (const col of relatedMetadata.columns) {
          const alias = `${rel.columnName}_${col.name}`;
          selectMap.push(
            `${this.wrap(relatedName)}.${this.wrap(col.name!)} AS ${this.wrap(alias)}`,
          );
        }
      }

      // OneToOne Eager 관계 컬럼을 SELECT에 추가 (alias: propertyKey_columnName)
      for (const rel of eagerOneToOneRelations) {
        const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
        const relatedMetadata = this.resolveEntityMetadata(RelatedEntity);
        if (!relatedMetadata) continue;

        const relatedName = relatedMetadata.name || RelatedEntity.name;
        for (const col of relatedMetadata.columns) {
          const alias = `${rel.propertyKey}_${col.name}`;
          selectMap.push(
            `${this.wrap(relatedName)}.${this.wrap(col.name!)} AS ${this.wrap(alias)}`,
          );
        }
      }

      for (const key in where) {
        const value = where[key];
        if (value !== undefined && value !== null) {
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
      // SQL 순서: SELECT → FROM → JOIN → WHERE → GROUP BY → HAVING → ORDER BY → LIMIT
      qb.select(selectMap).from(this.wrap(tableName));

      // Eager ManyToOne 관계에 대한 LEFT JOIN 추가 (FROM 뒤, WHERE 앞)
      for (const rel of eagerRelations) {
        const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
        const relatedMetadata = this.resolveEntityMetadata(RelatedEntity);
        if (!relatedMetadata) continue;

        const relatedTableName = relatedMetadata.name || RelatedEntity.name;
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

      // OneToOne Eager 관계에 대한 LEFT JOIN 추가 (FROM 뒤, WHERE 앞)
      for (const rel of eagerOneToOneRelations) {
        const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
        const relatedMetadata = this.resolveEntityMetadata(RelatedEntity);
        if (!relatedMetadata) continue;

        const relatedTableName = relatedMetadata.name || RelatedEntity.name;
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

      // WHERE (JOIN 뒤에 위치)
      qb.where(whereMap);

      // GROUP BY / HAVING (WHERE 뒤, ORDER BY 앞)
      if (groupBy && groupBy.length > 0) {
        const groupByColumns = (groupBy as string[]).map((col) =>
          hasEagerJoins
            ? `${this.wrap(tableName)}.${this.wrap(col)}`
            : this.wrap(col),
        );
        qb.groupBy(groupByColumns);
      }

      if (having && having.length > 0) {
        qb.having(having);
      }

      // ORDER BY
      qb.orderBy(orderByMap);

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

      // per-query 또는 connection-level 타임아웃 적용
      const effectiveTimeout = findOption.timeout ?? this.defaultQueryTimeout;
      if (effectiveTimeout && effectiveTimeout > 0 && this.driver) {
        const timeoutSql = this.driver.setQueryTimeout(effectiveTimeout);
        await transactionHolder.query(timeoutSql);
      }

      const queryStartTime = Date.now();
      const queryResult = (await transactionHolder.query<T>(
        resultQuery,
      )) as QueryResult;
      this.trackQuery(
        entity.name,
        resultQuery.text ?? String(resultQuery),
        Date.now() - queryStartTime,
      );

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
      if (
        findOption.relations &&
        findOption.relations.length > 0 &&
        entityResult
      ) {
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
   * select 옵션에서 컬럼 이름 배열을 추출합니다.
   * select가 배열이면 그대로 문자열로 반환하고,
   * 객체이면 값이 true인 키만 반환합니다.
   */
  private resolveSelectColumns<T>(select: ISelectOption<T>): string[] {
    if (Array.isArray(select)) {
      return select.map((col) => String(col));
    }

    // 객체 형태: { id: true, name: true }
    const columns: string[] = [];
    for (const key in select) {
      if ((select as any)[key] === true) {
        columns.push(key);
      }
    }
    return columns;
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
    const t = this.dbType ?? (this.client as any).type;
    return ["mysql", "mariadb"].includes(t as IDatabaseType);
  }

  private isPostgres() {
    const t = this.dbType ?? (this.client as any).type;
    return t === "postgres";
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
      throw new EntityMetadataNotFoundError(entity.name);
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

      // PK 컬럼 수집 (복합 PK 지원)
      const pkColumns = metadata.columns.filter(
        (column: ColumnMetadata) => column.options?.primary,
      );
      const pk = pkColumns[0]; // 하위 호환: 단일 PK 참조

      // auto-increment PK가 있는지 확인
      const hasAutoIncrementPk = pkColumns.some(
        (col: ColumnMetadata) => col.options?.autoIncrement,
      );
      const primaryKeyValue = pk ? (item as any)[pk.name!] : undefined;

      // INSERT vs UPDATE 판별:
      // - auto-increment PK: PK 값이 없으면 INSERT, 있으면 UPDATE (기존 동작)
      // - 수동 PK (복합 PK 포함): 항상 INSERT (수동 PK 엔티티의 UPDATE는
      //   delete+insert 또는 직접 쿼리 빌더 사용)
      const isInsert = hasAutoIncrementPk
        ? !primaryKeyValue // 기존 동작: auto-increment PK 값이 없으면 INSERT
        : true; // 수동 PK: 항상 INSERT

      // PK WHERE 절 빌더 (복합 PK 지원)
      const buildPkWhere = (pkValues?: Record<string, any>) => {
        return pkColumns.map((col: ColumnMetadata) => {
          const value = pkValues
            ? pkValues[col.name!]
            : (item as any)[col.name!];
          return sql`${raw(this.wrap(col.name!))} = ${value}`;
        });
      };

      // PK 기반 findOne WHERE 조건
      const buildPkFindWhere = (pkValues?: Record<string, any>) => {
        const where: any = {};
        for (const col of pkColumns) {
          where[col.name!] = pkValues
            ? pkValues[col.name!]
            : (item as any)[col.name!];
        }
        return where;
      };

      if (isInsert) {
        // @BeforeInsert 훅 실행 (columns/values 추출 전에 실행해야 훅의 변경사항이 반영됨)
        await this.runHooks(entity, item, "beforeInsert");
        await this.eventEmitter.emit("beforeInsert", { entity, data: item });
        await this.notifySubscribers(entity, "beforeInsert", {
          entity: item,
          manager: this,
        } as InsertEvent<T>);

        // 훅 실행 후 columns/values 추출 (훅에서 변경한 값이 INSERT SQL에 반영됨)
        // PostgreSQL의 SERIAL 컬럼은 INSERT 시 생략해야 자동 생성됩니다.
        const insertableColumns = metadata.columns.filter(
          (column: ColumnMetadata) => {
            const isAutoIncrement = column.options?.autoIncrement;
            const value = (item as any)[column.name!];
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

        // ManyToOne FK 컬럼 값 추출 (joinColumn이 명시된 관계에서 관계 객체의 PK 추출)
        // @Column과 @ManyToOne joinColumn이 같은 이름일 수 있으므로 중복 방지
        const manyToOneRelations = this.resolveManyToOneMetadata(entity);
        for (const rel of manyToOneRelations) {
          if (!rel.joinColumn) continue;
          const relatedValue = (item as any)[rel.columnName];

          // joinColumn이 이미 @Column으로 columns에 포함되어 있는지 확인
          const existingIdx = insertableColumns.findIndex(
            (col: ColumnMetadata) => col.name === rel.joinColumn,
          );

          // null 할당 시 FK를 NULL로 INSERT
          if (relatedValue === null) {
            if (existingIdx >= 0) {
              values[existingIdx] = null;
            } else {
              columns.push(raw(this.wrap(rel.joinColumn)));
              values.push(null);
            }
          } else if (relatedValue && typeof relatedValue === "object") {
            const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
            const relatedMeta = this.resolveEntityMetadata(RelatedEntity);
            if (relatedMeta) {
              const relatedPk = relatedMeta.columns.find(
                (col: any) => col.options?.primary,
              );
              if (relatedPk) {
                const fkValue = relatedValue[relatedPk.name!];
                if (fkValue !== undefined && fkValue !== null) {
                  if (existingIdx >= 0) {
                    values[existingIdx] = fkValue;
                  } else {
                    columns.push(raw(this.wrap(rel.joinColumn)));
                    values.push(fkValue);
                  }
                }
              }
            }
          }
        }

        // PostgreSQL: INSERT ... RETURNING PK 컬럼들
        const isPostgres = this.isPostgres();
        const returningCols = pkColumns
          .map((col: ColumnMetadata) => this.wrap(col.name!))
          .join(", ");
        const returningSql = isPostgres
          ? raw(` RETURNING ${returningCols}`)
          : raw("");

        const insertSql = sql`
                        INSERT INTO ${raw(this.wrap(metadata.name!))}
                        (${join(columns, ", ")})
                        VALUES (${join(values, ", ")})${returningSql}
                    `;
        const saveQueryStart = Date.now();
        const queryResult = (await transactionManager.query<T>(insertSql)) as {
          results: any;
          fields: any;
        };
        this.trackQuery(
          entity.name,
          insertSql.text ?? String(insertSql),
          Date.now() - saveQueryStart,
        );

        await transactionManager.commit();

        if (this.isMySqlFamily()) {
          const findWhere = hasAutoIncrementPk
            ? { [pk.name!]: queryResult?.results?.insertId }
            : buildPkFindWhere();
          const result = await this.findOne(entity, {
            where: findWhere,
          } as any);

          const cascadeId = hasAutoIncrementPk
            ? queryResult?.results?.insertId
            : primaryKeyValue;
          await this.cascadeSaveOneToMany(entity, item, cascadeId);
          // @AfterInsert 훅 실행
          await this.runHooks(entity, item, "afterInsert");
          await this.eventEmitter.emit("afterInsert", { entity, data: item });
          await this.notifySubscribers(entity, "afterInsert", {
            entity: item,
            manager: this,
          } as InsertEvent<T>);
          return result as T;
        }

        // PostgreSQL: RETURNING 절로 받은 PK 값으로 조회
        if (isPostgres && queryResult?.results?.length > 0) {
          const returnedRow = queryResult.results[0];
          const findWhere = buildPkFindWhere(returnedRow);
          const result = await this.findOne(entity, {
            where: findWhere,
          } as any);

          const cascadeId = returnedRow[pk.name!];
          await this.cascadeSaveOneToMany(entity, item, cascadeId);
          // @AfterInsert 훅 실행
          await this.runHooks(entity, item, "afterInsert");
          await this.eventEmitter.emit("afterInsert", { entity, data: item });
          await this.notifySubscribers(entity, "afterInsert", {
            entity: item,
            manager: this,
          } as InsertEvent<T>);
          return result as T;
        }

        // @AfterInsert 훅 실행
        await this.runHooks(entity, item, "afterInsert");
        await this.eventEmitter.emit("afterInsert", { entity, data: item });
        await this.notifySubscribers(entity, "afterInsert", {
          entity: item,
          manager: this,
        } as InsertEvent<T>);
        return queryResult as T;
      }

      // UPDATE path: 모든 PK 값이 존재하는 경우
      // @BeforeUpdate 훅 실행
      await this.runHooks(entity, item, "beforeUpdate");
      await this.eventEmitter.emit("beforeUpdate", { entity, data: item });
      await this.notifySubscribers(entity, "beforeUpdate", {
        entity: item,
        manager: this,
      } as UpdateEvent<T>);

      // 부분 업데이트 지원: undefined가 아닌 컬럼만 SET 절에 포함
      // PK 컬럼은 WHERE 절에서 사용하므로 SET에서 제외
      const pkColumnNames = new Set(
        pkColumns.map((col: ColumnMetadata) => col.name!),
      );
      const updatableColumns = metadata.columns.filter(
        (column: ColumnMetadata) => {
          if (pkColumnNames.has(column.name!)) return false;
          return (item as any)[column.name!] !== undefined;
        },
      );
      const updateMap = updatableColumns.map((column: ColumnMetadata) => {
        return sql`${raw(this.wrap(column.name!))} = ${(item as any)[column.name!]}`;
      });

      // 이미 SET에 포함된 컬럼명을 추적 (중복 방지)
      const updatedColumnNames = new Set(
        updatableColumns.map((col: ColumnMetadata) => col.name!),
      );

      // ManyToOne FK 컬럼 값을 UPDATE SET에 추가 (관계 객체의 PK → FK 컬럼)
      // @Column과 @ManyToOne joinColumn이 같은 이름일 수 있으므로 중복 방지
      const updateManyToOneRelations = this.resolveManyToOneMetadata(entity);
      for (const rel of updateManyToOneRelations) {
        if (!rel.joinColumn) continue;
        const relatedValue = (item as any)[rel.columnName];

        // 관계 프로퍼티가 item에 없으면 (undefined) 스킵 — FK 보존
        if (relatedValue === undefined) continue;

        // joinColumn이 이미 updatableColumns에 포함되어 있는지 확인
        const alreadyInSet = updatedColumnNames.has(rel.joinColumn);

        // null 할당 시 FK를 NULL로 설정
        if (relatedValue === null) {
          if (alreadyInSet) {
            const existingIdx = updatableColumns.findIndex(
              (col: ColumnMetadata) => col.name === rel.joinColumn,
            );
            updateMap[existingIdx] =
              sql`${raw(this.wrap(rel.joinColumn))} = ${null}`;
          } else {
            updateMap.push(sql`${raw(this.wrap(rel.joinColumn))} = ${null}`);
            updatedColumnNames.add(rel.joinColumn);
          }
        } else if (typeof relatedValue === "object") {
          const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
          const relatedMeta = this.resolveEntityMetadata(RelatedEntity);
          if (relatedMeta) {
            const relatedPk = relatedMeta.columns.find(
              (col: any) => col.options?.primary,
            );
            if (relatedPk) {
              const fkValue = relatedValue[relatedPk.name!];
              if (fkValue !== undefined && fkValue !== null) {
                if (alreadyInSet) {
                  const existingIdx = updatableColumns.findIndex(
                    (col: ColumnMetadata) => col.name === rel.joinColumn,
                  );
                  updateMap[existingIdx] =
                    sql`${raw(this.wrap(rel.joinColumn))} = ${fkValue}`;
                } else {
                  updateMap.push(
                    sql`${raw(this.wrap(rel.joinColumn))} = ${fkValue}`,
                  );
                  updatedColumnNames.add(rel.joinColumn);
                }
              }
            }
          }
        }
      }

      const pkWhereClauses = buildPkWhere();

      // updateMap이 비어있으면 (PK만 전달된 경우) UPDATE를 스킵
      if (updateMap.length > 0) {
        const updateSql = sql`
            UPDATE ${raw(this.wrap(metadata.name!))}
            SET ${join(updateMap, ", ")}
            WHERE ${join(pkWhereClauses, " AND ")}
                  `;
        const updateStart = Date.now();
        await transactionManager.query<T>(updateSql);
        this.trackQuery(
          entity.name,
          updateSql.text ?? String(updateSql),
          Date.now() - updateStart,
        );
      }

      await transactionManager.commit();

      await this.cascadeSaveOneToMany(entity, item, primaryKeyValue);

      // @AfterUpdate 훅 실행
      await this.runHooks(entity, item, "afterUpdate");
      await this.eventEmitter.emit("afterUpdate", { entity, data: item });
      await this.notifySubscribers(entity, "afterUpdate", {
        entity: item,
        manager: this,
      } as UpdateEvent<T>);

      // Retrieve and return the updated entity.
      const result = await this.findOne(entity, {
        where: buildPkFindWhere(),
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
  async deleteMany<T>(entity: ClazzType<T>, ids: any[]): Promise<DeleteResult> {
    if (ids.length === 0) {
      return { affected: 0 };
    }

    const metadata = this.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const pk = metadata.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );
    if (!pk) {
      throw new PrimaryKeyNotFoundError(entity.name);
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

      const queryResult = (await transactionManager.query(deleteQuery)) as {
        results: any;
        fields: any;
      };

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
      throw new EntityMetadataNotFoundError(entity.name);
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

      const queryResult = (await transactionManager.query(queryStr)) as {
        results: any;
        fields: any;
      };

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
   * 엔티티를 삽입하거나, 충돌 시 업데이트합니다 (UPSERT).
   *
   * @param entity 엔티티 클래스
   * @param data 삽입/업데이트할 데이터
   * @param conflictColumns 충돌 감지 컬럼 (미지정 시 PK 컬럼 자동 사용)
   */
  async upsert<T>(
    entity: ClazzType<T>,
    data: Partial<T>,
    conflictColumns?: string[],
  ): Promise<void> {
    const metadata = this.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    if (!this.driver) {
      throw new Error("Driver is not initialized.");
    }

    // conflictColumns 미지정 시 PK 컬럼 자동 사용
    const pkColumns = metadata.columns
      .filter((col: ColumnMetadata) => col.options?.primary)
      .map((col: ColumnMetadata) => col.name!);

    const resolvedConflictColumns = conflictColumns ?? pkColumns;

    if (resolvedConflictColumns.length === 0) {
      throw new PrimaryKeyNotFoundError(entity.name);
    }

    // 삽입 가능한 컬럼 (값이 있는 것만)
    const insertableColumns = metadata.columns.filter((col: ColumnMetadata) => {
      const value = (data as any)[col.name!];
      // auto-increment PK에 값이 없으면 제외
      if (
        col.options?.autoIncrement &&
        (value === null || value === undefined)
      ) {
        return false;
      }
      return value !== undefined;
    });

    if (insertableColumns.length === 0) {
      return;
    }

    // 충돌 시 업데이트할 컬럼 (충돌 감지 컬럼 제외)
    const conflictSet = new Set(resolvedConflictColumns);
    const updateColumnNames = insertableColumns
      .map((col: ColumnMetadata) => col.name!)
      .filter((name) => !conflictSet.has(name));

    const wrappedColumns = insertableColumns.map((col: ColumnMetadata) =>
      this.wrap(col.name!),
    );
    const wrappedConflict = resolvedConflictColumns.map((name) =>
      this.wrap(name),
    );
    const wrappedUpdate = updateColumnNames.map((name) => this.wrap(name));

    const tableName = this.wrap(metadata.name!);

    // 업데이트 대상 컬럼이 없으면 (충돌 컬럼만 있는 경우) 단순 INSERT IGNORE 동작
    // 대부분의 DB에서는 DO NOTHING/IGNORE 처리가 필요하지만,
    // 업데이트할 컬럼이 없으면 빈 SET 절이 되므로 기존 행 유지를 위해 리턴
    if (wrappedUpdate.length === 0) {
      return;
    }

    const transactionManager = new TransactionSessionManager();

    try {
      await transactionManager.connect();
      await transactionManager.startTransaction();

      if (this.isMySqlFamily()) {
        await transactionManager.query("SET autocommit = 0");
      }

      const columnValues = insertableColumns.map(
        (col: ColumnMetadata) => (data as any)[col.name!],
      );

      const upsertSql = this.buildUpsertQuery(
        tableName,
        wrappedColumns,
        columnValues,
        wrappedConflict,
        wrappedUpdate,
      );

      await transactionManager.query(upsertSql);
      await transactionManager.commit();
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
   * 드라이버별 upsert SQL을 sql-template-tag로 빌드합니다.
   */
  private buildUpsertQuery(
    tableName: string,
    columns: string[],
    values: any[],
    conflictColumns: string[],
    updateColumns: string[],
  ): Sql {
    const columnList = join(
      columns.map((c) => raw(c)),
      ", ",
    );
    const valueList = join(values, ", ");

    if (this.isMySqlFamily()) {
      const updateSet = join(
        updateColumns.map((col) => raw(`${col} = VALUES(${col})`)),
        ", ",
      );
      return sql`INSERT INTO ${raw(tableName)} (${columnList}) VALUES (${valueList}) ON DUPLICATE KEY UPDATE ${updateSet}`;
    }

    const conflictList = join(
      conflictColumns.map((c) => raw(c)),
      ", ",
    );

    if (this.isPostgres()) {
      const updateSet = join(
        updateColumns.map((col) => raw(`${col} = EXCLUDED.${col}`)),
        ", ",
      );
      return sql`INSERT INTO ${raw(tableName)} (${columnList}) VALUES (${valueList}) ON CONFLICT (${conflictList}) DO UPDATE SET ${updateSet}`;
    }

    // SQLite
    if ((this.dbType ?? (this.client as any).type) === "sqlite") {
      const updateSet = join(
        updateColumns.map((col) => raw(`${col} = excluded.${col}`)),
        ", ",
      );
      return sql`INSERT INTO ${raw(tableName)} (${columnList}) VALUES (${valueList}) ON CONFLICT (${conflictList}) DO UPDATE SET ${updateSet}`;
    }

    // MSSQL: MERGE 문
    const joinCondition = join(
      conflictColumns.map((col) => raw(`target.${col} = source.${col}`)),
      " AND ",
    );
    const updateSet = join(
      updateColumns.map((col) => raw(`target.${col} = source.${col}`)),
      ", ",
    );
    const sourceCols = join(
      columns.map((col) => raw(`source.${col}`)),
      ", ",
    );

    return sql`MERGE INTO ${raw(tableName)} AS target USING (SELECT ${valueList}) AS source (${columnList}) ON (${joinCondition}) WHEN MATCHED THEN UPDATE SET ${updateSet} WHEN NOT MATCHED THEN INSERT (${columnList}) VALUES (${sourceCols});`;
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
      throw new EntityMetadataNotFoundError(entity.name);
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
      await this.eventEmitter.emit("beforeDelete", { entity, data: criteria });
      await this.notifySubscribers(entity, "beforeDelete", {
        entityClass: entity,
        criteria,
        manager: this,
      } as DeleteEvent<T>);

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
        throw new DeleteWithoutConditionsError("Delete");
      }

      const whereSql = join(whereMap, " AND ");

      const deleteQuery = sql`DELETE FROM ${raw(this.wrap(metadata.name!))} WHERE ${whereSql}`;

      const deleteStart = Date.now();
      const queryResult = (await transactionManager.query(deleteQuery)) as {
        results: any;
        fields: any;
      };
      this.trackQuery(
        entity.name,
        deleteQuery.text ?? String(deleteQuery),
        Date.now() - deleteStart,
      );

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
      await this.eventEmitter.emit("afterDelete", { entity, data: criteria });
      await this.notifySubscribers(entity, "afterDelete", {
        entityClass: entity,
        criteria,
        manager: this,
      } as DeleteEvent<T>);

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
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const deletedAtColumn = this.getDeletedAtColumn(entity);
    if (!deletedAtColumn) {
      throw new InvalidQueryError(
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
        throw new DeleteWithoutConditionsError("Soft delete");
      }

      const whereSql = join(whereMap, " AND ");

      const nowExpr = this.isPostgres() ? raw("NOW()") : raw("NOW()");
      const updateQuery = sql`UPDATE ${raw(this.wrap(metadata.name!))} SET ${raw(this.wrap(deletedAtColumn))} = ${nowExpr} WHERE ${whereSql}`;

      const queryResult = (await transactionManager.query(updateQuery)) as {
        results: any;
        fields: any;
      };

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
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const deletedAtColumn = this.getDeletedAtColumn(entity);
    if (!deletedAtColumn) {
      throw new InvalidQueryError(
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
        throw new DeleteWithoutConditionsError("Restore");
      }

      const whereSql = join(whereMap, " AND ");

      const restoreQuery = sql`UPDATE ${raw(this.wrap(metadata.name!))} SET ${raw(this.wrap(deletedAtColumn))} = NULL WHERE ${whereSql}`;

      const queryResult = (await transactionManager.query(restoreQuery)) as {
        results: any;
        fields: any;
      };

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
      if (
        !hasCascade(rel.cascade, "insert") &&
        !hasCascade(rel.cascade, "update")
      )
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

      if (
        !hasCascade(rel.option?.cascade, "insert") &&
        !hasCascade(rel.option?.cascade, "update")
      )
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
      throw new EntityMetadataNotFoundError(entity.name);
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
   * 엔티티 목록과 전체 개수를 동시에 반환합니다.
   * find()와 count()를 호출하여 [entities, totalCount] 형태로 반환합니다.
   * count는 take/limit을 무시한 전체 조건 매칭 수입니다.
   *
   * @param entity 엔티티 클래스
   * @param findOption 검색 옵션 (where, orderBy, take, limit, select, relations 등)
   * @returns [엔티티 배열, 전체 개수] 튜플
   */
  async findAndCount<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
  ): Promise<[T[], number]> {
    const [entities, totalCount] = await Promise.all([
      this.find<T>(entity, findOption),
      this.count<T>(entity, findOption.where),
    ]);

    return [entities as unknown as T[], totalCount];
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

  /**
   * 임의의 SQL 쿼리를 실행하고 결과를 제네릭 타입 T[]로 반환합니다.
   *
   * @param sqlQuery 실행할 SQL 문자열 또는 sql-template-tag Sql 객체
   * @param params SQL 문자열 사용 시 바인딩할 파라미터 배열
   * @returns 쿼리 결과를 T[] 타입으로 반환
   *
   * @example
   * ```ts
   * interface UserRow { id: number; name: string; }
   * const users = await em.query<UserRow>(sql`SELECT * FROM "User" WHERE "id" = ${1}`);
   * ```
   */
  async query<T = Record<string, unknown>>(
    sqlQuery: string | Sql,
    params?: unknown[],
  ): Promise<T[]> {
    const transactionHolder = new TransactionSessionManager();

    try {
      await transactionHolder.connect();
      await transactionHolder.startTransaction();

      if (this.isMySqlFamily()) {
        await transactionHolder.query("SET autocommit = 0");
      }

      let queryResult: any;
      if (typeof sqlQuery === "string") {
        // string SQL with optional params: build a Sql object with parameter binding
        if (params && params.length > 0) {
          // Build parameterized query using sql-template-tag
          const parameterizedSql = {
            text: sqlQuery,
            sql: sqlQuery,
            values: params,
            strings: [sqlQuery],
          } as unknown as Sql;
          queryResult = await transactionHolder.query(parameterizedSql);
        } else {
          queryResult = await transactionHolder.query(sqlQuery);
        }
      } else {
        queryResult = await transactionHolder.query(sqlQuery);
      }

      await transactionHolder.commit();

      // 드라이버별 결과 정규화
      if (queryResult?.results) {
        // QueryResult 형태 ({ results, fields })
        return (queryResult.results as T[]) ?? [];
      }
      if (Array.isArray(queryResult)) {
        return queryResult as T[];
      }
      return [];
    } catch (e: unknown) {
      try {
        await transactionHolder.rollback();
      } catch (rollbackError) {
        this.logger.error(
          `Failed to rollback raw query transaction: ${rollbackError}`,
        );
      }
      throw e;
    } finally {
      try {
        await transactionHolder.close();
      } catch (closeError) {
        this.logger.error(
          `Failed to close raw query transaction: ${closeError}`,
        );
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

  /**
   * 내부 드라이버 인스턴스를 반환합니다.
   * PostgresTenantMigrationRunner 등 드라이버 접근이 필요한 경우에 사용합니다.
   *
   * @returns ISqlDriver 인스턴스 또는 connect() 전이면 undefined
   */
  getDriver(): ISqlDriver | undefined {
    return this.driver;
  }
}
