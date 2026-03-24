/**
 * Stingerloom ORM - A standalone, framework-agnostic TypeScript ORM
 *
 * This ORM can be used with any Node.js framework or standalone.
 * It provides a clean, type-safe API for working with MySQL databases.
 */

// Core ORM functionality
export * from "./core";
export * from "./DatabaseClient";

// Decorators for entity definitions
export * from "./decorators";

// Database dialects and drivers
export * from "./dialects";

// Type definitions
export * from "./types";

// Metadata management (Layered/Multi-tenant support)
export * from "./metadata";

// Utilities (excluding scanner-specific exports to avoid conflicts)
export { ClazzType, Type } from "./utils/types";
export { Logger } from "./utils/Logger";
export { ReflectManager } from "./utils/ReflectManager";
export { createEntityKey } from "./utils/scanner";
export { camelToSnakeCase } from "./utils/camelToSnakeCase";
export { resolveEntityGlobs } from "./utils/resolveEntityGlobs";

// Migration system
export * from "./migration";

// Database seeding framework
export * from "./seeding";

// Database introspection (entity generation from existing schema)
export * from "./introspection";

// Error classes
export * from "./errors";

// Schema-based entity definitions (decorator-free)
export * from "./schema";

// Prisma import (requires optional @mrleebo/prisma-ast)
export * from "./integration/prisma-import";
