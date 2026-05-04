import { Injectable, NotFoundException, ConflictException } from "@nestjs/common";
import { BaseRepository, Transactional } from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { User } from "./user.entity";
import { CreateUserDto, UpdateUserDto } from "./dto/user.dto";

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly repo: BaseRepository<User>,
  ) {}

  @Transactional()
  async create(dto: CreateUserDto): Promise<User> {
    const dup = await this.repo.findOne({ where: { email: dto.email } });
    if (dup) throw new ConflictException(`Email already registered: ${dto.email}`);

    const u = new User();
    u.email = dto.email;
    u.name = dto.name;
    if (dto.avatarUrl) u.avatarUrl = dto.avatarUrl;
    return this.repo.save(u);
  }

  findAll(): Promise<User[]> {
    return this.repo.find();
  }

  async findOne(id: number): Promise<User> {
    const u = await this.repo.findOne({ where: { id } });
    if (!u) throw new NotFoundException(`User ${id} not found`);
    return u;
  }

  @Transactional()
  async update(id: number, dto: UpdateUserDto): Promise<User> {
    const u = await this.findOne(id);
    if (dto.name !== undefined) u.name = dto.name;
    if (dto.avatarUrl !== undefined) u.avatarUrl = dto.avatarUrl;
    return this.repo.save(u);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.repo.delete({ id });
  }
}
