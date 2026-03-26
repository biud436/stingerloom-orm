/* eslint-disable @typescript-eslint/no-explicit-any */
import { MetadataLayer } from "./MetadataLayer";
import { MetadataContext } from "./MetadataContext";
import { MetadataPath } from "./MetadataPath";

/**
 * 계층적 메타데이터 스토어 (Docker OverlayFS 방식)
 *
 * Lower Layer (읽기 전용): 기본 스키마 (예: "public")
 * Upper Layers (읽기/쓰기): 테넌트별 수정사항 (예: "tenant_1", "tenant_2")
 *
 * 읽기: 현재 컨텍스트 레이어 → public 레이어 순서로 검색 (다른 테넌트 레이어는 절대 참조하지 않음)
 * 쓰기: 최상위 work 레이어에만 기록 (Copy-on-Write)
 */
export class LayeredMetadataStore {
  private layers: MetadataLayer[] = [];
  private pathTrie: MetadataPath;
  private currentContext: string = "public"; // 기본 컨텍스트

  constructor() {
    this.pathTrie = new MetadataPath();
    // 기본 lower 레이어 생성
    this.addLayer("public", true);
  }

  /**
   * 새로운 레이어 추가
   * @param name 레이어 이름
   * @param isReadOnly 읽기 전용 여부
   */
  addLayer(name: string, isReadOnly = false): MetadataLayer {
    const existingLayer = this.layers.find((l) => l.getName() === name);
    if (existingLayer) {
      throw new Error(`Layer "${name}" already exists.`);
    }

    const layer = new MetadataLayer(name, isReadOnly);
    this.layers.push(layer);
    return layer;
  }

  /**
   * 레이어 가져오기
   */
  getLayer(name: string): MetadataLayer | undefined {
    return this.layers.find((l) => l.getName() === name);
  }

  /**
   * 현재 컨텍스트 설정 (예: "tenant_1"으로 전환)
   *
   * @deprecated 프로덕션 코드에서는 `MetadataContext.run(tenantId, callback)` 사용 권장.
   * `setContext()`는 인스턴스 상태를 변경하므로 동시 요청 환경에서 안전하지 않습니다.
   * 테스트 코드 전용으로만 사용하세요.
   */
  setContext(context: string): void {
    this.currentContext = context;
  }

  /**
   * 현재 활성 컨텍스트 가져오기.
   * AsyncLocalStorage(MetadataContext)가 활성 상태이면 우선 사용하고,
   * 비활성이면 인스턴스의 currentContext를 반환합니다 (테스트 호환).
   */
  getContext(): string {
    return this.resolveContext();
  }

  /**
   * 현재 컨텍스트를 안전하게 결정합니다.
   * AsyncLocalStorage > 인스턴스 상태 순서로 조회합니다.
   */
  private resolveContext(): string {
    if (MetadataContext.isActive()) {
      return MetadataContext.getCurrentTenant();
    }
    return this.currentContext;
  }

  /**
   * 메타데이터 설정 (현재 컨텍스트의 최상위 쓰기 가능 레이어에 저장)
   * Copy-on-Write 방식
   */
  set<T>(key: string, value: T): void {
    const context = this.resolveContext();
    const fullPath = `${context}/${key}`;

    // #148: public 레이어에 직접 쓰기 허용
    if (context === "public") {
      const publicLayer = this.getLayer("public");
      if (publicLayer) {
        publicLayer.getInternalMap().set(key, value);
        this.pathTrie.insert(fullPath, { layer: "public", key, value });
        return;
      }
    }

    // 현재 컨텍스트에 해당하는 쓰기 가능한 레이어 찾기
    let workLayer = this.layers.find(
      (l) => l.getName() === context && !l.isReadOnlyLayer(),
    );

    // 쓰기 가능한 레이어가 없으면 생성
    if (!workLayer) {
      workLayer = this.addLayer(context, false);
    }

    // 레이어에 저장
    workLayer.set(key, value);

    // Trie에 경로 등록
    this.pathTrie.insert(fullPath, { layer: workLayer.getName(), key, value });
  }

  /**
   * 메타데이터 조회 (병합된 뷰 제공)
   * 현재 컨텍스트 레이어 → public 레이어 순서로 검색 (다른 테넌트 레이어는 절대 참조하지 않음)
   */
  get<T>(key: string): T | undefined {
    const context = this.resolveContext();
    const fullPath = `${context}/${key}`;

    // 1. Trie에서 현재 컨텍스트 경로 확인
    const pathData = this.pathTrie.search(fullPath);
    if (pathData) {
      return pathData.value;
    }

    // 2. 현재 컨텍스트 레이어에서만 검색 (다른 테넌트 레이어 절대 참조 안 함)
    const contextLayer = this.getLayer(context);
    if (contextLayer) {
      const value = contextLayer.get<T>(key);
      if (value !== undefined) {
        return value;
      }
    }

    // 3. public(lower) 레이어 fallback
    if (context !== "public") {
      const publicPath = `public/${key}`;
      const publicData = this.pathTrie.search(publicPath);
      if (publicData) {
        return publicData.value;
      }

      const publicLayer = this.getLayer("public");
      if (publicLayer) {
        return publicLayer.get<T>(key);
      }
    }

    return undefined;
  }

