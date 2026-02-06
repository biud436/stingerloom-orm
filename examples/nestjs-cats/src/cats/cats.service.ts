import { Injectable, NotFoundException } from "@nestjs/common";
import { CreateCatDto } from "./dto/create-cat.dto";
import { UpdateCatDto } from "./dto/update-cat.dto";
import { DatabaseService } from "../database/database.service";
import { Cat } from "./cat.entity";

@Injectable()
export class CatsService {
  constructor(private readonly databaseService: DatabaseService) {}

  private getRepository() {
    return this.databaseService.getRepository(Cat);
  }

  async create(createCatDto: CreateCatDto): Promise<Cat> {
    const cat = new Cat();
    cat.name = createCatDto.name;
    cat.age = createCatDto.age;
    cat.breed = createCatDto.breed;
    cat.createdAt = new Date();

    const result = await this.getRepository().save(cat);
    if (!result) {
      throw new Error("Failed to create cat");
    }
    return Array.isArray(result) ? result[0] : result;
  }

  async findAll(): Promise<Cat[]> {
    const result = await this.getRepository().find({});
    if (typeof result === "object" && !Array.isArray(result)) {
      return [result];
    }

    return result;
  }

  async findOne(id: number): Promise<Cat> {
    const result = await this.getRepository().findOne({
      where: { id } as any,
    });

    if (!result) {
      throw new NotFoundException(`Cat with ID ${id} not found`);
    }

    const cat = Array.isArray(result) ? result[0] : result;
    if (!cat) {
      throw new NotFoundException(`Cat with ID ${id} not found`);
    }
    return cat;
  }

  async update(id: number, updateCatDto: UpdateCatDto): Promise<Cat> {
    const cat = await this.findOne(id);

    if (updateCatDto.name !== undefined) {
      cat.name = updateCatDto.name;
    }
    if (updateCatDto.age !== undefined) {
      cat.age = updateCatDto.age;
    }
    if (updateCatDto.breed !== undefined) {
      cat.breed = updateCatDto.breed;
    }

    const result = await this.getRepository().save(cat);
    if (!result) {
      throw new Error("Failed to update cat");
    }
    return Array.isArray(result) ? result[0] : result;
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    throw new NotFoundException(
      "Delete operation is not fully implemented yet",
    );
  }
}
