/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Type } from "./types";
import { ENTITY_TOKEN } from "../decorators/Entity";
import { ENTITY_METADATA_TOKEN } from "../decorators/InjectEntityManager";

/**
 * Utility class for managing reflection metadata
 * Simplified version focused on ORM needs
 */
export class ReflectManager {
  /**
   * Get type metadata
   */
  public static getType<T = Type>(target: object): T | undefined;
  public static getType<T = Type>(
    target: object,
    key?: string | symbol | undefined,
  ): T | undefined;
  public static getType<T = Type>(
    target: object,
    key?: string | symbol | undefined,
  ): T | undefined {
    if (key) return Reflect.getMetadata("design:type", target, key);
    return Reflect.getMetadata("design:type", target);
  }

  /**
   * Get parameter types
   */
  public static getParamTypes(target: object): Type[] | undefined;
  public static getParamTypes(
    target: object,
    key: string | symbol | undefined,
  ): Type[] | undefined;
  public static getParamTypes(
    target: object,
    key?: string | symbol | undefined,
  ) {
    if (key) return Reflect.getMetadata("design:paramtypes", target, key);
    return Reflect.getMetadata("design:paramtypes", target);
  }

  /**
   * Get return type
   */
  public static getReturnType(target: object): Type | undefined;
  public static getReturnType(
    target: object,
    key?: string | symbol | undefined,
  ) {
    if (key) return Reflect.getMetadata("design:returntype", target, key);
    return Reflect.getMetadata("design:returntype", target);
  }

  /**
   * Check if target is an entity
   */
  public static isEntity(target: object): boolean {
    if (!Object.getPrototypeOf(target)) {
      return false;
    }
    return Reflect.getMetadata(ENTITY_TOKEN, target) !== undefined;
  }

  /**
   * Check if target is an entity manager
   */
  public static isEntityManager(target: any): boolean {
    return Reflect.getMetadata(ENTITY_METADATA_TOKEN, target) !== undefined;
  }
}
