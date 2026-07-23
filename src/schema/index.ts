/**
 * Decorator-free entity definition public surface.
 *
 * Declared as explicit named re-exports (no `export *`) so that adding an
 * export to an internal module does not silently widen this subpath's API.
 */

export { EntitySchema } from "./EntitySchema";
export {
  ColumnSchemaDef,
  DiscriminatorColumnSchemaDef,
  EntitySchemaOptions,
  InheritanceSchemaDef,
  ManyToManyRelationDef,
  ManyToOneRelationDef,
  OneToManyRelationDef,
  OneToOneRelationDef,
  RelationSchemaDef,
  ValidationDef,
} from "./EntitySchemaTypes";
export {
  BuilderKind,
  ColumnBuilder,
  ColumnTypes,
  ComputedBuilder,
  ManyToManyBuilderOptions,
  ManyToOneBuilderOptions,
  OneToOneBuilderOptions,
  RelationBuilder,
  SchemaBuilder,
  t,
} from "./builders";
export {
  AnyBuilder,
  defineEntity,
  DefineEntityOptions,
  EntityClass,
  EntityColumns,
  EntityHookFn,
  InferEntity,
  InferShape,
} from "./defineEntity";
