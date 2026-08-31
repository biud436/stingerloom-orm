# 날짜와 타임존

ORM이 기록하는 모든 시간 값은 자바스크립트 `Date` 객체 그대로 쿼리에 바인딩됩니다. 그 `Date`가 컬럼에 어떤 바이트로 들어갈지는 드라이버가 정하고, 컬럼에서 읽은 값을 어떻게 `Date`로 되돌릴지는 ORM이 정합니다. 이 문서는 그 양쪽을 모두 설명합니다. 무엇이 저장되고 무엇을 돌려받는지 예측할 수 있어야 하니까요.

## 원칙

**ORM은 날짜를 문자열로 미리 포맷하지 않습니다.** `save`, `saveMany`, `insertMany`, `insertManyAndReturn`, `upsert`, `batchUpsert`, `update`, `updateMany`, `@CreateTimestamp`, `@UpdateTimestamp`, 쿼리 빌더까지 전부 `Date`를 그대로 바인딩합니다.

직접 포맷하면 정보가 깎이기 때문입니다. 2.0.0 이전에는 배치 경로와 자동 타임스탬프 컬럼이 프로세스 로컬 시간 기준 `YYYY-MM-DD HH:MM:SS` 문자열을 만들었습니다. 오프셋도 없고 밀리초도 없는 형식이죠. 반면 단일 행 경로는 `Date`를 그대로 바인딩했습니다. 그래서 컬럼 하나에 두 가지 표기가 섞였고, `insertMany`로 넣은 행은 밀리초가 0으로 잘려서 돌아왔습니다. 전 경로를 `Date` 바인딩으로 통일해 이 분열을 없앴습니다.

## 드라이버별 저장 형식

| 드라이버 | 바인딩된 `Date`가 저장되는 형태 | 비고 |
| --- | --- | --- |
| SQLite | 밀리초를 포함한 ISO-8601 UTC 텍스트 (`2026-03-01T12:34:56.789Z`) | better-sqlite3는 number, string, bigint, buffer, null만 받기 때문에 커넥터가 `toISOString()`으로 변환합니다 |
| MySQL / MariaDB | 커넥션 타임존 기준 `YYYY-MM-DD HH:MM:SS[.fff]` | mysql2의 `timezone` 옵션을 따르며, 기본값은 Node 프로세스의 타임존입니다 |
| PostgreSQL | 오프셋이 붙은 ISO-8601 문자열 | `timestamptz`는 인스턴트를, `timestamp`는 그 인스턴트가 해석된 벽시계 시각을 저장합니다 |

## 읽을 때

시간 계열 컬럼(`datetime`, `timestamp`, `timestamptz`, `date`)은 `Date`로 하이드레이션됩니다.

pg와 mysql2는 드라이버 단계에서 시간 컬럼을 파싱합니다. 반면 better-sqlite3는 컬럼 타입 정보가 없어 저장된 텍스트를 그대로 돌려주기 때문에, ORM이 선언된 컬럼 타입을 근거로 변환합니다.

| 저장된 텍스트 | 해석 |
| --- | --- |
| `2026-03-01T12:34:56.789Z` | UTC — 현재 ORM이 쓰는 형식 |
| `2026-03-01 12:34:56` (존 표기 없음) | 로컬 벽시계 시각 — 예전 버전이 쓰던 형식 |
| `2026-03-01` | 로컬 자정. pg/mysql2의 `DATE` 관례와 같습니다 |
| 그 외 | `new Date(value)`로 시도하고, 파싱에 실패하면 Invalid Date로 망가뜨리지 않고 원본을 그대로 통과시킵니다 |

에포크 정수는 손대지 않고 그대로 넘깁니다. 초 단위인지 밀리초 단위인지 ORM이 구분할 방법이 없기 때문입니다. 이런 값을 저장한다면 `@Column({ transformer })`를 쓰세요.

## 컬럼 타입 매핑

| 선언 타입 | MySQL / MariaDB | PostgreSQL | SQLite |
| --- | --- | --- | --- |
| `datetime` | `DATETIME` | `TIMESTAMP` | `TEXT` |
| `timestamp` | `TIMESTAMP` | `TIMESTAMP` | `TEXT` |
| `timestamptz` | `DATETIME` (아래 참고) | `TIMESTAMPTZ` | `TEXT` |
| `date` | `DATE` | `DATE` | `TEXT` |

MySQL과 MariaDB에는 타임존을 아는 `DATETIME` 타입이 없습니다. 그래서 `timestamptz`는 평범한 `DATETIME`으로 생성되고 오프셋은 저장되지 않습니다. ORM은 이 매핑을 내보낼 때 프로세스당 한 번 경고를 남깁니다. 애플리케이션 타임존이 일정하다면 값 자체는 같은 인스턴트로 왕복하지만, 서버가 세션 타임존 사이를 변환해 주길 원한다면 `timestamp`를 쓰세요. MySQL의 `TIMESTAMP`는 내부적으로 UTC를 저장합니다. 대신 2038년 상한이 따라옵니다.