  /**
   * 메타데이터 존재 여부 확인
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * 특정 컨텍스트의 모든 메타데이터 가져오기 (병합된 뷰)
   * OverlayFS 방식: public(lower) 레이어 + 대상 컨텍스트(upper) 레이어만 병합
   */
  getAllInContext<T>(context?: string): Map<string, T> {
    const targetContext = context || this.resolveContext();
    const result = new Map<string, T>();

    // 1. public(lower) 레이어 데이터 수집 (base)
    const publicLayer = this.getLayer("public");
    if (publicLayer) {
      for (const [key, value] of publicLayer.entries<T>()) {
        result.set(key, value);
      }
    }

    // 2. 대상 컨텍스트 레이어의 데이터로 덮어쓰기 (Copy-on-Write)
    if (targetContext !== "public") {
      const contextLayer = this.getLayer(targetContext);
      if (contextLayer) {
        for (const [key, value] of contextLayer.entries<T>()) {
          result.set(key, value);
        }
      }
    }

    return result;
  }

  /**
   * 레이어 복사 (멀티테넌트 환경에서 새 테넌트 생성 시 사용)
   * @param sourceName 원본 레이어
   * @param targetName 대상 레이어
   */
  copyLayer(sourceName: string, targetName: string): MetadataLayer {
    const sourceLayer = this.getLayer(sourceName);
    if (!sourceLayer) {
      throw new Error(`Source layer "${sourceName}" not found.`);
    }

    // #141: 대상 레이어 이름 중복 방지
    const existingLayer = this.getLayer(targetName);
    if (existingLayer) {
      throw new Error(`Layer "${targetName}" already exists.`);
    }

    const clonedLayer = sourceLayer.clone(targetName, false);
    this.layers.push(clonedLayer);

    // Trie에도 경로 복사
    const sourcePaths = this.pathTrie.findByPrefix(sourceName);
    for (const { path, value } of sourcePaths) {
      const newPath = path.replace(sourceName, targetName);
      this.pathTrie.insert(newPath, { ...value, layer: targetName });
    }

    return clonedLayer;
  }

  /**
   * 레이어 병합 (특정 테넌트의 변경사항을 public으로 승격)
   */
  mergeLayer(sourceName: string, targetName: string): void {
    const sourceLayer = this.getLayer(sourceName);
    const targetLayer = this.getLayer(targetName);

    if (!sourceLayer) {
      throw new Error(`Source layer "${sourceName}" not found.`);
    }
    if (!targetLayer) {
      throw new Error(`Target layer "${targetName}" not found.`);
    }

    // #148: public 레이어로의 병합 허용 (getInternalMap 사용)
    const isTargetReadOnly = targetLayer.isReadOnlyLayer();

    // 소스 레이어의 모든 데이터를 타겟 레이어로 복사 + trie 동기화 (#143)
    for (const [key, value] of sourceLayer.entries()) {
      if (isTargetReadOnly) {
        targetLayer.getInternalMap().set(key, value);
      } else {
        targetLayer.set(key, value);
      }
      const fullPath = `${targetName}/${key}`;
      this.pathTrie.insert(fullPath, { layer: targetName, key, value });
    }
  }

  /**
   * 레이어 데이터 초기화 + trie 동기화 (#143)
   */
  clearLayer(name: string): void {
    const layer = this.getLayer(name);
    if (!layer) {
      throw new Error(`Layer "${name}" not found.`);
    }
    layer.clear();
    // trie에서도 해당 레이어의 경로 제거
    const paths = this.pathTrie.findByPrefix(name);
    for (const { path } of paths) {
      this.pathTrie.delete(path);
    }
  }

  /**
   * 레이어 제거
   */
  removeLayer(name: string): boolean {
    const index = this.layers.findIndex((l) => l.getName() === name);
    if (index === -1) {
      return false;
    }

    // public 레이어는 삭제 불가
    if (name === "public") {
      throw new Error('Cannot remove "public" layer.');
    }

    this.layers.splice(index, 1);

    // Trie에서도 경로 제거
    const paths = this.pathTrie.findByPrefix(name);
    for (const { path } of paths) {
      this.pathTrie.delete(path);
    }

    return true;
  }

  /**
   * 모든 레이어 정보 반환
   */
  getLayersInfo() {
    return this.layers.map((layer) => layer.getLayerInfo());
  }

  /**
   * 특정 경로의 모든 하위 항목 검색
   */
  findByPrefix(prefix: string): Array<{ path: string; value: any }> {
    return this.pathTrie.findByPrefix(`${this.resolveContext()}/${prefix}`);
  }
}
