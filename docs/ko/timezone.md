# 날짜와 타임존

시각 값은 결국 어딘가에서 문자열이나 바이트로 바뀝니다. 그 변환을 누가 맡느냐에 따라 저장되는 값이 달라집니다. 변환을 잘못 다루면 시각이 몇 시간씩 어긋납니다. Stingerloom에서는 `Date`를 컬럼 값으로 바꾸는 일을 드라이버가 맡습니다. 컬럼 값을 다시 `Date`로 되돌리는 일은 ORM이 맡습니다.

## ORM은 시각을 문자열로 만들지 않습니다

`save`, `saveMany`, `insertMany`, `insertManyAndReturn`, `upsert`, `batchUpsert`, `update`, `updateMany`, `@CreateTimestamp`, `@UpdateTimestamp`, 쿼리 빌더는 모두 `Date` 객체를 그대로 바인딩합니다. 문자열로 바꾸는 일은 드라이버가 맡습니다.

ORM이 직접 포맷하면 정보가 사라지기 때문입니다. 2.0 이전에는 배치 경로와 자동 타임스탬프 컬럼이 프로세스의 로컬 타임존 기준으로 `YYYY-MM-DD HH:MM:SS` 문자열을 만들었습니다. 이 형식에는 오프셋도 밀리초도 없습니다. 반면 단일 행 경로는 `Date`를 그대로 바인딩했습니다. 그래서 컬럼 하나에 두 가지 표기가 섞였습니다. `insertMany`로 삽입한 행은 조회하면 밀리초가 0으로 잘려 있었습니다. 지금은 모든 경로가 `Date`를 그대로 바인딩합니다.

## 드라이버가 실제로 저장하는 값

| 드라이버 | `Date`가 이렇게 저장됩니다 | 비고 |
| --- | --- | --- |
| SQLite | 밀리초까지 붙은 ISO-8601 UTC (`2026-03-01T12:34:56.789Z`) | better-sqlite3는 number, string, bigint, buffer, null만 받아서 커넥터가 `toISOString()`으로 바꿉니다 |
| MySQL / MariaDB | 연결 타임존 기준 `YYYY-MM-DD HH:MM:SS[.fff]` | mysql2의 `timezone` 옵션을 따릅니다. 기본값은 Node 프로세스의 타임존입니다 |
| PostgreSQL | 오프셋이 붙은 ISO-8601 문자열 | `timestamptz`는 시점을, `timestamp`는 그 시점이 해석된 벽시계 값을 저장합니다 |

## 읽을 때 되돌리는 규칙

시각 계열 컬럼(`datetime`, `timestamp`, `timestamptz`, `date`)은 조회할 때 `Date`로 변환됩니다.

pg와 mysql2에서는 드라이버가 시각 컬럼을 직접 파싱합니다. 반면 better-sqlite3는 컬럼 타입 정보가 없어서 저장된 텍스트를 그대로 반환합니다. 그래서 ORM이 선언된 컬럼 타입을 보고 텍스트를 `Date`로 변환합니다.

| 저장된 텍스트 | 이렇게 해석합니다 |
| --- | --- |
| `2026-03-01T12:34:56.789Z` | UTC. 지금 ORM이 쓰는 형식입니다 |
| `2026-03-01 12:34:56` | 로컬 벽시계. 2.0 이전 버전이 쓰던 형식입니다 |
| `2026-03-01` | 로컬 자정. pg와 mysql2의 `DATE` 관례와 같습니다 |
| 그 외 | `new Date(value)`로 해석합니다. 해석하지 못한 텍스트는 Invalid Date로 바꾸지 않고 원본 그대로 반환합니다 |

에포크 정수는 변환하지 않고 그대로 둡니다. ORM은 그 값이 초 단위인지 밀리초 단위인지 구별하지 못하기 때문입니다. 에포크 정수를 저장한다면 `@Column({ transformer })`로 직접 변환하세요.

## 컬럼 타입 매핑

| 선언 타입 | MySQL / MariaDB | PostgreSQL | SQLite |
| --- | --- | --- | --- |
| `datetime` | `DATETIME` | `TIMESTAMP` | `TEXT` |
| `timestamp` | `TIMESTAMP` | `TIMESTAMP` | `TEXT` |
| `timestamptz` | `DATETIME` (아래 참고) | `TIMESTAMPTZ` | `TEXT` |
| `date` | `DATE` | `DATE` | `TEXT` |

MySQL과 MariaDB에는 타임존 정보를 담는 `DATETIME` 타입이 없습니다. 그래서 `timestamptz`는 일반 `DATETIME`으로 생성되고 오프셋은 저장되지 않습니다. ORM은 이 매핑으로 컬럼을 생성할 때 프로세스당 한 번 경고를 출력합니다. 애플리케이션 타임존이 바뀌지 않는다면 값은 같은 시점으로 저장되고 조회됩니다. 서버가 세션 타임존에 맞춰 값을 변환해야 한다면 `timestamp`를 쓰세요. MySQL의 `TIMESTAMP`는 내부적으로 UTC를 저장합니다. 대신 2038년이라는 상한이 있습니다.

