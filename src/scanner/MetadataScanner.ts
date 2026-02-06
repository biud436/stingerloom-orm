/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { MetadataLayer } from "../metadata/MetadataLayer";

/**
 * 전역 LayeredMetadataStore 레지스트리
 *
 * 모든 MetadataScanner 인스턴스가 공유하는 중앙 레이어 관리자입니다.
 * 기본적으로 "public" 레이어에 기록되며, 컨텍스트 전환으로 멀티테넌트를 지원합니다.
 */
export class MetadataLayerRegistry {
  private static instance: MetadataLayerRegistry;

  private layers: Map<string, MetadataLayer> = new Map();
  private currentContext: string = "public";

  private constructor() {
    // 기본 lower 레이어 (쓰기 가능 — 데코레이터 단계에서 기록해야 하므로)
    this.layers.set("public", new MetadataLayer("public", false));
  }

  static getInstance(): MetadataLayerRegistry {
    if (!MetadataLayerRegistry.instance) {
      MetadataLayerRegistry.instance = new MetadataLayerRegistry();
    }
    return MetadataLayerRegistry.instance;
  }

  /**
   * 테스트 등에서 전역 상태를 초기화할 때 사용
   */
  static reset(): void {
    MetadataLayerRegistry.instance = new MetadataLayerRegistry();
  }

  // ── 컨텍스트 ──────────────────────────────────────────────

  getContext(): string {
    return this.currentContext;
  }

  setContext(context: string): void {
    this.currentContext = context;
    // 해당 레이어가 없으면 자동 생성
    if (!this.layers.has(context)) {
      this.layers.set(context, new MetadataLayer(context, false));
    }
  }

  // ── 레이어 관리 ───────────────────────────────────────────

  getLayer(name: string): MetadataLayer | undefined {
    return this.layers.get(name);
  }

  getCurrentLayer(): MetadataLayer {
    let layer = this.layers.get(this.currentContext);
    if (!layer) {
      layer = new MetadataLayer(this.currentContext, false);
      this.layers.set(this.currentContext, layer);
    }
    return layer;
  }

  addLayer(name: string, readOnly = false): MetadataLayer {
    if (this.layers.has(name)) {
      throw new Error(`Layer "${name}" already exists.`);
    }
    const layer = new MetadataLayer(name, readOnly);
    this.layers.set(name, layer);
    return layer;
  }

  /**
   * 레이어 복사 (멀티테넌트 — 새 테넌트가 public 스키마를 복제)
   */
  copyLayer(sourceName: string, targetName: string): MetadataLayer {
    const source = this.layers.get(sourceName);
    if (!source) throw new Error(`Source layer "${sourceName}" not found.`);
    const cloned = source.clone(targetName, false);
    this.layers.set(targetName, cloned);
    return cloned;
  }

  /**
   * 레이어 삭제
   */
  removeLayer(name: string): boolean {
    if (name === "public") throw new Error('Cannot remove "public" layer.');
    return this.layers.delete(name);
  }

  /**
   * 모든 레이어 정보
   */
  getLayersInfo() {
    return Array.from(this.layers.values()).map((l) => l.getLayerInfo());
  }

  /**
   * 병합된 뷰에서 값을 읽는다.
   * 현재 컨텍스트 레이어 → public 순서로 검색 (OverlayFS)
   */
  resolveValue<T>(key: string): T | undefined {
    // 1. 현재 컨텍스트 레이어
    const contextLayer = this.layers.get(this.currentContext);
    if (contextLayer) {
      const v = contextLayer.get<T>(key);
      if (v !== undefined) return v;
    }
    // 2. public fallback (현재 컨텍스트가 public이 아닌 경우)
    if (this.currentContext !== "public") {
      const publicLayer = this.layers.get("public");
      if (publicLayer) {
        const v = publicLayer.get<T>(key);
        if (v !== undefined) return v;
      }
    }
    return undefined;
  }

  /**
   * 병합된 뷰의 모든 엔트리를 반환 (lower → upper 순서로 덮어쓰기)
   */
  resolveAll<T>(): Map<string, T> {
    const result = new Map<string, T>();

    // 1. public 레이어 (lower)
    const publicLayer = this.layers.get("public");
    if (publicLayer) {
      for (const [k, v] of publicLayer.entries<T>()) {
        result.set(k, v);
      }
    }

    // 2. 현재 컨텍스트 레이어 (upper) — 덮어쓰기
    if (this.currentContext !== "public") {
      const contextLayer = this.layers.get(this.currentContext);
      if (contextLayer) {
        for (const [k, v] of contextLayer.entries<T>()) {
          result.set(k, v);
        }
      }
    }

    return result;
  }
}

