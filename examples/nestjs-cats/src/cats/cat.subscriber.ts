import { EntitySubscriber, InsertEvent } from "@stingerloom/orm";
import { Cat } from "./cat.entity";

/**
 * CatSubscriber — EntitySubscriber pattern demo.
 *
 * When registered via EntityManager.addSubscriber(), it can subscribe
 * to lifecycle events for the Cat entity.
 */
export class CatSubscriber implements EntitySubscriber<Cat> {
  listenTo() {
    return Cat;
  }

  afterInsert(event: InsertEvent<Cat>): void {
    console.log(
      `[CatSubscriber] Cat inserted: ${JSON.stringify(event.entity)}`,
    );
  }
}
