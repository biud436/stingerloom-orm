/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { MetadataLayer } from "../metadata/MetadataLayer";
import { MetadataContext } from "../metadata/MetadataContext";

/**
 * 전역 LayeredMetadataStore 레지스트리
 *
 * 모든 MetadataScanner 인스턴스가 공유하는 중앙 레이어 관리자입니다.
 * 기본적으로 "public" 레이어에 기록되며, 컨텍스트 전환으로 멀티테넌트를 지원합니다.
 *
 * AsyncLocalStorage 기반 MetadataContext가 활성화되어 있으면,
 * 요청 스코프의 tenantId가 우선 적용됩니다.
 */
export class MetadataLayerRegistry {
  private static instance: MetadataLayerRegistry;

  private layers: Map<string, MetadataLayer> = new Map();
  private currentContext: string = "public";

  // resolveAll() cache (#80) — bounded to prevent memory leak in multi-tenant
  private static readonly MAX_CACHE_SIZE = 1000;
  private resolveAllCache: Map<string, Map<string, any>> = new Map();
  private dirtyContexts: Set<string> = new Set(["public"]);

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

  /**
   * 현재 컨텍스트를 반환합니다.
   *
   * 우선순위:
   * 1. AsyncLocalStorage(MetadataContext)가 활성화되어 있으면 해당 tenantId
   * 2. 수동으로 setContext()로 설정한 값
   * 3. 기본값 "public"
   */
  getContext(): string {
    if (MetadataContext.isActive()) {
      return MetadataContext.getCurrentTenant();
    }
    return this.currentContext;
  }

  setContext(context: string): void {
    this.currentContext = context;
    // 해당 레이어가 없으면 자동 생성
    if (!this.layers.has(context)) {
      this.layers.set(context, new MetadataLayer(context, false));
      this.dirtyContexts.add(context);
    }
  }

  // ── 레이어 관리 ───────────────────────────────────────────

  getLayer(name: string): MetadataLayer | undefined {
    return this.layers.get(name);
  }

  getCurrentLayer(): MetadataLayer {
    const ctx = this.getContext();
    let layer = this.layers.get(ctx);
    if (!layer) {
      layer = new MetadataLayer(ctx, false);
      this.layers.set(ctx, layer);
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
    this.dirtyContexts.add(targetName);
    return cloned;
  }

  /**
   * 레이어 삭제
   */
  removeLayer(name: string): boolean {
    if (name === "public") throw new Error('Cannot remove "public" layer.');
    this.resolveAllCache.delete(name);
    this.dirtyContexts.delete(name);
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
    const ctx = this.getContext();
    // 1. 현재 컨텍스트 레이어
    const contextLayer = this.layers.get(ctx);
    if (contextLayer) {
      const v = contextLayer.get<T>(key);
      if (v !== undefined) return v;
    }
    // 2. public fallback (현재 컨텍스트가 public이 아닌 경우)
    if (ctx !== "public") {
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
   * 결과는 dirty flag 기반으로 캐시됩니다 (#80).
   */
  resolveAll<T>(): Map<string, T> {
    const ctx = this.getContext();

    // 캐시 히트: context가 dirty가 아니면 캐시된 결과 반환
    if (!this.dirtyContexts.has(ctx)) {
      const cached = this.resolveAllCache.get(ctx);
      if (cached) return cached as Map<string, T>;
    }

    const result = new Map<string, T>();

    // 1. public 레이어 (lower)
    const publicLayer = this.layers.get("public");
    if (publicLayer) {
      for (const [k, v] of publicLayer.entries<T>()) {
        result.set(k, v);
      }
    }

    // 2. 현재 컨텍스트 레이어 (upper) — 덮어쓰기
    if (ctx !== "public") {
      const contextLayer = this.layers.get(ctx);
      if (contextLayer) {
        for (const [k, v] of contextLayer.entries<T>()) {
          result.set(k, v);
        }
      }
    }

    // Evict oldest entries if cache exceeds max size
    if (this.resolveAllCache.size >= MetadataLayerRegistry.MAX_CACHE_SIZE) {
      const firstKey = this.resolveAllCache.keys().next().value;
      if (firstKey !== undefined && firstKey !== "public") {
        this.resolveAllCache.delete(firstKey);
      }
    }

    this.resolveAllCache.set(ctx, result);
    this.dirtyContexts.delete(ctx);

    return result;
  }

  /**
   * 지정된 context의 resolveAll 캐시를 무효화합니다.
   * "public"이 dirty되면 모든 context 캐시가 무효화됩니다.
   */
  markDirty(context: string): void {
    if (context === "public") {
      this.resolveAllCache.clear();
      for (const key of this.layers.keys()) {
        this.dirtyContexts.add(key);
      }
    } else {
      this.dirtyContexts.add(context);
    }
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
    this.registry.markDirty(this.registry.getContext());
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
      this.registry.markDirty(this.registry.getContext());
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
    if (keysToDelete.length > 0) {
      for (const key of keysToDelete) {
        raw.delete(key);
      }
      this.registry.markDirty(this.registry.getContext());
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

  // ── O(1) Target Lookup (#77) ────────────────────────────

  private lastResolvedMap: Map<string, any> | null = null;
  private targetIndexMap: Map<Function, any[]> = new Map();

  /**
   * O(1) lookup by entity class (target).
   * Returns all metadata entries in this scanner's namespace whose `target` matches.
   * The index is lazily rebuilt when the underlying resolveAll() map changes.
   */
  public getByTarget<T extends { target: Function }>(target: Function): T[] {
    const merged = this.registry.resolveAll<T>();
    if (merged !== this.lastResolvedMap) {
      this.targetIndexMap.clear();
      const prefix = this.scannerPrefix ? `${this.scannerPrefix}::` : "";
      for (const [key, value] of merged) {
        if (prefix && !key.startsWith(prefix)) continue;
        if (value && typeof value === "object" && "target" in value) {
          const fn = (value as any).target as Function;
          const existing = this.targetIndexMap.get(fn);
          if (existing) {
            existing.push(value);
          } else {
            this.targetIndexMap.set(fn, [value]);
          }
        }
      }
      this.lastResolvedMap = merged;
    }
    return (this.targetIndexMap.get(target) ?? []) as T[];
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
