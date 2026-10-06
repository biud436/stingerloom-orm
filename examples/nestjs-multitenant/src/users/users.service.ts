import { Injectable, NotFoundException } from "@nestjs/common";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { User } from "./user.entity";
import { Post } from "../posts/post.entity";
import { BaseRepository, EntityManager } from "@stingerloom/orm";
import { InjectEntityManager, InjectRepository } from "@stingerloom/orm/nestjs";
import { OnModuleInit } from "@nestjs/common";

@Injectable()
export class UsersService implements OnModuleInit {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: BaseRepository<User>,
    @InjectEntityManager() private readonly em: EntityManager,
  ) {}

  async onModuleInit() {
    // Posts reference users: clear them first, or the users' DELETE fails on
    // the foreign key.
    await this.em.clear(Post);
    await this.userRepository.clear();
  }

  async create(dto: CreateUserDto): Promise<User> {
    const user = new User();
    user.username = dto.username;
    user.email = dto.email;

    if (dto.bio) {
      user.bio = dto.bio;
    }

    return await this.userRepository.save(user);
  }

  async findAll(): Promise<User[]> {
    return await this.userRepository.find({});
  }

  async findOne(id: number): Promise<User> {
    const result = await this.userRepository.findOne({ where: { id } });

    if (!result) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    return result;
  }

  async update(id: number, dto: UpdateUserDto): Promise<User> {
    const user = await this.findOne(id);

    if (dto.username !== undefined) {
      user.username = dto.username;
    }

    if (dto.email !== undefined) {
      user.email = dto.email;
    }

    if (dto.bio !== undefined) {
      user.bio = dto.bio;
    }

    return await this.userRepository.save(user);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.userRepository.delete({ id });
  }
}
