/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType, ReflectManager, Logger } from "../utils";
import {
  ColumnMetadata,
  EntityScannerMetadata,
  EntityScanner,
} from "../scanner";
import { getScannerInstance } from "../scanner/ScannerContainer";
import { PostgresDriver } from "../dialects/postgres/PostgresDriver";
import { SchemaGenerator, SchemaDialect } from "./generators/SchemaGenerator";
import {
  NamingStrategy,
  DefaultNamingStrategy,
} from "./generators/NamingStrategy";
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
import {
  SchemaDiff,
  ColumnChange,
  SchemaDiffResult,
} from "./generators/SchemaDiff";
import { InheritanceResolver } from "./InheritanceResolver";
import { EntityMetadata } from "../decorators/Entity";

/**
 * 앱 시작 시 1회 실행되는 DDL/스키마 동기화 핸들러.
 * 런타임 CRUD와 무관합니다.
 */
export class SchemaRegistrar {
  private readonly namingStrategy: NamingStrategy;
  private readonly logger = new Logger(SchemaRegistrar.name);
  private readonly inheritanceResolver = new InheritanceResolver();

  constructor(
    private readonly resolver: RelationMetadataResolver,
    private readonly ctx: EntityManagerInternals,
    namingStrategy?: NamingStrategy,
  ) {
    this.namingStrategy = namingStrategy ?? new DefaultNamingStrategy();
  }

