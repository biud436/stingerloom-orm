/* eslint-disable @typescript-eslint/no-unused-vars */
import { MetadataScanner } from "./MetadataScanner";
import { ManyToOneMetadata } from "../decorators";
import { ClazzType } from "../utils";

export class ManyToOneScanner extends MetadataScanner {
  constructor() {
    super("relations");
  }

  public *makeManyToOnes(): IterableIterator<ManyToOneMetadata<unknown>> {
    for (const [_, value] of this.mapper) {
      yield value;
    }
  }

  public scan(target: ClazzType<unknown>): ManyToOneMetadata<unknown> | null {
    return this.getByTarget<ManyToOneMetadata<unknown>>(target)[0] ?? null;
  }
}