/**
 * Base class for metadata scanners
 *
 * 내부적으로 MetadataLayerRegistry의 현재 레이어에 메타데이터를 저장합니다.
 * 기존 API(set/get/clear/allMetadata/has/size)를 그대로 유지하므로
 * ColumnScanner, EntityScanner, ManyToOneScanner 등 기존 하위 클래스 및
 * 데코레이터 코드는 수정 없이 동작합니다.
 *
 * 각 스캐너 인스턴스는 scannerPrefix로 네임스페이스가 분리되어,
 * 같은 레이어에 여러 스캐너가 공존해도 서로 간섭하지 않습니다.
 */
export class MetadataScanner {
  /**
   * @deprecated mapper를 직접 순회하는 하위 클래스 호환용.
   * 레이어 시스템 마이그레이션 완료 후 제거 예정.
   * 현재 컨텍스트 레이어에서 이 스캐너의 prefix에 해당하는 엔트리만 반환합니다.
   */
  protected get mapper(): Map<string, any> {
    return this.prefixedView;
  }

  private uniqueIdCounter = 0;

  /**
   * 이 스캐너를 식별하는 prefix.
   * 하위 클래스에서 super("columns") 등으로 지정합니다.
   * 지정하지 않으면 "" (전역 네임스페이스).
   */
  protected readonly scannerPrefix: string;

  constructor(scannerPrefix = "") {
    this.scannerPrefix = scannerPrefix;
  }

  // ── LayerRegistry 접근 ──────────────────────────────────

  protected get registry(): MetadataLayerRegistry {
    return MetadataLayerRegistry.getInstance();
  }

  /**
   * 내부 키에 prefix를 적용합니다.
   */
  private prefixKey(key: string): string {
    return this.scannerPrefix ? `${this.scannerPrefix}::${key}` : key;
  }

  /**
   * prefix가 적용된 키에서 원래 키를 복원합니다.
   */
  private unprefixKey(key: string): string {
    if (!this.scannerPrefix) return key;
    const prefix = `${this.scannerPrefix}::`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  }

  /**
   * 현재 컨텍스트 레이어에서 이 스캐너의 네임스페이스에 해당하는 엔트리만 볼 수 있는 Map 뷰를 반환합니다.
   * 하위 클래스의 for (const [_, value] of this.mapper) 패턴을 지원합니다.
   */
  private get prefixedView(): Map<string, any> {
    const layer = this.registry.getCurrentLayer();
    const raw = layer.getInternalMap();

    if (!this.scannerPrefix) return raw;

    const view = new Map<string, any>();
    const prefix = `${this.scannerPrefix}::`;
    for (const [k, v] of raw) {
      if (k.startsWith(prefix)) {
        view.set(k.slice(prefix.length), v);
      }
    }
    return view;
  }

  // ── 기존 API (하위 호환) ─────────────────────────────────

  /**
   * Create a unique key for metadata storage
   */
  public createUniqueKey(): string {
    return `key_${Date.now()}_${this.uniqueIdCounter++}`;
  }

  /**
   * Store metadata with a key
   * 현재 컨텍스트의 레이어에 저장됩니다.
   */
  public set<T>(key: string, value: T): void {
    this.registry.getCurrentLayer().set(this.prefixKey(key), value);
  }

  /**
   * Retrieve metadata by key (병합된 뷰)
   */
  public get<T>(key: string): T | undefined {
    return this.registry.resolveValue<T>(this.prefixKey(key));
  }

  /**
   * Clear metadata for this scanner's namespace in current context layer.
   * 다른 스캐너의 데이터에는 영향을 주지 않습니다.
   */
  public clear(): void {
    const layer = this.registry.getCurrentLayer();
    if (!this.scannerPrefix) {
      layer.clear();
      return;
    }
    const prefix = `${this.scannerPrefix}::`;
    const raw = layer.getInternalMap();
    const keysToDelete: string[] = [];
    for (const key of raw.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      raw.delete(key);
    }
  }

  /**
   * Get all metadata values for this scanner's namespace (병합된 뷰)
   */
  public allMetadata<T = any>(): T[] {
    const merged = this.registry.resolveAll<T>();
    if (!this.scannerPrefix) {
      return Array.from(merged.values());
    }
    const prefix = `${this.scannerPrefix}::`;
    const results: T[] = [];
    for (const [key, value] of merged) {
      if (key.startsWith(prefix)) {
        results.push(value);
      }
    }
    return results;
  }

  /**
   * Check if a key exists (병합된 뷰)
   */
  public has(key: string): boolean {
    return this.registry.resolveValue(this.prefixKey(key)) !== undefined;
  }

  /**
   * Get the size of the metadata store for this namespace (병합된 뷰)
   */
  public get size(): number {
    return this.allMetadata().length;
  }

  // ── 멀티테넌트 지원 API ─────────────────────────────────

  /**
   * 현재 컨텍스트 전환
   */
  public switchContext(context: string): void {
    this.registry.setContext(context);
  }

  /**
   * 현재 컨텍스트 반환
   */
  public getContext(): string {
    return this.registry.getContext();
  }

  /**
   * 레이어 복사 (새 테넌트 생성)
   */
  public copyLayer(source: string, target: string): void {
    this.registry.copyLayer(source, target);
  }
}
