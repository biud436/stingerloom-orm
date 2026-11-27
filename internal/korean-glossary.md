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
| property | 속성 | 프로퍼티 | 엔티티 클래스의 필드도 속성입니다. |
| shadow property | 섀도 속성 | 섀도우 프로퍼티 | |
| unique (constraint, key) | 고유 제약 조건, 고유 키 | 유니크 | 고유 인덱스와 같은 규칙입니다. |
| discriminator column | 구분 컬럼 | 판별자, discriminator 컬럼 | 처음 나올 때 구분 컬럼(discriminator column)으로 씁니다. |
| discriminator value | 구분 값 | 판별자 값 | |
| lifecycle hook | 생명주기 훅 | 라이프사이클 훅 | |
| read replica | 읽기 레플리카 | 읽기 복제본, 리플리카 | |
| window function | 윈도 함수 | 윈도우 함수 | |
| race condition | 경쟁 상태 | 레이스 컨디션, 경쟁 조건 | 처음 나올 때 원어를 붙입니다. |
| deadlock | 데드락 | 교착 상태 | |
| SQL fragment | SQL 조각 | 프래그먼트 | |
| raw SQL | raw SQL | 원시 SQL | |
| hydrate | 하이드레이트 | 수화 | 조회한 행을 엔티티 인스턴스로 채우는 일입니다. |
| user | 사용자 | 유저 | 애플리케이션의 최종 사용자를 말합니다. |
| predicate | 조건 | 술어, 프레디킷 | WHERE에 들어가는 조건식입니다. |
| named connection | 이름 있는 연결 | 명명된 연결, 네임드 커넥션 | 처음 나올 때 원어를 붙입니다. |
| lost update | 갱신 손실 | 갱신 분실, 로스트 업데이트 | 처음 나올 때 원어를 붙입니다. |
| idempotent | 멱등 | | 처음 나올 때 멱등(idempotent)으로 씁니다. |
| typed builder | 타입 있는 빌더 | 타입드 빌더 | |
| workflow | 워크플로 | 워크플로우 | |
| naming strategy | 네이밍 전략 | 네이밍 규약, 명명 전략 | |
| fallback | 대체 | 폴백 | 동작을 말할 때는 "~로 넘어갑니다"로 씁니다. |
| owning side | 소유 측 | 주인 쪽, 오너 사이드 | 외래 키를 가진 쪽의 관계입니다. |
| inverse side | 역방향 측 | 반대편, 인버스 사이드 | |
| round trip | 라운드 트립 | 왕복 | 데이터베이스와 한 번 주고받는 일입니다. |
| hard delete | 하드 삭제 | 물리 삭제 | 소프트 삭제와 대비할 때 씁니다. |
| tenant scope | 테넌트 범위 | 테넌트 스코프 | |
| full-text search | 전문 검색 | 풀텍스트 검색 | |
| single-valued relation | 단일 값 관계 | | ManyToOne과 OneToOne처럼 대상이 하나인 관계입니다. |
| placeholder | 플레이스홀더 | 자리표시자 | |
| circuit breaker | 서킷 브레이커 | 회로 차단기 | |
| time window | 윈도 | 윈도우, 구간 | 시간 구간을 말합니다. |
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
