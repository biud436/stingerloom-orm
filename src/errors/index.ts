/**
 * ORM error types.
 *
 * Declared as explicit named re-exports (no `export *`) so that adding an
 * export to an internal module does not silently widen this subpath's API.
 */

export { AdvisoryLockError } from "./AdvisoryLockError";
export { DatabaseConnectionFailedError } from "./DatabaseConnectionFailedError";
export { DatabaseNotConnectedError } from "./DatabaseNotConnectedError";
export { DeleteWithoutConditionsError } from "./DeleteWithoutConditionsError";
export { EntityMetadataNotFoundError } from "./EntityMetadataNotFoundError";
export { EntityNotFoundError } from "./EntityNotFoundError";
export { Exception } from "./Exception";
export { InvalidQueryError } from "./InvalidQueryError";
export { NotSupportedDatabaseTypeError } from "./NotSupportedDatabaseTypeError";
export { OptimisticLockError } from "./OptimisticLockError";
export { OrmError } from "./OrmError";
export { OrmErrorCode } from "./OrmErrorCode";
export { PrimaryKeyNotFoundError } from "./PrimaryKeyNotFoundError";
export { QueryTimeoutError } from "./QueryTimeoutError";
export { TransactionError } from "./TransactionError";
export {
  unsupportedExpression,
  UnsupportedExpressionOptions,
} from "./UnsupportedExpressionError";
export { UnsupportedFeatureError } from "./UnsupportedFeatureError";
export { ValidationError } from "./ValidationError";
