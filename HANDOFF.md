# 다음 세션 프롬프트

아래 블록을 새 세션에 그대로 붙여넣으세요.

---

```
C:\dev\mylecture_1 의 "10년 뒤의 나" 웹앱을 실제로 배포하고 수업 리허설까지 하려고 합니다.
README.md, RUNBOOK.md, HANDOFF.md 를 먼저 읽어주세요. (PRD는 필요할 때만 — 기능은 이미 전부
구현돼 있습니다.)

## 현재 상태
Next.js 16 + Supabase + Vercel Hobby. 커밋 32개. PRD 전 기능 구현 + 화면 연결 완료.
로컬 검증 기준선: 단위 91 / API 스모크 86 / Playwright 19 / verify-gate SQL 불변식 —
전부 PASS. 작업 후 이 숫자가 줄면 회귀입니다.

**코드는 끝났습니다. 이번 세션은 기능 추가가 아니라 실제 인프라에 올리는 세션입니다.**
아래 1~3은 제 자격증명이 필요하니, 값을 어디서 가져와야 하는지 알려주시면 제가 붙여넣겠습니다.

## 이번 세션 작업 (순서대로)

### 1. 실제 Supabase
- `pnpm db:push` 로 마이그레이션 0007까지 적용
- Storage에 **`drawings` 이름의 public 버킷** 생성
- Vault 시크릿 2개 (SQL 편집기에서 한 번):
    select vault.create_secret('<배포된 주소>', 'app_url');
    select vault.create_secret('<WORKER_SECRET 값>', 'worker_secret');
- Database > Extensions 에서 `pg_cron`, `pg_net` 활성화 확인
- **Postgres 15.1.1.61 이상**이어야 `'10 seconds'` 스케줄이 동작합니다. 낮으면 업그레이드부터.

### 2. Vercel 배포
- 저장소는 **개인 GitHub 계정** 아래에 있어야 합니다. Hobby는 조직 소유 저장소에 연결이
  안 됩니다.
- `.env.example` 의 변수를 전부 Vercel 환경변수로 등록 (`MOCK_OPENAI` 은 **제외** —
  프로덕션에 이게 켜져 있으면 학생 전원이 1x1 픽셀을 받습니다)
- `CRON_SECRET` 을 하나 추가해야 vercel.json 의 일일 keep-alive cron이 동작합니다
- **순서 주의**: 배포해야 실제 주소가 나옵니다. 그러니 1번의 Vault `app_url` 과 환경변수
  `APP_URL` 은 **배포 뒤에 다시** 채워야 합니다. 이걸 놓치면 pg_cron이 조용히 아무 데도
  요청을 보내지 않고, 증상은 "모두 대기에서 멈춤"으로만 보입니다.

### 3. 프로덕션 점검
- `/teacher` 로그인 → **수업 전 점검** 다섯 줄이 전부 초록인지
- `pnpm check:limits` 로 계정의 진짜 분당 한도 확인 (Admin 키 `sk-admin-...` 필요).
  `OPENAI_IPM` 환경변수와 다르면 환경변수를 고치고 재배포.
- 학생 1명 흐름을 **손으로** 한 번 걸어보기 (그림 1장, 약 $0.04)

> **scripts/smoke.ts 를 프로덕션 주소로 돌리지 마세요.** `MOCK_OPENAI` 는 서버 설정이라
> 스크립트가 강제할 수 없습니다. 프로덕션에서 돌리면 진짜 그림을 10장 가까이 그려서 돈과
> 분당 한도를 쓰고, 큐가 느려 drain 단계에서 어차피 실패합니다. 스모크는 로컬 전용입니다.

### 4. 수업 전날 리허설 (RUNBOOK '수업 전날' 그대로)
- 교사 화면 **스타일 예시 생성** 3장 (수업 중에는 절대 누르지 말 것)
- `src/lib/safety/banned-words.ts` 금칙어 검토 — 우리 학교에서 요즘 쓰는 말 추가
- `pnpm tsx scripts/age-drift-grid.ts --go` (약 $0.12, 6분 이상)
  → `out/age-drift/index.html` 열어서 **25살이 고등학생처럼 나온 칸이 있는지** 눈으로 확인
- `pnpm loadtest --code XXXX --n 20` — 마지막 GATE 세 줄이 전부 PASS여야 설정이 맞는 것

### 5. 배포가 막히면 / 자격증명 기다리는 동안 할 코드 작업
**예상 비용이 화질 변경을 소급 적용합니다.** 교사 화면은 완료된 그림 전부를 세션의 '지금'
화질로 계산하므로, 수업 중에 low→high 로 바꾸면 이미 그린 그림 값까지 33배로 다시 매겨집니다.
마이그레이션 0008로 `jobs` 행에 화질을 기록하고, `estimateCostUsd` 대신 행별 합계를 쓰면
정확해집니다. (lib/openai/image.ts 주석에 KNOWN IMPRECISION 으로 적어 뒀습니다.)

## 선생님이 결정하셔야 하는 것
**Vercel Hobby는 계약상 비상업 전용입니다.** "제작에 관여한 누구든의 금전적 이득"이 정의에
포함되어, 급여를 받는 교사가 업무에 쓰는 도구는 회색지대입니다. 위반 시 조치는 프로젝트
일시정지(503)이고 자동 해제되지 않습니다 — **수업 중에 걸리면 복구가 안 됩니다.** Pro(월 $20)로
올리거나 Vercel 지원팀에 문의하는 선택지가 있습니다. RUNBOOK '미리 알고 있어야 할 위험' 참고.

## 절대 되돌리면 안 되는 것들 (이유는 전부 코드 주석에)
- claim_job() 의 `update pacer ... where id` — WHERE 빼면 Supabase의 pg-safeupdate가
  모든 클레임을 거부해 큐가 멈춥니다. 일반 Postgres에서는 통과해서 안 걸립니다.
- pg_cron은 '10 seconds' 같은 문자열을 1분 미만에만 허용. '1 minute'은 에러.
- 교사 쿠키 secure 플래그는 요청 프로토콜 기준. NODE_ENV 기준으로 바꾸면
  next start(=production)에서 로컬 http 인증이 조용히 깨집니다.
- devices에 generation_count 컬럼 만들지 말 것. 할당량은 jobs 파생 COUNT이고,
  교사 화면의 '남은 횟수'는 src/lib/device-usage.ts 가 used_quota() 와 같은 규칙으로
  계산합니다. 한쪽만 바꾸면 device-usage.test.ts 가 잡습니다 — 테스트를 고치지 말고
  양쪽을 같이 고치세요.
- /api/gallery/{코드} 의 SELECT 는 id,url,tags 고정이고 ETag는 교실 전체가 공유합니다.
  소유 표시를 얹으면 304가 통째로 깨집니다. 소유 확인은 POST /api/gallery/{코드}/mine.
- 세션 닫기는 반드시 draining 을 거칩니다. 바로 closed 로 바꾸면 worker의 tick()이
  즉시 반환해서 대기 중인 그림이 전부 버려집니다.
- **'지난 수업 정리'는 status='closed' 인 세션만 건드립니다.** open/draining 을 범위에
  넣으면 수업 중에 누른 교사가 그 반의 대기열을 지웁니다. draining 이 특히 위험합니다 —
  거기 있는 그림이 바로 "끝까지 그려주겠다"고 약속한 것들입니다.
- **/api/jobs 의 allowed_styles 검증을 빼지 마세요.** 학생 폰은 그 목록을 입장할 때
  한 번만 읽습니다. 서버가 안 막으면 수업 중 스타일 끄기는 이미 들어와 있는 폰 전부
  (= 15분 수업에서는 교실 전체)에게 아무 일도 하지 않습니다. 거절 응답에 새 목록을
  실어 보내는 것도 필수입니다 — 안 그러면 같은 카드를 눌러 무한히 거절당합니다.
- **장당 단가는 src/lib/pricing.ts 한 곳뿐입니다.** server-only 아님(클라이언트가
  import 함). 값을 두 벌 두면 버튼의 가격과 청구서의 가격이 갈라집니다.
- 브라우저에 Supabase 키 노출 금지(NEXT_PUBLIC_ 0개). moderation:'auto' 하드코딩 유지.
  archiver ^7 고정(@types ^6). 프롬프트 모듈은 클라이언트 import 금지.

## 로컬 실행 (회귀 확인용)
npx supabase start   # CLI 2.101.0이면 config.toml의 [local_smtp]를 못 읽습니다.
                     # CLI를 2.116+ 로 올리세요(그 줄을 [inbucket]으로 바꾸는 건 임시방편).
pnpm db:push         # 0007까지 적용
# Storage에 'drawings' public 버킷 (없으면 수업 전 점검이 알려줌)
pnpm build && pnpm start
pnpm test                        # 91
pnpm tsx scripts/smoke.ts        # 86  ← 로컬 전용. 프로덕션에 돌리지 말 것
npx playwright test              # 19
pnpm tsx scripts/verify-gate.ts  # 앱 서버를 끄고 돌릴 것

.env.local 의 MOCK_OPENAI=1 로 OpenAI 없이 전체 흐름 확인 가능(비용 0).
앱 서버를 강제 종료했다면 worker_lock 이 최대 300초 잡혀 tick이 전부 skip 됩니다.
큐가 안 도는 것처럼 보이면 이걸 먼저 의심하세요 — 서버를 kill 한 직후 e2e를 돌리면
앞쪽 acceptance 테스트가 "그림이 안 나온다"로 실패합니다. 5분 기다렸다 다시 돌리세요.

## 작업 방식
- 화면을 만들면 scripts/smoke.ts 나 e2e/ 에 검증을 같이 넣어주세요. e2e/acceptance.spec.ts
  는 PRD §9 전용으로 동결돼 있으니 새 기능은 새 spec 파일에 씁니다.
- e2e 로그인은 e2e/auth.setup.ts 가 실행당 한 번만 합니다. 테스트 안에서는
  helpers.ts 의 teacherLogin/teacherLoginUi 를 쓰고, page.request 를 재사용하세요
  (별도 request fixture를 쓰면 컨텍스트가 하나 더 생겨 로그인이 하나 더 나갑니다).
- 커밋은 conventional commit(feat:/fix:/docs:/test:)으로 나눠서, 왜 그렇게 했는지를
  본문에 적어주세요. 이 저장소는 그 이유들이 자산입니다.
- **수업 중에는 배포하지 마세요.** git push 는 진행 중인 학생 작업을 흔듭니다.
```

