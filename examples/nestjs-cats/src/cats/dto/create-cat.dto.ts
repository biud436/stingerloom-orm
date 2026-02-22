export class CreateCatDto {
  name!: string;
  age!: number;
  breed!: string;
  /** 선택: 주인 ID. 지정 시 owner FK가 설정됩니다. */
  ownerId?: number;
}
