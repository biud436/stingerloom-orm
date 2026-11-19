import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";

/**
 * @internal The error an expression module throws when `and()` / `or()` /
 * `not()` runs before `LogicalCondition` registered itself. The expression
 * modules reach the logical combinators through a registration hook to stay
 * free of import cycles, so this only happens when a module is imported on
 * its own, past the package entry point that loads `LogicalCondition`.
 */
export function logicalConditionNotRegistered(): OrmError {
  return new OrmError(
    OrmErrorCode.INVALID_CONFIG,
    "LogicalCondition not registered: and() / or() / not() ran before the module that implements them was loaded.",
    "Import from '@stingerloom/orm' (or another package entry point) instead of an internal file.",
  );
}
