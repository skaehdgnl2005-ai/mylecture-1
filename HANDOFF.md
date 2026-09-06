# 다음 세션 프롬프트

아래 블록을 새 세션에 그대로 붙여넣으세요.

---

```
C:\dev\mylecture_1 의 "10년 뒤의 나" 웹앱을 이어서 작업합니다.
README.md, RUNBOOK.md, PRD_10년뒤_나_그림생성_웹앱.md 를 먼저 읽어주세요.

## 현재 상태
Next.js 16 + Supabase + Vercel Hobby 로 PRD 전 기능이 구현돼 있고 커밋 23개가 있습니다.
지난 세션에서 "API는 있는데 화면이 없던" 4곳을 전부 연결했고, 그 과정에서 찾은
수업 당일 블로커 2개를 고쳤습니다.

로컬 Supabase 기준 검증 완료:
  단위 91개 / API 스모크 63개 / Playwright 13개 / SQL 불변식(verify-gate) 전부 PASS.

## 지난 세션에 한 일
화면 연결 4개
  1. 교사 화면 **수업 전 점검** (PreflightPanel) — 5개 항목 + 40장 예상 시간
  2. 교사 화면 **기기별 남은 횟수 / 횟수 초기화** (DevicePanel, PRD §F3)
  3. 교사 화면 **스타일 예시 생성** (StyleSamplePanel, PRD §F4)
  4. 갤러리에서 학생이 본인 그림 **내리기 / 다시 올리기** (+ 결과 화면 토글이
     '다시 켜기'를 서버에 보내지 않던 버그 수정)

수업 당일 블로커 2개
  5. 15분(deadline_at)을 넘긴 queued 잡이 영원히 멈추고 학생 횟수까지 잡아먹던 문제
     → reap_expired_leases() 가 failed 로 넘김 (마이그레이션 0007)
  6. '수업 닫기'가 대기 중인 그림을 전부 버리던 문제 → draining 을 거쳐 큐를 비운 뒤
     스스로 closed

그 외
  7. 대기열 화면의 '기기' 열이 항상 '알 수 없음' 이던 것
  8. 생성 실패 시 학생의 5개 답변이 전부 지워지던 것
  9. `pnpm db:push` / verify-gate 가 문서대로는 아예 실행되지 않던 것

## 다음 후보 (사용자가 아직 고르지 않음)
- 교사 설정에 '사용 가능 스타일'·'화질' 넣기 (PATCH 라우트는 이미 받고 있음.
  화질은 비용 4배라 경고 문구 필요)
- 예상 비용 단가가 PRD와 다름 (medium $0.045 vs $0.041) — 어느 쪽이 맞는지 확인 필요
- supabase/migrations/README.md 가 6개 중 3개만 설명하고 없는 스크립트를 가리킴
- RUNBOOK '수업 전날 5 — 24장 미리보기 그리드'를 실행할 스크립트가 없음

## 절대 되돌리면 안 되는 것들 (이유는 코드 주석에)
- claim_job() 의 `update pacer ... where id` — WHERE 빼면 Supabase의 pg-safeupdate가
  모든 클레임을 거부해 큐가 멈춥니다. 일반 Postgres에서는 통과해서 안 걸립니다.
- pg_cron은 '10 seconds' 같은 문자열을 1분 미만에만 허용. '1 minute'은 에러.
- 교사 쿠키 secure 플래그는 요청 프로토콜 기준. NODE_ENV 기준으로 바꾸면
  next start(=production)에서 로컬 http 인증이 조용히 깨집니다.
- devices에 generation_count 컬럼 만들지 말 것. 할당량은 jobs 파생 COUNT이고,
  교사 화면에 보이는 '남은 횟수'도 src/lib/device-usage.ts 에서 같은 규칙으로 계산합니다
  (used_quota() 와 짝지어 테스트로 고정돼 있으니 한쪽만 바꾸지 마세요).
- /api/gallery/{코드} 의 SELECT 는 id,url,tags 세 컬럼 고정. 소유 확인은 별도 경로
  (POST /api/gallery/{코드}/mine). 여기에 소유 표시를 얹으면 교실 전체가 공유하는
  ETag 304가 깨집니다.
- 브라우저에 Supabase 키 노출 금지. NEXT_PUBLIC_ 변수는 0개.
- moderation:'auto' 하드코딩 유지. archiver는 ^7 고정(@types도 ^6).
- 프롬프트 모듈은 클라이언트 import 금지 (chips.test.ts가 검사).
- 세션 닫기는 반드시 draining 을 거칩니다. 바로 closed 로 바꾸면 worker의 tick()이
  즉시 반환해서 대기 중인 그림이 전부 버려집니다.

## 로컬 실행
npx supabase start        # 포트 553xx (mymap-app 스택과 충돌 안 함)
                          # CLI가 2.101.0 이면 config.toml의 [local_smtp] 를 못 읽습니다.
                          # supabase CLI를 2.116+ 로 올리거나, 그 줄만 [inbucket] 으로 바꾸세요.
pnpm db:push
# Storage에 'drawings' public 버킷 생성
pnpm build && pnpm start
pnpm tsx scripts/smoke.ts # 63개 전부 PASS 여야 함

.env.local 의 MOCK_OPENAI=1 로 OpenAI 없이 전체 흐름 확인 가능.
verify-gate.ts 돌릴 때는 앱 서버를 끄세요(워커가 테스트 잡을 가져갑니다).

앱 서버를 강제 종료했다면 worker_lock 이 최대 300초 잡혀 있어 그동안 tick이
전부 skip 됩니다. 큐가 안 도는 것처럼 보이면 이걸 먼저 의심하세요.

## 아직 사람이 해야 하는 것 (자격증명 필요)
- 실제 Supabase에 db:push (0007 포함) + 'drawings' 버킷 + Vault 시크릿 2개
  (app_url, worker_secret)
- Postgres 15.1.1.61 이상 / pg_cron·pg_net 활성 확인
- Vercel 배포 (저장소는 개인 GitHub 계정 — Hobby는 조직 저장소 연결 불가)
- pnpm check:limits 로 실제 IPM 확인 (Admin 키 필요)
- 수업 전날: 교사 화면에서 스타일 예시 3장 생성, 금칙어 검토,
  연령 드리프트 확인용 24장 그리드
```

---

## 이 프롬프트에 담은 것과 뺀 것

**담은 것**: 새 세션이 모르면 같은 함정을 다시 밟게 되는 것들 — pg-safeupdate, pg_cron 문법,
쿠키 secure 플래그, 그리고 이번에 추가된 두 가지: 갤러리 ETag를 깨뜨리는 변경과
세션을 바로 closed 로 바꾸는 변경. 전부 코드만 봐서는 이유를 알 수 없는 것들입니다.

**뺀 것**: 아키텍처 설명. README에 있고, 새 세션이 읽으면 됩니다. 프롬프트에 중복으로 넣으면
길어지기만 하고 README와 어긋날 위험이 생깁니다.
