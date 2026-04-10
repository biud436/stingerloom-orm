export const DISCRIMINATOR_VALUE_TOKEN = Symbol.for("STG_DISCRIMINATOR_VALUE");

/**
 * Specifies the discriminator value for a child entity in an inheritance hierarchy.
 * If omitted, the class name is used as the default discriminator value.
 *
 * @example
 * @Entity()
 * @DiscriminatorValue("credit_card")
 * class CreditCardPayment extends Payment {
 *   @Column({ nullable: true }) cardNumber: string;
 * }
 */
export function DiscriminatorValue(value: string): ClassDecorator {
  return function (target) {
    Reflect.defineMetadata(DISCRIMINATOR_VALUE_TOKEN, value, target);
  };
}
