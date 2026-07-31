/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { MetadataScanner } from "./MetadataScanner";
import { ClazzType } from "../utils";
export type EntityScannerMetadata = {
  target: ClazzType<any>;
  /**
   * Resolved table name. Always set: the @Entity decorator fills it from the
   * class name when `@Entity({ name })` is not given, and the NamingStrategy
   * pass rewrites it in place (`nameExplicit` wins).
   */
  name: string;
  columns: any[];
  indexes?: any[];
};

export class EntityScanner extends MetadataScanner {
  constructor() {
    super("entities");
  }

  public *makeEntities(): IterableIterator<EntityScannerMetadata> {
    for (const [_, value] of this.mapper) {
      yield value;
    }
  }

  public scan(target: ClazzType<unknown>): EntityScannerMetadata | null {
    return this.getByTarget<EntityScannerMetadata>(target)[0] ?? null;
  }
}
