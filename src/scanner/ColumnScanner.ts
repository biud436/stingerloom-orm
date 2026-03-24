/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { MetadataScanner } from "./MetadataScanner";
import { ClazzType } from "../utils";
import { Service } from "typedi";
import { ColumnOption } from "../decorators/Column";

export type ColumnMetadata = {
  /**
   * Specifies the target class of the column.
   */
  target: ClazzType<unknown>;
  /**
   * 원본 TypeScript 프로퍼티 이름입니다.
   */
  propertyKey?: string;
  /**
   * Specifies the name of the column.
   * if not specified, the name of the column is the same as the property name.
   * the table is created using the name of the column.
   */
  name?: string;
  options?: ColumnOption;
  type: any;
  transform?: (raw: unknown) => any;
  transformer?: import("../decorators/Column").ColumnTransformer;
};

@Service()
export class ColumnScanner extends MetadataScanner {
  constructor() {
    super("columns");
  }

  public *makeColumns(): IterableIterator<ColumnMetadata> {
    for (const [_, value] of this.mapper) {
      yield value;
    }
  }
}
