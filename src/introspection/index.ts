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
  EntityCodeStyle,
} from "./EntityCodeBuilder";
export {
  buildEntityModel,
  EntityModel,
  EntityModelField,
  ModelColumnField,
  ModelIndex,
  ModelRelationField,
} from "./EntityModel";
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
