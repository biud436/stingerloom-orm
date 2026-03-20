import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  BeforeInsert,
  BeforeUpdate,
  DeletedAt,
} from '@stingerloom/orm';

@Entity()
export class Todo {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'boolean' })
  completed!: boolean;

  @Column({ type: 'datetime', nullable: true })
  createdAt!: Date;

  @Column({ type: 'datetime', nullable: true })
  updatedAt!: Date;

  @DeletedAt()
  deletedAt!: Date | null;

  @BeforeInsert()
  setTimestamps() {
    const now = new Date();
    this.createdAt = now;
    this.updatedAt = now;
    if (this.completed === undefined) this.completed = false;
  }

  @BeforeUpdate()
  updateTimestamp() {
    this.updatedAt = new Date();
  }
}
