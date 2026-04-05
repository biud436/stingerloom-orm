import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../src/decorators/ManyToOne";
import { OneToMany } from "../../src/decorators/OneToMany";
import { DeletedAt } from "../../src/decorators/DeletedAt";
import { Version } from "../../src/decorators/Version";
import { CreateTimestamp } from "../../src/decorators/CreateTimestamp";
import { UpdateTimestamp } from "../../src/decorators/UpdateTimestamp";

@Entity()
class Author {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;

  @OneToMany(() => Book, { mappedBy: "author" })
  books!: Book[];

  @Version()
  version!: number;

  @CreateTimestamp()
  createdAt!: Date;

  @UpdateTimestamp()
  updatedAt!: Date;

  @DeletedAt()
  deletedAt!: Date | null;
}

@Entity()
class Book {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  title!: string;

  @Column({ type: "boolean", nullable: true })
  published!: boolean;

  @ManyToOne(() => Author, (a) => a.books)
  author!: Author;
}

describe("Public Metadata API (#233)", () => {
  let em: EntityManager;

  beforeAll(() => {
    em = new EntityManager();
    // Manually set entities for testing (without DB connection)
    (em as any)._entities = [Author, Book];
  });

  describe("getRegisteredEntities()", () => {
    it("should return all registered entity classes", () => {
      const entities = em.getRegisteredEntities();
      expect(entities).toContain(Author);
      expect(entities).toContain(Book);
      expect(entities).toHaveLength(2);
    });

    it("should return a copy (not the internal array)", () => {
      const entities1 = em.getRegisteredEntities();
      const entities2 = em.getRegisteredEntities();
      expect(entities1).not.toBe(entities2);
      expect(entities1).toEqual(entities2);
    });
  });

  describe("getEntityMetadata()", () => {
    it("should return metadata for a registered entity", () => {
      const meta = em.getEntityMetadata(Author);
      expect(meta).not.toBeNull();
      // Entity decorator may lowercase the table name
      expect(meta!.tableName.toLowerCase()).toBe("author");
    });

    it("should include columns", () => {
      const meta = em.getEntityMetadata(Author);
      expect(meta!.columns.length).toBeGreaterThanOrEqual(1);
      const nameCol = meta!.columns.find((c) => c.propertyKey === "name");
      expect(nameCol).toBeDefined();
      expect(nameCol!.type).toBe("varchar");
    });

    it("should include relations", () => {
      const meta = em.getEntityMetadata(Author);
      const bookRel = meta!.relations.find((r) => r.propertyKey === "books");
      expect(bookRel).toBeDefined();
      expect(bookRel!.type).toBe("OneToMany");
    });

    it("should include special columns", () => {
      const meta = em.getEntityMetadata(Author);
      expect(meta!.deletedAtColumn).toBe("deletedAt");
      expect(meta!.versionColumn).toBe("version");
      expect(meta!.createTimestampColumn).toBe("createdAt");
      expect(meta!.updateTimestampColumn).toBe("updatedAt");
    });

    it("should return null for unknown entity", () => {
      class Unknown {}
      const meta = em.getEntityMetadata(Unknown);
      expect(meta).toBeNull();
    });
  });

  describe("getColumnMetadata()", () => {
    it("should return column metadata for an entity", () => {
      const columns = em.getColumnMetadata(Book);
      expect(columns.length).toBeGreaterThanOrEqual(2);

      const titleCol = columns.find((c) => c.propertyKey === "title");
      expect(titleCol).toBeDefined();
      expect(titleCol!.type).toBe("varchar");
    });

    it("should include nullable info", () => {
      const columns = em.getColumnMetadata(Book);
      const published = columns.find((c) => c.propertyKey === "published");
      expect(published).toBeDefined();
      expect(published!.nullable).toBe(true);
    });

    it("should return empty array for unknown entity", () => {
      class Unknown {}
      const columns = em.getColumnMetadata(Unknown);
      expect(columns).toEqual([]);
    });
  });

  describe("getRelationMetadata()", () => {
    it("should return ManyToOne relations", () => {
      const relations = em.getRelationMetadata(Book);
      const authorRel = relations.find((r) => r.propertyKey === "author");
      expect(authorRel).toBeDefined();
      expect(authorRel!.type).toBe("ManyToOne");
    });

    it("should return OneToMany relations", () => {
      const relations = em.getRelationMetadata(Author);
      const booksRel = relations.find((r) => r.propertyKey === "books");
      expect(booksRel).toBeDefined();
      expect(booksRel!.type).toBe("OneToMany");
    });

    it("should return empty array for entity with no relations", () => {
      @Entity()
      class Standalone {
        @PrimaryGeneratedColumn()
        id!: number;
      }

      (em as any)._entities.push(Standalone);
      const relations = em.getRelationMetadata(Standalone);
      expect(relations).toEqual([]);
    });
  });
});