  async registerEntities() {
    const entityScanner = getScannerInstance(EntityScanner);
    const entities = entityScanner.makeEntities();

    let entity: IteratorResult<EntityScannerMetadata>;

    const syncOption = this.ctx.getSynchronize();
    const synchronize = !!syncOption; // truthy for true, 'safe', 'dry-run'
    const isDryRun = syncOption === "dry-run";
    const isSafe = syncOption === "safe";

    // PostgreSQL: 스키마가 존재하지 않으면 자동으로 생성합니다.
    if (
      synchronize &&
      !isDryRun &&
      this.ctx.isPostgres() &&
      this.ctx.getDriver()
    ) {
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
      tableExisted: boolean;
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

      // STI: 자식 엔티티는 자체 테이블을 생성하지 않음 (부모 테이블 공유)
      if (this.inheritanceResolver.isChildEntity(TargetEntity)) {
        const strategy = this.inheritanceResolver.getStrategy(TargetEntity);
        if (strategy === "SINGLE_TABLE") {
          continue;
        }
      }

      // TPT: 자식 테이블은 고유 컬럼 + PK만 DDL에 포함 (상속 컬럼은 부모 테이블에)
      // 주의: metadata.columns 원본은 수정하지 않음 (EntityManager가 전체 컬럼 필요)
      let tptDdlColumns: any[] | undefined;
      if (this.inheritanceResolver.isChildEntity(TargetEntity)) {
        const strategy = this.inheritanceResolver.getStrategy(TargetEntity);
        if (strategy === "JOINED") {
          const ownCols = this.inheritanceResolver.getOwnColumns(TargetEntity);
          const ownColNames = new Set(
            ownCols.map((c: any) => c.propertyKey ?? c.name),
          );
          const pkColNames = new Set(
            metadata.columns
              .filter((c: any) => c.options?.primary)
              .map((c: any) => c.name ?? c.propertyKey),
          );
          tptDdlColumns = metadata.columns.filter((c: any) => {
            const key = c.propertyKey ?? c.name;
            return pkColNames.has(key) || ownColNames.has(key);
          });
        }
      }

      // 상속 루트: discriminator 컬럼 추가 + STI 자식 컬럼 병합
      if (this.inheritanceResolver.isRootEntity(TargetEntity)) {
        const strategy = this.inheritanceResolver.getStrategy(TargetEntity);
        const entityMeta = Reflect.getMetadata(ENTITY_TOKEN, TargetEntity) as EntityMetadata | undefined;
        if (entityMeta) {
          // STI/TPT: discriminator 컬럼 추가 (루트 테이블에)
          if (strategy === "SINGLE_TABLE" || strategy === "JOINED") {
            const discCol = entityMeta.discriminatorColumn;
            if (discCol) {
              const alreadyHas = metadata.columns.some(
                (col: any) => col.name === discCol.name,
              );
              if (!alreadyHas) {
                metadata.columns.push({
                  name: discCol.name,
                  options: {
                    type: discCol.type,
                    length: discCol.length,
                    nullable: false,
                  },
                } as any);
              }
            }
          }

          // STI 전용: 자식 엔티티의 고유 컬럼 병합 (nullable 강제)
          if (strategy === "SINGLE_TABLE") {
            const childEntities = entityMeta.childEntities ?? [];
            const existingColNames = new Set(
              metadata.columns.map((col: any) => col.name ?? col.propertyKey),
            );
            for (const ChildEntity of childEntities) {
              const ownCols = this.inheritanceResolver.getOwnColumns(ChildEntity);
              for (const col of ownCols) {
                const colName = col.name ?? col.propertyKey;
                if (colName && !existingColNames.has(colName)) {
                  const mergedCol = { ...col };
                  if (mergedCol.options) {
                    mergedCol.options = { ...mergedCol.options, nullable: true };
                  } else {
                    (mergedCol as any).options = { nullable: true };
                  }
                  metadata.columns.push(mergedCol as any);
                  existingColNames.add(colName!);
                }
              }
            }
          }
        }
      }

      // PK validation: every entity must have at least one primary key column
      const hasPrimaryKey = metadata.columns.some(
        (col: any) => col.options?.primary,
      );
      if (!hasPrimaryKey) {
        throw new PrimaryKeyNotFoundError(tableName ?? "Unknown");
      }

      let tableExisted = false;
      const driver = this.ctx.getDriver();
      if (synchronize) {
        const hasTable = await driver?.hasTable(tableName);
        tableExisted = !!(hasTable && hasTable.length > 0);
        if (!tableExisted) {
          if (isDryRun) {
            this.logger.info(`[dry-run] Would CREATE TABLE ${tableName}`);
          } else {
            await driver?.createTable(tableName, tptDdlColumns ?? metadata.columns);
          }
        }
      }

      entityList.push({ TargetEntity, tableName, metadata, tableExisted });
    }

    // 1.5패스: 이미 존재하는 테이블에 대해 SchemaDiff를 실행하여 컬럼 변경사항을 적용합니다.
    if (synchronize) {
      const existingEntities = entityList.filter((e) => e.tableExisted);
      if (existingEntities.length > 0) {
        await this.syncExistingTables(
          existingEntities.map((e) => e.TargetEntity),
          entityList,
          syncOption,
        );
      }
    }

    // 2패스: 모든 테이블이 생성된 후 FK, 인덱스, 유니크 인덱스를 등록합니다.
    if (synchronize && !isDryRun) {
      for (const { TargetEntity, tableName, metadata } of entityList) {
        // 외래키를 생성합니다.
        await this.registerForeignKeys(TargetEntity, tableName);

        // TPT: 자식 PK → 부모 PK FK 등록
        if (this.inheritanceResolver.isChildEntity(TargetEntity)) {
          const tptStrategy = this.inheritanceResolver.getStrategy(TargetEntity);
          if (tptStrategy === "JOINED") {
            const root = this.inheritanceResolver.getRoot(TargetEntity);
            if (root) {
              const rootMeta = this.resolver.resolveEntityMetadata(root);
              const pk = metadata.columns.find((c: any) => c.options?.primary);
              const rootPk = rootMeta?.columns.find(
                (c: any) => c.options?.primary,
              );
              const tptDriver = this.ctx.getDriver();
              if (pk && rootPk && rootMeta && tptDriver) {
                const rootTableName = rootMeta.name!;
                const fkName = this.namingStrategy.foreignKeyName(
                  tableName,
                  pk.name!,
                  rootTableName,
                );
                try {
                  const fkExists = await tptDriver.hasForeignKey(tableName, fkName);
                  if (!fkExists) {
                    await tptDriver.addForeignKey(
                      tableName,
                      pk.name!,
                      rootTableName,
                      rootPk.name!,
                    );
                  }
                } catch {
                  // SQLite: ALTER TABLE ADD CONSTRAINT 미지원 — FK 생략
                  this.logger.warn(
                    `Could not create FK ${fkName} for TPT child table ${tableName} (may be unsupported by dialect)`,
                  );
                }
              }
            }
          }
        }

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
        this.logger.info(
          `[dry-run] Would register FKs/indexes for ${tableName}`,
        );
      }
    }
  }

