/**
 * 라이브러리 독립적인 역직렬화 옵션 인터페이스입니다.
 * class-transformer 등 특정 구현에 종속되지 않도록 설계되었습니다.
 */
export interface DeserializeOptions {
  /**
   * 클래스에 존재하지 않는 속성을 제외합니다.
   */
  excludeExtraneousValues?: boolean;

  /**
   * 특정 그룹에 속하는 속성만 노출합니다.
   */
  groups?: string[];

  /**
   * 특정 버전에 해당하는 속성만 노출합니다.
   */
  version?: number;

  /**
   * 순환 참조 검사를 활성화합니다.
   */
  enableCircularCheck?: boolean;

  /**
   * 기본값이 있는 속성을 노출합니다.
   */
  exposeDefaultValues?: boolean;

  /**
   * 데코레이터가 없는 속성을 노출할지 여부를 설정합니다.
   */
  exposeUnsetProperties?: boolean;
}
