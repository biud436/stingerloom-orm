/**
 * SQLite In-Memory: WriteBuffer identity-map keying for Single-Table
 * Inheritance.
 *
 * Regression for the audited identity-conflict bug: the identity key was built
 * from the class used for the LOOKUP (`resolveIdentity(queryClass, ...)`) but
 * from `instance.constructor` when STORING (`track()`). An STI polymorphic
 * query hydrates concrete subclass instances, so a root-class query looked up
 * "Root:id=N", missed, and tracked under "Child:id=N" — loading the same row a
 * second time missed again and threw `Identity conflict` on track().
 *
 * The fix keys SINGLE_TABLE / JOINED hierarchies by their ROOT class (the PK
 * space is shared across the hierarchy), preferring the instance's concrete
 * constructor to resolve the hierarchy. TABLE_PER_CLASS keeps concrete-class
 * keys (each table has its own PK sequence). A first-level-cache hit is
 * additionally guarded by `instanceof`, so a sibling-type PK lookup never
 * returns a cached instance of the wrong subtype.
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
} from "../../../src";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe("[Integration] SQLite: WriteBuffer STI identity-map keying", () => {
  let conn: TestConnectionResult;
  let Animal: any;
  let Dog: any;
  let Cat: any;
  let dogId: number;
  let catId: number;

  beforeAll(async () => {
    const tableName = shortName("sti_idm");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
        plugins: [bufferPlugin()],
      },
      () => {
        getScannerInstance(ColumnScanner).clear();

        @Entity({ name: tableName })
        @Inheritance({ strategy: "SINGLE_TABLE" })
        @DiscriminatorColumn({ name: "animal_type", type: "varchar", length: 50 })
        class AnimalEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() name!: string;
        }

        @Entity()
        @DiscriminatorValue("dog")
        class DogEntity extends AnimalEntity {
          @Column({ nullable: true }) breed!: string;
        }

        @Entity()
        @DiscriminatorValue("cat")
        class CatEntity extends AnimalEntity {
          @Column({ nullable: true }) whiskers!: number;
        }

        Animal = AnimalEntity;
        Dog = DogEntity;
        Cat = CatEntity;

        return { entities: [AnimalEntity, DogEntity, CatEntity] };
      },
    );

    const dog: any = await conn.em.save(Dog, { name: "rex", breed: "husky" });
    const cat: any = await conn.em.save(Cat, { name: "tom", whiskers: 12 });
    dogId = dog.id;
    catId = cat.id;
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  it("loads the same rows twice through the root class without an identity conflict", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    const first = await buf.find(Animal, {});
    expect(first.length).toBeGreaterThanOrEqual(2);

    // Audited bug: this second polymorphic load threw
    // "Identity conflict: another instance ... is already tracked".
    const second = await buf.find(Animal, {});
    expect(second.length).toBe(first.length);

    // Same row → same instance, across the two loads.
    for (const item of second as any[]) {
      const match = (first as any[]).find((f) => f.id === item.id);
      expect(item).toBe(match);
    }
  });

  it("resolves root-class and subclass lookups of the same row to one instance", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    const viaChild = await buf.findOne(Dog, { where: { id: dogId } as any });
    expect(viaChild).not.toBeNull();

    const viaRoot = await buf.findOne(Animal, { where: { id: dogId } as any });
    expect(viaRoot).toBe(viaChild);
  });

  it("does not serve a sibling-type PK lookup from the cached instance", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    const dog = await buf.findOne(Animal, { where: { id: dogId } as any });
    expect(dog).toBeInstanceOf(Dog);

    // Same PK, wrong subtype — must NOT return the cached Dog.
    const wrongType = await buf.findOne(Cat, { where: { id: dogId } as any });
    expect(wrongType).toBeNull();

    // The correct subtype lookup still works.
    const cat = await buf.findOne(Cat, { where: { id: catId } as any });
    expect(cat).toBeInstanceOf(Cat);
  });

  it("dirty-tracks the deduplicated STI instance exactly once", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    const viaRoot: any = await buf.findOne(Animal, { where: { id: dogId } as any });
    const viaChild: any = await buf.findOne(Dog, { where: { id: dogId } as any });
    expect(viaChild).toBe(viaRoot);

    viaRoot.name = "rex-updated";
    const result = await buf.flush();
    expect(result.updates).toBe(1);

    const reloaded: any = await conn.em.findOne(Dog, { where: { id: dogId } as any });
    expect(reloaded.name).toBe("rex-updated");
  });
});
