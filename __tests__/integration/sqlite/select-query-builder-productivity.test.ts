/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The query builder's productivity methods executed against SQLite, with
 * hydrated results: entity scopes, IN / EXISTS subqueries (plain and
 * correlated), OR groups, take(), getOneOrFail(), and relation existence.
 * The unit suite compares the SQL these build; this checks the rows.
 */
import "reflect-metadata";
import { createTestConnection, type TestConnectionResult } from "../helpers/test-connection";
import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, OneToMany } from "../../../src";
import { EntityNotFoundError } from "../../../src/errors";
import { sql } from "../../../src/utils/sqlTag";

describe("[Integration] SQLite: SelectQueryBuilder productivity methods", () => {
  let conn: TestConnectionResult;
  let Author: any;
  let Book: any;

  beforeAll(async () => {
    conn = await createTestConnection(
      { type: "sqlite", database: ":memory:", synchronize: true, logging: false } as any,
      () => {
        @Entity({ name: "sqbp_author" })
        class SqbpAuthor {
          static scopes = {
            verified: (qb: any) => qb.where("verified", true),
          };

          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "varchar", length: 40 }) name!: string;
          @Column({ type: "varchar", length: 20 }) role!: string;
          @Column({ type: "boolean" }) verified!: boolean;
          @OneToMany(() => SqbpBook, { mappedBy: "author" }) books!: any[];
        }

        @Entity({ name: "sqbp_book" })
        class SqbpBook {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "varchar", length: 40 }) title!: string;
          @Column({ type: "int" }) price!: number;
          @Column({ type: "int" }) authorId!: number;
          @ManyToOne(() => SqbpAuthor, (a: any) => a.books, { joinColumn: "authorId" })
          author!: any;
        }

        Author = SqbpAuthor;
        Book = SqbpBook;
        return { entities: [SqbpAuthor, SqbpBook] };
      },
    );

    const em = conn.em as any;
    const ann = await em.save(Author, { name: "ann", role: "admin", verified: true });
    const bob = await em.save(Author, { name: "bob", role: "writer", verified: false });
    const cid = await em.save(Author, { name: "cid", role: "admin", verified: false });
    await em.save(Author, { name: "dee", role: "writer", verified: true });
    await em.save(Book, { title: "a1", price: 120, authorId: ann.id });
    await em.save(Book, { title: "a2", price: 30, authorId: ann.id });
    await em.save(Book, { title: "b1", price: 50, authorId: bob.id });
    await em.save(Book, { title: "c1", price: 200, authorId: cid.id });
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  const authors = () => conn.em.createQueryBuilder(Author, "a");
  const books = () => conn.em.createQueryBuilder(Book, "b");
  const names = (rows: any[]) => rows.map((r) => r.name).sort();

  it("applyScope() runs the entity's named scope", async () => {
    expect(names(await authors().applyScope("verified").getMany())).toEqual(["ann", "dee"]);
  });

  it("applyScope() rejects a scope the entity does not declare", () => {
    expect(() => authors().applyScope("missing")).toThrow(/Scope "missing" not found/);
  });

  it("whereInSubquery() keeps the rows whose column is in the subquery", async () => {
    const expensiveAuthors = books().select(["authorId"] as any).where("price", ">", 100);
    const rows = await authors().whereInSubquery("id", expensiveAuthors).getMany();
    expect(names(rows)).toEqual(["ann", "cid"]);
  });

  it("whereExistsSubquery() / whereNotExistsSubquery() correlate through the outer reference", async () => {
    const cheapBookOf = (outer: (ref: string) => any) =>
      books()
        .select(["id"] as any)
        .where("price", "<", 60)
        .where(sql`"b"."authorId" = ${outer("id")}`);

    const withCheap = await authors().whereExistsSubquery(cheapBookOf).getMany();
    expect(names(withCheap)).toEqual(["ann", "bob"]);

    const withoutCheap = await authors().whereNotExistsSubquery(cheapBookOf).getMany();
    expect(names(withoutCheap)).toEqual(["cid", "dee"]);
  });

  it("orWhereGroup() parenthesizes its conditions", async () => {
    const rows = await authors()
      .where("role", "writer")
      .orWhereGroup((g) => g.where("role", "admin").where("verified", true))
      .getMany();
    expect(names(rows)).toEqual(["ann", "bob", "dee"]);
  });

  it("take() limits the rows", async () => {
    const rows = await authors().orderBy({ name: "ASC" }).take(2).getMany();
    expect(rows.map((r: any) => r.name)).toEqual(["ann", "bob"]);
  });

  it("getOneOrFail() returns the row, or throws EntityNotFoundError", async () => {
    expect(((await authors().where("name", "cid").getOneOrFail()) as any).role).toBe("admin");
    await expect(authors().where("name", "nobody").getOneOrFail()).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
  });

  it("whereHas() / whereNotHas() filter by related rows, with a condition on them", async () => {
    expect(names(await authors().whereHas("books").getMany())).toEqual(["ann", "bob", "cid"]);
    expect(names(await authors().whereNotHas("books").getMany())).toEqual(["dee"]);
    expect(
      names(await authors().whereHas("books", (q) => q.where("price", ">", 150)).getMany()),
    ).toEqual(["cid"]);
  });

  it("getManyAndCount() counts every match while take() pages them", async () => {
    const [rows, count] = await authors().where("role", "admin").orderBy({ name: "ASC" }).take(1).getManyAndCount();
    expect(rows.map((r: any) => r.name)).toEqual(["ann"]);
    expect(count).toBe(2);
  });
});
