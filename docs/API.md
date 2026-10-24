# API

이 문서는 Models를 호출하는 Agent 서비스 개발자와 운영자를 위한 계약이다.
브라우저는 Studio OIDC 세션을, 서버는 Studio에서 발급한 OAuth access token을 사용한다.
Bearer token은 `urn:opspresso:agent:models` audience와 요청에 맞는 scope가 필요하다.
DPoP·mTLS에 묶인 token은 지원하지 않으며, 이를 일반 Bearer token으로 보내면 401로 거부한다.

## 권한

| Scope | 동작 |
| --- | --- |
| `models:read` | 활성 선택 모델 조회 |
| `models:invoke` | 현재 Studio 계정 권한이 허용하는 모델 실행 |
| `models:manage` | 공급자·선택·수집 관리. Studio의 현재 유효 관리자만 허용 |
| `usage:read` | 본인 사용량 조회. 관리자는 전체 조회 |
| `usage:receipts` | 서비스 자격 증명으로 해당 서비스가 보낸 개별 요청의 영수증 조회. 사용자 토큰에는 적용하지 않음 |

JWT 서명·issuer·audience·만료를 검증한 뒤 introspection으로 client·세션의 현재 유효성을
확인한다. 사용자 token은 UserInfo로 현재 권한을 확인한다. 서비스 token은 서비스 주체로
집계하며 사용자·Agent를 요청 본문이나 임의의 헤더로 선택할 수 없다. 브라우저의 변경 요청은
`AUTH_BASE_URL`과 같은 Origin만 허용한다.

Studio가 실행 권한을 확인한 호출은 `urn:opspresso:agent:model-call` claim으로 한 요청에
제한할 수 있다. `version=1`, `requestId`, `modelId`, `operation`, 선택적 `agentId`를 검증하며
토큰의 최대 수명은 60초다. `Idempotency-Key`에 서명된 `requestId`를 그대로 보낸다.
다른 요청·모델·작업으로 바꾸면 공급자 호출 전에 403을 반환한다. 이 토큰의 `usage:read`는
해당 서비스와 요청의 영수증에만 적용하며 다른 영수증이나 전체 집계는 허용하지 않는다.
`usage:receipts`는 소비 서비스가 만료된 사용자 호출의 사용량을 복구하는 권한이다. 개별 영수증의
서비스가 발급받은 서비스와 같아야 한다. 다른 서비스·전체 집계·추론 실행을 허용하지 않는다.
HTTP 인증은 요청 시작 시 확인한다. 이미 승인한 스트림은 별도의 실행 제한 시간과 취소 신호를 따른다.

## 조회와 관리

| Method | 경로 | 입력·결과 |
| --- | --- | --- |
| GET | `/v1/models` | OpenAI 형식의 `{object:"list", data:[...]}`. 활성 선택 모델만 포함 |
| GET | `/api/models` | 선택 모델 배열. `all=true`는 관리자와 `models:manage` scope 필요 |
| PUT | `/api/models` | `{revision, model}`. 신규는 `revision:null`, 갱신은 읽은 revision |
| GET | `/api/providers` | 관리자용 공급자 배열. 원문·암호화 자격 증명은 반환하지 않음 |
| PUT | `/api/providers` | `{revision, provider}`. 같은 연결의 빈 `secret`은 기존 값을 보존. 주소·유형 변경 시 새 키 필요 |
| POST | `/api/providers/{id}/discover` | 공급자의 현재 모델 목록 수집 |
| GET | `/api/discovered` | `provider`, `limit`(1–500), `after`(wire ID)로 수집 목록 조회 |
| GET | `/api/usage` | 기간·그룹 필터와 전체 기간 합계 |
| GET | `/api/usage/{service}/{requestId}` | 허용된 요청 한 건의 상태·사용량·가격 snapshot |

선택 모델에는 `providerKind`, `providerName`, `providerEnabled`, `providerRevision`을 함께 제공한다.
소비 서비스의 embedding 캐시는 선택 ID·공급자 ID·공급자 revision·wire ID·차원을 구분한다.
공급자 연결 변경 후 이전 공간의 query vector를 재사용하지 않는다. 공급자 주소나
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
이미지·오디오는 인라인 `data:...;base64,...` 또는 업로드한 multipart bytes로 전달한다.
공급자가 외부 URL에서 이미지·파일을 가져오게 하는 참조는 허용하지 않는다. 일반 텍스트의 URL과
함수 도구 스키마는 그대로 전달한다. multipart의 `file`, `image`, `mask` 필드는 실제 파일이어야 한다.

응답의 `x-model-dispatch`는 이번 HTTP 시도의 공급자 전송 여부를 나타낸다. `not_started`는
전송 전 거부이며 `started`는 전송을 시도했다는 뜻이다. 헤더가 없거나 응답을 받지 못한 경우에는
미전송으로 추정하지 않는다. 동일 요청 ID의 기존 영수증이 있으면 그 영수증을 우선한다.

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
