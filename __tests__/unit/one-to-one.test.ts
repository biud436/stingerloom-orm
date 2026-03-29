import "reflect-metadata";
import { getScannerInstance, resetScannerContainer } from "../../src/scanner/ScannerContainer";
import {
  OneToOne,
  ONE_TO_ONE_TOKEN,
  OneToOneMetadata,
} from "../../src/decorators/OneToOne";
import { OneToOneScanner } from "../../src/scanner/OneToOneScanner";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";

describe("@OneToOne decorator", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
  });

  it("should store metadata via Reflect.defineMetadata with ONE_TO_ONE_TOKEN", () => {
    class Profile {
      id!: number;
      bio!: string;
    }

    class User {
      @OneToOne(() => Profile, { joinColumn: "profile_id" })
      profile!: Profile;
    }

    const metadata: OneToOneMetadata<Profile>[] = Reflect.getMetadata(
      ONE_TO_ONE_TOKEN,
      User,
    );

    expect(metadata).toBeDefined();
    expect(metadata).toHaveLength(1);
    expect(metadata[0].target).toBe(User);
    expect(metadata[0].propertyKey).toBe("profile");
    expect(metadata[0].joinColumn).toBe("profile_id");
    expect(metadata[0].getRelatedEntity()).toBe(Profile);
  });

  it("should store metadata without joinColumn (inverse side)", () => {
    class User {
      id!: number;
    }

    class Profile {
      @OneToOne(() => User, { inverseSide: "profile" })
      user!: User;
    }

    const metadata: OneToOneMetadata<User>[] = Reflect.getMetadata(
      ONE_TO_ONE_TOKEN,
      Profile,
    );

    expect(metadata).toBeDefined();
    expect(metadata).toHaveLength(1);
    expect(metadata[0].target).toBe(Profile);
    expect(metadata[0].propertyKey).toBe("user");
    expect(metadata[0].joinColumn).toBeUndefined();
    expect(metadata[0].inverseSide).toBe("profile");
    expect(metadata[0].getRelatedEntity()).toBe(User);
  });

  it("should support multiple @OneToOne decorators on the same entity", () => {
    class Address {}
    class Profile {}

    class User {
      @OneToOne(() => Profile, { joinColumn: "profile_id" })
      profile!: Profile;

      @OneToOne(() => Address, { joinColumn: "address_id" })
      address!: Address;
    }

    const metadata: OneToOneMetadata<unknown>[] = Reflect.getMetadata(
      ONE_TO_ONE_TOKEN,
      User,
    );

    expect(metadata).toHaveLength(2);

    const profileMeta = metadata.find((m) => m.propertyKey === "profile");
    const addressMeta = metadata.find((m) => m.propertyKey === "address");

    expect(profileMeta).toBeDefined();
    expect(profileMeta!.getRelatedEntity()).toBe(Profile);
    expect(profileMeta!.joinColumn).toBe("profile_id");

    expect(addressMeta).toBeDefined();
    expect(addressMeta!.getRelatedEntity()).toBe(Address);
    expect(addressMeta!.joinColumn).toBe("address_id");
  });

  it("should set target to the constructor of the decorated class", () => {
    class Passport {}

    class Person {
      @OneToOne(() => Passport, { joinColumn: "passport_id" })
      passport!: Passport;
    }

    const metadata: OneToOneMetadata<Passport>[] = Reflect.getMetadata(
      ONE_TO_ONE_TOKEN,
      Person,
    );

    expect(metadata[0].target).toBe(Person);
  });

  it("should support eager option", () => {
    class Profile {}

    class User {
      @OneToOne(() => Profile, { joinColumn: "profile_id", eager: true })
      profile!: Profile;
    }

    const metadata: OneToOneMetadata<Profile>[] = Reflect.getMetadata(
      ONE_TO_ONE_TOKEN,
      User,
    );

    expect(metadata[0].option?.eager).toBe(true);
  });

  it("should support cascade option", () => {
    class Profile {}

    class User {
      @OneToOne(() => Profile, {
        joinColumn: "profile_id",
        cascade: ["insert", "update"],
      })
      profile!: Profile;
    }

    const metadata: OneToOneMetadata<Profile>[] = Reflect.getMetadata(
      ONE_TO_ONE_TOKEN,
      User,
    );

    expect(metadata[0].option?.cascade).toEqual(["insert", "update"]);
  });

  it("should work without any options", () => {
    class Profile {}

    class User {
      @OneToOne(() => Profile)
      profile!: Profile;
    }

    const metadata: OneToOneMetadata<Profile>[] = Reflect.getMetadata(
      ONE_TO_ONE_TOKEN,
      User,
    );

    expect(metadata).toBeDefined();
    expect(metadata).toHaveLength(1);
    expect(metadata[0].propertyKey).toBe("profile");
    expect(metadata[0].joinColumn).toBeUndefined();
    expect(metadata[0].inverseSide).toBeUndefined();
    expect(metadata[0].getRelatedEntity()).toBe(Profile);
  });
});

