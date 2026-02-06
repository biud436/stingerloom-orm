/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Generic class constructor type
 */
export type ClazzType<T = any> = { new (...args: any[]): T };

/**
 * Type for reflection metadata
 */
export type Type = Function | string | symbol | undefined;
