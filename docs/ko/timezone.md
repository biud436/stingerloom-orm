# 날짜와 타임존

시각 값은 결국 어딘가에서 문자열이나 바이트가 됩니다. 그 변환을 누가 하느냐에 따라 저장되는 값이 달라지고, 잘못 잡으면 시간이 몇 시간씩 밀립니다. 이 문서는 Stingerloom이 시각을 어떻게 쓰고 어떻게 읽는지를 양쪽 다 정리합니다.

## ORM은 시각을 문자열로 만들지 않습니다

`save`, `saveMany`, `insertMany`, `insertManyAndReturn`, `upsert`, `batchUpsert`, `update`, `updateMany`, `@CreateTimestamp`, `@UpdateTimestamp`, 쿼리 빌더까지 전부 `Date` 객체를 그대로 바인딩합니다. 문자열로 바꾸는 일은 드라이버가 맡습니다.

직접 포맷하면 정보가 깎이기 때문입니다. 2.0 이전에는 배치 경로와 자동 타임스탬프가 로컬 벽시계 기준 `YYYY-MM-DD HH:MM:SS`를 만들었습니다. 오프셋도 없고 밀리초도 없는 형식이죠. 반면 단일 행 경로는 `Date`를 그대로 넘겼습니다. 그래서 컬럼 하나에 표기가 두 가지 섞였고, `insertMany`로 넣은 행은 밀리초가 0으로 잘려 돌아왔습니다. 지금은 전 경로가 같은 방식을 씁니다.

## 드라이버가 실제로 저장하는 값

| 드라이버 | `Date`가 이렇게 저장됩니다 | 비고 |
| --- | --- | --- |
| SQLite | 밀리초까지 붙은 ISO-8601 UTC (`2026-03-01T12:34:56.789Z`) | better-sqlite3는 number, string, bigint, buffer, null만 받아서 커넥터가 `toISOString()`으로 바꿉니다 |
| MySQL / MariaDB | 커넥션 타임존 기준 `YYYY-MM-DD HH:MM:SS[.fff]` | mysql2의 `timezone` 옵션을 따르고, 기본값은 Node 프로세스의 타임존입니다 |
| PostgreSQL | 오프셋이 붙은 ISO-8601 문자열 | `timestamptz`는 시점을, `timestamp`는 그 시점이 해석된 벽시계 값을 저장합니다 |

## 읽을 때 되돌리는 규칙

시각 계열 컬럼(`datetime`, `timestamp`, `timestamptz`, `date`)은 `Date`로 돌아옵니다.

pg와 mysql2는 드라이버가 알아서 파싱합니다. better-sqlite3는 컬럼 타입을 모르기 때문에 저장된 텍스트를 그대로 주고, 그래서 ORM이 선언된 컬럼 타입을 보고 직접 되돌립니다.

| 저장된 텍스트 | 이렇게 해석합니다 |
| --- | --- |
| `2026-03-01T12:34:56.789Z` | UTC. 지금 ORM이 쓰는 형식입니다 |
| `2026-03-01 12:34:56` | 로컬 벽시계. 2.0 이전 버전이 쓰던 형식입니다 |
| `2026-03-01` | 로컬 자정. pg와 mysql2의 `DATE` 관례와 같습니다 |
| 그 외 | `new Date(value)`로 시도하고, 실패하면 Invalid Date로 망가뜨리지 않고 원본을 그대로 둡니다 |

에포크 정수는 손대지 않습니다. 초 단위인지 밀리초 단위인지 ORM이 알 방법이 없어서요. 이런 값을 쓴다면 `@Column({ transformer })`로 직접 변환하세요.

## 컬럼 타입 매핑

| 선언 타입 | MySQL / MariaDB | PostgreSQL | SQLite |
| --- | --- | --- | --- |
| `datetime` | `DATETIME` | `TIMESTAMP` | `TEXT` |
| `timestamp` | `TIMESTAMP` | `TIMESTAMP` | `TEXT` |
| `timestamptz` | `DATETIME` (아래 참고) | `TIMESTAMPTZ` | `TEXT` |
| `date` | `DATE` | `DATE` | `TEXT` |

MySQL과 MariaDB에는 타임존을 아는 `DATETIME`이 없습니다. 그래서 `timestamptz`는 그냥 `DATETIME`이 되고 오프셋은 저장되지 않습니다. ORM은 이 매핑을 내보낼 때 프로세스당 한 번 경고합니다. 애플리케이션 타임존이 일정하다면 값 자체는 같은 시점으로 왕복하지만, 서버가 세션 타임존을 감안해 변환해 주길 원한다면 `timestamp`를 쓰세요. MySQL의 `TIMESTAMP`는 내부적으로 UTC를 저장합니다. 대신 2038년 상한이 따라옵니다.

