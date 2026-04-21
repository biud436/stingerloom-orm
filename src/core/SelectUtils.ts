import { ISelectOption } from "../dialects/ISelectOption";
import { FindOption } from "../dialects/FindOption";

type SelectableFields<T> = { [K in keyof T]?: boolean };

class SelectUtils {
  static isArraySelect<T>(select: ISelectOption<T>): select is (keyof T)[] {
    return Array.isArray(select);
  }

  static isBooleanSelect<T>(
    select: ISelectOption<T>,
  ): select is SelectableFields<T> {
    if (!select || typeof select !== "object" || Array.isArray(select))
      return false;

    // Check that every value in the object is a boolean
    return Object.values(select).every(
      (value) => typeof value === "boolean" || value === undefined,
    );
  }

  static isNestedSelect<T>(
    select: ISelectOption<T>,
  ): select is { [K in keyof T]?: FindOption<T[K]> } {
    if (!select || typeof select !== "object" || Array.isArray(select))
      return false;

    // If any value is an object (not a boolean), treat it as a nested select
    return Object.values(select).some(
      (value) =>
        typeof value === "object" && value !== null && !Array.isArray(value),
    );
  }
}

export default SelectUtils;
