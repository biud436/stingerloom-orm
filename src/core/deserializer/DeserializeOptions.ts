/**
 * Library-independent deserialization option interface.
 * Designed so it does not depend on any specific implementation such as class-transformer.
 */
export interface DeserializeOptions {
  /**
   * Drop properties that do not exist on the class.
   */
  excludeExtraneousValues?: boolean;

  /**
   * Expose only properties in specific groups.
   */
  groups?: string[];

  /**
   * Expose only properties that match the given version.
   */
  version?: number;

  /**
   * Enable circular-reference detection.
   */
  enableCircularCheck?: boolean;

  /**
   * Expose properties that have default values.
   */
  exposeDefaultValues?: boolean;

  /**
   * Whether to expose properties that have no decorator.
   */
  exposeUnsetProperties?: boolean;
}
