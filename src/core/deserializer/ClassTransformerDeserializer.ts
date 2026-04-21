/* eslint-disable @typescript-eslint/no-explicit-any */
import { DeserializeOptions } from "./DeserializeOptions";
import { Deserializer } from "./Deserializer";
import { MyClassConstructor } from "../MyClassConstructor";

/**
 * Deserializer implementation backed by class-transformer.
 *
 * class-transformer must be installed:
 * ```bash
 * npm install class-transformer
 * ```
 */
export class ClassTransformerDeserializer implements Deserializer {
  private _plainToClass: Function | undefined;

  private getPlainToClass(): Function {
    if (!this._plainToClass) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const ct = require("class-transformer");
        this._plainToClass = ct.plainToClass;
      } catch {
        throw new Error(
          "class-transformer is required for ClassTransformerDeserializer. " +
            "Install it with: npm install class-transformer",
        );
      }
    }
    return this._plainToClass!;
  }

  deserialize<T, V extends object>(
    cls: MyClassConstructor<T>,
    plain: V | V[],
    options?: DeserializeOptions,
  ): T {
    return this.getPlainToClass()(cls, plain, {
      excludeExtraneousValues: false,
      ...options,
    });
  }
}