## 애플리케이션 타임존 선택

가장 안전한 구성은 심심한 쪽입니다. **모든 애플리케이션 프로세스를 UTC로 돌리고**(`TZ=UTC`) 지역화는 표현 계층에 맡기세요. 그러면 MySQL의 벽시계 표기도, SQLite의 로컬 시간 폴백도 전부 UTC와 일치하고, 프로세스가 다른 장비로 옮겨가도 값이 흔들리지 않습니다.

UTC로 돌릴 수 없다면 이렇게 하세요.

- PostgreSQL에서는 `timestamptz`를 쓰세요. 인스턴트를 저장하므로 프로세스 타임존 가정이 데이터베이스까지 넘어가지 않습니다.
- MySQL에서는 같은 테이블에 쓰는 모든 프로세스의 커넥션 `timezone` 옵션을 통일하세요. 서로 다른 존의 두 프로세스가 `DATETIME`에 쓰면 저장된 벽시계 시각의 의미가 갈립니다.
- SQLite에서는 2.0.0부터 UTC 표기가 붙은 값을 쓰기 때문에 프로세스 타임존과 무관하게 뜻이 하나로 정해집니다.

## 타임존 교차 테스트

UTC에서만 도는 테스트 스위트는 타임존 결함을 볼 수 없습니다. 존 없는 로컬 기록과 올바른 UTC 기록이 같은 텍스트를 만들어 내니까요. 이 리포지토리는 자체 시간 스위트를 위한 매트릭스 러너를 제공합니다.

```bash
pnpm test:temporal-tz
```

시간, 소프트 삭제, 커서 스위트를 `UTC`, `Asia/Seoul`, `America/New_York`, `Asia/Kolkata`(30분 오프셋) 네 존에서 다시 돌립니다. 테스트 본문에서 `process.env.TZ`를 바꾸는 방법은 통하지 않습니다. Jest가 넘겨주는 `process.env`는 Node의 타임존 setter가 없는 평범한 복사본이라, V8은 시작할 때의 존을 그대로 유지합니다. 결국 타임존은 프로세스 단위로 지정해야 하고, 러너가 하는 일이 그것입니다.

직접 만드는 애플리케이션 테스트도 마찬가지입니다. `TZ`는 테스트 본문이 아니라 프로세스에 걸어야 합니다.

## 소프트 삭제

`softDelete()`는 데이터베이스 시계로 `@DeletedAt` 컬럼을 찍습니다. MySQL과 PostgreSQL은 `NOW()`, SQLite는 `strftime('%Y-%m-%dT%H:%M:%fZ','now')`를 씁니다.

2.0.0 이전 SQLite 분기는 `datetime('now')`를 썼는데, 이 함수는 존 표기 없이 UTC를 그려 냅니다. 그런데 읽기 쪽은 존 없는 텍스트를 로컬로 해석하죠. 그래서 `deletedAt`이 프로세스 오프셋만큼 어긋나 돌아왔습니다. `Asia/Seoul`이라면 아홉 시간 이른 값이 나왔습니다. 2.0.0부터 찍히는 값은 `Z` 표기를 달고 있어 정확히 해석됩니다.

이전 버전에서 소프트 삭제된 행은 옛 표기를 그대로 갖고 있습니다. `deletedAt` 값이 "이 행이 버려졌는가" 이상의 의미를 가지고, UTC가 아닌 프로세스에서 운영했다면 한 번 보정하세요.

```sql
-- SQLite: 2.0.0 이전 행을 UTC 표기 텍스트로 다시 찍습니다.
-- '+9 hours' 자리에는 기록한 프로세스가 쓰던 오프셋의 부호를 뒤집어 넣으세요.
UPDATE my_table
SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at)
WHERE deleted_at IS NOT NULL
  AND deleted_at NOT LIKE '%Z';
```

실제 데이터에 돌리기 전에 사본에서 결과를 확인하세요. 존 표기가 없는 값을 어느 타임존의 프로세스가 썼는지는 ORM도 알 수 없습니다.

## 밀리초

ORM은 바인딩하는 모든 `Date`의 밀리초를 보존합니다. 데이터베이스가 그걸 유지하는지는 스키마 문제입니다.

- MySQL `DATETIME`과 `TIMESTAMP`는 소수 자릿수를 명시하지 않으면(`DATETIME(3)`) 초 단위까지만 저장합니다.
- PostgreSQL `TIMESTAMP`/`TIMESTAMPTZ`는 기본적으로 마이크로초까지 유지합니다.
- SQLite는 커넥터가 만든 텍스트를 그대로 저장하므로 밀리초가 살아남습니다.

저장한 엔티티와 넘긴 `Date`의 밀리초가 다르다면 컬럼 정밀도부터 확인하세요.
