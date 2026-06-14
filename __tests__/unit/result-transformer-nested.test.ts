/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { ResultTransformer } from "../../src/core/ResultTransformer";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../src/decorators/ManyToOne";
import { OneToOne } from "../../src/decorators/OneToOne";

// ─────────────────────────────────────────────────
// Test entities for #116 and #117
// ─────────────────────────────────────────────────

@Entity()
class Department116 {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  name!: string;
}

@Entity()
class Profile116 {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  bio!: string;

  @ManyToOne(() => Department116, (d) => d.id, { joinColumn: "department_id", eager: true })
  department!: Department116;
}

@Entity()
class User116 {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  name!: string;

  @OneToOne(() => Profile116, { joinColumn: "profile_id", eager: true })
  profile!: Profile116;
}

// ─────────────────────────────────────────────────
// #116: OneToOne eager loading with nested ManyToOne
// ─────────────────────────────────────────────────

describe("#116: OneToOne recursively processes nested ManyToOne", () => {
  it("should deserialize nested ManyToOne inside OneToOne eager", () => {
    const transformer = new ResultTransformer();

    const queryResult = {
      results: [
        {
          id: 1,
          name: "Alice",
          profile_id: 10,
          profile_bio: "Hello world",
          profile_department_id: 100,
          profile_department_name: "Engineering",
        },
      ],
    };

    const result = transformer.transformNested(User116, queryResult);
    expect(result).toBeDefined();

    const user = result as any;
    expect(user.id).toBe(1);
    expect(user.name).toBe("Alice");
    expect(user.profile).not.toBeNull();
    expect(user.profile.bio).toBe("Hello world");
    // The nested department should be populated
    expect(user.profile.department).not.toBeNull();
    expect(user.profile.department.name).toBe("Engineering");
  });
});

// ─────────────────────────────────────────────────
// #117: Deep NULL detection for nested relations
// ─────────────────────────────────────────────────

describe("#117: isDeepNull handles nested all-null objects", () => {
  it("should return null for LEFT JOINed entity with all NULL columns", () => {
    const transformer = new ResultTransformer();

    // Simulate a LEFT JOIN where user is NULL (all aliased columns are null)
    const queryResult = {
      results: [
        {
          id: 1,
          name: "Post Title",
          // All profile columns are NULL (LEFT JOIN returned no match)
          profile_id: null,
          profile_bio: null,
          // Nested department through profile is also all NULL
          profile_department_id: null,
          profile_department_name: null,
        },
      ],
    };

    const result = transformer.transformNested(User116, queryResult) as any;
    expect(result).toBeDefined();
    expect(result.id).toBe(1);
    // profile should be null because all its leaf values are null
    expect(result.profile).toBeNull();
  });

  it("should not return null when some nested values are non-null", () => {
    const transformer = new ResultTransformer();

    const queryResult = {
      results: [
        {
          id: 1,
          name: "Alice",
          profile_id: 10,
          profile_bio: "Some bio",
          // department is null
          profile_department_id: null,
          profile_department_name: null,
        },
      ],
    };

    const result = transformer.transformNested(User116, queryResult) as any;
    expect(result).toBeDefined();
    expect(result.profile).not.toBeNull();
    expect(result.profile.bio).toBe("Some bio");
    // Nested department should be null since all values are null
    expect(result.profile.department).toBeNull();
  });
});

// ─────────────────────────────────────────────────
// Eager-join path: root + nested read transforms and reverse-mapping
// ─────────────────────────────────────────────────

@Entity()
class OrgX {
  @PrimaryGeneratedColumn()
  id!: number;

  // DB column name differs from the property key → exercises reverse-mapping.
  @Column({ type: "varchar", length: 100, name: "org_name" })
  orgName!: string;

  @Column({ type: "boolean" })
  active!: boolean;
}

@Entity()
class MemberX {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "boolean" })
  verified!: boolean;

  @ManyToOne(() => OrgX, (o) => o.id, { joinColumn: "org_id", eager: true })
  org!: OrgX;
}

describe("transformNested applies read transforms + reverse-mapping (eager join)", () => {
  it("transforms the root boolean and the nested relation's boolean, and remaps its snake_case column", () => {
    const transformer = new ResultTransformer();

    // mysql2 / better-sqlite3 surface booleans as 0/1; the eager JOIN aliases
    // the related columns as `${relationProp}_${dbColumnName}`.
    const queryResult = {
      results: [
        {
          id: 1,
          verified: 0,
          org_id: 100,
          org_org_name: "Acme",
          org_active: 1,
        },
      ],
    };

    const result = transformer.transformNested(MemberX, queryResult) as any;

    // Root boolean coerced from 0 → false (was previously left as a raw 0).
    expect(typeof result.verified).toBe("boolean");
    expect(result.verified).toBe(false);

    // Nested relation: snake_case DB column reverse-mapped to the property key…
    expect(result.org).not.toBeNull();
    expect(result.org.orgName).toBe("Acme");
    expect((result.org as any).org_name).toBeUndefined();

    // …and its boolean transformed from 1 → true.
    expect(typeof result.org.active).toBe("boolean");
    expect(result.org.active).toBe(true);
  });
});