---

## 이 프롬프트에 담은 것과 뺀 것

**담은 것**: 배포 순서에서 한 번 틀리면 증상만으로는 원인을 못 찾는 것들 —
`APP_URL`/Vault `app_url` 을 배포 후에 다시 채워야 한다는 것(안 하면 "모두 대기에서 멈춤"),
프로덕션에 `MOCK_OPENAI` 가 켜지면 학생 전원이 1x1 픽셀을 받는다는 것, 그리고
스모크를 프로덕션에 돌리면 진짜 돈이 나간다는 것. 마지막 항목은 스크립트가 스스로
막을 수 없어서 — `MOCK_OPENAI` 는 서버 설정입니다 — 문서에 적는 것 말고는 방법이 없습니다.

Vercel Hobby 비상업 조항을 "선생님이 결정하셔야 하는 것"으로 따로 뺐습니다. 기술적 선택이
아니라 위험을 감수할지의 판단이고, 수업 중에 걸리면 그날은 복구가 안 됩니다.

**뺀 것**: 아키텍처 설명과 PRD 재확인. README에 있고, 기능은 이미 다 구현돼 있어서
새 세션이 PRD를 처음부터 읽을 이유가 없습니다. 프롬프트에 중복으로 넣으면 길어지기만 하고
README와 어긋날 위험이 생깁니다.