## 애플리케이션 타임존은 어떻게 잡을까

제일 안전한 건 시시한 답입니다. **모든 프로세스를 UTC로 돌리고**(`TZ=UTC`) 지역화는 화면 쪽에서 하세요. 그러면 MySQL의 벽시계 표기도, SQLite의 로컬 해석도 전부 UTC와 맞아떨어지고, 프로세스가 다른 장비로 옮겨가도 값이 흔들리지 않습니다.

UTC로 돌릴 수 없는 사정이 있다면 이렇게 하세요.

- PostgreSQL에서는 `timestamptz`를 쓰세요. 시점 자체를 저장하니 프로세스 타임존 가정이 DB까지 넘어가지 않습니다.
- MySQL에서는 같은 테이블에 쓰는 모든 프로세스의 커넥션 `timezone`을 통일하세요. 서로 다른 존의 두 프로세스가 `DATETIME`에 쓰면, 저장된 벽시계 값이 무엇을 뜻하는지가 갈립니다.
- SQLite는 2.0부터 UTC 표기를 붙여 저장하므로 프로세스 타임존과 무관하게 뜻이 하나로 정해집니다.

## 타임존을 바꿔 가며 테스트하기

UTC에서만 도는 테스트로는 타임존 버그를 잡을 수 없습니다. 존 없이 저장한 값과 제대로 저장한 값이 UTC에서는 똑같이 생겼거든요. 이 저장소는 자체 시각 스위트를 여러 존에서 돌리는 러너를 두고 있습니다.

```bash
pnpm test:temporal-tz
```

시각, 소프트 삭제, 커서 스위트를 `UTC`, `Asia/Seoul`, `America/New_York`, `Asia/Kolkata`(30분 오프셋)에서 다시 돌립니다.

테스트 본문에서 `process.env.TZ`를 바꾸는 방법은 통하지 않습니다. Jest가 넘겨주는 `process.env`는 Node의 타임존 setter가 없는 평범한 복사본이라, V8은 시작할 때 잡은 존을 그대로 씁니다. 결국 타임존은 프로세스 단위로 줘야 하고, 러너가 하는 일이 그것입니다. 직접 만드는 애플리케이션 테스트도 마찬가지로 `TZ`는 테스트 안이 아니라 실행 환경에 걸어야 합니다.

## 소프트 삭제 시각

`softDelete()`는 데이터베이스 시계로 `@DeletedAt` 컬럼을 채웁니다. MySQL과 PostgreSQL은 `NOW()`, SQLite는 `strftime('%Y-%m-%dT%H:%M:%fZ','now')`입니다.

2.0 이전 SQLite는 `datetime('now')`를 썼는데, 이 함수는 UTC를 주면서 존 표기를 붙이지 않습니다. 그런데 읽는 쪽은 존 없는 텍스트를 로컬로 해석하죠. 그래서 `deletedAt`이 프로세스 타임존만큼 어긋났습니다. `Asia/Seoul`이라면 아홉 시간 이른 값이었습니다. 지금 찍히는 값은 `Z`가 붙어 있어 그대로 읽힙니다.

이전 버전에서 삭제된 행은 옛 표기를 그대로 갖고 있습니다. `deletedAt` 값이 "버려진 행인가" 이상의 의미를 갖고 UTC가 아닌 환경에서 운영했다면 한 번 보정해 두세요.

```sql
-- SQLite: 2.0 이전 행을 UTC 표기로 다시 씁니다.
-- '+9 hours' 자리에는 기록한 프로세스가 쓰던 오프셋의 부호를 뒤집어 넣으세요.
UPDATE my_table
SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at)
WHERE deleted_at IS NOT NULL
  AND deleted_at NOT LIKE '%Z';
```

실제 데이터에 돌리기 전에 사본에서 결과를 확인하세요. 존 표기가 없는 값을 어느 타임존의 프로세스가 썼는지는 ORM도 알 수 없습니다.

## 밀리초가 사라졌다면

ORM은 바인딩하는 모든 `Date`의 밀리초를 그대로 넘깁니다. 그걸 데이터베이스가 지키는지는 스키마 문제입니다.

- MySQL의 `DATETIME`과 `TIMESTAMP`는 소수 자릿수를 지정하지 않으면(`DATETIME(3)`) 초 단위까지만 저장합니다.
- PostgreSQL의 `TIMESTAMP`/`TIMESTAMPTZ`는 기본적으로 마이크로초까지 갖고 있습니다.
- SQLite는 커넥터가 만든 텍스트를 그대로 저장하므로 밀리초가 남습니다.

저장한 엔티티와 넘긴 `Date`의 밀리초가 다르다면 컬럼 정밀도부터 확인하세요.
