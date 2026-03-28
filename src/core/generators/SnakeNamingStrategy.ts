import { camelToSnakeCase } from "../../utils/camelToSnakeCase";
import { DefaultNamingStrategy } from "./NamingStrategy";

/**
 * Naming strategy that converts camelCase TypeScript names to snake_case database names.
 *
 * @example
 * ```typescript
 * const client = new DatabaseClient({
 *   // ...
 *   namingStrategy: new SnakeNamingStrategy(),
 * });
 * ```
 *
 * With this strategy:
 * - `class UserProfile` → table `user_profile`
 * - `firstName: string` → column `first_name`
 * - `@ManyToOne author` → FK column `author_id`
 */
export class SnakeNamingStrategy extends DefaultNamingStrategy {
  columnName(propertyName: string): string {
    return camelToSnakeCase(propertyName);
  }

  joinColumnName(propertyName: string, referencedColumnName: string): string {
    return `${camelToSnakeCase(propertyName)}_${camelToSnakeCase(referencedColumnName)}`;
  }
}