  /**
   * 이미 존���하는 테이블에 대해 SchemaDiff를 실행하여 엔티티 변경사항을 동기화합니다.
   */
  private async syncExistingTables(
    existingEntities: ClazzType<any>[],
    entityList: Array<{ TargetEntity: ClazzType<any>; tableName: string }>,
    syncOption: boolean | "safe" | "dry-run",
  ): Promise<void> {
    const connection = this.ctx.getConnection();
    if (!connection) return;

    const dialect = this.ctx.getDialect();
    const schema = this.ctx.getSchema();
    const queryRunner = { query: (s: any) => connection.query(s) };

    const schemaDiff = new SchemaDiff();

    let diff: SchemaDiffResult;
    try {
      diff = await schemaDiff.diff(
        existingEntities,
        queryRunner,
        dialect,
        schema,
      );
    } catch (err) {
      this.logger.warn(
        `[sync] SchemaDiff failed, skipping ALTER operations: ${err}`,
      );
      return;
    }

    // addTables는 이미 1패스에서 처리되므로 무시 (여기서는 기존 테이블만 처리)

    // FK 컬럼 수집 (DROP에서 제외하기 위해)
    const fkColumnsPerTable = new Map<string, Set<string>>();
    for (const { TargetEntity, tableName } of entityList) {
      fkColumnsPerTable.set(
        tableName.toLowerCase(),
        this.collectForeignKeyColumns(TargetEntity),
      );
    }

    await this.applySchemaDiff(diff, fkColumnsPerTable, syncOption, dialect);
  }

  /**
   * SchemaDiffResult를 모드에 따라 적용합니다.
   */
  private async applySchemaDiff(
    diff: SchemaDiffResult,
    fkColumnsPerTable: Map<string, Set<string>>,
    mode: boolean | "safe" | "dry-run",
    dialect: SchemaDialect,
  ): Promise<void> {
    const driver = this.ctx.getDriver();
    if (!driver) return;

    const isDryRun = mode === "dry-run";
    const isSafe = mode === "safe";
    const isFull = mode === true;

    // 1. ADD COLUMNS (true, safe 모두 실행)
    for (const col of diff.addColumns) {
      const typeDef = this.buildAddColumnTypeDef(col);
      if (isDryRun) {
        this.logger.info(
          `[dry-run] ALTER TABLE ${col.tableName} ADD COLUMN ${col.columnName} ${typeDef}`,
        );
      } else {
        this.logger.info(
          `[sync] Adding column ${col.tableName}.${col.columnName} (${typeDef})`,
        );
        await driver.addColumn(col.tableName, col.columnName, typeDef);
      }
    }

    // 2. ALTER COLUMNS (true만 실행, safe는 건너뜀)
    if (isFull || isDryRun) {
      for (const col of diff.alterColumns) {
        const ddl = this.buildAlterColumnDDL(col, dialect);
        if (!ddl) continue; // SQLite: 미지원
        if (isDryRun) {
          this.logger.info(`[dry-run] ${ddl}`);
        } else {
          this.logger.warn(
            `[sync] Altering column ${col.tableName}.${col.columnName}: ${col.currentType} → ${col.columnType}`,
          );
          await driver.executeRaw(ddl);
        }
      }
    }

    // 3. DROP COLUMNS (true만 실행, safe는 건��뜀)
    if (isFull || isDryRun) {
      for (const col of diff.dropColumns) {
        // FK 컬럼은 DROP에서 제외 (2패스에서 관리됨)
        const tableFkCols = fkColumnsPerTable.get(col.tableName.toLowerCase());
        if (tableFkCols?.has(col.columnName.toLowerCase())) continue;

        if (isDryRun) {
          this.logger.info(
            `[dry-run] ALTER TABLE ${col.tableName} DROP COLUMN ${col.columnName}`,
          );
        } else {
          this.logger.warn(
            `[sync] Dropping column ${col.tableName}.${col.columnName}`,
          );
          await driver.dropColumn(col.tableName, col.columnName);
        }
      }
    }

    // 4. RENAME COLUMNS (true만 실행)
    if ((isFull || isDryRun) && diff.renamedColumns) {
      for (const rename of diff.renamedColumns) {
        const ddl = `ALTER TABLE ${this.ctx.wrap(rename.tableName)} RENAME COLUMN ${this.ctx.wrap(rename.oldColumnName)} TO ${this.ctx.wrap(rename.newColumnName)}`;
        if (isDryRun) {
          this.logger.info(`[dry-run] ${ddl}`);
        } else {
          this.logger.warn(
            `[sync] Renaming column ${rename.tableName}.${rename.oldColumnName} → ${rename.newColumnName}`,
          );
          await driver.executeRaw(ddl);
        }
      }
    }
  }

