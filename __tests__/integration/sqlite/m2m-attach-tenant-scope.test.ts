/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: `attachRelation()` / `detachRelation()` under
 * `tenantStrategy: "tenant_column"`.
 *
 * The join table has no tenant column, and both writes keyed the join table
 * on the caller's ids alone. Inside tenant acme a caller could link a row to
 * tenant globex's post and delete globex's existing links, which globex then
 * saw as an empty collection. Both writes now check the two ids against the
 * active tenant first.
 */
import "reflect-metadata";
import { Entity, Column, PrimaryGeneratedColumn, ManyToMany, NonTenantEntity } from "../../../src";
import { EntityManager } from "../../../src/core/EntityManager";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { EntityNotFoundError } from "../../../src/errors/EntityNotFoundError";

@Entity({ name: "mat_tag" })
class MatTag {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
  @ManyToMany(() => MatPost, { mappedBy: "tags" })
  posts!: MatPost[];
}

@Entity({ name: "mat_label" })
@NonTenantEntity()
class MatLabel {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

@Entity({ name: "mat_post" })
class MatPost {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
  @ManyToMany(() => MatTag, {
    joinTable: { name: "mat_post_tag", joinColumn: "post_id", inverseJoinColumn: "tag_id" },
  })
  tags!: MatTag[];
  @ManyToMany(() => MatLabel, {
    joinTable: { name: "mat_post_label", joinColumn: "post_id", inverseJoinColumn: "label_id" },
  })
  labels!: MatLabel[];
}

const acme = <R>(fn: () => Promise<R>) => MetadataContext.run("acme", fn);
const globex = <R>(fn: () => Promise<R>) => MetadataContext.run("globex", fn);

async function rejection(promise: unknown): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

describe("[Integration] SQLite: M2M attach/detach under tenant_column", () => {
  let em: EntityManager;
  let globexPost: MatPost;
  let globexTag: MatTag;
  let acmePost: MatPost;
  let acmeTag: MatTag;

  beforeEach(async () => {
    MetadataContext.reset();
    em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [MatPost, MatTag, MatLabel],
        synchronize: true,
        logging: false,
        tenantStrategy: "tenant_column",
      } as any,
      `mat_${Math.random().toString(36).slice(2, 10)}`,
    );
    globexPost = await globex(() => em.save(MatPost, { title: "g" }));
    globexTag = await globex(() => em.save(MatTag, { name: "g" }));
    await globex(() => em.attachRelation(MatPost, globexPost.id, "tags", globexTag.id));
    acmePost = await acme(() => em.save(MatPost, { title: "a" }));
    acmeTag = await acme(() => em.save(MatTag, { name: "a" }));
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  async function pivot(): Promise<Array<{ post_id: number; tag_id: number }>> {
    const raw: any = await em.getDriver()!.executeRaw(
      `SELECT post_id, tag_id FROM "mat_post_tag" ORDER BY post_id, tag_id`,
    );
    return Array.isArray(raw) ? raw : (raw.results ?? raw.rows ?? []);
  }

  async function globexTags(): Promise<string[]> {
    const post: any = await globex(() =>
      em.findOne(MatPost, { where: { id: globexPost.id }, relations: ["tags"] } as any),
    );
    return post.tags.map((tag: MatTag) => tag.name);
  }

  it("rejects linking a row to another tenant's owner", async () => {
    const error = await rejection(
      acme(() => em.attachRelation(MatPost, globexPost.id, "tags", acmeTag.id)),
    );

    expect(error).toBeInstanceOf(EntityNotFoundError);
    expect(error.message).toContain('"MatPost"');
    expect(await pivot()).toEqual([{ post_id: globexPost.id, tag_id: globexTag.id }]);
  });

  it("rejects linking another tenant's row to an own owner", async () => {
    const error = await rejection(
      acme(() => em.attachRelation(MatPost, acmePost.id, "tags", globexTag.id)),
    );

    expect(error).toBeInstanceOf(EntityNotFoundError);
    expect(error.message).toContain('"MatTag"');
    expect(await pivot()).toHaveLength(1);
  });

  it("leaves another tenant's link in place on detach", async () => {
    const result = await acme(() =>
      em.detachRelation(MatPost, globexPost.id, "tags", globexTag.id),
    );

    expect(result).toEqual({ affected: 0 });
    expect(await globexTags()).toEqual(["g"]);
  });

  it("checks the ids from the inverse side too", async () => {
    const error = await rejection(
      acme(() => em.attachRelation(MatTag, acmeTag.id, "posts", globexPost.id)),
    );
    const detached = await acme(() =>
      em.detachRelation(MatTag, globexTag.id, "posts", globexPost.id),
    );

    expect(error).toBeInstanceOf(EntityNotFoundError);
    expect(detached).toEqual({ affected: 0 });
    expect(await globexTags()).toEqual(["g"]);
  });

  it("links and unlinks rows of the active tenant as before", async () => {
    const attached = await acme(() => em.attachRelation(MatPost, acmePost.id, "tags", acmeTag.id));
    const post: any = await acme(() =>
      em.findOne(MatPost, { where: { id: acmePost.id }, relations: ["tags"] } as any),
    );
    const detached = await acme(() => em.detachRelation(MatPost, acmePost.id, "tags", acmeTag.id));

    expect(attached).toEqual({ affected: 1 });
    expect(post.tags.map((tag: MatTag) => tag.name)).toEqual(["a"]);
    expect(detached).toEqual({ affected: 1 });
  });

  it("links a shared @NonTenantEntity row from any tenant", async () => {
    const label = await MetadataContext.runUnscoped(() => em.save(MatLabel, { name: "shared" }));

    const result = await acme(() => em.attachRelation(MatPost, acmePost.id, "labels", label.id));

    expect(result).toEqual({ affected: 1 });
  });

  it("links across tenants inside runUnscoped(), deliberately", async () => {
    const result = await MetadataContext.runUnscoped(() =>
      em.attachRelation(MatPost, globexPost.id, "tags", acmeTag.id),
    );

    expect(result).toEqual({ affected: 1 });
  });
});