## 애플리케이션 타임존은 어떻게 잡을까

가장 안전한 설정은 가장 단순한 설정입니다. 모든 애플리케이션 프로세스를 UTC(`TZ=UTC`)로 실행하고 지역화는 화면 쪽에서 처리하세요. 그러면 MySQL의 벽시계 표기와 SQLite의 로컬 시각 해석이 모두 UTC와 일치합니다. 프로세스를 다른 장비로 옮겨도 값이 달라지지 않습니다.

프로세스를 UTC로 실행하지 못하는 사정이 있다면 아래처럼 하세요.

- PostgreSQL에서는 `timestamptz`를 쓰세요. `timestamptz`는 시점 자체를 저장합니다. 그래서 프로세스 타임존이 저장되는 값에 영향을 주지 않습니다.
- MySQL에서는 같은 테이블에 쓰는 모든 프로세스의 연결 `timezone` 옵션을 통일하세요. 타임존이 다른 프로세스들이 `DATETIME` 컬럼에 값을 쓰면 저장된 벽시계 값의 뜻이 프로세스마다 달라집니다.
- SQLite는 2.0부터 UTC 표기를 붙여 저장합니다. 그래서 프로세스 타임존과 상관없이 값의 뜻이 하나로 정해집니다.

## 타임존을 바꿔 가며 테스트하기

UTC에서만 실행하는 테스트로는 타임존 버그를 잡지 못합니다. 타임존 표기 없이 저장한 로컬 시각과 제대로 저장한 UTC 값이 UTC 환경에서는 똑같은 텍스트가 되기 때문입니다. Stingerloom 프로젝트에는 자체 시각 테스트 스위트를 여러 타임존에서 실행하는 러너가 있습니다.

```bash
pnpm test:temporal-tz
```

이 러너는 시각, 소프트 삭제, 커서 스위트를 `UTC`, `Asia/Seoul`, `America/New_York`, `Asia/Kolkata`에서 다시 실행합니다. `Asia/Kolkata`는 30분 단위 오프셋을 쓰는 타임존입니다.

테스트 본문에서 `process.env.TZ`를 바꾸는 방법은 동작하지 않습니다. Jest가 테스트에 넘기는 `process.env`는 Node의 타임존 setter가 없는 평범한 복사본입니다. 그래서 V8은 시작할 때 정한 타임존을 계속 씁니다. 타임존은 프로세스 단위로 설정해야 하고 러너가 바로 그 일을 합니다. 직접 작성하는 애플리케이션 테스트도 마찬가지입니다. `TZ`는 테스트 본문이 아니라 프로세스 실행 환경에 설정하세요.

## 소프트 삭제 시각

`softDelete()`는 데이터베이스 시계로 `@DeletedAt` 컬럼을 채웁니다. MySQL과 PostgreSQL에서는 `NOW()`를 쓰고 SQLite에서는 `strftime('%Y-%m-%dT%H:%M:%fZ','now')`를 씁니다.

2.0 이전에는 SQLite에서 `datetime('now')`를 썼습니다. 이 함수는 UTC 시각을 만들지만 타임존 표기를 붙이지 않습니다. 그런데 ORM은 타임존 표기가 없는 텍스트를 로컬 시각으로 해석합니다. 그래서 `deletedAt`이 프로세스 타임존의 오프셋만큼 어긋났습니다. `Asia/Seoul`에서는 아홉 시간 이른 값이 되었습니다. 2.0부터 기록하는 값에는 `Z`가 붙어 있어서 올바르게 해석됩니다.

이전 버전에서 소프트 삭제된 행에는 옛 표기가 그대로 남아 있습니다. UTC가 아닌 환경에서 운영했고 `deletedAt` 값을 삭제 여부 판별 이상의 용도로 쓴다면 한 번 보정해 두세요.

```sql
-- SQLite: 2.0 이전 행을 UTC 표기로 다시 씁니다.
-- '+9 hours' 자리에는 기록한 프로세스가 쓰던 오프셋의 부호를 뒤집어 넣으세요.
UPDATE my_table
SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at)
WHERE deleted_at IS NOT NULL
  AND deleted_at NOT LIKE '%Z';
```

실제 데이터에 실행하기 전에 사본에서 결과를 확인하세요. 타임존 표기가 없는 값을 어느 타임존의 프로세스가 기록했는지는 ORM도 구별하지 못합니다.

## 밀리초가 사라졌다면

ORM은 바인딩하는 모든 `Date`의 밀리초를 그대로 넘깁니다. 데이터베이스가 밀리초를 보존하는지는 스키마에 달려 있습니다.

- MySQL의 `DATETIME`과 `TIMESTAMP`는 `DATETIME(3)`처럼 소수 자릿수를 지정하지 않으면 초 단위까지만 저장합니다.
- PostgreSQL의 `TIMESTAMP`/`TIMESTAMPTZ`는 기본으로 마이크로초까지 저장합니다.
- SQLite는 커넥터가 만든 텍스트를 그대로 저장하므로 밀리초가 남습니다.

저장한 엔티티와 넘긴 `Date`의 밀리초가 다르다면 컬럼 정밀도부터 확인하세요.