  /**
   * ColumnChange에서 순수 타입 문자열만 생��합니다.
   * ENUM 값, 길이, precision/scale을 포함합니다.
   * 예: "VARCHAR(255)", "ENUM('a','b')", "DECIMAL(10,2)"
   */
  private buildColumnTypeExpr(col: ColumnChange): string {
    let type = col.columnType ?? "VARCHAR(255)";

    // ENUM 타입의 경우, enumValues로 값 목록을 포함
    const isENUM = type.toUpperCase().startsWith("ENUM");
    if (isENUM && col.enumValues && col.enumValues.length > 0) {
      const values = col.enumValues
        .map((v: string) => `'${v.replace(/'/g, "''")}'`)
        .join(",");
      type = `ENUM(${values})`;
    }

    // 길이가 지정되어 있고 타입에 아직 괄호가 없으면 추가
    if (col.expectedLength && !type.includes("(")) {
      type = `${type}(${col.expectedLength})`;
    }

    // 정밀도/스케일이 지정되어 있으면 추���
    if (col.expectedPrecision && !type.includes("(")) {
      const scale =
        col.expectedScale !== undefined && col.expectedScale !== null
          ? `,${col.expectedScale}`
          : "";
      type = `${type}(${col.expectedPrecision}${scale})`;
    }

    return type;
  }

  /**
   * ColumnChange에서 ADD COLUMN용 타입 정의 문자열을 생성합니다.
   * 예: "VARCHAR(255) NULL", "INT NOT NULL DEFAULT 0"
   *
   * For non-nullable columns being backfilled into existing rows,
   * a type-appropriate default is used (#177):
   *   - String types (VARCHAR, TEXT, CHAR, LONGTEXT) -> DEFAULT ''
   *   - Numeric types (INT, BIGINT, FLOAT, etc.) -> DEFAULT 0
   *   - Boolean -> DEFAULT FALSE (pg/sqlite) or DEFAULT 0 (mysql)
   *   - Datetime/timestamp/date -> forced NULL (no safe default)
   *   - Other types (JSON, BLOB, etc.) -> forced NULL (no safe default)
   */
  private buildAddColumnTypeDef(col: ColumnChange): string {
    const type = this.buildColumnTypeExpr(col);

    if (col.nullable !== false) {
      return `${type} NULL`;
    }

    // Type-appropriate default for NOT NULL backfill (#177)
    const upperType = type.toUpperCase();

    if (/^(VARCHAR|TEXT|CHAR|LONGTEXT|MEDIUMTEXT|TINYTEXT|ENUM)/.test(upperType)) {
      return `${type} NOT NULL DEFAULT ''`;
    }
    if (/^(INT|BIGINT|FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL|SMALLINT|TINYINT|SERIAL|INTEGER|MEDIUMINT)/.test(upperType)) {
      return `${type} NOT NULL DEFAULT 0`;
    }
    if (/^(BOOL|BOOLEAN)/.test(upperType)) {
      const defaultVal = this.ctx.isMySqlFamily() ? "0" : "FALSE";
      return `${type} NOT NULL DEFAULT ${defaultVal}`;
    }

    // Datetime/timestamp/date and other types (JSON, JSONB, BLOB, BYTEA, ARRAY, etc.)
    // cannot have a safe universal default — force nullable for existing rows
    return `${type} NULL`;
  }

