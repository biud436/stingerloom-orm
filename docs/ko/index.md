---
layout: home

hero:
  name: Stingerloom ORM
  text: Node.js를 위한 TypeScript ORM
  tagline: 프레임워크 독립적인 ORM — 멀티테넌시, MySQL, PostgreSQL, SQLite 지원
  actions:
    - theme: brand
      text: 시작하기
      link: /ko/getting-started
    - theme: alt
      text: API 레퍼런스
      link: /ko/api-reference
    - theme: alt
      text: GitHub
      link: https://github.com/biud436/stingerloom-orm

features:
  - title: 완전한 CRUD & 관계
    details: ManyToOne, OneToMany, ManyToMany, OneToOne 관계를 즉시/지연 로딩, 캐스케이드, 소프트 삭제와 함께 지원합니다.
  - title: 멀티테넌시
    details: Docker OverlayFS에서 영감 받은 레이어드 메타데이터 시스템과 AsyncLocalStorage 기반의 안전한 동시 테넌트 격리를 제공합니다.
  - title: 타입 안전한 TypeScript
    details: 데코레이터 기반 엔티티 정의, 제네릭 쿼리 빌더, 전체 코드에 걸친 엄격한 타입 체크를 지원합니다.
  - title: 멀티 다이얼렉트
    details: MySQL, PostgreSQL, SQLite 드라이버를 제공하며, 파라미터화된 쿼리로 SQL 인젝션을 방지합니다.
  - title: 스키마 마이그레이션
    details: 자동 스키마 차이 감지, 마이그레이션 생성, 테넌트 인식 마이그레이션 러너를 제공합니다.
  - title: NestJS 통합
    details: "@InjectRepository, @Transactional, 전용 모듈을 통한 최상의 NestJS 지원을 제공합니다."
---
