/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 메타데이터 경로를 관리하는 Trie 노드
 * API Route의 Trie와 유사하게 경로 개념을 제공합니다.
 */
export class MetadataPathNode {
  children: Map<string, MetadataPathNode> = new Map();
  value?: any;
  isEndOfPath: boolean = false;
  path: string;

  constructor(path: string) {
    this.path = path;
  }
}

/**
 * 메타데이터 경로 관리자 (Trie 자료구조)
 * 예: "public/users", "tenant_1/users", "tenant_1/schema_v2/posts"
 */
export class MetadataPath {
  private root: MetadataPathNode;

  constructor() {
    this.root = new MetadataPathNode("");
  }

  /**
   * 경로 삽입
   * @param path 예: "public/users" 또는 "tenant_1/users"
   * @param value 저장할 메타데이터
   */
  insert(path: string, value: any): void {
    const segments = this.normalizePath(path).split("/");
    let currentNode = this.root;

    for (const segment of segments) {
      if (!currentNode.children.has(segment)) {
        currentNode.children.set(
          segment,
          new MetadataPathNode(
            `${currentNode.path}/${segment}`.replace(/^\//, ""),
          ),
        );
      }
      currentNode = currentNode.children.get(segment)!;
    }

    currentNode.isEndOfPath = true;
    currentNode.value = value;
  }

  /**
   * 경로 검색
   * @param path 경로
   * @returns 메타데이터 또는 undefined
   */
  search(path: string): any | undefined {
    const segments = this.normalizePath(path).split("/");
    let currentNode = this.root;

    for (const segment of segments) {
      if (!currentNode.children.has(segment)) {
        return undefined;
      }
      currentNode = currentNode.children.get(segment)!;
    }

    return currentNode.isEndOfPath ? currentNode.value : undefined;
  }

  /**
   * 경로가 존재하는지 확인
   */
  has(path: string): boolean {
    return this.search(path) !== undefined;
  }

  /**
   * 특정 prefix로 시작하는 모든 경로 찾기
   * @param prefix 예: "public" → "public/users", "public/posts" 등
   */
  findByPrefix(prefix: string): Array<{ path: string; value: any }> {
    const segments = this.normalizePath(prefix).split("/");
    let currentNode = this.root;

    // prefix까지 이동
    for (const segment of segments) {
      if (!currentNode.children.has(segment)) {
        return [];
      }
      currentNode = currentNode.children.get(segment)!;
    }

    // prefix 이하 모든 경로 수집
    const results: Array<{ path: string; value: any }> = [];
    this.collectPaths(currentNode, results);
    return results;
  }

  /**
   * 경로 삭제
   */
  delete(path: string): boolean {
    const segments = this.normalizePath(path).split("/");
    return this.deleteRecursive(this.root, segments, 0);
  }

  /**
   * 재귀적 경로 삭제
   */
  private deleteRecursive(
    node: MetadataPathNode,
    segments: string[],
    index: number,
  ): boolean {
    if (index === segments.length) {
      if (!node.isEndOfPath) {
        return false;
      }
      node.isEndOfPath = false;
      node.value = undefined;
      return node.children.size === 0;
    }

    const segment = segments[index];
    const childNode = node.children.get(segment);
    if (!childNode) {
      return false;
    }

    const shouldDeleteChild = this.deleteRecursive(
      childNode,
      segments,
      index + 1,
    );

    if (shouldDeleteChild) {
      node.children.delete(segment);
      return node.children.size === 0 && !node.isEndOfPath;
    }

    return false;
  }

  /**
   * 모든 경로 수집 (DFS)
   */
  private collectPaths(
    node: MetadataPathNode,
    results: Array<{ path: string; value: any }>,
  ): void {
    if (node.isEndOfPath && node.value !== undefined) {
      results.push({
        path: node.path,
        value: node.value,
      });
    }

    for (const child of node.children.values()) {
      this.collectPaths(child, results);
    }
  }

  /**
   * 경로 정규화 (앞뒤 슬래시 제거, 연속 슬래시 제거)
   */
  private normalizePath(path: string): string {
    return path
      .replace(/^\/+|\/+$/g, "") // 앞뒤 슬래시 제거
      .replace(/\/+/g, "/") // 연속 슬래시를 하나로
      .trim();
  }

  /**
   * 모든 경로 목록 반환
   */
  getAllPaths(): string[] {
    const results: Array<{ path: string; value: any }> = [];
    this.collectPaths(this.root, results);
    return results.map((r) => r.path);
  }
}
