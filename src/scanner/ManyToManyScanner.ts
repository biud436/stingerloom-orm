/* eslint-disable @typescript-eslint/no-unused-vars */
import { MetadataScanner } from "./MetadataScanner";
import { Service } from "typedi";
import { ManyToManyMetadata } from "../decorators";
import { ClazzType } from "../utils";

@Service()
export class ManyToManyScanner extends MetadataScanner {
  constructor() {
    super("manyToManyRelations");
  }

  public *makeManyToManys(): IterableIterator<ManyToManyMetadata<unknown>> {
    for (const [_, value] of this.mapper) {
      yield value;
    }
  }

  public scan(target: ClazzType<unknown>): ManyToManyMetadata<unknown>[] {
    const results: ManyToManyMetadata<unknown>[] = [];
    for (const [_, value] of this.mapper) {
      if (value.target === target) {
        results.push(value);
      }
    }
    return results;
  }
}
