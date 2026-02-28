import { Injectable, NotFoundException } from "@nestjs/common";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { User } from "./user.entity";
import { BaseRepository, Transactional } from "@stingerloom/orm";
import { InjectRepository } from "src/stingerloom-orm/inject-repository.decorator";

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: BaseRepository<User>,
  ) {}

  @Transactional()
  async create(dto: CreateUserDto): Promise<User> {
    const user = new User();
    user.username = dto.username;
    user.email = dto.email;
    if (dto.bio) user.bio = dto.bio;

    const result = await this.userRepository.save(user);
    return Array.isArray(result) ? result[0] : result;
  }

  async findAll(): Promise<User[]> {
    const result = await this.userRepository.find();
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
  }

  async findOne(id: number): Promise<User> {
    const result = await this.userRepository.findOne({
      where: { id } as any,
    });

    if (!result) throw new NotFoundException(`User with ID ${id} not found`);
    return Array.isArray(result) ? result[0] : result;
  }

  @Transactional()
  async update(id: number, dto: UpdateUserDto): Promise<User> {
    const user = await this.findOne(id);

    if (dto.username !== undefined) user.username = dto.username;
    if (dto.email !== undefined) user.email = dto.email;
    if (dto.bio !== undefined) user.bio = dto.bio;

    const result = await this.userRepository.save(user);
    return Array.isArray(result) ? result[0] : result;
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.userRepository.delete({ id } as any);
  }

  async count(): Promise<number> {
    return this.userRepository.count();
  }

  /** findAndCount — 사용자 목록 + 총 개수 페이지네이션 */
  async findPaginated(
    page = 1,
    limit = 10,
  ): Promise<{ data: User[]; total: number; page: number; totalPages: number }> {
    const [data, total] = await this.userRepository.findAndCount({
      take: limit,
      skip: (page - 1) * limit,
    } as any);
    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }
}
