import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { User } from "./user.entity";
import { EntityManager } from "stingerloom-orm";

@Injectable()
export class UsersService {
  constructor(
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  async create(tenantId: string, dto: CreateUserDto): Promise<User> {
    return this.em.withTenant(tenantId, async (em) => {
      const user = new User();
      user.username = dto.username;
      user.email = dto.email;
      if (dto.bio) user.bio = dto.bio;

      const result = await em.save(User, user);
      return Array.isArray(result) ? result[0] : result;
    });
  }

  async findAll(tenantId: string): Promise<User[]> {
    return this.em.withTenant(tenantId, async (em) => {
      const result = await em.find(User, {});
      if (!result) return [];
      return Array.isArray(result) ? result : [result];
    });
  }

  async findOne(tenantId: string, id: number): Promise<User> {
    return this.em.withTenant(tenantId, async (em) => {
      const result = await em.findOne(User, { where: { id } as any });
      if (!result) throw new NotFoundException(`User with ID ${id} not found`);
      return Array.isArray(result) ? result[0] : result;
    });
  }

  async update(tenantId: string, id: number, dto: UpdateUserDto): Promise<User> {
    return this.em.withTenant(tenantId, async (em) => {
      const result = await em.findOne(User, { where: { id } as any });
      if (!result) throw new NotFoundException(`User with ID ${id} not found`);
      const user = Array.isArray(result) ? result[0] : result;

      if (dto.username !== undefined) user.username = dto.username;
      if (dto.email !== undefined) user.email = dto.email;
      if (dto.bio !== undefined) user.bio = dto.bio;

      const saved = await em.save(User, user);
      return Array.isArray(saved) ? saved[0] : saved;
    });
  }

  async remove(tenantId: string, id: number): Promise<void> {
    await this.em.withTenant(tenantId, async (em) => {
      const result = await em.findOne(User, { where: { id } as any });
      if (!result) throw new NotFoundException(`User with ID ${id} not found`);
      await em.delete(User, { id } as any);
    });
  }
}
