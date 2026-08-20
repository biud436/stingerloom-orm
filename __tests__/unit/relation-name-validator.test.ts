/**
 * Unit coverage for the read-path `relations` guard (V4-T2-3).
 *
 * The SQLite integration suite pins the end-to-end behavior; these cases pin
 * the pieces that are awkward to reach through a live query — an entity with
 * no relations at all, and a relation whose lazy target thunk yields nothing
 * (the ESM circular-import shape both loaders used to skip in silence).
 */
import "reflect-metadata";
import {
  collectRelationNames,
  validateRelationNames,
} from "../../src/core/RelationNameValidator";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";

class Post {}
class Author {}

interface StubShape {
  manyToOne?: Array<Record<string, unknown>>;
  oneToMany?: Array<Record<string, unknown>>;
  manyToMany?: Array<Record<string, unknown>>;
  oneToOne?: Array<Record<string, unknown>>;
}

function stubResolver(shape: StubShape): RelationMetadataResolver {
  return {
    resolveManyToOneMetadata: () => shape.manyToOne ?? [],
    resolveOneToManyMetadata: () => shape.oneToMany ?? [],
    resolveManyToManyMetadata: () => shape.manyToMany ?? [],
    resolveOneToOneMetadata: () => shape.oneToOne ?? [],
  } as unknown as RelationMetadataResolver;
}

const fullShape: StubShape = {
  manyToOne: [{ columnName: "author", getMappingEntity: () => Author }],
  oneToMany: [{ propertyKey: "comments", getRelatedEntity: () => Author }],
  manyToMany: [{ propertyKey: "tags", getRelatedEntity: () => Author }],
  oneToOne: [{ propertyKey: "meta", getRelatedEntity: () => Author }],
};

describe("collectRelationNames", () => {
  it("keys ManyToOne by columnName and every other kind by propertyKey", () => {
    const index = collectRelationNames(Post as never, stubResolver(fullShape));

    expect(index.manyToOne).toEqual(["author"]);
    expect(index.oneToMany).toEqual(["comments"]);
    expect(index.manyToMany).toEqual(["tags"]);
    expect(index.oneToOne).toEqual(["meta"]);
    expect([...index.all].sort()).toEqual(["author", "comments", "meta", "tags"]);
  });
});

describe("validateRelationNames", () => {
  it("passes every declared relation name through", () => {
    expect(() =>
      validateRelationNames(
        Post as never,
        ["author", "comments", "tags", "meta"],
        stubResolver(fullShape),
      ),
    ).not.toThrow();
  });

  it("skips the work when relations is absent or empty", () => {
    const resolver = stubResolver(fullShape);
    const spy = jest.spyOn(resolver, "resolveManyToOneMetadata");

    validateRelationNames(Post as never, undefined, resolver);
    validateRelationNames(Post as never, [], resolver);

    expect(spy).not.toHaveBeenCalled();
  });

  it("says so when the entity declares no relations at all", () => {
    let caught: InvalidQueryError | undefined;
    try {
      validateRelationNames(Post as never, ["author"], stubResolver({}));
    } catch (error) {
      caught = error as InvalidQueryError;
    }

    expect(caught).toBeInstanceOf(InvalidQueryError);
    expect(caught!.message).toContain("Available relations: none");
    expect(caught!.message).not.toContain("Did you mean");
  });

  it("reports a target thunk that yields nothing as a circular import", () => {
    let caught: InvalidQueryError | undefined;
    try {
      validateRelationNames(
        Post as never,
        ["author"],
        stubResolver({
          manyToOne: [{ columnName: "author", getMappingEntity: () => undefined }],
        }),
      );
    } catch (error) {
      caught = error as InvalidQueryError;
    }

    expect(caught).toBeInstanceOf(InvalidQueryError);
    expect(caught!.message).toContain('Relation "author" on entity "Post"');
    expect(caught!.message).toContain("@ManyToOne target thunk returned no entity class");
    expect(caught!.suggestion).toContain("circular import");
  });

  it("wraps a throwing target thunk (ESM temporal dead zone)", () => {
    let caught: InvalidQueryError | undefined;
    try {
      validateRelationNames(
        Post as never,
        ["tags"],
        stubResolver({
          manyToMany: [
            {
              propertyKey: "tags",
              getRelatedEntity: () => {
                throw new ReferenceError("Cannot access 'Tag' before initialization");
              },
            },
          ],
        }),
      );
    } catch (error) {
      caught = error as InvalidQueryError;
    }

    expect(caught).toBeInstanceOf(InvalidQueryError);
    expect(caught!.message).toContain("could not resolve its target entity");
    expect(caught!.message).toContain("Cannot access 'Tag' before initialization");
  });

  it("does not touch target thunks of relations the caller did not request", () => {
    const exploding = jest.fn(() => undefined);

    expect(() =>
      validateRelationNames(
        Post as never,
        ["author"],
        stubResolver({
          manyToOne: [{ columnName: "author", getMappingEntity: () => Author }],
          manyToMany: [{ propertyKey: "tags", getRelatedEntity: exploding }],
        }),
      ),
    ).not.toThrow();
    expect(exploding).not.toHaveBeenCalled();
  });
});
