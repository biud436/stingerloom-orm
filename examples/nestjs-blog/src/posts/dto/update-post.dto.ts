export class UpdatePostDto {
  title?: string;
  slug?: string;
  content?: string;
  categoryId?: number;
  tagIds?: number[];
}
