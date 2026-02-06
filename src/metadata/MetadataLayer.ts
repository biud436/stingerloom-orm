/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 메타데이터 레이어
 * Docker의 레이어와 유사하게, 각 레이어는 독립적인 메타데이터를 저장합니다.
 */
export class MetadataLayer {
  /** @internal scanner 통합을 위해 protected로 노출 */
  protected metadata: Map<string, any> = new Map();
  private readonly name: string;
  private readonly isReadOnly: boolean;
  private readonly createdAt: Date;

  constructor(name: string, isReadOnly = false) {
    this.name = name;
    this.isReadOnly = isReadOnly;
    this.createdAt = new Date();
  }

  /**
   * 레이어 이름 반환
   */
  getName(): string {
    return this.name;
  }

  /**
   * 읽기 전용 여부 확인
   */
  isReadOnlyLayer(): boolean {
    return this.isReadOnly;
  }

  /**
   * 메타데이터 설정
   * 읽기 전용 레이어면 에러 발생
   */
  set<T>(key: string, value: T): void {
    if (this.isReadOnly) {
      throw new Error(
        `Cannot modify read-only layer: ${this.name}. Use a writable upper layer.`,
      );
    }
    this.metadata.set(key, value);
  }

  /**
   * 메타데이터 조회 (현재 레이어에만 한정)
   */
  get<T>(key: string): T | undefined {
    return this.metadata.get(key);
  }

  /**
   * 키 존재 여부 확인
   */
  has(key: string): boolean {
    return this.metadata.has(key);
  }

  /**
   * 메타데이터 삭제 (읽기 전용 레이어면 에러)
   */
  delete(key: string): boolean {
    if (this.isReadOnly) {
      throw new Error(
        `Cannot delete from read-only layer: ${this.name}. Use a whiteout marker.`,
      );
    }
    return this.metadata.delete(key);
  }

  /**
   * 현재 레이어의 모든 키 반환
   */
  keys(): string[] {
    return Array.from(this.metadata.keys());
  }

  /**
   * 현재 레이어의 모든 값 반환
   */
  values<T>(): T[] {
    return Array.from(this.metadata.values());
  }

  /**
   * 현재 레이어의 모든 엔트리 반환
   */
  entries<T>(): Array<[string, T]> {
    return Array.from(this.metadata.entries());
  }

  /**
   * 레이어 크기 반환
   */
  size(): number {
    return this.metadata.size;
  }

  /**
   * 내부 Map 참조를 반환합니다.
   * MetadataScanner와의 통합을 위해 사용됩니다.
   * @internal
   */
  getInternalMap(): Map<string, any> {
    return this.metadata;
  }

  /**
   * 레이어 정보 반환
   */
  getLayerInfo() {
    return {
      name: this.name,
      isReadOnly: this.isReadOnly,
      createdAt: this.createdAt,
      size: this.metadata.size,
    };
  }

  /**
   * 현재 레이어 복제 (새로운 레이어 생성)
   * structuredClone이 불가능한 값(함수, 클래스 참조 등)은 얕은 복사로 대체합니다.
   */
  clone(newName: string, readOnly = false): MetadataLayer {
    const clonedLayer = new MetadataLayer(newName, readOnly);
    for (const [key, value] of this.metadata.entries()) {
      try {
        clonedLayer.metadata.set(key, structuredClone(value));
      } catch {
        // structuredClone이 실패하면 (함수, 클래스 참조 등) 얕은 복사
        clonedLayer.metadata.set(key, { ...value });
      }
    }
    return clonedLayer;
  }

  /**
   * 레이어 초기화
   */
  clear(): void {
    if (this.isReadOnly) {
      throw new Error(`Cannot clear read-only layer: ${this.name}`);
    }
    this.metadata.clear();
  }
}
