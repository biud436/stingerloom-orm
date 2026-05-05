import * as Joi from "joi";

/**
 * Boot-time env validation. Runs inside `ConfigModule.forRoot({ validationSchema })`,
 * so any missing or malformed value fails the process before a single
 * request is served. Production secrets must be set explicitly — defaults
 * are provided only for local dev.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid("development", "test", "production")
    .default("development"),

  PORT: Joi.number().integer().min(1).max(65535).default(3000),

  // Database
  DB_TYPE: Joi.string().valid("mysql", "postgres").default("mysql"),
  DB_HOST: Joi.string().hostname().default("localhost"),
  DB_PORT: Joi.number().integer().min(1).max(65535),
  DB_USER: Joi.string().min(1).default("root"),
  DB_PASSWORD: Joi.string()
    .min(1)
    .when("NODE_ENV", {
      is: "production",
      then: Joi.required(),
      otherwise: Joi.string().default("password"),
    }),
  DB_NAME: Joi.string().min(1).default("linear_clone"),
  DB_LOGGING: Joi.boolean().truthy("true").falsy("false").default(false),
  DB_SLOW_QUERY_MS: Joi.number().integer().min(1).default(200),

  // Logging
  LOG_LEVEL: Joi.string()
    .valid("trace", "debug", "info", "warn", "error", "fatal", "silent")
    .default("info"),

  // JWT
  JWT_SECRET: Joi.string()
    .min(32)
    .when("NODE_ENV", {
      is: "production",
      then: Joi.required(),
      otherwise: Joi.string().default("dev-only-do-not-use-in-prod-must-be-32-chars"),
    }),
  JWT_EXPIRES_IN: Joi.string().default("1h"),

  // Schema sync — only in non-prod, opt-in via env
  // Default in non-prod is "safe": create missing tables on first boot but
  // never alter or drop them. Production stays "false" — DDL is owned by
  // checked-in migrations (`pnpm migrate:run`).
  ORM_SYNC: Joi.string()
    .valid("true", "false", "safe", "dry-run")
    .when("NODE_ENV", {
      is: "production",
      then: Joi.string().valid("false").default("false"),
      otherwise: Joi.string().default("safe"),
    }),

  // Dev-only token mint
  AUTH_ALLOW_DEV_TOKEN: Joi.boolean()
    .truthy("true")
    .falsy("false")
    .default(false),

  // CORS
  CORS_ORIGINS: Joi.string().allow("").default(""),

  // Throttling
  THROTTLE_TTL_MS: Joi.number().integer().min(100).default(60_000),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(120),
});
