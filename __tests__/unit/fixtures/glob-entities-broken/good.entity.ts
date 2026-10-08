import { Entity } from "../../../../src/decorators/Entity";
import { Column } from "../../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../../src/decorators/PrimaryGeneratedColumn";

@Entity({ name: "glob_good" })
export class GlobGood {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 20 }) name!: string;
}
