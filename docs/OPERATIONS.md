# 운영

## 설정

| 변수 | 기본값·조건 |
| --- | --- |
| `DATABASE_URL` | 필수. 공유 PostgreSQL 연결 |
| `AES_ENCRYPTION_KEY` | 필수. canonical base64 32바이트. 공급자 secret 암호화 |
| `AUTH_BASE_URL` | 필수. Models의 HTTP(S) origin |
| `AUTH_SECRET` | 필수. 최소 32자. 세션과 OIDC token 암호화 |
| `OIDC_ISSUER` | 필수. Studio 연결 화면에 표시된 정확한 issuer |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | 필수. Models용으로 등록한 같은 client의 값 |
| `OIDC_PROVIDER_ID` | `studio`. 계정과 callback의 고정 식별자 |
| `OIDC_SCOPES` | 기본 identity·Models scope. 변경 시 `openid email profile platform:identity` 필수 |
| `MODEL_REQUEST_TIMEOUT_MS` | 600000. 1–3600000 ms |
| `MODEL_MAX_CONCURRENT_REQUESTS` | 64. 1–1000. DB로 공유하는 실행 한도 |
| `MODEL_MAX_REQUEST_BYTES` | 100663296(96 MiB). 1–256 MiB. 단일 요청과 프로세스의 입력 보관 예산 |
| `MODEL_MAX_STREAM_BUFFER_BYTES` | 268435456(256 MiB). 64 MiB–1 GiB. 프로세스가 공유하는 SSE payload 보관 예산 |

Provider, model과 가격은 관리 API에서 저장한다. 키를 환경 변수와 별도 provider 목록에
중복 등록하지 않는다. Bedrock은 표준 AWS credential chain을 사용하며 signing region은
endpoint hostname에서 읽는다. 공개 카탈로그 사실은 image에 포함되므로 부팅에 외부 인터넷이
필요하지 않다. 필수 연결은 PostgreSQL과 설정된 Studio이며, 모델 호출·수집은 등록된 공급자를 사용한다.

## 부팅과 probes

`/api/health`는 프로세스 생존, `/api/ready`는 bootstrap과 DB 연결을 확인한다.
첫 bootstrap은 Models 소유 schema만 생성하고 Studio discovery에서 검증 가능한 OIDC 제공자를
확인한다. bootstrap 실패는 503이며, 정리한 연결을 닫고 5초 뒤 다음 요청에서 다시 초기화할 수 있다.
이 경로는 모델 호출 접수 전이므로 유료 요청을 재실행하지 않는다.

실행 deadline을 지난 요청은 30초 간격으로 결과 불명 처리한다. 새 접수도 만료 요청을 먼저
정리한다. 추론 본문은 보관하지 않으며 JSON·SSE에서는 제한된 사용량·상태 필드만 추출한다.
스트림 종료 표식을 읽은 SDK의 연결 종료는 정상 완료로 정산한다.
SSE는 한 event를 최대 64 MiB까지 메모리에서 검증한 뒤 전달한다. 이는 Models의 플랫폼
상한이며 provider의 한도나 전체 응답 한도가 아니다. 초과 시 `provider_event_too_large`로
정산하고 고정된 stream 오류를 반환한다. 원문을 잘라 성공으로 반환하거나 추론을 재시도하지 않는다.
미완료 event와 검증 후 소비자를 기다리는 bytes는 모두 공유 예산에 포함한다. 소비·취소·예외에서
reservation을 해제한다. 공유 예산이 부족하면 해당 event를 `provider_stream_capacity_exceeded`로
종료하고 upstream을 닫는다. 이전에 전달한 정상 event와 관측한 부분 사용량은 보존한다.
이 예산은 raw payload bytes의 한도이며 parser·network chunk·런타임 메모리까지 포함한 RSS 한도는 아니다.

OIDC access/refresh token은 암호화해서 저장한다. 갱신은 계정별 DB 잠금으로 직렬화하며
전용 잠금 pool이 auth pool을 소진하지 않는다. 권한은 token에 남은 과거 값이 아니라
introspection과 현재 UserInfo를 기준으로 검사한다. 응답 불능을 익명·관리자 권한으로 대체하지 않는다.

## 배포와 데이터

Docker image는 standalone Next.js 앱을 비특권 사용자로 실행하며 기본 포트는 3400이다.
암호화 키·auth secret·OIDC client 값을 유지한다. 키를 바꾸면 저장된 credential·token을 읽지 못할 수 있다.
인식하지 못한 Models schema는 reset하지 않고 부팅을 거부한다. 형제 서비스 테이블과 사용자
원본 데이터는 삭제하거나 초기화하지 않는다.

배포 순서는 Studio OIDC 제공자 → Models client 등록·설정 → Models rollout → 소비 서비스 전환이다.
Tag·CI·GitOps revision·Pod readiness와 실제 로그인·모델 요청·원장 반영을 각각 확인한다.

## 장애 확인

- 401: 만료·철회·잘못된 대상 token이다. Studio 로그인 또는 서비스 credential 설정을 확인한다.
- 403: 현재 역할이나 scope가 작업을 허용하지 않는다. 다른 사용자·관리자로 대체하지 않는다.
- 409: 설정 revision 충돌 또는 이미 접수한 request ID다. 설정을 다시 읽거나 원장을 조회한다.
- 429: 입력 보관 예산 또는 동시 실행 한도다. 접수 여부를 확인하고 새 작업을 조절한다.
- 503: DB·Studio·bootstrap 상태를 확인한다. 로그에는 credential·prompt·원문 provider 오류를 남기지 않는다.

결과 불명 요청은 자동 재실행하지 않는다. 실제 공급자 처리 여부를 확인할 수 없으면 불명 상태와
미확정 비용을 유지한다. 가격 변경으로 과거 요청의 snapshot을 덮어쓰지 않는다.


## 릴리즈와 배포

`v*` tag의 release workflow는 같은 commit의 CI를 통과한 뒤 공통 Agent service release를
호출한다. ECR·GHCR image와 GitHub Release를 게시하고 GitOps alpha·prod 선언을 갱신한다.
수동 release 실행은 검증과 image build만 수행하며 게시·배포하지 않는다.

첫 설치에는 Models의 ECR 저장소·GitHub OIDC role, GitOps chart·Secret·등록 Studio client가
필요하다. 준비 전 tag를 게시하지 않는다. `GITOPS_AUTO_DEPLOY=false`로 image 발행과 조정된
플랫폼 배포를 분리할 수 있다. 실제 배포는 image revision·readiness·OIDC 로그인·선택 모델
실행과 원장으로 확인한다. Tag 생성이나 workflow 시작은 배포 완료가 아니다.
