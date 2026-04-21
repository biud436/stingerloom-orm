/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { MetadataScanner } from "./MetadataScanner";
import { ClazzType } from "../utils";
import { ColumnOption } from "../decorators/Column";

export type ColumnMetadata = {
  /**
   * Specifies the target class of the column.
   */
  target: ClazzType<unknown>;
  /**
   * Original TypeScript property name.
   */
  propertyKey?: string;
  /**
   * Specifies the name of the column.
   * if not specified, the name of the column is the same as the property name.
   * the table is created using the name of the column.
   */
  name?: string;
  /** True when the user explicitly provided `@Column({ name: "..." })`. */
  nameExplicit?: boolean;
  options?: ColumnOption;
  type: any;
  transform?: (raw: unknown) => any;
  transformer?: import("../decorators/Column").ColumnTransformer;
};

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
