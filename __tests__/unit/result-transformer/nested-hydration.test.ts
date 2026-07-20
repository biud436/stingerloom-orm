/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Expose } from "class-transformer";
import {
  Column,
  Entity,
  ManyToOne,
  OneToOne,
  PrimaryColumn,
} from "../../../src/decorators";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { ResultTransformerFactory } from "../../../src/core/ResultTransformerFactory";
import type { QueryResult } from "../../../src/types";

/**
 * Regression suite — nested relation hydration.
 *
 * `transformNested` walks ManyToOne / OneToOne chains and builds nested
 * entity objects from a single flat row of join columns. These tests pin:
 *
 *   - null-relation detection (LEFT JOIN with no match → null, not an empty entity)
 *   - prefix isolation between sibling relations (`address_*` vs `order_*`)
 *   - self-referencing cycles terminate cleanly
 *   - nested ManyToOne under OneToOne (issue #116)
 */

const rt = ResultTransformerFactory.create();

describe("ResultTransformer / nested hydration regression", () => {
  describe("null relation — LEFT JOIN miss yields null, not an empty entity", () => {
    @Entity()
    class Author {
      @Expose()
      @PrimaryColumn({ type: "int", name: "id" })
      id!: number;

      @Expose()
      @Column({ type: "varchar", name: "name" })
      name!: string;
    }

    @Entity()
    class Post {
      @Expose()
      @PrimaryColumn({ type: "int", name: "id" })
      id!: number;

      @Expose()
      @ManyToOne(() => Author, undefined as any)
      author?: Author | null;
    }

    it("returns post.author === null when every joined column is null", () => {
      const result: QueryResult = {
        results: [
          { id: 7, author_id: null, author_name: null },
        ],
      };
      const post = rt.transformNested(Post, result) as Post;
      expect(post).toBeInstanceOf(Post);
      expect(post.id).toBe(7);
      // isDeepNull short-circuits the relation when every leaf is null/undefined.
      // Returning an empty Author instance instead would leak null FK rows as
      // "phantom" related entities.
      expect(post.author).toBeNull();
    });

    it("hydrates the nested entity when the JOIN matched", () => {
      const result: QueryResult = {
        results: [
          { id: 7, author_id: 1, author_name: "Alice" },
        ],
      };
      const post = rt.transformNested(Post, result) as Post;
      expect(post.author).toBeInstanceOf(Author);
      expect(post.author?.id).toBe(1);
      expect(post.author?.name).toBe("Alice");
    });
  });

  describe("multiple sibling ManyToOne relations — prefixes do not bleed", () => {
    /**
     * A row carries `address_*` and `order_*` join columns side by side.
     * Each ManyToOne hydration must consume only its own prefix and must
     * not include the other relation's columns when checking `isDeepNull`.
     */
    @Entity()
    class Address {
      @Expose()
      @PrimaryColumn({ type: "int", name: "id" })
      id!: number;

      @Expose()
      @Column({ type: "varchar", name: "city" })
      city!: string;
    }

    @Entity()
    class Order {
      @Expose()
      @PrimaryColumn({ type: "int", name: "id" })
      id!: number;

      @Expose()
      @Column({ type: "int", name: "total" })
      total!: number;
    }

    @Entity()
    class Customer {
      @Expose()
      @PrimaryColumn({ type: "int", name: "id" })
      id!: number;

      @Expose()
      @ManyToOne(() => Address, undefined as any)
      address?: Address | null;

      @Expose()
      @ManyToOne(() => Order, undefined as any)
      order?: Order | null;
    }

    it("populates both relations when both JOINs matched", () => {
      const result: QueryResult = {
        results: [
          {
            id: 1,
            address_id: 11,
            address_city: "Seoul",
            order_id: 22,
            order_total: 100,
          },
        ],
      };
      const c = rt.transformNested(Customer, result) as Customer;
      expect(c.address).toBeInstanceOf(Address);
      expect(c.address?.city).toBe("Seoul");
      expect(c.order).toBeInstanceOf(Order);
      expect(c.order?.total).toBe(100);
    });

    it("hydrates one relation and nulls the other independently", () => {
      const result: QueryResult = {
        results: [
          {
            id: 1,
            address_id: 11,
            address_city: "Seoul",
            order_id: null,
            order_total: null,
          },
        ],
      };
      const c = rt.transformNested(Customer, result) as Customer;
      expect(c.address?.city).toBe("Seoul");
      // The order_* prefix is independently all-null → relation is null.
      expect(c.order).toBeNull();
    });

    it("both relations null when both JOINs missed", () => {
      const result: QueryResult = {
        results: [
          {
            id: 1,
            address_id: null,
            address_city: null,
            order_id: null,
            order_total: null,
          },
        ],
      };
      const c = rt.transformNested(Customer, result) as Customer;
      expect(c.address).toBeNull();
      expect(c.order).toBeNull();
    });
  });

  describe("nested ManyToOne under OneToOne (issue #116)", () => {
    /**
     * `user.profile.country` — OneToOne to Profile, Profile has a ManyToOne
     * to Country. The recursive descent under OneToOne must use the
     * already-stripped foreignObject as its resultSet so the inner
     * `country_*` prefix matching still finds its columns.
     */
    @Entity()
    class Country {
      @Expose()
      @PrimaryColumn({ type: "int", name: "id" })
      id!: number;

      @Expose()
      @Column({ type: "varchar", name: "code" })
      code!: string;
    }

    @Entity()
    class Profile {
      @Expose()
      @PrimaryColumn({ type: "int", name: "id" })
      id!: number;

      @Expose()
      @Column({ type: "varchar", name: "bio" })
      bio!: string;

      @Expose()
      @ManyToOne(() => Country, undefined as any)
      country?: Country | null;
    }

    @Entity()
    class Person {
      @Expose()
      @PrimaryColumn({ type: "int", name: "id" })
      id!: number;

      @Expose()
      @OneToOne(() => Profile, { joinColumn: "profile_id" })
      @RelationColumn({ name: "profile_id" })
      profile?: Profile | null;
    }

    it("walks ManyToOne nested under OneToOne and hydrates the leaf entity", () => {
      const result: QueryResult = {
        results: [
          {
            id: 5,
            profile_id: 10,
            profile_bio: "hello",
            profile_country_id: 99,
            profile_country_code: "KR",
          },
        ],
      };
      const person = rt.transformNested(Person, result) as Person;
      expect(person.profile).toBeInstanceOf(Profile);
      expect(person.profile?.bio).toBe("hello");
      // Inner ManyToOne hydrated via the stripped foreignObject pass.
      expect(person.profile?.country).toBeInstanceOf(Country);
      expect(person.profile?.country?.code).toBe("KR");
    });

    it("nulls a OneToOne miss without recursing into its inner relations", () => {
      const result: QueryResult = {
        results: [
          {
            id: 5,
            profile_id: null,
            profile_bio: null,
            profile_country_id: null,
            profile_country_code: null,
          },
        ],
      };
      const person = rt.transformNested(Person, result) as Person;
      expect(person.profile).toBeNull();
    });
  });

  describe("self-referencing relation — cycle termination", () => {
    /**
     * `Issue.parent → Issue`. The `visited` set must prevent infinite
     * descent. The relation is still attached; only its nested fan-out
     * stops at the cycle boundary.
     */
    @Entity()
    class Issue {
      @Expose()
      @PrimaryColumn({ type: "int", name: "id" })
      id!: number;

      @Expose()
      @Column({ type: "varchar", name: "title" })
      title!: string;

      @Expose()
      @ManyToOne(() => Issue, undefined as any)
      parent?: Issue | null;
    }

    it("hydrates one level deep on a self-referencing FK and stops", () => {
      const result: QueryResult = {
        results: [
          {
            id: 2,
            title: "child",
            parent_id: 1,
            parent_title: "root",
          },
        ],
      };
      const issue = rt.transformNested(Issue, result) as Issue;
      expect(issue).toBeInstanceOf(Issue);
      expect(issue.title).toBe("child");
      expect(issue.parent).toBeInstanceOf(Issue);
      expect(issue.parent?.title).toBe("root");
      // The cycle guard means the inner `parent.parent` is not attempted —
      // the visited set carries `Issue` and skips the recursion.
      expect(issue.parent?.parent).toBeUndefined();
    });

    it("nulls the self-referencing relation when the JOIN missed", () => {
      const result: QueryResult = {
        results: [
          {
            id: 1,
            title: "root",
            parent_id: null,
            parent_title: null,
          },
        ],
      };
      const issue = rt.transformNested(Issue, result) as Issue;
      expect(issue.title).toBe("root");
      expect(issue.parent).toBeNull();
    });
  });
});
