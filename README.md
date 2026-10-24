# Agent Models

Agent 플랫폼의 중앙 모델 관리·라우팅·사용량 서비스다. 공급자 연결과 자격 증명, 사용할 모델,
요청별 사용량과 비용을 한곳에서 관리한다. Studio가 신원과 권한을 결정하며 Models는 OIDC로
연결한다. 콘솔은 Studio와 같은 화면 패턴과 한국어·영어를 사용한다.

현재 브랜치에는 Models 서비스와 Studio의 연결 등록이 구현돼 있다. 다른 Agent 서비스의
모델 호출 전환과 실제 환경 배포는 [플랫폼 개편 계약](https://github.com/opspresso/agent-platform/blob/main/docs/MODEL_ROUTER.md)에 따라 진행한다.
기존 공개 배포는 아직 정적 카탈로그다.

## 실행

Node 24, pnpm 12, PostgreSQL이 필요하다. 형제 서비스와 같은 database를 사용하며
Models의 테이블에는 `agent_models_` 접두어를 붙인다.

1. Studio에서 **Settings → Platform connections**를 열어 **Agent Models**와 서비스 URL을
   등록한다. 로컬 기본 URL은 `http://localhost:3400`이다.
2. `.env.example`을 `.env.local`로 복사한다. database, 암호화 키, 인증 secret과 Studio에서
   발급한 `OIDC_*` 값을 설정한다. 비밀키는 발급할 때만 표시되므로 안전하게 보관한다.
3. 실행한다.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`http://localhost:3400`에서 Studio로 로그인한다. 첫 시작은 빈 Models schema를 초기화하며
기존 형제 서비스 테이블을 변경하지 않는다. 인식할 수 없는 기존 Models schema는 덮어쓰지 않는다.

## 운영자 작업

1. **Providers**에서 공급자의 API 기본 URL과 인증을 등록한다. API 키는 암호화해서 저장한다.
2. **Selected models → Discovered models**에서 공급자를 고르고 모델 목록을 수집한다.
3. 사용할 모델의 유형·한도·기능·API 작업·가격을 확인하고 선택한다. 수집만으로 사용을 허용하지 않는다.
4. **Usage**에서 모델·사용자·Agent·서비스·UTC 날짜별 사용량을 확인한다. 금액 미확정 요청은
   0원으로 취급하지 않는다. 일반 사용자는 본인 사용량만 조회한다.

실행 중에 바뀐 가격으로 과거 비용을 다시 계산하지 않는다. 중복 request ID는 재실행하지 않는다.
SDK가 `[DONE]`을 읽고 연결을 닫는 정상 종료와 사용자의 중단을 구분한다.

## API와 설정

- [API](docs/API.md): 선택 목록, inference, 관리, 사용량과 권한
- [운영](docs/OPERATIONS.md): 환경 변수, probes, database, 장애 처리
- [실행 코어](docs/ROUTER.md): 경계, 원장, 동시성, 가격
- [공개 카탈로그](docs/CATALOG.md): 모델 사실의 원본·수집·생성 규칙

공개 사실 문서 `/models.json`은 로그인 없이 제공한다. 설치별 선택 모델과 공급자 정보는 인증된
API로만 읽는다. 공개 카탈로그는 사용 권한을 부여하지 않는다.

## 검증

```bash
pnpm typecheck
pnpm test
pnpm build:check
DATABASE_URL=<local disposable database ending in _test> pnpm test:integration
pnpm build
pnpm exec playwright install chromium
DATABASE_URL=<local disposable database ending in _test> pnpm test:ui
```

통합·브라우저 검사는 테스트 database 안에 전용 schema를 만들고 종료 시 해당 schema만 삭제한다.
브라우저 검사는 실제 OIDC 제공자와 HTTP fixture로 로그인, 모델 선택·호출·사용량, 권한 회수,
비밀키 격리와 모바일 화면을 검증한다. 유료 외부 모델은 호출하지 않는다.

Google native 요청의 `cachedContent`/`cached_content`와 `fileData`/`file_data`는 같은 공유 provider resource 제한을 적용합니다.
대화 본문과 system instruction은 호출자가 제공한 inline context만 사용하며, 다른 작업의 provider file·cache 참조는 dispatch 전에 거절합니다.
[ProtoJSON 필드 이름 계약](https://protobuf.dev/programming-guides/json/#field-names-as-json-keys)을 따릅니다.
