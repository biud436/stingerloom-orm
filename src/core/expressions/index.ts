/**
 * Barrel for the QueryDSL expression layer.
 *
 * Re-exports every deferred expression / condition class so the public
 * `core` barrel (and consumers) can pull the whole family from one path.
 * Mirrors the sibling `deserializer/`, `generators/`, and `plugin/` barrels.
 *
 * `ComputedColumnExpression` is re-exported *selectively* — only the two
 * names that belong on the public surface — so its internal helpers
 * (`renderComputedColumnExpression`, the builder/context type aliases) stay
 * package-private and reachable via the direct module path.
 */
export * from "./JsonPathExpression";
export * from "./ConditionLike";
export * from "./OrderExpression";
export * from "./AggregateExpression";
export * from "./OrderedSetAggregateExpression";
export * from "./LogicalCondition";
export * from "./AliasedExpression";
export * from "./ScalarExpression";
export * from "./NullishExpression";
export * from "./TemporalExpression";
export * from "./CastExpression";
export * from "./DateComponentExpression";
export * from "./SubqueryExpression";
export * from "./CaseExpression";
export * from "./StringExpression";
export * from "./NumericExpression";
export * from "./DateArithmeticExpression";
export * from "./WindowExpression";
export * from "./WindowFunctions";
export * from "./RawExpression";
export * from "./TupleExpression";
export * from "./likeEscape";
export {
  getExpressionContext,
  type SelectExpressionContext,
} from "./ComputedColumnExpression";
