# API

이 문서는 Models를 호출하는 Agent 서비스 개발자와 운영자를 위한 계약이다.
브라우저는 Studio OIDC 세션을, 서버는 Studio에서 발급한 OAuth access token을 사용한다.
Bearer token은 `urn:opspresso:agent:models` audience와 요청에 맞는 scope가 필요하다.

## 권한

| Scope | 동작 |
| --- | --- |
| `models:read` | 활성 선택 모델 조회 |
| `models:invoke` | 현재 Studio 계정 권한이 허용하는 모델 실행 |
| `models:manage` | 공급자·선택·수집 관리. Studio의 현재 유효 관리자만 허용 |
| `usage:read` | 본인 사용량 조회. 관리자는 전체 조회 |

JWT 서명·issuer·audience·만료를 검증한 뒤 introspection으로 client·세션의 현재 유효성을
확인한다. 사용자 token은 UserInfo로 현재 권한을 확인한다. 서비스 token은 서비스 주체로
집계하며 사용자·Agent를 요청 본문이나 임의의 헤더로 선택할 수 없다. 브라우저의 변경 요청은
`AUTH_BASE_URL`과 같은 Origin만 허용한다.

## 조회와 관리

| Method | 경로 | 입력·결과 |
| --- | --- | --- |
| GET | `/v1/models` | OpenAI 형식의 `{object:"list", data:[...]}`. 활성 선택 모델만 포함 |
| GET | `/api/models` | 선택 모델 배열. `all=true`는 관리자와 `models:manage` scope 필요 |
| PUT | `/api/models` | `{revision, model}`. 신규는 `revision:null`, 갱신은 읽은 revision |
| GET | `/api/providers` | 관리자용 공급자 배열. 원문·암호화 자격 증명은 반환하지 않음 |
| PUT | `/api/providers` | `{revision, provider}`. 빈 `secret`은 기존 값을 보존 |
| POST | `/api/providers/{id}/discover` | 공급자의 현재 모델 목록 수집 |
| GET | `/api/discovered` | `provider`, `limit`(1–500), `after`(wire ID)로 수집 목록 조회 |
| GET | `/api/usage` | 기간·그룹 필터와 전체 기간 합계 |
| GET | `/api/usage/{service}/{requestId}` | 허용된 요청 한 건의 상태·사용량·가격 snapshot |

선택 모델에는 `providerKind`, `providerName`, `providerEnabled`를 함께 제공한다. 공급자 주소나
자격 증명은 일반 모델 조회 응답에 포함하지 않는다. 서로 다른 공급자의 wire ID가 같아도 선택 ID로
구분한다. 호출 시 현재 선택 ID를 사용하며, router가 승인된 wire ID로 바꾼다.

## Inference

`POST /v1/{operation}`에 선택 모델 ID를 `model`로 보낸다. 지원 작업은
`chat/completions`, `responses`, `messages`, `messages/count_tokens`, `embeddings`, `images`,
`images/generations`, `images/edits`, `audio/transcriptions`, `rerank`, `decisions`,
`generateContent`, `streamGenerateContent`다. 선택 모델에 허용한 작업만 실행한다.
`images/edits`와 `audio/transcriptions`는 multipart도 허용한다.

고유한 `Idempotency-Key` 또는 `X-Request-Id`를 지정한다. 생략하면 서버가 ID를 만들고 응답의
`X-Request-Id`로 반환한다. 같은 서비스의 같은 ID는 다시 실행하지 않고 409로 거부한다.
결과가 불명확하면 요청 사용량 API를 조회한다. SDK의 유료 HTTP 자동 재시도는 끈다.

응답 JSON·SSE는 공급자의 원래 wire 형식을 유지한다. 자격 증명과 작업 경로는 router가
결정하며 redirect를 따르지 않는다. 공급자의 오류 본문은 그대로 노출하지 않는다. 지원하지 않는
호스팅 파일·대화 참조나 background 실행은 호출 전에 거부한다.

## 사용량

`from`, `to`는 ISO timestamp이며 시작은 포함하고 끝은 제외한다. 최대 기간은 366일이다.
`groupBy`는 `model`, `user`, `agent`, `service`, `day` 중 하나이며 `day`는 UTC 기준이다.
선택 필터는 `subject`, `agentId`, `modelId`, `service`다. 일반 사용자의 subject는 서버가 고정한다.
`limit`은 1–500, `after`는 이전 페이지의 마지막 그룹 키다.

응답의 `groups`는 해당 페이지, `totals`는 전체 기간의 합계다. 두 결과는 같은 DB snapshot을
사용하며 페이지 변경이 전체 합계를 바꾸지 않는다. `usage`의 각 단위에는 관측 합계 `total`과
관측 요청 수 `observedRequests`가 있다. 한 번도 관측하지 못한 단위는 생략한다.

`unpriced`는 금액을 확정하지 못한 요청 수다. `costUsd`는 확인된 금액만 합산하며
미확정 금액을 0원으로 확정하는 의미가 아니다. 실패·취소·실행 중·결과 불명 건수도 별도로 반환한다.
