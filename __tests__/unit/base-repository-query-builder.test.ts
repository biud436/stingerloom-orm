import "reflect-metadata";
import { BaseRepository } from "../../src/core/BaseRepository";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import { EntityManager } from "../../src/core/EntityManager";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;
}

describe("BaseRepository.createQueryBuilder delegation", () => {
  it("should delegate to EntityManager.createQueryBuilder", () => {
    const em = new EntityManager();
    const spy = jest.spyOn(em, "createQueryBuilder");

    const repo = new BaseRepository(User, em);
    repo.createQueryBuilder("u");

    expect(spy).toHaveBeenCalledWith(User, "u");
    spy.mockRestore();
  });

  it("should return a SelectQueryBuilder instance", () => {
    const em = new EntityManager();
    const repo = new BaseRepository(User, em);
    const qb = repo.createQueryBuilder("u");
    expect(qb).toBeInstanceOf(SelectQueryBuilder);
  });
});
