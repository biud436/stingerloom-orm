import "reflect-metadata";
import { BaseRepository } from "../../src/core/BaseRepository";
import { EntityManager } from "../../src/core/EntityManager";

class User {
  id!: number;
  name!: string;
}

/**
 * #230: BaseRepository.em/entity should be protected so that
 * subclasses can access them for custom repository patterns.
 */
class CustomUserRepository extends BaseRepository<User> {
  async findAdmins(): Promise<User[]> {
    // This should compile — em and entity are protected
    return this.em.find(this.entity, { where: { name: "admin" } as any });
  }

  getEntityClass() {
    return this.entity;
  }

  getEntityManager() {
    return this.em;
  }
}

describe("BaseRepository protected fields (#230)", () => {
  it("should allow subclass to access entity field", () => {
    const em = new EntityManager();
    const repo = new CustomUserRepository(User, em);
    expect(repo.getEntityClass()).toBe(User);
  });

  it("should allow subclass to access em field", () => {
    const em = new EntityManager();
    const repo = new CustomUserRepository(User, em);
    expect(repo.getEntityManager()).toBe(em);
  });
});
