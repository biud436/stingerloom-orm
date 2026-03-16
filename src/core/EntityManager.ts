/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { ClazzType, Logger, resolveEntityGlobs } from "../utils";
import { ColumnMetadata } from "../scanner";
import { DatabaseClient } from "../DatabaseClient";
import { MySqlDriver } from "../dialects/mysql/MySqlDriver";
import { PostgresDriver } from "../dialects/postgres/PostgresDriver";
import { SqliteDriver } from "../dialects/sqlite/SqliteDriver";
import { ISqlDriver } from "../dialects/SqlDriver";
import { IDatabaseType } from "../dialects/mysql/MySqlConnector";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import { FindOption, WhereClause } from "../dialects/FindOption";
import { ISelectOption } from "../dialects/ISelectOption";
import { IDataSource } from "../dialects/IDataSource";
import { MySqlDataSource } from "../dialects/mysql/MySqlDataSource";
import { PostgresDataSource } from "../dialects/postgres/PostgresDataSource";
import { SqliteDataSource } from "../dialects/sqlite/SqliteDataSource";
import sql, { Sql, join, raw } from "sql-template-tag";
import { BaseRepository } from "./BaseRepository";
import { BaseEntityManager } from "./BaseEntityManager";
import { QueryResult } from "../types/QueryResult";
import { EntityResult } from "../types/EntityResult";
import { DeleteResult } from "../types/DeleteResult";
import { RawQueryBuilderFactory } from "./RawQueryBuilderFactory";
import { BaseRawQueryBuilder } from "./BaseRawQueryBuilder";
import { Conditions } from "./Conditions";
import { ResultTransformerFactory } from "./ResultTransformerFactory";
import { DatabaseClientOptions } from "./DatabaseClientOptions";
import { MetadataContext } from "../metadata/MetadataContext";
import { injectLazyProxy } from "./LazyLoader";
import { EntityValidator } from "./EntityValidator";
import {
  EntityEventEmitter,
  EntityEventType,
  EntityEventListener,
} from "./EntityEventEmitter";
import { EntityMetadataNotFoundError } from "../errors/EntityMetadataNotFoundError";
import { InvalidQueryError } from "../errors/InvalidQueryError";
import { OptimisticLockError } from "../errors/OptimisticLockError";
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
import {
  PagePaginationOption,
  PagePaginationResult,
  normalizePage,
} from "./PagePagination";
import { ExplainResult } from "./ExplainResult";
import {
  ReplicationRouter,
  ReplicationNodeConfig,
} from "../dialects/ReplicationRouter";
import { transactionStorage } from "../decorators/Transactional";

// Extracted handler classes
import { EntityManagerInternals } from "./EntityManagerInternals";
import { RelationMetadataResolver } from "./RelationMetadataResolver";
import { ReplicationManager } from "./ReplicationManager";
import { CascadeHandler } from "./CascadeHandler";
import { RelationLoader } from "./RelationLoader";
import { SchemaRegistrar } from "./SchemaRegistrar";
import { ExplainQueryHandler } from "./ExplainQueryHandler";
import { AggregateQueryHandler } from "./AggregateQueryHandler";
import {
  TenantQueryStrategy,
  SearchPathStrategy,
  SchemaQualifiedStrategy,
} from "./TenantQueryStrategy";

/**
 * Date를 MySQL/MariaDB 호환 'YYYY-MM-DD HH:MM:SS' 형식으로 변환합니다.
 * ISO 8601 형식은 MariaDB strict mode에서 거부될 수 있습니다.
 */
