/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Trie node used to manage metadata paths.
 * Provides a path abstraction similar to API route tries.
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
 * Metadata path manager (trie data structure).
 * Example paths: "public/users", "tenant_1/users", "tenant_1/schema_v2/posts".
 */
export class MetadataPath {
  private root: MetadataPathNode;

  constructor() {
    this.root = new MetadataPathNode("");
  }

  /**
   * Insert a path.
   * @param path e.g. "public/users" or "tenant_1/users"
   * @param value metadata to store
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
   * Look up a path.
   * @param path the path
   * @returns the metadata or undefined
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
   * Check whether a path exists.
   */
  has(path: string): boolean {
    return this.search(path) !== undefined;
  }

  /**
   * Find all paths starting with a given prefix.
   * @param prefix e.g. "public" → "public/users", "public/posts", etc.
   */
  findByPrefix(prefix: string): Array<{ path: string; value: any }> {
    const segments = this.normalizePath(prefix).split("/");
    let currentNode = this.root;

    // Descend to the prefix node
    for (const segment of segments) {
      if (!currentNode.children.has(segment)) {
        return [];
      }
      currentNode = currentNode.children.get(segment)!;
    }

    // Collect every path below the prefix
    const results: Array<{ path: string; value: any }> = [];
    this.collectPaths(currentNode, results);
    return results;
  }

  /**
   * Delete a path.
   */
  delete(path: string): boolean {
    const segments = this.normalizePath(path).split("/");
    return this.deleteRecursive(this.root, segments, 0);
  }

  /**
   * Recursive path deletion.
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
   * Collect every path (DFS).
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
   * Normalize a path (trim leading/trailing slashes and collapse repeats).
   */
  private normalizePath(path: string): string {
    return path
      .replace(/^\/+|\/+$/g, "") // strip leading/trailing slashes
      .replace(/\/+/g, "/") // collapse consecutive slashes into one
      .trim();
  }

  /**
   * Return every registered path.
   */
  getAllPaths(): string[] {
    const results: Array<{ path: string; value: any }> = [];
    this.collectPaths(this.root, results);
    return results.map((r) => r.path);
  }
}
