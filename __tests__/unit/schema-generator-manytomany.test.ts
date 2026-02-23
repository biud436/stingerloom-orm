/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { SchemaGenerator } from "../../src/core/SchemaGenerator";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ManyToMany } from "../../src/decorators/ManyToMany";

// ─────────────────────────────────────────────────
// Test entities
// ─────────────────────────────────────────────────

@Entity()
class Tag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  name!: string;

  @ManyToMany(() => Post, { mappedBy: "tags" })
  posts!: Post[];
}

@Entity()
class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  title!: string;

  @ManyToMany(() => Tag, {
    joinTable: {
      name: "post_tags",
      joinColumn: "post_id",
      inverseJoinColumn: "tag_id",
    },
  })
  tags!: Tag[];
}

@Entity()
class Student {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  name!: string;

  @ManyToMany(() => Course, {
    joinTable: {
      name: "student_courses",
      joinColumn: "student_id",
      inverseJoinColumn: "course_id",
    },
  })
  courses!: Course[];
}

@Entity()
class Course {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 200 })
  title!: string;

  @ManyToMany(() => Student, { mappedBy: "courses" })
  students!: Student[];
}

// Entity without ManyToMany
@Entity()
class SimpleEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  name!: string;
}

// ─────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────

describe("SchemaGenerator - ManyToMany Join Table DDL", () => {
  describe("MySQL dialect", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });

    it("소유측(joinTable)에서 중간 테이블 CREATE TABLE DDL을 생성해야 함", () => {
      const ddls = gen.generateManyToManyJoinTableDDL([Post, Tag]);
      expect(ddls.length).toBe(1);
      expect(ddls[0]).toContain("CREATE TABLE IF NOT EXISTS");
      expect(ddls[0]).toContain("`post_tags`");
      expect(ddls[0]).toContain("`post_id` INT NOT NULL");
      expect(ddls[0]).toContain("`tag_id` INT NOT NULL");
      expect(ddls[0]).toContain("PRIMARY KEY (`post_id`, `tag_id`)");
      expect(ddls[0]).toContain("ENGINE=InnoDB");
    });

    it("역방향(mappedBy)은 중간 테이블 DDL을 생성하지 않아야 함", () => {
      const ddls = gen.generateManyToManyJoinTableDDL([Tag]);
      expect(ddls.length).toBe(0);
    });

    it("중복 joinTable 이름은 한 번만 생성해야 함", () => {
      // Post와 Tag 둘 다 전달하지만, Post만 joinTable이 있으므로 1개만 생성
      const ddls = gen.generateManyToManyJoinTableDDL([Post, Tag]);
      expect(ddls.length).toBe(1);
    });

    it("여러 ManyToMany 관계의 중간 테이블을 모두 생성해야 함", () => {
      const ddls = gen.generateManyToManyJoinTableDDL([
        Post,
        Tag,
        Student,
        Course,
      ]);
      expect(ddls.length).toBe(2);

      const tableNames = ddls.join("\n");
      expect(tableNames).toContain("`post_tags`");
      expect(tableNames).toContain("`student_courses`");
    });

    it("ManyToMany 없는 엔티티에서는 빈 배열을 반환해야 함", () => {
      const ddls = gen.generateManyToManyJoinTableDDL([SimpleEntity]);
      expect(ddls).toEqual([]);
    });

    it("빈 엔티티 배열에서는 빈 배열을 반환해야 함", () => {
      const ddls = gen.generateManyToManyJoinTableDDL([]);
      expect(ddls).toEqual([]);
    });

    it("중간 테이블 FK DDL을 생성해야 함", () => {
      const fkDdls = gen.generateManyToManyForeignKeyDDL([Post, Tag]);
      expect(fkDdls.length).toBe(2);

      // post_id → post 테이블
      const postFk = fkDdls.find((d) => d.includes("`post_id`"));
      expect(postFk).toBeDefined();
      expect(postFk).toContain("FOREIGN KEY");
      expect(postFk).toContain("REFERENCES");
      expect(postFk).toContain("ON DELETE CASCADE");

      // tag_id → tag 테이블
      const tagFk = fkDdls.find((d) => d.includes("`tag_id`"));
      expect(tagFk).toBeDefined();
      expect(tagFk).toContain("FOREIGN KEY");
      expect(tagFk).toContain("REFERENCES");
    });

    it("역방향만 있는 엔티티에서는 FK DDL이 빈 배열이어야 함", () => {
      const fkDdls = gen.generateManyToManyForeignKeyDDL([Tag]);
      expect(fkDdls).toEqual([]);
    });

    it("중간 테이블 DROP DDL을 생성해야 함", () => {
      const ddls = gen.generateManyToManyDropDDL([Post, Tag]);
      expect(ddls.length).toBe(1);
      expect(ddls[0]).toContain("DROP TABLE IF EXISTS");
      expect(ddls[0]).toContain("`post_tags`");
    });
  });

  describe("PostgreSQL dialect", () => {
    const gen = new SchemaGenerator({
      dialect: "postgres",
      schema: "myschema",
    });

    it("소유측(joinTable)에서 중간 테이블 CREATE TABLE DDL을 생성해야 함 (schema-qualified)", () => {
      const ddls = gen.generateManyToManyJoinTableDDL([Post, Tag]);
      expect(ddls.length).toBe(1);
      expect(ddls[0]).toContain("CREATE TABLE IF NOT EXISTS");
      expect(ddls[0]).toContain('"myschema"."post_tags"');
      expect(ddls[0]).toContain('"post_id" INT NOT NULL');
      expect(ddls[0]).toContain('"tag_id" INT NOT NULL');
      expect(ddls[0]).toContain('PRIMARY KEY ("post_id", "tag_id")');
      expect(ddls[0]).not.toContain("ENGINE=InnoDB");
    });

    it("큰따옴표로 식별자를 래핑해야 함", () => {
      const ddls = gen.generateManyToManyJoinTableDDL([Post]);
      expect(ddls[0]).toContain('"post_id"');
      expect(ddls[0]).toContain('"tag_id"');
    });

    it("기본 schema는 public이어야 함", () => {
      const genDefault = new SchemaGenerator({ dialect: "postgres" });
      const ddls = genDefault.generateManyToManyJoinTableDDL([Post]);
      expect(ddls[0]).toContain('"public"."post_tags"');
    });

    it("중간 테이블 FK DDL에서 schema-qualified 테이블 참조를 해야 함", () => {
      const fkDdls = gen.generateManyToManyForeignKeyDDL([Post, Tag]);
      expect(fkDdls.length).toBe(2);
      // schema-qualified 중간 테이블
      expect(fkDdls[0]).toContain('"myschema"."post_tags"');
      // schema-qualified 참조 테이블
      expect(fkDdls[0]).toContain('"myschema".');
    });

    it("역방향(mappedBy)은 중간 테이블 DDL을 생성하지 않아야 함", () => {
      const ddls = gen.generateManyToManyJoinTableDDL([Tag]);
      expect(ddls.length).toBe(0);
    });

    it("중간 테이블 DROP DDL을 생성해야 함 (schema-qualified)", () => {
      const ddls = gen.generateManyToManyDropDDL([Post, Tag]);
      expect(ddls.length).toBe(1);
      expect(ddls[0]).toContain("DROP TABLE IF EXISTS");
      expect(ddls[0]).toContain('"myschema"."post_tags"');
    });
  });

  describe("generateSchemaDDL() 통합", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });

    it("ManyToMany 중간 테이블 DDL이 generateSchemaDDL에 포함되어야 함", () => {
      const ddls = gen.generateSchemaDDL([Post, Tag]);

      // 중간 테이블 CREATE TABLE이 포함되어야 함
      const joinTableDdl = ddls.find((d) => d.includes("`post_tags`"));
      expect(joinTableDdl).toBeDefined();
      expect(joinTableDdl).toContain("CREATE TABLE IF NOT EXISTS");
    });

    it("ManyToMany FK DDL이 generateSchemaDDL에 포함되어야 함", () => {
      const ddls = gen.generateSchemaDDL([Post, Tag]);

      // 중간 테이블 FK가 포함되어야 함
      const fkDdls = ddls.filter(
        (d) => d.includes("post_tags") && d.startsWith("ALTER TABLE"),
      );
      expect(fkDdls.length).toBe(2);
    });

    it("중간 테이블 CREATE TABLE은 엔티티 CREATE TABLE 이후에 와야 함", () => {
      const ddls = gen.generateSchemaDDL([Post, Tag]);

      const entityCreateIdxs = ddls
        .map((d, i) =>
          d.startsWith("CREATE TABLE") && !d.includes("`post_tags`") ? i : -1,
        )
        .filter((i) => i >= 0);
      const joinTableIdx = ddls.findIndex(
        (d) => d.startsWith("CREATE TABLE") && d.includes("`post_tags`"),
      );

      expect(joinTableIdx).toBeGreaterThan(Math.max(...entityCreateIdxs));
    });
  });

  describe("generateDropSchemaDDL() 통합", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });

    it("중간 테이블 DROP이 엔티티 DROP 전에 와야 함 (FK 의존성)", () => {
      const ddls = gen.generateDropSchemaDDL([Post, Tag]);

      const joinTableDropIdx = ddls.findIndex((d) =>
        d.includes("`post_tags`"),
      );
      const entityDropIdxs = ddls
        .map((d, i) =>
          d.includes("DROP TABLE") && !d.includes("`post_tags`") ? i : -1,
        )
        .filter((i) => i >= 0);

      expect(joinTableDropIdx).toBeLessThan(Math.min(...entityDropIdxs));
    });

    it("ManyToMany 없는 엔티티에서도 정상 동작해야 함", () => {
      const ddls = gen.generateDropSchemaDDL([SimpleEntity]);
      expect(ddls.length).toBe(1);
      expect(ddls[0]).toContain("DROP TABLE IF EXISTS");
    });

    it("중간 테이블과 엔티티 테이블 모두 DROP DDL에 포함되어야 함", () => {
      const ddls = gen.generateDropSchemaDDL([Post, Tag]);
      // 중간 테이블 1개 + 엔티티 테이블 2개
      expect(ddls.length).toBe(3);
    });
  });
});
