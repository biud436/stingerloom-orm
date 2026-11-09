/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";
import { EntityScanner } from "../../src/scanner/EntityScanner";
import { OneToManyScanner } from "../../src/scanner/OneToManyScanner";
import { MetadataContext } from "../../src/metadata/MetadataContext";

class Author {}
class Book {}

describe("scanner iteration inside a tenant context", () => {
  let entities: EntityScanner;
  let oneToManys: OneToManyScanner;

  beforeEach(() => {
    MetadataLayerRegistry.reset();
    entities = new EntityScanner();
    oneToManys = new OneToManyScanner();
    // Decorators record metadata on the public layer, whatever the context.
    entities.setOnPublic("author", { target: Author, name: "author", columns: [] });
    entities.setOnPublic("book", { target: Book, name: "book", columns: [] });
    oneToManys.setOnPublic("author.books", { target: Author, propertyKey: "books" });
  });

  afterEach(() => {
    MetadataContext.reset();
  });

  it("makeEntities() yields the public entities", async () => {
    const names = await MetadataContext.run("acme", () => [...entities.makeEntities()].map((e) => e.name));

    expect(names).toEqual(["author", "book"]);
  });

  it("scan() finds the public relations of a class", async () => {
    const found = await MetadataContext.run("acme", () => oneToManys.scan(Author));

    expect(found.map((r) => r.propertyKey)).toEqual(["books"]);
  });

  it("yields a tenant's own entry in place of the public one it overrides", async () => {
    await MetadataContext.run("acme", () =>
      entities.set("book", { target: Book, name: "acme_book", columns: [] }),
    );

    const acme = await MetadataContext.run("acme", () => [...entities.makeEntities()].map((e) => e.name));
    const other = await MetadataContext.run("globex", () => [...entities.makeEntities()].map((e) => e.name));

    expect(acme.sort()).toEqual(["acme_book", "author"]);
    expect(other).toEqual(["author", "book"]);
  });

  it("does not create a layer for a tenant it only reads", async () => {
    await MetadataContext.run("acme", () => [...entities.makeEntities()]);

    expect(MetadataLayerRegistry.getInstance().getLayer("acme")).toBeUndefined();
  });
});
