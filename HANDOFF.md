# 다음 세션 프롬프트

아래 블록을 새 세션에 그대로 붙여넣으세요.

---

```
C:\dev\mylecture_1 의 "10년 뒤의 나" 웹앱을 이어서 작업합니다.
README.md, RUNBOOK.md, PRD_10년뒤_나_그림생성_웹앱.md 를 먼저 읽어주세요.

## 현재 상태
Next.js 16 + Supabase + Vercel Hobby 로 PRD 전 기능이 구현돼 있고 커밋 10개가 있습니다.
로컬 Supabase 기준으로 검증 완료: 단위 83개, API 스모크 33개, Playwright 수용기준 6개,
SQL 불변식 검증(3회 연속 동일 결과). 부하 테스트에서 20건 동시 투입 시
IPM=5 → 251초, IPM=20 → 67초로 페이서가 설정값을 정확히 따라갑니다.

## 먼저 해야 할 일 — API는 있는데 UI가 없는 3곳
지난 세션에서 라우트만 만들고 화면에 연결하지 않았습니다. RUNBOOK이 이미 이 기능들을
안내하고 있어서 그대로 두면 문서와 앱이 어긋납니다.

1. GET /api/health/preflight → 교사 화면에 "수업 전 점검" 섹션 없음
   (RUNBOOK "수업 전날 1번"이 이 화면을 쓰라고 안내함. 5개 항목 초록/빨강 + 조치 문구,
    그리고 40장 예상 소요 시간을 크게 보여줄 것)
2. POST /api/teacher/devices/[id]/reset → "이 기기 횟수 초기화" 버튼 없음 (PRD §F3)
   (/api/teacher/session-images 가 이미 devices[] 에 label·count·resetAt 를 반환함)
3. POST /api/teacher/style-samples → "스타일 예시 생성" 버튼 없음 (PRD §F4)
   (수업 중 누르면 안 된다는 경고 문구를 버튼 옆에 붙일 것)

그다음 순위:
4. 갤러리 페이지에서 학생이 본인 그림 내리기 (지금은 결과 화면 토글로만 가능)
5. 교사 화면에서 이미지 삭제(숨김이 아니라 완전 삭제) — PRD에 없으니 필요한지 먼저 물어볼 것

## 절대 되돌리면 안 되는 것들
이유가 코드 주석에 다 적혀 있습니다. 바꾸기 전에 읽어주세요.
- claim_job() 의 `update pacer ... where id` — WHERE 빼면 Supabase의 pg-safeupdate가
  모든 클레임을 거부해서 큐가 아예 안 돕니다. 일반 Postgres에서는 통과하므로 안 걸립니다.
- pg_cron은 '10 seconds' 같은 문자열을 1분 미만에만 허용합니다. '1 minute'은 에러입니다.
- 교사 쿠키의 secure 플래그는 요청 프로토콜 기준입니다. NODE_ENV 기준으로 바꾸면
  next start(=production)에서 로컬 http 인증이 조용히 깨집니다.
- devices에 generation_count 컬럼을 만들지 마세요. 할당량은 jobs 파생 COUNT입니다.
- 브라우저에 Supabase 키를 절대 노출하지 마세요. NEXT_PUBLIC_ 변수는 0개입니다.
- moderation:'auto' 는 하드코딩입니다. 환경변수로 빼지 마세요.
- archiver는 ^7 고정 (@types도 ^6). v8은 API가 달라 조용히 실패합니다.
- 프롬프트 모듈은 클라이언트에서 import 금지 (chips.test.ts가 이걸 검사합니다).

## 로컬 실행
npx supabase start        # 포트 553xx (mymap-app 스택과 충돌 안 함)
pnpm db:push
# Storage에 'drawings' public 버킷 생성 (없으면 preflight가 알려줌)
pnpm build && pnpm start
pnpm tsx scripts/smoke.ts # 33개 전부 PASS 여야 함

.env.local 에 MOCK_OPENAI=1 이 있으면 OpenAI를 호출하지 않고 전체 흐름을 돌려볼 수 있습니다.
verify-gate.ts 를 돌릴 때는 앱 서버를 반드시 끄세요(워커가 테스트 잡을 가져갑니다).

## 아직 사람이 해야 하는 것 (자격증명 필요)
- 실제 Supabase에 pnpm db:push + 'drawings' 버킷 + Vault 시크릿 2개(app_url, worker_secret)
- Postgres 버전 15.1.1.61 이상인지, pg_cron·pg_net 켤 수 있는지 확인
- Vercel 배포 (저장소는 개인 GitHub 계정 아래여야 함 — Hobby는 조직 저장소 연결 불가)
- pnpm check:limits 로 실제 IPM 확인 (Admin 키 필요)
- 수업 전날: 스타일 예시 3장 생성, 금칙어 목록 검토, 연령 드리프트 확인용 24장 그리드
```

---

## 이 프롬프트에 담은 것과 뺀 것

**담은 것**: 새 세션이 모르면 같은 함정을 다시 밟게 되는 것들 — pg-safeupdate, pg_cron 문법,
쿠키 secure 플래그. 셋 다 지난 세션에서 실제로 겪은 것이고, 코드만 봐서는 이유를 알 수 없습니다.

**뺀 것**: 아키텍처 설명. README에 있고, 새 세션이 읽으면 됩니다. 프롬프트에 중복으로 넣으면
길어지기만 하고 README와 어긋날 위험이 생깁니다.
