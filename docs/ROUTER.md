# 모델 라우터 실행 코어

이 문서는 라우터를 구현·운영하는 개발자를 위한 현재 코드 계약이다. Next.js가 HTTP·관리 화면을
제공하고 Studio OIDC가 사용자와 권한을 결정한다. 전체 개편과 완료 조건은
[플랫폼 계약](https://github.com/opspresso/agent-platform/blob/main/docs/MODEL_ROUTER.md)을 따른다.

## 책임

`domain/router`는 공급자·선택 모델·사용량과 가격 규칙을, `application`은 관리·호출·정산을
소유한다. PostgreSQL·암호화·공급자 HTTP는 `infrastructure`의 어댑터다. 사용자는 Studio가
인증한 주체로 전달하며, 사용자·Agent 귀속을 모델 요청 본문에서 가져오지 않는다.

공급자 자격 증명은 AES-256-GCM으로 암호화하며 공급자 ID·유형·인증 방식·정규화된 URL을 인증 데이터에 포함한다.
같은 연결의 마스킹된 자격 증명이나 빈 입력은 기존 값을 보존한다. 주소·유형을 바꾸면
자격 증명을 다시 입력해야 하며, 저장된 연결 정보를 변조하면 기존 암호문을 복호화할 수 없다. 공급자 URL은 내부 HTTP(S)
주소를 허용하지만 URL 안의 credential·query·fragment는 거부하고 redirect를 따르지 않는다.

## 수집과 선택

공급자의 목록은 사용 가능 여부를 확인하는 자료다. 유형·한도·가격을 확인할 수 없으면 없는
값을 만들지 않는다. 공개 카탈로그의 동일 공급자·wire ID 사실을 사용할 수 있다. OpenRouter는
텍스트·이미지·embedding·rerank·transcription·decision 목록을 각각 조회한다. 수집 실패나
계속 읽기 오류는 기존 목록을 부분 결과로 바꾸지 않는다.

운영자가 선택한 모델만 호출할 수 있다. 공급자는 최대 50개, 선택 모델은 최대 500개다.
같은 공급자의 동일 wire ID는 중복 선택하지 않는다. 설정 변경은 revision이 일치해야 하며,
공급자 또는 모델을 비활성화하면 새 요청을 거부한다. 수집은 모델을 자동 활성화하지 않는다.

## 호출과 원장

1. 실행 권한과 선택 모델의 operation을 검사한다.
2. `(service, request_id)`를 유일 키로 사용해 DB에 호출 의도를 기록한다. 당시 모델·가격과
   공급자 revision도 저장한다. 설정 변경으로 이미 접수한 요청의 가격을 바꾸지 않는다.
3. 선택한 공급자와 wire ID로 한 번 호출한다. 요청 본문의 다른 model 값이나 caller credential은
   공급자 대상·자격 증명을 바꾸지 못한다. HTTP 자동 재시도는 하지 않는다.
4. 응답의 text·image·vector 원문을 영속 저장하지 않고 JSON·SSE에서 사용량 숫자만 읽는다.
   SSE는 현재 event만 메모리에 보관하고 metadata projection으로 검증한다. 정상 event는 원문
   bytes를 전달하고, 오류 event는 고정된 protocol 오류로 바꾼 뒤 upstream을 닫는다.
   응답 소비가 끝나거나 취소되면 해당 execution ID로 정산한다. 같은 정산은 중복 집계하지 않는다.
5. deadline을 지난 실행은 결과 불명으로 기록한다. 다시 실행하지 않으며, 같은 실행에서 늦게
   도착한 확정 정산은 원장을 보정할 수 있다.

HTTP·MCP·CLI의 작업 성공 여부는 각 소비 서비스가 판정한다. 이 원장의 결과는 공급자 요청과
응답 수명이다. `succeeded`, `failed`, `cancelled`, `unknown`과 사용량의 `reported`, `partial`,
`unavailable`, `not_started`를 분리한다. 사용량이 없거나 불완전하면 0원으로 확정하지 않는다.
전송 전에 거부된 접수 요청만 `not_started`와 0원으로 기록한다.

SSE event 상한은 플랫폼 정책으로 64 MiB다. 줄 구분자까지 포함해 byte로 계산하며 전체
응답 크기를 제한하지 않는다. 파편화된 입력은 작은 slab에 모으고, 같은 network chunk의
검증된 작은 event는 묶어 전달한다. event 검증 전에 data를 노출하지 않으므로 뒤쪽 error 필드도
오류 정제 경계를 우회하지 못한다. 잘못된 UTF-8·JSON이나 상한 초과는 고정 오류로 종료하며
관측한 부분 사용량을 유지한다. 오류 정제는 provider 요청을 재시도하지 않는다.
하나의 transport가 모든 stream의 payload 보관 예산을 공유한다. 기본 256 MiB이며
`MODEL_MAX_STREAM_BUFFER_BYTES`로 64 MiB–1 GiB 범위에서 설정한다. 검증 전 event와 검증 후
전달 대기 bytes를 같은 owner가 계상하고 소비·취소·예외에서 해제한다. 용량 초과는 현재
event만 고정 오류로 끝내며 다른 stream의 reservation을 해제하지 않는다.

공급자가 보고한 비용을 우선 사용한다. xAI `cost_in_usd_ticks`는 10¹⁰으로 나눠 USD로 변환한다.
나머지는 당시 가격과 보고된 단위로 계산한다. [xAI 비용 계약](https://docs.x.ai/developers/cost-tracking).
Anthropic token counting은 소비된 추론 토큰으로 합산하지 않으며 무료 API 호출로 기록한다.
[Anthropic token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting).

공용 공급자 계정의 저장된 대화·파일·container와 비동기 background 실행을 요청할 수 없다.
자체 context와 함수 도구를 사용한다. 이 경계는 기존 Forge native 실행 계약과 같다.

## 조회와 검증

관리자는 전체 사용량을, 일반 사용자는 본인 사용량만 조회한다. 기간은 최대 366일이며 모델·
사용자·Agent·서비스·UTC 날짜로 묶는다. 한 페이지는 최대 500개 그룹이고 `after`로 다음
그룹을 조회한다. 미확정 금액은 합계에서 제외하되 `unpriced`에 별도로 센다.
토큰·이미지 수·오디오 초·검색 단위는 관측한 합계와 관측 요청 수를 함께 반환한다.
한 번도 보고되지 않은 사용량 단위는 0으로 만들지 않는다.

```bash
pnpm typecheck
pnpm test
pnpm build:check
DATABASE_URL=<local disposable database ending in _test> pnpm test:integration
```

통합 검사는 기존 데이터와 분리한 schema에서 동시 초기화·형제 데이터 보존·선택·암호화·
동시 접수·정산·취소·만료·권한별 집계를 검사한다. 유료 외부 모델은 호출하지 않는다.
