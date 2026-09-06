# 다음 세션 프롬프트

아래 블록을 새 세션에 그대로 붙여넣으세요.

---

```
C:\dev\mylecture_1 의 "10년 뒤의 나" 웹앱을 이어서 작업합니다.
README.md, RUNBOOK.md, PRD_10년뒤_나_그림생성_웹앱.md, HANDOFF.md 를 먼저 읽어주세요.

## 현재 상태
Next.js 16 + Supabase + Vercel Hobby. 커밋 31개. PRD 전 기능 구현 + 화면 연결 완료.
로컬 검증 기준선: 단위 91 / API 스모크 86 / Playwright 19 / verify-gate SQL 불변식 —
전부 PASS. 작업 후 이 숫자가 줄면 회귀입니다.

## 지난 세션에 한 일
1. 교사 설정에 **학생이 고를 수 있는 그림** · **화질** 추가.
   화질 버튼에 장당 단가가 찍히고, 높음(약 4배)은 바꾸기 전에 물어봅니다.
2. 대기열에 **지난 수업 정리**. 수업 전 점검의 빨간 안내가 가리키던 그 버튼입니다.
3. medium 단가 $0.045 → **$0.041** (PRD가 맞았음). 단가는 이제 src/lib/pricing.ts
   한 곳에만 있습니다.
4. 결과 화면 '그림 저장하기'가 파일 준비 전에도 눌리던 것 수정.
5. scripts/age-drift-grid.ts — RUNBOOK '수업 전날 5'의 24장 그리드.
6. 마이그레이션 README가 7개 중 3개만 설명하던 것 + 없는 스크립트 참조 제거.
7. e2e 로그인을 실행당 1회로 (분당 10회 제한을 스위트가 넘고 있었음).

## 남은 후보 (사용자가 아직 고르지 않음)
- **예상 비용이 화질 변경을 소급 적용합니다.** 교사 화면은 완료된 그림 전부를 세션의
  '지금' 화질로 계산하므로, 수업 중에 low→high 로 바꾸면 이미 그린 그림 값까지 33배로
  다시 매겨집니다. 정확히 하려면 jobs 행에 화질을 기록해야 하고 그건 마이그레이션입니다.
  (lib/openai/image.ts 주석에 적어 뒀습니다.)
- 세션 총 상한을 채운 뒤의 학생 화면 문구 검토
- 갤러리 무한 스크롤 (지금은 전체 로드)

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

## 로컬 실행
npx supabase start   # CLI 2.101.0이면 config.toml의 [local_smtp]를 못 읽습니다.
                     # CLI를 2.116+ 로 올리세요(그 줄을 [inbucket]으로 바꾸는 건 임시방편).
pnpm db:push         # 0007까지 적용
# Storage에 'drawings' public 버킷 (없으면 수업 전 점검이 알려줌)
pnpm build && pnpm start
pnpm test                        # 91
pnpm tsx scripts/smoke.ts        # 86
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

## 아직 사람이 해야 하는 것 (자격증명 필요)
- 실제 Supabase에 db:push (0007 포함) + 'drawings' 버킷 + Vault 시크릿 2개
  (app_url, worker_secret)
- Postgres 15.1.1.61 이상 / pg_cron·pg_net 활성 확인
- Vercel 배포 (저장소는 개인 GitHub 계정 — Hobby는 조직 저장소 연결 불가)
- pnpm check:limits 로 실제 IPM 확인 (Admin 키 필요)
- 수업 전날: 교사 화면에서 스타일 예시 3장 생성, 금칙어 검토,
  pnpm tsx scripts/age-drift-grid.ts --go 로 연령 드리프트 24장 확인 (약 $0.12)
```

---

## 이 프롬프트에 담은 것과 뺀 것

**담은 것**: 새 세션이 모르면 같은 함정을 다시 밟게 되는 것들. 이번에 추가된 세 가지는
전부 "코드만 봐서는 왜 그런지 알 수 없는" 것들입니다 — 정리 액션이 closed 세션에만
걸리는 이유, /api/jobs 의 스타일 검증이 클라이언트 필터로 대체될 수 없는 이유,
그리고 단가가 왜 server-only 가 아닌 파일에 있는지.

worker_lock 항목에 "서버 kill 직후 e2e를 돌리면 앞쪽 테스트가 실패한다"를 덧붙였습니다.
이번 세션에 실제로 겪었고, 증상(그림이 안 나옴)과 원인(락)이 전혀 닮지 않아서
한 번은 회귀로 오해했습니다.

**뺀 것**: 아키텍처 설명. README에 있고, 새 세션이 읽으면 됩니다. 프롬프트에 중복으로 넣으면
길어지기만 하고 README와 어긋날 위험이 생깁니다.
