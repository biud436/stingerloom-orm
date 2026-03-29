/* eslint-disable @typescript-eslint/no-unused-vars */
import { MetadataScanner } from "./MetadataScanner";
import { OneToOneMetadata } from "../decorators/OneToOne";
import { ClazzType } from "../utils";

export class OneToOneScanner extends MetadataScanner {
  constructor() {
    super("oneToOneRelations");
  }

  public *makeOneToOnes(): IterableIterator<OneToOneMetadata<unknown>> {
    for (const [_, value] of this.mapper) {
      yield value;
    }
  }

  public scan(target: ClazzType<unknown>): OneToOneMetadata<unknown>[] {
    const results: OneToOneMetadata<unknown>[] = [];
    for (const [_, value] of this.mapper) {
      if (value.target === target) {
        results.push(value);
      }
    }
    return results;
  }
}