describe("OneToOneScanner", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
  });

  it("should register metadata in the scanner via the decorator", () => {
    class Profile {}

    class User {
      @OneToOne(() => Profile, { joinColumn: "profile_id" })
      profile!: Profile;
    }

    const scanner = getScannerInstance(OneToOneScanner);
    const results = scanner.scan(User);

    expect(results).toHaveLength(1);
    expect(results[0].target).toBe(User);
    expect(results[0].propertyKey).toBe("profile");
    expect(results[0].joinColumn).toBe("profile_id");
    expect(results[0].getRelatedEntity()).toBe(Profile);
  });

  it("should iterate over all OneToOne metadata via makeOneToOnes", () => {
    class Profile {}
    class Address {}

    class User {
      @OneToOne(() => Profile, { joinColumn: "profile_id" })
      profile!: Profile;

      @OneToOne(() => Address, { joinColumn: "address_id" })
      address!: Address;
    }

    const scanner = getScannerInstance(OneToOneScanner);
    const allMeta = [...scanner.makeOneToOnes()];

    expect(allMeta).toHaveLength(2);
    expect(allMeta.map((m) => m.propertyKey)).toContain("profile");
    expect(allMeta.map((m) => m.propertyKey)).toContain("address");
  });

  it("should return empty array when scanning entity with no @OneToOne", () => {
    class PlainEntity {}

    const scanner = getScannerInstance(OneToOneScanner);
    const results = scanner.scan(PlainEntity);

    expect(results).toHaveLength(0);
  });

  it("should use layered metadata store and support context switching", () => {
    const scanner = getScannerInstance(OneToOneScanner);

    // Register in public context
    scanner.switchContext("public");
    scanner.set("publicRelation", {
      target: class A {},
      propertyKey: "profile",
      getRelatedEntity: () => class B {},
      joinColumn: "profile_id",
    });

    // Register in tenant_1 context
    scanner.switchContext("tenant_1");
    scanner.set("tenantRelation", {
      target: class C {},
      propertyKey: "settings",
      getRelatedEntity: () => class D {},
      joinColumn: "settings_id",
    });

    // tenant_1 should see its own + public metadata
    const tenantMeta = scanner.allMetadata();
    expect(tenantMeta.length).toBeGreaterThanOrEqual(1);

    const tenantEntry = tenantMeta.find(
      (m: any) => m.propertyKey === "settings",
    );
    expect(tenantEntry).toBeDefined();

    // Switch back to public: should only see public metadata
    scanner.switchContext("public");
    const publicMeta = scanner.allMetadata();
    const publicEntry = publicMeta.find(
      (m: any) => m.propertyKey === "profile",
    );
    expect(publicEntry).toBeDefined();

    // tenant-only entry should not be in public context
    const tenantOnlyInPublic = publicMeta.find(
      (m: any) => m.propertyKey === "settings",
    );
    expect(tenantOnlyInPublic).toBeUndefined();
  });

  it("should scan multiple entities correctly", () => {
    class Profile {}
    class Settings {}

    class User {
      @OneToOne(() => Profile, { joinColumn: "profile_id" })
      profile!: Profile;
    }

    class Account {
      @OneToOne(() => Settings, { joinColumn: "settings_id" })
      settings!: Settings;
    }

    const scanner = getScannerInstance(OneToOneScanner);

    const userResults = scanner.scan(User);
    expect(userResults).toHaveLength(1);
    expect(userResults[0].propertyKey).toBe("profile");

    const accountResults = scanner.scan(Account);
    expect(accountResults).toHaveLength(1);
    expect(accountResults[0].propertyKey).toBe("settings");
  });
});

describe("@OneToOne bidirectional", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
  });

  it("should allow bidirectional OneToOne relationship setup", () => {
    class Profile {
      @OneToOne(() => User, { inverseSide: "profile" })
      user!: any;
    }

    class User {
      @OneToOne(() => Profile, { joinColumn: "profile_id" })
      profile!: Profile;
    }

    // Verify owner side (User)
    const userMeta: OneToOneMetadata<Profile>[] = Reflect.getMetadata(
      ONE_TO_ONE_TOKEN,
      User,
    );
    expect(userMeta).toHaveLength(1);
    expect(userMeta[0].propertyKey).toBe("profile");
    expect(userMeta[0].joinColumn).toBe("profile_id");
    expect(userMeta[0].getRelatedEntity()).toBe(Profile);

    // Verify inverse side (Profile)
    const profileMeta: OneToOneMetadata<any>[] = Reflect.getMetadata(
      ONE_TO_ONE_TOKEN,
      Profile,
    );
    expect(profileMeta).toHaveLength(1);
    expect(profileMeta[0].propertyKey).toBe("user");
    expect(profileMeta[0].inverseSide).toBe("profile");
    expect(profileMeta[0].joinColumn).toBeUndefined();
    expect(profileMeta[0].getRelatedEntity()).toBe(User);
  });

  it("should distinguish owning side from inverse side", () => {
    class Profile {
      @OneToOne(() => User, { inverseSide: "profile" })
      user!: any;
    }

    class User {
      @OneToOne(() => Profile, { joinColumn: "profile_id" })
      profile!: Profile;
    }

    const scanner = getScannerInstance(OneToOneScanner);

    const userRelations = scanner.scan(User);
    const profileRelations = scanner.scan(Profile);

    // User is the owning side (has joinColumn)
    expect(userRelations[0].joinColumn).toBe("profile_id");
    expect(userRelations[0].inverseSide).toBeUndefined();

    // Profile is the inverse side (has inverseSide, no joinColumn)
    expect(profileRelations[0].joinColumn).toBeUndefined();
    expect(profileRelations[0].inverseSide).toBe("profile");
  });
});
