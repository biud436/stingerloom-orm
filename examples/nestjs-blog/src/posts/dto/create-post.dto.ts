export class CreatePostDto {
  title!: string;
  slug!: string;
  content!: string;
  authorId!: number;
  categoryId?: number;
  tagIds?: number[];
}