function formatDateTimeForSQL(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export class EntityManager implements BaseEntityManager {
  private _entities: ClazzType<any>[] = [];
  private readonly logger = new Logger(EntityManager.name);
  private driver?: ISqlDriver;
  private dataSource?: IDataSource;
  private dirtyEntities: Set<InstanceType<ClazzType<any>>> = new Set();
  private readonly eventEmitter = new EntityEventEmitter();
  private readonly subscribers: EntitySubscriber<any>[] = [];
  private readonly cursorPkWarned = new Set<string>();
  private queryTracker: QueryTracker | null = null;
  private defaultQueryTimeout: number | undefined;
  private queryLoggingEnabled = false;
  private tenantStrategy: TenantQueryStrategy = new SearchPathStrategy();

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

  // ── 추출된 핸들러 ──────────────────────────────────────────

  private readonly resolver = new RelationMetadataResolver();
  private readonly replication = new ReplicationManager();

  /** @internal 추출된 클래스에게 EntityManager 내부 기능을 노출하는 어댑터 */
  private readonly _ctx: EntityManagerInternals = {
    wrap: (col) => this.wrap(col),
    wrapTable: (tableName) => this.wrapTable(tableName),
    isMySqlFamily: () => this.isMySqlFamily(),
    isPostgres: () => this.isPostgres(),
    getDriver: () => this.driver,
    getEntities: () => this._entities,
    getSynchronize: () => this.client.getOptions(this.connectionName).synchronize ?? false as boolean | "safe" | "dry-run",
    executeInTransaction: (fn, s, r) => this.executeInTransaction(fn, s, r),
    executeReadOnly: (fn, opts) => this.executeReadOnly(fn, opts),
    beginTrackQuery: () => this.beginTrackQuery(),
    trackQuery: (e, s, m) => this.trackQuery(e, s, m),
    getReadNode: (u) => this.getReadNode(u),
    getNameStrategy: (c) => this.getNameStrategy(c),
    resolveSelectColumns: (s) => this.resolveSelectColumns(s),
    markDirty: (e) => this.dirtyEntities.add(e),
    findInternal: (e, o, s) => this.findInternal(e, o, s),
    findOneInternal: (e, o, s) => this.findOneInternal(e, o, s),
    save: (e, i) => this.save(e, i),
    find: (e, o) => this.find(e, o),
    delete: (e, c) => this.delete(e, c),
  };

  private readonly cascadeHandler = new CascadeHandler(this.resolver, this._ctx);
  private readonly relationLoader = new RelationLoader(this.resolver, this._ctx);
  private schemaRegistrar = new SchemaRegistrar(this.resolver, this._ctx);
  private readonly explainHandler = new ExplainQueryHandler(this.resolver, this._ctx);
  private readonly aggregateHandler = new AggregateQueryHandler(this.resolver, this._ctx);

  // ── 라이프사이클 ──────────────────────────────────────────

  public async register(
    databaseClientOptions: DatabaseClientOptions,
    connectionName = "default",
  ) {
    if (databaseClientOptions.namingStrategy) {
      this.schemaRegistrar = new SchemaRegistrar(
        this.resolver,
        this._ctx,
        databaseClientOptions.namingStrategy,
      );
    }
    await this.connect(databaseClientOptions, connectionName);
    await this.schemaRegistrar.registerEntities();
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
    const resolvedEntities = await resolveEntityGlobs(
      databaseClientOptions.entities ?? [],
    );
    this._entities = resolvedEntities as ClazzType<any>[];

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

    // TenantQueryStrategy 초기화
    if (databaseClientOptions.tenantStrategy === "schema_qualified") {
      this.tenantStrategy = new SchemaQualifiedStrategy();
    }

    // ReplicationRouter 초기화
    if (replication) {
      this.replication.initialize(replication);
    }
  }

  /**
   * 리소스를 정리하고 종료합니다.
   */
  public async propagateShutdown(options?: {
    gracefulTimeoutMs?: number;
    closeConnections?: boolean;
  }): Promise<boolean> {
    const gracefulTimeoutMs = options?.gracefulTimeoutMs ?? 0;
    const closeConnections = options?.closeConnections ?? false;

    let allQueriesCompleted = true;

    // 1. 진행 중 쿼리 대기
    if (gracefulTimeoutMs > 0 && this.queryTracker) {
      const activeCount = this.queryTracker.activeQueryCount;
      if (activeCount > 0) {
        this.logger.info(
          `[Shutdown] Waiting for ${activeCount} active queries (timeout: ${gracefulTimeoutMs}ms)...`,
        );
        allQueriesCompleted = await this.queryTracker.waitForQueries(gracefulTimeoutMs);
        if (!allQueriesCompleted) {
          this.logger.warn(
            `[Shutdown] Timed out waiting for active queries. Forcing shutdown.`,
          );
        }
      }
    }

    // 2. 이벤트 리스너 / 구독자 / dirty 엔티티 정리
    this.removeAllListeners();
    this.subscribers.length = 0;
    this.dirtyEntities.clear();
    this.cursorPkWarned.clear();

    // 3. QueryTracker 정리
    this.queryTracker?.reset();
    this.queryTracker = null;

    // 4. ReplicationRouter 정리
    this.replication.shutdown();

    // 5. 커넥션 풀 종료 (요청 시)
    if (closeConnections) {
      try {
        await this.client.close(this.connectionName);
      } catch (err) {
        this.logger.warn(
          `[Shutdown] Error closing connection '${this.connectionName}': ${err}`,
        );
      }
    }

    return allQueriesCompleted;
  }

  getNameStrategy<T>(clazz: ClazzType<T>): string {
    return clazz.name;
  }

  // ── QueryTracker ──────────────────────────────────────────

  private initQueryTracker(options: DatabaseClientOptions): void {
    const logging = options.logging;

    // logging: true → enable query SQL logging
    if (logging === true) {
      this.queryLoggingEnabled = true;
      return;
    }

    if (typeof logging === "object" && logging !== null) {
      const loggingOpts = logging as LoggingOptions;

      // queries: true → log generated SQL
      if (loggingOpts.queries) {
        this.queryLoggingEnabled = true;
      }

      // enableQueryTracking이 명시적으로 false이면 비활성화
      if (loggingOpts.enableQueryTracking === false) {
        this.queryTracker = null;
        return;
      }

      if (loggingOpts.nPlusOne || loggingOpts.slowQueryMs) {
        this.queryTracker = new QueryTracker({
          slowQueryMs: loggingOpts.slowQueryMs ?? null,
          enabled: loggingOpts.enableQueryTracking ?? true,
          maxLogEntries: loggingOpts.maxLogEntries,
          ttlMs: loggingOpts.ttlMs,
        });
      }
    }
  }

  getQueryLog(): ReadonlyArray<QueryLogEntry> {
    return this.queryTracker?.getLog() ?? [];
  }

  getQueryTracker(): QueryTracker | null {
    return this.queryTracker;
  }

  private beginTrackQuery(): void {
    this.queryTracker?.beginQuery();
  }

  private trackQuery(
    entityName: string,
    sqlText: string,
    durationMs: number,
  ): void {
    if (this.queryLoggingEnabled) {
      this.logger.debug(`[${entityName}] ${sqlText} (+${durationMs}ms)`);
    }
    this.queryTracker?.endQuery();
    this.queryTracker?.track(entityName, sqlText, durationMs);
  }

  // ── Replication 위임 ──────────────────────────────────────

  getReadNode(useMaster?: boolean): ReplicationNodeConfig | null {
    return this.replication.getReadNode(useMaster);
  }

  getWriteNode(): ReplicationNodeConfig | null {
    return this.replication.getWriteNode();
  }

  get isReplicationEnabled(): boolean {
    return this.replication.isEnabled;
  }

  getReplicationRouter(): ReplicationRouter | null {
    return this.replication.getRouter();
  }

  // ── 이벤트 / 구독 ────────────────────────────────────────

  on(event: EntityEventType, listener: EntityEventListener): void {
    this.eventEmitter.on(event, listener);
  }

  off(event: EntityEventType, listener: EntityEventListener): void {
    this.eventEmitter.off(event, listener);
  }

  removeAllListeners(): void {
    this.eventEmitter.removeAllListeners();
  }

  addSubscriber(subscriber: EntitySubscriber<any>): void {
    this.subscribers.push(subscriber);
  }

  removeSubscriber(subscriber: EntitySubscriber<any>): void {
    const idx = this.subscribers.indexOf(subscriber);
    if (idx !== -1) {
      this.subscribers.splice(idx, 1);
    }
  }

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

  private async notifyTransactionSubscribers(
    method: keyof EntitySubscriber<any>,
  ): Promise<void> {
    for (const sub of this.subscribers) {
      if (typeof sub[method] === "function") {
        await (sub[method] as Function)();
      }
    }
  }

  // ── CRUD: 읽기 ────────────────────────────────────────────

  async findOne<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
  ): Promise<T | null> {
    return this.findOneInternal(entity, findOption);
  }

  private async findOneInternal<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
    existingSession?: TransactionSessionManager,
  ): Promise<T | null> {
    const result = await this.findInternal<T>(entity, { ...findOption, limit: 1 }, existingSession);
    if (result === undefined || result === null) {
      return null;
    }
    if (Array.isArray(result)) {
      return (result[0] as T) ?? null;
    }
    return result as T;
  }

  async find<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
  ): Promise<T[]> {
    const result = await this.findInternal(entity, findOption);
    if (result === undefined || result === null) return [];
    if (Array.isArray(result)) return result as T[];
    return [result as T];
  }

  private async findInternal<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
    existingSession?: TransactionSessionManager,
  ): Promise<EntityResult<T>> {
    const { select, orderBy, where, take, skip, groupBy, having } = findOption;
    const { limit } = findOption;

    const readNode = this.getReadNode(findOption.useMaster);
    const effectiveTimeout = findOption.timeout ?? this.defaultQueryTimeout;

    return this.executeReadOnly(async (session) => {
      const resultTransformer = ResultTransformerFactory.create();

      const metadata = this.resolver.resolveEntityMetadata(entity);

      if (!metadata) {
        throw new EntityMetadataNotFoundError(entity.name);
      }

      const qb = RawQueryBuilderFactory.create();

      const selectMap: string[] = [];
      const whereMap: Sql[] = [];
      const orderByMap: Array<{ column: string; direction: "ASC" | "DESC" }> =
        [];

      // Eager 로드할 ManyToOne 관계를 수집
      const manyToOneRelations = this.resolver.resolveManyToOneMetadata(entity);
      const eagerRelations = manyToOneRelations.filter((rel) => {
        const isEager = rel.option?.eager === true;
        const isInRelations = findOption.relations?.includes(
          rel.columnName,
        );
        return isEager || isInRelations;
      });

      // Eager 로드할 OneToOne 관계를 수집 (소유측: joinColumn이 있는 쪽)
      const oneToOneRelations = this.resolver.resolveOneToOneMetadata(entity);
      const eagerOneToOneRelations = oneToOneRelations.filter((rel) => {
        if (!rel.joinColumn) return false;
        const isEager = rel.option?.eager === true;
        const isInRelations = findOption.relations?.includes(
          rel.propertyKey,
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

      // ManyToOne Eager 관계 컬럼을 SELECT에 추가
      for (const rel of eagerRelations) {
        const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
        const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
        if (!relatedMetadata) continue;

        const relatedName = relatedMetadata.name || RelatedEntity.name;
        for (const col of relatedMetadata.columns) {
          const alias = `${rel.columnName}_${col.name}`;
          selectMap.push(
            `${this.wrap(relatedName)}.${this.wrap(col.name!)} AS ${this.wrap(alias)}`,
          );
        }
      }

      // OneToOne Eager 관계 컬럼을 SELECT에 추가
      for (const rel of eagerOneToOneRelations) {
        const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
        const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
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
            const col = `${this.wrap(tableName)}.${this.wrap(key)}`;
            whereMap.push(
              Array.isArray(value)
                ? Conditions.in(col, value)
                : Conditions.equals(col, value),
            );
          } else {
            const col = this.wrap(key);
            whereMap.push(
              Array.isArray(value)
                ? Conditions.in(col, value)
                : Conditions.equals(col, value),
            );
          }
        }
      }

      // @DeletedAt 컬럼이 있으면 자동으로 WHERE deleted_at IS NULL 조건 추가
      const deletedAtColumn = this.resolver.getDeletedAtColumn(entity);
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

      qb.select(selectMap).from(this.wrapTable(tableName));

      // Eager ManyToOne LEFT JOIN
      for (const rel of eagerRelations) {
        const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
        const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
        if (!relatedMetadata) continue;

        const relatedTableName = relatedMetadata.name || RelatedEntity.name;
        const joinColumn = rel.joinColumn ?? rel.columnName;

        const relatedPk = relatedMetadata.columns.find(
          (col: any) => col.options?.primary,
        );
        if (!relatedPk) continue;

        const joinCondition = sql`${raw(this.wrap(tableName))}.${raw(this.wrap(joinColumn))} = ${raw(this.wrap(relatedTableName))}.${raw(this.wrap(relatedPk.name!))}`;
        qb.leftJoin(
          this.wrapTable(relatedTableName),
          this.wrap(relatedTableName),
          joinCondition,
        );
      }

      // OneToOne Eager LEFT JOIN
      for (const rel of eagerOneToOneRelations) {
        const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
        const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
        if (!relatedMetadata) continue;

        const relatedTableName = relatedMetadata.name || RelatedEntity.name;
        const joinColumn = rel.joinColumn!;

        const relatedPk = relatedMetadata.columns.find(
          (col: any) => col.options?.primary,
        );
        if (!relatedPk) continue;

        const joinCondition = sql`${raw(this.wrap(tableName))}.${raw(this.wrap(joinColumn))} = ${raw(this.wrap(relatedTableName))}.${raw(this.wrap(relatedPk.name!))}`;
        qb.leftJoin(
          this.wrapTable(relatedTableName),
          this.wrap(relatedTableName),
          joinCondition,
        );
      }

      qb.where(whereMap);

      // GROUP BY / HAVING
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

      qb.orderBy(orderByMap);

      if (Array.isArray(limit)) {
        let [offset, count] = limit;
        if (offset < 0) offset = 0;
        if (count < 0) count = 0;
        if (count === 0) count = 1;
        if (take && take > 0) count = take;
        if (this.isMySqlFamily()) qb.setDatabaseType("mysql");
        qb.limit([offset, count]);
      } else if (skip !== undefined || (take !== undefined && !limit)) {
        // skip/take pagination → convert to limit tuple
        const offset = Math.max(skip ?? 0, 0);
        const count = Math.max(take ?? 0, 0) || undefined;
        if (count) {
          if (this.isMySqlFamily()) qb.setDatabaseType("mysql");
          qb.limit([offset, count]);
        } else if (offset > 0 && this.isMySqlFamily()) {
          // MySQL requires a count with OFFSET — use a very large number
          qb.setDatabaseType("mysql");
          qb.limit([offset, 2147483647]);
        } else if (offset > 0) {
          qb.limit([offset, 2147483647]);
        }
      } else {
        if (limit) {
          qb.limit(limit as number);
        }
      }

      const resultQuery = qb.build();

      // per-query 또는 connection-level 타임아웃 적용
      const effectiveTimeout = findOption.timeout ?? this.defaultQueryTimeout;
      if (effectiveTimeout && effectiveTimeout > 0 && this.driver) {
        const timeoutSql = this.driver.setQueryTimeout(effectiveTimeout);
        await session.query(timeoutSql);
      }

      const queryStartTime = Date.now();
      this.beginTrackQuery();
      const queryResult = (await session.query<T>(
        resultQuery,
      )) as QueryResult;
      this.trackQuery(
        entity.name,
        resultQuery.text ?? String(resultQuery),
        Date.now() - queryStartTime,
      );

      const { results } = queryResult;
      if (!results || results.length === 0) {
        return undefined;
      }

      const isEntityArray = results.length > 1;
      let entityResult: EntityResult<T>;
      if (hasEagerJoins) {
        entityResult = resultTransformer.transformNested(
          entity,
          queryResult,
        ) as EntityResult<T>;
      } else if (isEntityArray) {
        entityResult = resultTransformer.toEntities(entity, queryResult);
      } else {
        entityResult = resultTransformer.toEntity(entity, queryResult);
      }

      // OneToMany / ManyToMany / OneToOne(inverse) 관계 로드
      if (
        findOption.relations &&
        findOption.relations.length > 0 &&
        entityResult
      ) {
        await this.relationLoader.loadOneToManyRelations(
          entity,
          entityResult as T | T[],
          findOption.relations,
          session,
        );
        await this.relationLoader.loadManyToManyRelations(
          entity,
          entityResult as T | T[],
          findOption.relations,
          session,
        );
        await this.relationLoader.loadOneToOneRelations(
          entity,
          entityResult as T | T[],
          findOption.relations,
          session,
        );
      }

      // Lazy ManyToOne 관계에 대해 Proxy 주입
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

            const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
            if (!relatedMetadata) continue;

            const relatedPk = relatedMetadata.columns.find(
              (col: any) => col.options?.primary,
            );
            if (!relatedPk) continue;

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
    }, { existingSession, readNodeOverride: readNode, timeout: effectiveTimeout });
  }

  async findWithCursor<T>(
    entity: ClazzType<T>,
    option: CursorPaginationOption<T> = {},
  ): Promise<CursorPaginationResult<T>> {
    const metadata = this.resolver.resolveEntityMetadata(entity);

    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const pk = metadata.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );

    const orderByColumn = option.orderBy ?? (pk?.name as keyof T & string);
    if (!orderByColumn) {
      throw new InvalidQueryError(
        "Cursor pagination requires an orderBy column or a primary key.",
      );
    }

    // orderBy를 명시하지 않은 경우 PK 타입을 검사하여 비숫자형이면 경고
    if (!option.orderBy && pk) {
      this.warnIfNonSortablePk(entity.name, pk);
    }

    const direction = option.direction ?? "ASC";
    const pageSize = normalizePageSize(option.take);

    let cursorValue: unknown = null;
    if (option.cursor) {
      cursorValue = decodeCursor(option.cursor);
      if (cursorValue === null) {
        throw new InvalidQueryError("Invalid cursor value.");
      }
    }

    const where: any = { ...(option.where ?? {}) };
    const readNode = this.getReadNode(option.useMaster);

    return this.executeReadOnly(async (session) => {
      const resultTransformer = ResultTransformerFactory.create();

      const tableName = metadata.name!;
      const qb = RawQueryBuilderFactory.create();

      const selectMap = metadata.columns.map((column) =>
        this.wrap(column.name!),
      );

      const whereMap: Sql[] = [];

      for (const key in where) {
        const value = where[key];
        if (value !== undefined && value !== null) {
          const col = this.wrap(key);
          whereMap.push(
            Array.isArray(value)
              ? Conditions.in(col, value)
              : Conditions.equals(col, value),
          );
        }
      }

      const deletedAtColumn = this.resolver.getDeletedAtColumn(entity);
      if (deletedAtColumn) {
        whereMap.push(Conditions.isNull(this.wrap(deletedAtColumn)));
      }

      if (cursorValue !== null) {
        if (direction === "ASC") {
          whereMap.push(Conditions.gt(this.wrap(orderByColumn), cursorValue));
        } else {
          whereMap.push(Conditions.lt(this.wrap(orderByColumn), cursorValue));
        }
      }

      qb.select(selectMap)
        .from(this.wrapTable(tableName))
        .where(whereMap)
        .orderBy([{ column: this.wrap(orderByColumn), direction }]);

      qb.limit(pageSize + 1);

      const resultQuery = qb.build();

      const queryResult = (await session.query<T>(
        resultQuery,
      )) as QueryResult;

      const { results } = queryResult;
      if (!results || results.length === 0) {
        return {
          data: [],
          hasNextPage: false,
          nextCursor: null,
          count: 0,
        };
      }

      const hasNextPage = results.length > pageSize;
      const pageResults = hasNextPage ? results.slice(0, pageSize) : results;

      const entities = resultTransformer.toEntities(entity, {
        results: pageResults,
        fields: queryResult.fields,
      });

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
    }, { readNodeOverride: readNode });
  }

  async findAndCount<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
  ): Promise<[T[], number]> {
    return this.executeInTransaction(async (session) => {
      const entities = await this.findInternal<T>(entity, findOption, session);
      const totalCount = await this.aggregateHandler.aggregate<T>(entity, "COUNT", "*", findOption.where, session);

      return [entities as unknown as T[], totalCount];
    });
  }

  async findWithPage<T>(
    entity: ClazzType<T>,
    option: PagePaginationOption<T> = {},
  ): Promise<PagePaginationResult<T>> {
    const page = normalizePage(option.page);
    const pageSize = normalizePageSize(option.pageSize);
    const offset = (page - 1) * pageSize;

    const [rawData, total] = await this.findAndCount<T>(entity, {
      where: option.where,
      orderBy: option.orderBy,
      select: option.select,
      relations: option.relations,
      withDeleted: option.withDeleted,
      timeout: option.timeout,
      useMaster: option.useMaster,
      groupBy: option.groupBy,
      having: option.having,
      limit: [offset, pageSize],
    });

    const data = (rawData ?? []) as T[];
    const totalPages = Math.ceil(total / pageSize);

    return {
      data,
      total,
      page,
      pageSize,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    };
  }

  // ── CRUD: 쓰기 ────────────────────────────────────────────

  async save<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): Promise<InstanceType<ClazzType<T>>> {
    return this.saveInternal(entity, item);
  }

  private async saveInternal<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
    existingSession?: TransactionSessionManager,
  ): Promise<InstanceType<ClazzType<T>>> {
    const metadata = this.resolver.resolveEntityMetadata(entity);

    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    // 유효성 검사
    EntityValidator.validate(entity, item);

    // Cascade: ManyToOne 관계의 부모 엔티티를 먼저 저장
    await this.cascadeHandler.cascadeSaveManyToOne(entity, item);

    return this.executeInTransaction(async (session) => {
      const pkColumns = metadata.columns.filter(
        (column: ColumnMetadata) => column.options?.primary,
      );
      const pk = pkColumns[0];

      const hasAutoIncrementPk = pkColumns.some(
        (col: ColumnMetadata) => col.options?.autoIncrement,
      );
      const primaryKeyValue = pk ? (item as any)[pk.name!] : undefined;

      const isInsert = hasAutoIncrementPk
        ? !primaryKeyValue
        : true;

      const buildPkWhere = (pkValues?: Record<string, any>) => {
        return pkColumns.map((col: ColumnMetadata) => {
          const value = pkValues
            ? pkValues[col.name!]
            : (item as any)[col.name!];
          return sql`${raw(this.wrap(col.name!))} = ${value}`;
        });
      };

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
        await this.cascadeHandler.runHooks(entity, item, "beforeInsert");
        await this.eventEmitter.emit("beforeInsert", { entity, data: item });
        await this.notifySubscribers(entity, "beforeInsert", {
          entity: item,
          manager: this,
        } as InsertEvent<T>);

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

        // @CreateTimestamp / @UpdateTimestamp 자동 주입 (INSERT 시)
        const now = new Date();
        const nowStr = formatDateTimeForSQL(now);
        const createTsCol = this.resolver.getCreateTimestampColumn(entity);
        if (createTsCol) {
          const idx = insertableColumns.findIndex(
            (col: ColumnMetadata) => col.name === createTsCol,
          );
          if (idx >= 0) {
            const existing = (item as any)[createTsCol];
            values[idx] = existing instanceof Date ? formatDateTimeForSQL(existing) : (existing ?? nowStr);
          }
        }
        const updateTsCol = this.resolver.getUpdateTimestampColumn(entity);
        if (updateTsCol) {
          const idx = insertableColumns.findIndex(
            (col: ColumnMetadata) => col.name === updateTsCol,
          );
          if (idx >= 0) {
            const existing = (item as any)[updateTsCol];
            values[idx] = existing instanceof Date ? formatDateTimeForSQL(existing) : (existing ?? nowStr);
          }
        }

        // @Version 컬럼 자동 초기화
        const versionCol = this.resolver.getVersionColumn(entity);
        if (versionCol) {
          const versionIdx = insertableColumns.findIndex(
            (col: ColumnMetadata) => col.name === versionCol,
          );
          if (versionIdx >= 0) {
            values[versionIdx] = 1;
          }
        }

        // ManyToOne FK 컬럼 값 추출
        const manyToOneRelations = this.resolver.resolveManyToOneMetadata(entity);
        for (const rel of manyToOneRelations) {
          if (!rel.joinColumn) continue;
          const relatedValue = (item as any)[rel.columnName];
          const idPropValue = (item as any)[`${rel.columnName}Id`];

          const existingIdx = insertableColumns.findIndex(
            (col: ColumnMetadata) => col.name === rel.joinColumn,
          );

          let fkValue: any = undefined;

          if (relatedValue === null) {
            fkValue = null;
          } else if (relatedValue && typeof relatedValue === "object") {
            const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
            const relatedMeta = this.resolver.resolveEntityMetadata(RelatedEntity);
            if (relatedMeta) {
              const relatedPk = relatedMeta.columns.find(
                (col: any) => col.options?.primary,
              );
              if (relatedPk) {
                fkValue = relatedValue[relatedPk.name!] ?? undefined;
              }
            }
          } else if (idPropValue != null) {
            fkValue = idPropValue;
          }

          if (fkValue !== undefined) {
            if (existingIdx >= 0) {
              values[existingIdx] = fkValue;
            } else {
              columns.push(raw(this.wrap(rel.joinColumn)));
              values.push(fkValue);
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
                        INSERT INTO ${raw(this.wrapTable(metadata.name!))}
                        (${join(columns, ", ")})
                        VALUES (${join(values, ", ")})${returningSql}
                    `;
        const saveQueryStart = Date.now();
        this.beginTrackQuery();
        const queryResult = (await session.query<T>(insertSql)) as {
          results: any;
          fields: any;
        };
        this.trackQuery(
          entity.name,
          insertSql.text ?? String(insertSql),
          Date.now() - saveQueryStart,
        );

        if (this.isMySqlFamily()) {
          const findWhere = hasAutoIncrementPk
            ? { [pk.name!]: queryResult?.results?.insertId }
            : buildPkFindWhere();
          const result = await this.findOneInternal(entity, {
            where: findWhere,
          } as any, session);

          const cascadeId = hasAutoIncrementPk
            ? queryResult?.results?.insertId
            : primaryKeyValue;
          await this.cascadeHandler.cascadeSaveOneToMany(entity, item, cascadeId);
          await this.cascadeHandler.runHooks(entity, item, "afterInsert");
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
          const result = await this.findOneInternal(entity, {
            where: findWhere,
          } as any, session);

          const cascadeId = returnedRow[pk.name!];
          await this.cascadeHandler.cascadeSaveOneToMany(entity, item, cascadeId);
          await this.cascadeHandler.runHooks(entity, item, "afterInsert");
          await this.eventEmitter.emit("afterInsert", { entity, data: item });
          await this.notifySubscribers(entity, "afterInsert", {
            entity: item,
            manager: this,
          } as InsertEvent<T>);
          return result as T;
        }

        await this.cascadeHandler.runHooks(entity, item, "afterInsert");
        await this.eventEmitter.emit("afterInsert", { entity, data: item });
        await this.notifySubscribers(entity, "afterInsert", {
          entity: item,
          manager: this,
        } as InsertEvent<T>);
        return queryResult as T;
      }

      // UPDATE path
      await this.cascadeHandler.runHooks(entity, item, "beforeUpdate");
      await this.eventEmitter.emit("beforeUpdate", { entity, data: item });
      await this.notifySubscribers(entity, "beforeUpdate", {
        entity: item,
        manager: this,
      } as UpdateEvent<T>);

      const versionColName = this.resolver.getVersionColumn(entity);
      const pkColumnNames = new Set(
        pkColumns.map((col: ColumnMetadata) => col.name!),
      );
      const updatableColumns = metadata.columns.filter(
        (column: ColumnMetadata) => {
          if (pkColumnNames.has(column.name!)) return false;
          if (versionColName && column.name === versionColName) return false;
          return (item as any)[column.name!] !== undefined;
        },
      );
      const updateMap = updatableColumns.map((column: ColumnMetadata) => {
        return sql`${raw(this.wrap(column.name!))} = ${(item as any)[column.name!]}`;
      });

      // @UpdateTimestamp 자동 주입
      const updateTsColName = this.resolver.getUpdateTimestampColumn(entity);
      if (updateTsColName) {
        const existingIdx = updatableColumns.findIndex(
          (col: ColumnMetadata) => col.name === updateTsColName,
        );
        const updateNow = formatDateTimeForSQL(new Date());
        if (existingIdx >= 0) {
          updateMap[existingIdx] =
            sql`${raw(this.wrap(updateTsColName))} = ${updateNow}`;
        } else {
          updateMap.push(
            sql`${raw(this.wrap(updateTsColName))} = ${updateNow}`,
          );
        }
      }

      const updatedColumnNames = new Set(
        updatableColumns.map((col: ColumnMetadata) => col.name!),
      );

      // ManyToOne FK 컬럼 값을 UPDATE SET에 추가
      const updateManyToOneRelations = this.resolver.resolveManyToOneMetadata(entity);
      for (const rel of updateManyToOneRelations) {
        if (!rel.joinColumn) continue;
        const relatedValue = (item as any)[rel.columnName];

        if (relatedValue === undefined) continue;

        const alreadyInSet = updatedColumnNames.has(rel.joinColumn);

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
          const relatedMeta = this.resolver.resolveEntityMetadata(RelatedEntity);
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

      // @Version: Optimistic Locking
      const currentVersion = versionColName
        ? (item as any)[versionColName]
        : undefined;
      if (versionColName) {
        updateMap.push(
          sql`${raw(this.wrap(versionColName))} = ${raw(this.wrap(versionColName))} + 1`,
        );
        if (currentVersion !== undefined && currentVersion !== null) {
          pkWhereClauses.push(
            sql`${raw(this.wrap(versionColName))} = ${currentVersion}`,
          );
        }
      }

      if (updateMap.length > 0) {
        const updateSql = sql`
            UPDATE ${raw(this.wrapTable(metadata.name!))}
            SET ${join(updateMap, ", ")}
            WHERE ${join(pkWhereClauses, " AND ")}
                  `;
        const updateStart = Date.now();
        this.beginTrackQuery();
        const updateResult = (await session.query<T>(updateSql)) as {
          results: any;
          fields: any;
          rowCount?: number;
        };
        this.trackQuery(
          entity.name,
          updateSql.text ?? String(updateSql),
          Date.now() - updateStart,
        );

        if (versionColName && currentVersion !== undefined && currentVersion !== null) {
          let affected = 0;
          if (this.isMySqlFamily()) {
            affected = updateResult?.results?.affectedRows ?? 0;
          } else {
            affected = updateResult?.rowCount ?? 0;
          }
          if (affected === 0) {
            throw new OptimisticLockError(entity.name, currentVersion);
          }
        }
      }

      await this.cascadeHandler.cascadeSaveOneToMany(entity, item, primaryKeyValue);

      await this.cascadeHandler.runHooks(entity, item, "afterUpdate");
      await this.eventEmitter.emit("afterUpdate", { entity, data: item });
      await this.notifySubscribers(entity, "afterUpdate", {
        entity: item,
        manager: this,
      } as UpdateEvent<T>);

      const result = await this.findOneInternal(entity, {
        where: buildPkFindWhere(),
      } as any, session);

      return result as T;
    }, existingSession);
  }

  async saveMany<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
  ): Promise<InstanceType<ClazzType<T>>[]> {
    if (items.length === 0) {
      return [];
    }

    return this.executeInTransaction(async (session) => {
      const results: InstanceType<ClazzType<T>>[] = [];
      for (const item of items) {
        const saved = await this.saveInternal(entity, item, session);
        results.push(saved);
      }
      return results;
    });
  }

  async insertMany<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
  ): Promise<{ affected: number }> {
    if (items.length === 0) {
      return { affected: 0 };
    }

    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    return this.executeInTransaction(async (session) => {
      const deletedAtColumn = this.resolver.getDeletedAtColumn(entity);
      const timestampTypes = new Set(["datetime", "timestamp", "date"]);
      const timestampColumns = metadata.columns.filter(
        (col: ColumnMetadata) =>
          col.options?.type &&
          timestampTypes.has(col.options.type) &&
          col.name !== deletedAtColumn,
      );
      if (timestampColumns.length > 0) {
        const now = new Date();
        for (const item of items) {
          for (const col of timestampColumns) {
            if ((item as any)[col.name!] == null) {
              (item as any)[col.name!] = now;
            }
          }
        }
      }

      const versionCol = this.resolver.getVersionColumn(entity);
      if (versionCol) {
        for (const item of items) {
          if ((item as any)[versionCol] == null) {
            (item as any)[versionCol] = 1;
          }
        }
      }

      const insertableColumns = metadata.columns.filter(
        (column: ColumnMetadata) => {
          const isAutoIncrement = column.options?.autoIncrement;
          if (!isAutoIncrement) return true;
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

      const manyToOneRelations = this.resolver.resolveManyToOneMetadata(entity);
      const fkColumns: { joinColumn: string; propertyName: string; relMeta: any }[] = [];
      for (const rel of manyToOneRelations) {
        if (!rel.joinColumn) continue;
        const alreadyIncluded = insertableColumns.some(
          (col: ColumnMetadata) => col.name === rel.joinColumn,
        );
        if (!alreadyIncluded) {
          columns.push(raw(this.wrap(rel.joinColumn)));
          fkColumns.push({
            joinColumn: rel.joinColumn,
            propertyName: rel.columnName,
            relMeta: rel,
          });
        }
      }

      const valueRows = items.map((item) => {
        const rowValues = insertableColumns.map(
          (column: ColumnMetadata) => (item as any)[column.name!],
        );
        for (const fk of fkColumns) {
          const relatedValue = (item as any)[fk.propertyName];
          const idPropValue = (item as any)[`${fk.propertyName}Id`];

          if (relatedValue != null) {
            if (typeof relatedValue === "object") {
              const RelatedEntity = fk.relMeta.getMappingEntity() as ClazzType<any>;
              const relatedMeta = this.resolver.resolveEntityMetadata(RelatedEntity);
              const relatedPk = relatedMeta?.columns.find(
                (col: any) => col.options?.primary,
              );
              rowValues.push(relatedPk ? relatedValue[relatedPk.name!] ?? null : null);
            } else {
              rowValues.push(relatedValue);
            }
          } else if (idPropValue != null) {
            rowValues.push(idPropValue);
          } else {
            rowValues.push(null);
          }
        }
        return sql`(${join(rowValues, ", ")})`;
      });

      const queryStr = sql`INSERT INTO ${raw(this.wrapTable(metadata.name!))} (${join(columns, ", ")}) VALUES ${join(valueRows, ", ")}`;

      const queryResult = (await session.query(queryStr)) as {
        results: any;
        fields: any;
        rowCount?: number;
      };

      let affected = items.length;
      if (this.isMySqlFamily()) {
        affected = queryResult?.results?.affectedRows ?? items.length;
      } else if (queryResult?.rowCount !== undefined) {
        affected = queryResult.rowCount;
      }

      return { affected };
    });
  }

  // ── CRUD: 삭제 ────────────────────────────────────────────

  async delete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult> {
    const metadata = this.resolver.resolveEntityMetadata(entity);

    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    return this.executeInTransaction(async (session) => {
      await this.cascadeHandler.runHooks(entity, criteria as Partial<T>, "beforeDelete");
      await this.eventEmitter.emit("beforeDelete", { entity, data: criteria as Partial<T> });
      await this.notifySubscribers(entity, "beforeDelete", {
        entityClass: entity,
        criteria,
        manager: this,
      } as DeleteEvent<T>);

      // cascade remove
      await this.cascadeHandler.cascadeDeleteOneToMany(entity, criteria);

      const whereMap: Sql[] = [];
      for (const key in criteria) {
        const value = (criteria as any)[key];
        if (value !== undefined && value !== null) {
          const col = this.wrap(key);
          whereMap.push(
            Array.isArray(value)
              ? Conditions.in(col, value)
              : Conditions.equals(col, value),
          );
        }
      }

      if (whereMap.length === 0) {
        throw new DeleteWithoutConditionsError("Delete");
      }

      const whereSql = join(whereMap, " AND ");

      const deleteQuery = sql`DELETE FROM ${raw(this.wrapTable(metadata.name!))} WHERE ${whereSql}`;

      const deleteStart = Date.now();
      this.beginTrackQuery();
      const queryResult = (await session.query(deleteQuery)) as {
        results: any;
        fields: any;
        rowCount?: number;
      };
      this.trackQuery(
        entity.name,
        deleteQuery.text ?? String(deleteQuery),
        Date.now() - deleteStart,
      );

      let affected = 0;
      if (this.isMySqlFamily()) {
        affected = queryResult?.results?.affectedRows ?? 0;
      } else {
        affected = queryResult?.rowCount ?? 0;
      }

      await this.cascadeHandler.runHooks(entity, criteria as Partial<T>, "afterDelete");
      await this.eventEmitter.emit("afterDelete", { entity, data: criteria as Partial<T> });
      await this.notifySubscribers(entity, "afterDelete", {
        entityClass: entity,
        criteria,
        manager: this,
      } as DeleteEvent<T>);

      return { affected };
    });
  }

  async deleteMany<T>(entity: ClazzType<T>, ids: any[]): Promise<DeleteResult> {
    if (ids.length === 0) {
      return { affected: 0 };
    }

    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const pk = metadata.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );
    if (!pk) {
      throw new PrimaryKeyNotFoundError(entity.name);
    }

    return this.executeInTransaction(async (session) => {
      const placeholders = join(
        ids.map((id) => sql`${id}`),
        ", ",
      );

      const deleteQuery = sql`DELETE FROM ${raw(this.wrapTable(metadata.name!))} WHERE ${raw(this.wrap(pk.name!))} IN (${placeholders})`;

      const queryResult = (await session.query(deleteQuery)) as {
        results: any;
        fields: any;
        rowCount?: number;
      };

      let affected = 0;
      if (this.isMySqlFamily()) {
        affected = queryResult?.results?.affectedRows ?? 0;
      } else {
        affected = queryResult?.rowCount ?? 0;
      }

      return { affected };
    });
  }

  async clear<T>(entity: ClazzType<T>): Promise<void> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    if (!this.driver) {
      throw new Error("Driver is not initialized. Call connect() first.");
    }

    await this.driver.clear(metadata.name!);
  }

  /**
   * Updates multiple entities matching the WHERE condition with the given data.
   *
   * @param entity The entity class.
   * @param data The partial data to set on matching rows.
   * @param options Options with `where` clause to filter rows.
   * @returns The number of affected rows.
   *
   * @example
   * ```ts
   * const result = await em.updateMany(User, { active: true }, { where: { status: 'pending' } });
   * console.log(result.affected); // 42
   * ```
   */
  async updateMany<T>(
    entity: ClazzType<T>,
    data: Partial<T>,
    options: { where: WhereClause<T> },
  ): Promise<{ affected: number }> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const { where } = options;
    if (!where || Object.keys(where).length === 0) {
      throw new DeleteWithoutConditionsError("Update");
    }

    return this.executeInTransaction(async (session) => {
      const setMap: Sql[] = [];
      for (const key in data) {
        const value = (data as any)[key];
        if (value !== undefined) {
          setMap.push(sql`${raw(this.wrap(key))} = ${value}`);
        }
      }

      // @UpdateTimestamp auto-inject
      const updateTsColName = this.resolver.getUpdateTimestampColumn(entity);
      if (updateTsColName) {
        const hasExplicit = setMap.some(
          (s) => s.text?.includes(this.wrap(updateTsColName)),
        );
        if (!hasExplicit) {
          setMap.push(
            sql`${raw(this.wrap(updateTsColName))} = ${formatDateTimeForSQL(new Date())}`,
          );
        }
      }

      if (setMap.length === 0) {
        return { affected: 0 };
      }

      const whereMap: Sql[] = [];
      for (const key in where) {
        const value = (where as any)[key];
        if (value !== undefined && value !== null) {
          const col = this.wrap(key);
          whereMap.push(
            Array.isArray(value)
              ? Conditions.in(col, value)
              : Conditions.equals(col, value),
          );
        }
      }

      const updateSql = sql`UPDATE ${raw(this.wrapTable(metadata.name!))} SET ${join(setMap, ", ")} WHERE ${join(whereMap, " AND ")}`;

      const queryStart = Date.now();
      this.beginTrackQuery();
      const queryResult = (await session.query(updateSql)) as {
        results: any;
        fields: any;
        rowCount?: number;
      };
      this.trackQuery(
        entity.name,
        updateSql.text ?? String(updateSql),
        Date.now() - queryStart,
      );

      let affected = 0;
      if (this.isMySqlFamily()) {
        affected = queryResult?.results?.affectedRows ?? 0;
      } else {
        affected = queryResult?.rowCount ?? 0;
      }

      return { affected };
    });
  }

  async softDelete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const deletedAtColumn = this.resolver.getDeletedAtColumn(entity);
    if (!deletedAtColumn) {
      throw new InvalidQueryError(
        `Entity "${entity.name}" does not have a @DeletedAt column. Use delete() instead.`,
      );
    }

    return this.executeInTransaction(async (session) => {
      const whereMap: Sql[] = [];
      for (const key in criteria) {
        const value = (criteria as any)[key];
        if (value !== undefined && value !== null) {
          const col = this.wrap(key);
          whereMap.push(
            Array.isArray(value)
              ? Conditions.in(col, value)
              : Conditions.equals(col, value),
          );
        }
      }

      if (whereMap.length === 0) {
        throw new DeleteWithoutConditionsError("Soft delete");
      }

      const whereSql = join(whereMap, " AND ");

      const nowExpr = this.isPostgres() ? raw("NOW()") : raw("NOW()");
      const updateQuery = sql`UPDATE ${raw(this.wrapTable(metadata.name!))} SET ${raw(this.wrap(deletedAtColumn))} = ${nowExpr} WHERE ${whereSql}`;

      const queryResult = (await session.query(updateQuery)) as {
        results: any;
        fields: any;
        rowCount?: number;
      };

      let affected = 0;
      if (this.isMySqlFamily()) {
        affected = queryResult?.results?.affectedRows ?? 0;
      } else {
        affected = queryResult?.rowCount ?? 0;
      }

      return { affected };
    });
  }

  async restore<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const deletedAtColumn = this.resolver.getDeletedAtColumn(entity);
    if (!deletedAtColumn) {
      throw new InvalidQueryError(
        `Entity "${entity.name}" does not have a @DeletedAt column. Cannot restore.`,
      );
    }

    return this.executeInTransaction(async (session) => {
      const whereMap: Sql[] = [];
      for (const key in criteria) {
        const value = (criteria as any)[key];
        if (value !== undefined && value !== null) {
          const col = this.wrap(key);
          whereMap.push(
            Array.isArray(value)
              ? Conditions.in(col, value)
              : Conditions.equals(col, value),
          );
        }
      }

      if (whereMap.length === 0) {
        throw new DeleteWithoutConditionsError("Restore");
      }

      const whereSql = join(whereMap, " AND ");

      const restoreQuery = sql`UPDATE ${raw(this.wrapTable(metadata.name!))} SET ${raw(this.wrap(deletedAtColumn))} = NULL WHERE ${whereSql}`;

      const queryResult = (await session.query(restoreQuery)) as {
        results: any;
        fields: any;
        rowCount?: number;
      };

      let affected = 0;
      if (this.isMySqlFamily()) {
        affected = queryResult?.results?.affectedRows ?? 0;
      } else {
        affected = queryResult?.rowCount ?? 0;
      }

      return { affected };
    });
  }

  // ── Upsert ────────────────────────────────────────────────

  async upsert<T>(
    entity: ClazzType<T>,
    data: Partial<T>,
    conflictColumns?: string[],
  ): Promise<void> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    if (!this.driver) {
      throw new Error("Driver is not initialized.");
    }

    const pkColumns = metadata.columns
      .filter((col: ColumnMetadata) => col.options?.primary)
      .map((col: ColumnMetadata) => col.name!);

    const resolvedConflictColumns = conflictColumns ?? pkColumns;

    if (resolvedConflictColumns.length === 0) {
      throw new PrimaryKeyNotFoundError(entity.name);
    }

    const insertableColumns = metadata.columns.filter((col: ColumnMetadata) => {
      const value = (data as any)[col.name!];
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

    const tableName = this.wrapTable(metadata.name!);

    if (wrappedUpdate.length === 0) {
      return;
    }

    await this.executeInTransaction(async (session) => {
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

      await session.query(upsertSql);
    });
  }

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

    throw new Error(`Unsupported database type for upsert: ${this.dbType}`);
  }

  // ── 집계 위임 ─────────────────────────────────────────────

  async count<T>(
    entity: ClazzType<T>,
    where?: WhereClause<T>,
  ): Promise<number> {
    return this.aggregateHandler.count(entity, where);
  }

  async sum<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
  ): Promise<number> {
    return this.aggregateHandler.sum(entity, field, where);
  }

  async avg<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
  ): Promise<number> {
    return this.aggregateHandler.avg(entity, field, where);
  }

  async min<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
  ): Promise<number> {
    return this.aggregateHandler.min(entity, field, where);
  }

  async max<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
  ): Promise<number> {
    return this.aggregateHandler.max(entity, field, where);
  }

  // ── EXPLAIN 위임 ──────────────────────────────────────────

  async explain<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
  ): Promise<ExplainResult> {
    return this.explainHandler.explain(entity, findOption);
  }

  // ── 유틸리티 ──────────────────────────────────────────────

  wrap(columnName: string) {
    if (this.driver && "wrap" in this.driver) {
      return (this.driver as any).wrap(columnName);
    }
    if (this.isPostgres()) {
      return `"${columnName.replace(/"/g, '""')}"`;
    }
    return `\`${columnName.replace(/`/g, "``")}\``;
  }

  /**
   * Wrap a table name with optional schema qualification for multi-tenant queries.
   * Uses the configured TenantQueryStrategy to determine whether to prefix with tenant schema.
   */
  wrapTable(tableName: string): string {
    const tenant = this.isPostgres()
      ? MetadataContext.getCurrentTenant()
      : "public";
    return this.tenantStrategy.qualifyTable(tableName, tenant, (n) =>
      this.wrap(n),
    );
  }

  private isMySqlFamily() {
    const t = this.dbType ?? (this.client as any).type;
    return ["mysql", "mariadb"].includes(t as IDatabaseType);
  }

  private isPostgres() {
    const t = this.dbType ?? (this.client as any).type;
    return t === "postgres";
  }

  private isSqlite() {
    const t = this.dbType ?? (this.client as any).type;
    return t === "sqlite";
  }

  /**
   * 커서 페이지네이션에서 PK가 비숫자형(varchar, char, text 등)일 때
   * 다이얼렉트별 경고를 한 번만 출력합니다.
   */
  private warnIfNonSortablePk(entityName: string, pk: ColumnMetadata): void {
    const pkType = pk.options?.type as string | undefined;
    const numericTypes = new Set([
      "int", "number", "float", "double", "bigint",
    ]);
    if (!pkType || numericTypes.has(pkType)) {
      return;
    }

    const key = entityName;
    if (this.cursorPkWarned.has(key)) {
      return;
    }
    this.cursorPkWarned.add(key);

    const base =
      `[CursorPagination] '${entityName}' entity uses a non-numeric PK ` +
      `(type: ${pkType}). Cursor pagination defaults to PK ordering, ` +
      `which may not reflect insertion order for random values like UUID v4.`;

    if (this.isMySqlFamily()) {
      this.logger.warn(
        `${base} MySQL stores UUIDs as VARCHAR — lexicographic ordering ` +
        `does not match time-based ordering. Consider specifying ` +
        `orderBy: "createdAt" or using a sequential ID.`,
      );
    } else if (this.isPostgres()) {
      this.logger.warn(
        `${base} PostgreSQL compares UUID values lexicographically. ` +
        `For time-ordered pagination, use UUID v7 (sortable) or specify ` +
        `orderBy: "createdAt".`,
      );
    } else if (this.isSqlite()) {
      this.logger.warn(
        `${base} SQLite compares TEXT values lexicographically. ` +
        `Consider specifying orderBy: "createdAt" or using an INTEGER PK.`,
      );
    } else {
      this.logger.warn(
        `${base} Consider specifying an explicit orderBy column ` +
        `(e.g. orderBy: "createdAt") for meaningful pagination order.`,
      );
    }
  }

  private async executeInTransaction<R>(
    fn: (session: TransactionSessionManager) => Promise<R>,
    existingSession?: TransactionSessionManager,
    readNodeOverride?: ReplicationNodeConfig | null,
  ): Promise<R> {
    const reusable = existingSession ?? transactionStorage.getStore();
    if (reusable) {
      return fn(reusable);
    }

    const session = new TransactionSessionManager();
    try {
      if (readNodeOverride) {
        await session.connectToNode(readNodeOverride);
      } else {
        await session.connect();
      }
      await session.startTransaction();

      if (this.isMySqlFamily()) {
        await session.query("SET autocommit = 0");
      }

      const result = await fn(session);
      await session.commit();
      return result;
    } catch (e: unknown) {
      try {
        await session.rollback();
      } catch (rollbackError) {
        this.logger.error(`Failed to rollback transaction: ${rollbackError}`);
      }
      throw e;
    } finally {
      try {
        await session.close();
      } catch (closeError) {
        this.logger.error(`Failed to close transaction: ${closeError}`);
      }
    }
  }

  private async executeReadOnly<R>(
    fn: (session: TransactionSessionManager) => Promise<R>,
    options?: {
      existingSession?: TransactionSessionManager;
      readNodeOverride?: ReplicationNodeConfig | null;
      timeout?: number;
    },
  ): Promise<R> {
    const { existingSession, readNodeOverride, timeout } = options ?? {};

    // 1. Reuse existing session (@Transactional or nested call)
    const reusable = existingSession ?? transactionStorage.getStore();
    if (reusable) {
      return fn(reusable);
    }

    // 2. PostgreSQL tenant or timeout → need transaction for SET LOCAL
    const tenant = this.isPostgres()
      ? MetadataContext.getCurrentTenant()
      : "public";
    const needsTxForTenant =
      this.isPostgres() &&
      tenant !== "public" &&
      this.tenantStrategy.needsTransactionForTenantRead();
    if (this.isPostgres() && (needsTxForTenant || (timeout && timeout > 0))) {
      return this.executeInTransaction(fn, existingSession, readNodeOverride);
    }

    // 3. Lightweight read-only path (no BEGIN/COMMIT)
    const session = new TransactionSessionManager();
    try {
      if (readNodeOverride) {
        await session.connectToNode(readNodeOverride);
      } else {
        await session.connect();
      }

      // MySQL timeout (SET SESSION — no transaction needed)
      if (timeout && timeout > 0 && this.driver && this.isMySqlFamily()) {
        const timeoutSql = this.driver.setQueryTimeout(timeout);
        await session.query(timeoutSql);
      }

      const result = await fn(session);
      return result;
    } finally {
      try {
        await session.close();
      } catch (closeError) {
        this.logger.error(`Failed to close read-only session: ${closeError}`);
      }
    }
  }

  private resolveSelectColumns<T>(select: ISelectOption<T>): string[] {
    if (Array.isArray(select)) {
      return select.map((col) => String(col));
    }

    const columns: string[] = [];
    for (const key in select) {
      if ((select as any)[key] === true) {
        columns.push(key);
      }
    }
    return columns;
  }

  // ── 기타 ──────────────────────────────────────────────────

  async query<T = Record<string, unknown>>(
    sqlQuery: string | Sql,
    params?: unknown[],
  ): Promise<T[]> {
    return this.executeInTransaction(async (session) => {
      let queryResult: any;
      if (typeof sqlQuery === "string") {
        if (params && params.length > 0) {
          const parameterizedSql = {
            text: sqlQuery,
            sql: sqlQuery,
            values: params,
            strings: [sqlQuery],
          } as unknown as Sql;
          queryResult = await session.query(parameterizedSql);
        } else {
          queryResult = await session.query(sqlQuery);
        }
      } else {
        queryResult = await session.query(sqlQuery);
      }

      if (queryResult?.results) {
        return (queryResult.results as T[]) ?? [];
      }
      if (Array.isArray(queryResult)) {
        return queryResult as T[];
      }
      return [];
    });
  }

  /**
   * Executes a callback within a database transaction.
   * Auto-commits on success, auto-rollbacks on error.
   *
   * All EntityManager operations inside the callback share the same transaction.
   *
   * @param callback A function that receives this EntityManager and performs DB operations.
   * @returns The return value of the callback.
   *
   * @example
   * ```ts
   * const result = await em.transaction(async (txEm) => {
   *   await txEm.save(User, { name: "Alice" });
   *   await txEm.save(Post, { title: "Hello", authorId: 1 });
   *   return "done";
   * });
   * ```
   */
  async transaction<R>(callback: (em: this) => Promise<R>): Promise<R> {
    return this.executeInTransaction(async (session) => {
      return transactionStorage.run(session, () => callback(this));
    });
  }

  getRepository<T>(entity: ClazzType<T>) {
    return BaseRepository.of(entity, this);
  }

  async withTenant<R>(
    tenantId: string,
    callback: (em: this) => Promise<R>,
  ): Promise<R> {
    return MetadataContext.run(tenantId, () => callback(this)) as Promise<R>;
  }

  createQueryBuilder(): BaseRawQueryBuilder {
    const qb = RawQueryBuilderFactory.create();
    if (this.isMySqlFamily()) qb.setDatabaseType("mysql");
    else qb.setDatabaseType("postgresql");
    return qb;
  }

  getDriver(): ISqlDriver | undefined {
    return this.driver;
  }
}
