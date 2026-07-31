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
   * Resolved DB column name. Always set: the decorator / EntitySchema bridge
   * fills it from the property key when `@Column({ name })` is not given, and
   * the NamingStrategy pass rewrites it in place (`nameExplicit` wins).
   * The table is created using this name.
   */
  name: string;
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
