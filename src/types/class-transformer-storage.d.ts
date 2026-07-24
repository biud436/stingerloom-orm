/**
 * class-transformer ships no types for its internal cjs/storage module.
 * ClassTransformerDeserializer reaches into it for the fast-path metadata
 * probe (same approach as @nestjs/swagger) and validates the shape at runtime.
 */
declare module "class-transformer/cjs/storage";