  /**
   * ALTER COLUMN DDL을 다이얼렉트별로 생성합니다.
   * SQLite는 ALTER COLUMN TYPE을 지원하지 않으므로 null을 반환���니다.
   */
  private buildAlterColumnDDL(
    col: ColumnChange,
    dialect: SchemaDialect,
  ): string | null {
    const typeExpr = this.buildColumnTypeExpr(col);
    const tableName = this.ctx.wrapTable(col.tableName);
    const columnName = this.ctx.wrap(col.columnName);

    if (dialect === "sqlite") {
      this.logger.warn(
        `[sync] SQLite does not support ALTER COLUMN TYPE for ${col.tableName}.${col.columnName} ` +
          `(${col.currentType} → ${typeExpr}). Skipping.`,
      );
      return null;
    }

    if (dialect === "mysql") {
      const nullable = col.nullable === false ? "NOT NULL" : "NULL";
      return `ALTER TABLE ${tableName} MODIFY COLUMN ${columnName} ${typeExpr} ${nullable}`;
    }

    // PostgreSQL
    return `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE ${typeExpr}`;
  }

  /**
   * 엔티티의 @ManyToOne/@OneToOne 관계에서 FK 조인 컬럼명을 수집합니다.
   * DROP COLUMN에서 이 컬럼들을 제외하기 위해 사용됩니다.
   */
  private collectForeignKeyColumns(TargetEntity: ClazzType<any>): Set<string> {
    const fkColumns = new Set<string>();
    const m2o = this.resolver.resolveManyToOneMetadata(TargetEntity);
    for (const rel of m2o) {
      if (rel.joinColumn) fkColumns.add(rel.joinColumn.toLowerCase());
    }
    const o2o = this.resolver.resolveOneToOneMetadata(TargetEntity);
    for (const rel of o2o) {
      if (rel.joinColumn) fkColumns.add(rel.joinColumn.toLowerCase());
    }
    return fkColumns;
  }

  /**
   * Resolves the SQL column type for the primary key of an entity.
   * Falls back to the driver's castType("int") if no PK metadata is found.
   * Used to derive correct join column types for ManyToMany tables (#178).
   */
  private resolvePkColumnType(entityClass: ClazzType<any>): string {
    const driver = this.ctx.getDriver();
    const columns = (Reflect.getMetadata(
      COLUMN_TOKEN,
      entityClass.prototype,
    ) ?? []) as ColumnMetadata[];
    const pkCol = columns.find((c) => c.options?.primary);
    if (!pkCol || !pkCol.options?.type || !driver) {
      return driver ? driver.castType("int") : "INT";
    }
    let sqlType = driver.castType(pkCol.options.type);
    // Append length for varchar/char PK types
    const colType = pkCol.options.type;
    if (pkCol.options.length && pkCol.options.length > 0 && !sqlType.includes("(")
        && (colType === "varchar" || colType === "char")) {
      sqlType = `${sqlType}(${pkCol.options.length})`;
    }
    return sqlType;
  }

