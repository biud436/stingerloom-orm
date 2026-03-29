/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { getScannerInstance, resetScannerContainer } from "../../src/scanner/ScannerContainer";
import {
  Entity,
  ENTITY_TOKEN,
  EntityMetadata,
  Column,
  ManyToOne,
  OneToMany,
  OneToOne,
  ManyToMany,
  PrimaryGeneratedColumn,
} from "../../src/decorators";

describe("EntityMetadata — relation metadata completeness (#51)", () => {
  beforeEach(() => {
    resetScannerContainer();
  });

  it("should include oneToManys in EntityMetadata", () => {
    @Entity()
    class Child {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: "int" })
      parentId!: number;

      @ManyToOne(() => Parent, (e: any) => e.parent, { joinColumn: "parent_id" })
      parent!: any;
    }

    @Entity()
    class Parent {
      @PrimaryGeneratedColumn()
      id!: number;

      @OneToMany(() => Child, { mappedBy: "parent" })
      children!: Child[];
    }

    const meta = Reflect.getMetadata(ENTITY_TOKEN, Parent) as EntityMetadata;
    expect(meta.oneToManys).toBeDefined();
    expect(meta.oneToManys!.length).toBe(1);
    expect(meta.oneToManys![0].propertyKey).toBe("children");
    expect(meta.oneToManys![0].mappedBy).toBe("parent");
  });

  it("should include oneToOnes in EntityMetadata", () => {
    @Entity()
    class Profile {
      @PrimaryGeneratedColumn()
      id!: number;

      @OneToOne(() => User51, { inverseSide: "profile" })
      user!: any;
    }

    @Entity()
    class User51 {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: "int" })
      profileId!: number;

      @OneToOne(() => Profile, { joinColumn: "profile_id" })
      profile!: Profile;
    }

    const meta = Reflect.getMetadata(ENTITY_TOKEN, User51) as EntityMetadata;
    expect(meta.oneToOnes).toBeDefined();
    expect(meta.oneToOnes!.length).toBe(1);
    expect(meta.oneToOnes![0].propertyKey).toBe("profile");
    expect(meta.oneToOnes![0].joinColumn).toBe("profile_id");
  });

  it("should include manyToManys in EntityMetadata", () => {
    @Entity()
    class Tag51 {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToMany(() => Post51, { mappedBy: "tags" })
      posts!: any[];
    }

    @Entity()
    class Post51 {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToMany(() => Tag51, {
        joinTable: {
          name: "post_tags",
          joinColumn: "post_id",
          inverseJoinColumn: "tag_id",
        },
      })
      tags!: Tag51[];
    }

    const meta = Reflect.getMetadata(ENTITY_TOKEN, Post51) as EntityMetadata;
    expect(meta.manyToManys).toBeDefined();
    expect(meta.manyToManys!.length).toBe(1);
    expect(meta.manyToManys![0].propertyKey).toBe("tags");
    expect(meta.manyToManys![0].joinTable?.name).toBe("post_tags");
  });

  it("should still include manyToOnes for backward compatibility", () => {
    @Entity()
    class Owner51 {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity()
    class Pet51 {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => Owner51, (e: any) => e.owner, { joinColumn: "owner_id" })
      owner!: Owner51;
    }

    const meta = Reflect.getMetadata(ENTITY_TOKEN, Pet51) as EntityMetadata;
    expect(meta.manyToOnes).toBeDefined();
    expect(meta.manyToOnes!.length).toBe(1);
    expect(meta.manyToOnes![0].columnName).toBe("owner");
  });

  it("should have empty arrays for entities with no relations", () => {
    @Entity()
    class Standalone51 {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: "varchar", length: 100 })
      name!: string;
    }

    const meta = Reflect.getMetadata(ENTITY_TOKEN, Standalone51) as EntityMetadata;
    expect(meta.oneToManys).toEqual([]);
    expect(meta.oneToOnes).toEqual([]);
    expect(meta.manyToManys).toEqual([]);
    expect(meta.manyToOnes).toEqual([]);
  });

  it("should not leak relations between different entities", () => {
    @Entity()
    class A51 {
      @PrimaryGeneratedColumn()
      id!: number;

      @OneToMany(() => B51, { mappedBy: "a" })
      bs!: any[];
    }

    @Entity()
    class B51 {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => A51, (e: any) => e.a, { joinColumn: "a_id" })
      a!: A51;
    }

    const metaA = Reflect.getMetadata(ENTITY_TOKEN, A51) as EntityMetadata;
    const metaB = Reflect.getMetadata(ENTITY_TOKEN, B51) as EntityMetadata;

    expect(metaA.oneToManys!.length).toBe(1);
    expect(metaA.manyToOnes).toEqual([]);
    expect(metaB.manyToOnes!.length).toBe(1);
    expect(metaB.oneToManys).toEqual([]);
  });
});
