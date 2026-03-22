import "reflect-metadata";
import { ClazzType } from "../utils";
import { VALIDATION_TOKEN, ValidationMetadata } from "../decorators/Validation";
import { ValidationError } from "../errors/ValidationError";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 엔티티 저장 전 유효성 검사를 수행합니다.
 */
export class EntityValidator {
  /**
   * 엔티티 클래스와 저장할 데이터를 받아 유효성 검사를 수행합니다.
   * 검사 실패 시 첫 번째 실패 항목에 대한 ValidationError를 throw합니다.
   */
  static validate<T>(entity: ClazzType<T>, item: Partial<T>): void {
    const validations: ValidationMetadata[] =
      Reflect.getMetadata(VALIDATION_TOKEN, entity) ?? [];

    for (const meta of validations) {
      const value = (item as any)[meta.propertyKey];

      switch (meta.constraint) {
        case "notNull":
          if (value === null || value === undefined) {
            throw new ValidationError(
              meta.propertyKey,
              "notNull",
              meta.message,
              value,
              "non-null value",
            );
          }
          break;

        case "minLength":
          if (typeof value === "string" && value.length < meta.value!) {
            throw new ValidationError(
              meta.propertyKey,
              "minLength",
              meta.message,
              value.length,
              meta.value,
            );
          }
          break;

        case "maxLength":
          if (typeof value === "string" && value.length > meta.value!) {
            throw new ValidationError(
              meta.propertyKey,
              "maxLength",
              meta.message,
              value.length,
              meta.value,
            );
          }
          break;

        case "min":
          if (typeof value === "number" && value < meta.value!) {
            throw new ValidationError(
              meta.propertyKey,
              "min",
              meta.message,
              value,
              meta.value,
            );
          }
          break;

        case "max":
          if (typeof value === "number" && value > meta.value!) {
            throw new ValidationError(
              meta.propertyKey,
              "max",
              meta.message,
              value,
              meta.value,
            );
          }
          break;
      }
    }
  }
}