  /**
   * @UniqueIndex 데코레이터로 선언된 복합 유니��� 인덱스를 등록��니다.
   */
  async registerUniqueIndexes(TargetEntity: ClazzType<any>, tableName: string) {
    const uniqueIndexes = Reflect.getMetadata(
      UNIQUE_INDEX_TOKEN,
      TargetEntity,
    ) as UniqueIndexMetadata[] | undefined;

    if (!uniqueIndexes || uniqueIndexes.length === 0) return;

    const driver = this.ctx.getDriver();

    // Build property-to-column name map to resolve @UniqueIndex() property keys (#176)
    const colMeta = (Reflect.getMetadata(
      COLUMN_TOKEN,
      TargetEntity.prototype,
    ) ?? []) as ColumnMetadata[];
    const propColMap = new Map<string, string>();
    for (const col of colMeta) {
      if (col.propertyKey && col.name) {
        propColMap.set(col.propertyKey, col.name);
      }
    }

    for (const uq of uniqueIndexes) {
      // Resolve property keys to actual DB column names (#176)
      const resolvedColumns = uq.columns.map((col) => propColMap.get(col) ?? col);
      const indexName =
        uq.name ?? this.namingStrategy.uniqueIndexName(tableName, resolvedColumns);

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
        await driver?.addCompositeUniqueIndex(tableName, resolvedColumns, indexName);
      }
    }
  }

  /**
   * ManyToMany 중간 테이블과 FK 제약을 생성합니다.
   * joinTable 소유측 엔티티만 처리하며, 중복은 Set으로 방지��니다.
   * Join column types are derived from the actual PK types of the referenced entities (#178).
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
          // Derive join column types from actual PK types (#178)
          const ownerPkType = this.resolvePkColumnType(entity);
          const relatedPkType = this.resolvePkColumnType(relatedEntity);
          let ddl = `CREATE TABLE IF NOT EXISTS ${wJoinTable} (${wJoinCol} ${ownerPkType} NOT NULL, ${wInvCol} ${relatedPkType} NOT NULL, PRIMARY KEY (${wJoinCol}, ${wInvCol}))`;
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

  async registerForeignKeys(TargetEntity: ClazzType<any>, tableName: string) {
    // 엔티티 매니저를 가지고 옵니다.
    const entityScanner = getScannerInstance(EntityScanner);
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
          : mappingTableMetadata.columns.find((e: any) => e.options?.primary)
              ?.name;

        if (!mappingTablePrimaryKey) {
          throw new PrimaryKeyNotFoundError(mappingEntity.name);
        }

        const mappingTableName =
          mappingTableMetadata.name || this.ctx.getNameStrategy(mappingEntity);

        // joinColumn 컬럼이 테이블에 ���으면 먼저 추가합니다.
        if (driver) {
          const columnExists = await driver.hasColumn(tableName, joinColumn);
          if (!columnExists) {
            const fkColumnType = driver.castType("int") + " NULL";
            await driver.addColumn(tableName, joinColumn, fkColumnType);
          }
        }

        // FK 제약이 이미 존재하면 중복 추가를 건���뜁니다.
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

      // joinColumn 컬럼이 테이블에 없으면 먼��� 추가합니다.
      if (driver) {
        const columnExists = await driver.hasColumn(tableName, joinColumn);
        if (!columnExists) {
          const fkColumnType = driver.castType("int") + " NULL";
          await driver.addColumn(tableName, joinColumn, fkColumnType);
        }
      }

      const relatedTableName =
        relatedMetadata.name || this.ctx.getNameStrategy(RelatedEntity);

      // FK 제약이 이미 ���재하면 중복 ��가를 건너뜁니다.
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
   * Resolves property keys to actual DB column names (#176).
   */
  async registerIndex(TargetEntity: ClazzType<any>, tableName: string) {
    const indexer = Reflect.getMetadata(
      INDEX_TOKEN,
      TargetEntity.prototype,
    ) as IndexMetadata[];
    if (indexer) {
      const driver = this.ctx.getDriver();
      // Build property-to-column name map to resolve @Index() property keys (#176)
      const columns = (Reflect.getMetadata(
        COLUMN_TOKEN,
        TargetEntity.prototype,
      ) ?? []) as ColumnMetadata[];
      const propColMap = new Map<string, string>();
      for (const col of columns) {
        if (col.propertyKey && col.name) {
          propColMap.set(col.propertyKey, col.name);
        }
      }

      for (const index of indexer) {
        // index.name is the property key; resolve to actual DB column name
        const columnName = propColMap.get(index.name) ?? index.name;
        const indexName = this.namingStrategy.indexName(tableName, columnName);

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
          await driver?.addIndex(tableName, columnName, indexName);
        }
      }
    }
  }
}
