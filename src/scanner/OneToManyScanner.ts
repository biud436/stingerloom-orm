/* eslint-disable @typescript-eslint/no-unused-vars */
import { MetadataScanner } from "./MetadataScanner";
import { Service } from "typedi";
import { OneToManyMetadata } from "../decorators";
import { ClazzType } from "../utils";

@Service()
export class OneToManyScanner extends MetadataScanner {
  constructor() {
    super("oneToManyRelations");
  }

  public *makeOneToManys(): IterableIterator<OneToManyMetadata<unknown>> {
    for (const [_, value] of this.mapper) {
      yield value;
    }
  }

  public scan(target: ClazzType<unknown>): OneToManyMetadata<unknown>[] {
    const results: OneToManyMetadata<unknown>[] = [];
    for (const [_, value] of this.mapper) {
      if (value.target === target) {
        results.push(value);
      }
    }
    return results;
  }
}
