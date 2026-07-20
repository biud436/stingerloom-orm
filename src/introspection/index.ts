/**
 * Database introspection (entity generation from an existing schema).
 *
 * Declared as explicit named re-exports (no `export *`) so that adding an
 * export to an internal module does not silently widen this subpath's API.
 */

export {
  DbColumn,
  DbForeignKey,
  DbIndex,
  EntityCodeBuilder,
  EntityCodeBuilderOptions,
} from "./EntityCodeBuilder";
export {
  IntrospectionCliOptions,
  IntrospectionCliResult,
  runIntrospect,
} from "./IntrospectionCli";
export {
  GeneratedEntity,
  IntrospectionGenerator,
  IntrospectionGeneratorOptions,
  IntrospectionQueryFn,
} from "./IntrospectionGenerator";
export { IntrospectionDialect, IntrospectionTypeMapper } from "./TypeMapper";
