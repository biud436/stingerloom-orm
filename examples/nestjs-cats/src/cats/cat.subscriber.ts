import { EntitySubscriber, InsertEvent } from "@stingerloom/orm";
import { Cat } from "./cat.entity";

/**
 * CatSubscriber — EntitySubscriber 패턴 데모.
 *
 * EntityManager.addSubscriber()로 등록하면
 * Cat 엔티티에 대한 생명주기 이벤트를 구독할 수 있습니다.
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
