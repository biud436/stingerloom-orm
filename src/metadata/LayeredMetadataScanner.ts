/* eslint-disable @typescript-eslint/no-explicit-any */
import { LayeredMetadataStore } from "./LayeredMetadataStore";
import { ClazzType } from "../utils";

/**
 * 기존 MetadataScanner를 계층적 스토어와 연동하는 어댑터
 *
 * 기존 코드와의 호환성을 유지하면서 점진적으로 마이그레이션할 수 있도록 설계
 */
export class LayeredMetadataScanner {
  protected store: LayeredMetadataStore;
  protected prefix: string; // 스캐너 타입별 prefix (예: "entities", "columns")

  constructor(store: LayeredMetadataStore, prefix: string) {
    this.store = store;
    this.prefix = prefix;
  }

  /**
   * 유니크 키 생성 (기존 API 호환)
   */
  public createUniqueKey(): string {
    return `${this.prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 메타데이터 저장 (현재 컨텍스트의 레이어에 저장)
   */
  public set<T>(key: string, value: T): void {
    const fullKey = `${this.prefix}/${key}`;
    this.store.set(fullKey, value);
  }

  /**
   * 메타데이터 조회 (병합된 뷰에서 검색)
   */
  public get<T>(key: string): T | undefined {
    const fullKey = `${this.prefix}/${key}`;
    return this.store.get<T>(fullKey);
  }

  /**
   * 모든 메타데이터 조회 (현재 컨텍스트에서 병합된 결과)
   */
  public allMetadata<T = any>(): T[] {
    const allData = this.store.getAllInContext<T>();
    const results: T[] = [];

    for (const [key, value] of allData.entries()) {
      // prefix로 시작하는 것만 필터링
      if (key.startsWith(this.prefix)) {
        results.push(value);
      }
    }

    return results;
  }

  /**
   * 키 존재 여부 확인
   */
  public has(key: string): boolean {
    const fullKey = `${this.prefix}/${key}`;
    return this.store.has(fullKey);
  }

  /**
   * 현재 컨텍스트의 메타데이터 초기화
   */
  public clear(): void {
    const context = this.store.getContext();
    const layer = this.store.getLayer(context);

    if (!layer) {
      return;
    }

    // 현재 prefix에 해당하는 키만 삭제
    const keysToDelete: string[] = [];
    for (const key of layer.keys()) {
      if (key.startsWith(this.prefix)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      layer.delete(key);
    }
  }

  /**
   * 메타데이터 크기 반환
   */
  public get size(): number {
    return this.allMetadata().length;
  }

  /**
   * 컨텍스트 전환 (멀티테넌트 지원)
   */
  public switchContext(context: string): void {
    this.store.setContext(context);
  }

  /**
   * 현재 컨텍스트 가져오기
   */
  public getCurrentContext(): string {
    return this.store.getContext();
  }

  /**
   * 레이어 복사 (새 테넌트 생성 시)
   */
  public copyToNewContext(newContext: string): void {
    const currentContext = this.store.getContext();
    this.store.copyLayer(currentContext, newContext);
  }
}

/**
 * EntityScanner를 위한 계층적 스캐너
 */
export class LayeredEntityScanner extends LayeredMetadataScanner {
  constructor(store: LayeredMetadataStore) {
    super(store, "entities");
  }

  /**
   * 엔티티 스캔 (기존 API 호환)
   */
  public scan(target: ClazzType<unknown>): any | null {
    const allEntities = this.allMetadata();

    for (const entity of allEntities) {
      if (entity.target === target) {
        return entity;
      }
    }

    return null;
  }

  /**
   * 모든 엔티티 순회 (기존 API 호환)
   */
  public *makeEntities(): IterableIterator<any> {
    const entities = this.allMetadata();
    for (const entity of entities) {
      yield entity;
    }
  }
}

/**
 * ColumnScanner를 위한 계층적 스캐너
 */
export class LayeredColumnScanner extends LayeredMetadataScanner {
  constructor(store: LayeredMetadataStore) {
    super(store, "columns");
  }

  /**
   * 모든 컬럼 순회 (기존 API 호환)
   */
  public *makeColumns(): IterableIterator<any> {
    const columns = this.allMetadata();
    for (const column of columns) {
      yield column;
    }
  }
}

/**
 * ManyToOneScanner를 위한 계층적 스캐너
 */
export class LayeredManyToOneScanner extends LayeredMetadataScanner {
  constructor(store: LayeredMetadataStore) {
    super(store, "relations");
  }

  /**
   * 관계 스캔 (기존 API 호환)
   */
  public scan(target: ClazzType<unknown>): any | null {
    const allRelations = this.allMetadata();

    for (const relation of allRelations) {
      if (relation.target === target) {
        return relation;
      }
    }

    return null;
  }

  /**
   * 모든 ManyToOne 관계 순회 (기존 API 호환)
   */
  public *makeManyToOnes(): IterableIterator<any> {
    const relations = this.allMetadata();
    for (const relation of relations) {
      yield relation;
    }
  }
}
