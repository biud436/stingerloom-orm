# 한국어 용어집

`docs/ko/`와 한국어 내부 문서에서 쓰는 이름입니다. 대상 하나에는 아래 이름 하나만 씁니다. 여기에 없는 용어를 새로 쓰려면 먼저 이 표에 추가합니다. 작성 규칙은 `AGENTS.md`의 "한국어 작성 규칙"에 있습니다.

코드 이름은 번역하지 않습니다. `EntitySubscriber`, `findOne()`, `synchronize`처럼 백틱으로 감싼 이름은 그대로 둡니다.

## 대상을 가리키는 말

| 영어 | 쓰는 이름 | 쓰지 않는 이름 | 비고 |
|---|---|---|---|
| connection | 연결 | 커넥션 | 연결을 맺는 동작도 "연결합니다"로 씁니다. |
| connection pool | 연결 풀 | 커넥션 풀 | 문맥이 분명하면 "풀"로 줄입니다. |
| connection leak | 연결 누수 | 커넥션 누수 | |
| row | 행 | 레코드, 로우 | |
| column | 컬럼 | 열 | |
| table | 테이블 | | |
| entity | 엔티티 | 개체 | |
| repository | 리포지토리 | 레포지토리, 저장소 | |
| store | 저장소 | 스토어 | `cache.store`처럼 값을 보관하는 객체입니다. |
| statement | SQL 문 | 스테이트먼트, 구문 | "구문"은 문법(syntax)으로도 읽힙니다. |
| query | 쿼리 | 질의 | |
| transaction | 트랜잭션 | | |
| savepoint | 세이브포인트 | | |
| tenant | 테넌트 | | |
| relation | 관계 | 연관, 연관관계 | |
| eager loading | 즉시 로딩 | eager 로딩 | 옵션 이름 `eager`는 그대로 씁니다. |
| lazy loading | 지연 로딩 | lazy 로딩 | |
| soft delete | 소프트 삭제 | soft delete, 논리 삭제 | |
| primary key | 기본 키 | PK, 프라이머리 키 | 복합 기본 키도 같습니다. |
| foreign key | 외래 키 | FK | |
| unique index | 고유 인덱스 | 유니크 인덱스 | |
| error | 에러 | 오류 | |
| exception | 예외 | | uncaught exception처럼 런타임 용어를 말할 때만 씁니다. 그 밖에는 에러입니다. |
| warning | 경고 | | |
| replica | 레플리카 | 복제본 | |
| subscriber | 구독자 | 서브스크라이버 | |
| lock | 잠금 | 락 | advisory lock은 어드바이저리 잠금입니다. |
| dialect | 다이얼렉트 | 방언 | |
| driver | 드라이버 | | |
| option | 옵션 | | `register()`에 넘기는 각 항목입니다. |
| configuration | 설정 | 구성 | 옵션 전체를 묶어 말할 때 씁니다. |
| callback | 콜백 | | |
| decorator | 데코레이터 | | |
| metadata | 메타데이터 | | |
| migration | 마이그레이션 | | |
| schema | 스키마 | | |
| index | 인덱스 | | |
| cache | 캐시 | | |
| plugin | 플러그인 | | |
| hook | 훅 | | |
| instance | 인스턴스 | | |
| timeout | 타임아웃 | 시간 초과 | |
| pagination | 페이지네이션 | 페이징 | |
| validation | 검증 | 유효성 검사 | |
| deprecated | deprecated | 더 이상 사용되지 않는, 폐기 예정 | |
| created at | 생성 일시 | 생성 시각, 처음 넣은 시각 | |
| updated at | 수정 일시 | 수정 시각, 갱신 시각 | |
| deleted at | 삭제 일시 | 삭제 시각 | |

## 동작을 나타내는 말

| 영어 | 쓰는 말 | 쓰지 않는 말 |
|---|---|---|
| return | 반환합니다 | 돌려줍니다 |
| throw | 던집니다 | 발생시킵니다 |
| reject (Promise) | 거부합니다 | |
| insert | 삽입합니다 | 넣습니다 |
| update | 갱신합니다 | 업데이트합니다 |
| delete | 삭제합니다 | 지웁니다 |
| add | 추가합니다 | |
| replace | 교체합니다 | 통째로 바꿉니다 |
| create (table, index) | 생성합니다 | |
| find, read | 조회합니다 | 읽어 옵니다, 가져옵니다 |
| save | 저장합니다 | |
| run, execute | 실행합니다 | 돌립니다 |
| call | 호출합니다 | 부릅니다 |
| ignore | 무시합니다 | |
| validate | 검증합니다 | |
| load (relation) | 로드합니다 | 불러옵니다 |
| skip | 건너뜁니다 | 스킵합니다 |
