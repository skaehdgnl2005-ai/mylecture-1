# 10년 뒤의 나

중학생이 폰으로 접속해 5스텝 폼을 채우면 "10년 뒤 가장 행복한 어느 하루의 한 장면"을 그려주고,
반 전체가 익명 갤러리로 함께 감상하는 수업용 웹앱.

구현 대상 사양은 [PRD](./PRD_10년뒤_나_그림생성_웹앱.md), 수업 당일 절차는 [RUNBOOK.md](./RUNBOOK.md).

---

## 이 앱을 쓰기 전에 꼭 알아야 할 숫자

**OpenAI 계정의 분당 이미지 한도가 이 앱의 모든 것을 결정합니다.**

| 한도 | 20명 × 2장 = 40장 소요 시간 |
|---|---|
| 5 IPM (Tier 1) | **약 9분** |
| 20 IPM (Tier 2) | 약 2.5분 |

- **화질을 낮춰도 빨라지지 않습니다.** 한도가 "장수" 기준이라서요.
- 동시 실행 수를 올려도 빨라지지 않습니다 — 오히려 429가 나고 실패한 요청도 한도를 깎아서 더 느려집니다.
- 유일하게 효과가 있는 건 티어 상향입니다. `pnpm check:limits` 로 현재 한도를 확인하세요.

현재 설정 기준 예상 시간은 교사 화면의 **수업 전 점검**에 표시됩니다.

---

## 아키텍처 한 문단

Postgres가 큐이자 속도 게이트입니다. 학생이 제출하면 `jobs` 행이 생기고 즉시 `job_id`를 돌려받습니다.
`claim_job()` 이라는 SQL 함수가 **단 하나의 페이서 행**을 잠그고 "다음 슬롯 시각"을 전진시키면서 작업을 하나씩 꺼내므로,
서버리스 인스턴스가 몇 개로 늘어나든 분당 생성 수는 설정값을 넘지 않습니다.
(서버리스에서 `p-limit` 같은 프로세스 내 세마포어는 `상한 × 인스턴스 수`를 허용하므로 이 보장을 줄 수 없습니다.)

워커는 Vercel 라우트 핸들러(`/api/worker/tick`, `maxDuration=300`)이고, 세 경로에서 깨어납니다.
전부 `claim_job()`을 통과하므로 중복 호출은 낭비일 뿐 절대 위험하지 않습니다.

1. **Supabase pg_cron** 10초마다 (주 경로 — 모든 폰이 꺼져 있어도 동작)
2. 학생의 상태 폴링 (`POST /api/jobs`, `GET /api/jobs/{id}`)
3. 대기열 화면의 **"지금 그리기"** 버튼

> 교사 대시보드의 4초 갱신은 워커를 깨우지 **않습니다.** 화면만 새로 그립니다.
> (예전 문서와 코드 주석이 반대로 적혀 있었습니다.)

왜 이 방식인지, 어떤 대안을 왜 기각했는지는 구현 계획서에 근거와 함께 정리돼 있습니다.

---

## 시작하기

### 1. 의존성

```bash
pnpm install
```

### 2. Supabase

이미 쓰는 프로젝트가 있다면 그 프로젝트에 마이그레이션만 적용하면 됩니다.

```bash
cp .env.example .env.local     # 값 채우기
pnpm db:push                   # supabase/migrations/*.sql 순서대로 적용
```

`SUPABASE_DB_URL` 은 Supabase 대시보드 > Project Settings > Database > Connection string > URI 에서 가져옵니다.

그다음 Storage에 **`drawings` 라는 이름의 public 버킷**을 만들어 주세요.

마지막으로 pg_cron 심장박동에 필요한 Vault 시크릿 2개를 SQL 편집기에서 한 번 만듭니다.

```sql
select vault.create_secret('https://your-app.vercel.app', 'app_url');
select vault.create_secret('<WORKER_SECRET 값>', 'worker_secret');
```

> 확인할 것: Postgres 버전이 15.1.1.61 이상이어야 `'10 seconds'` 스케줄이 동작합니다.
> Database > Extensions 에서 `pg_cron`, `pg_net` 을 켜 두세요.

### 3. 로컬 개발

```bash
pnpm dev
```

로컬 Supabase로 전부 돌려보려면:

```bash
npx supabase start     # 포트는 553xx 로 잡아 두었습니다 (다른 프로젝트와 충돌 방지)
pnpm db:push
```

`.env.local` 에 `MOCK_OPENAI=1` 을 넣으면 OpenAI를 호출하지 않고 큐·페이서·대기 화면을 그대로 확인할 수 있습니다.
수업 예산을 한 장도 쓰지 않습니다.

### 4. 배포 (Vercel)

저장소를 **개인 GitHub 계정** 아래 두세요. Hobby 팀은 Git 조직 소유 저장소에 연결할 수 없습니다.

`.env.example` 의 모든 변수를 Vercel 환경변수로 등록하고 (`MOCK_OPENAI` 은 제외),
`CRON_SECRET` 을 하나 추가하면 `vercel.json` 의 일일 keep-alive cron이 동작합니다.

---

## 명령어

| 명령 | 하는 일 |
|---|---|
| `pnpm dev` | 개발 서버 |
| `pnpm build` / `pnpm start` | 프로덕션 빌드 · 실행 |
| `pnpm typecheck` | `next typegen && tsc --noEmit` |
| `pnpm test` | Vitest — 금칙어·프롬프트·오류 분류·백오프·칩 동기화 |
| `pnpm e2e` | Playwright — PRD §9 수용 기준 + 교사 패널 · 갤러리 내리기 |
| `pnpm db:push` | 마이그레이션 적용 |
| `pnpm check:limits` | **계정의 실제 분당 이미지 한도를 읽음** |
| `pnpm loadtest --code XXXX --n 20` | 20건 동시 투입 후 속도 게이트 검증 |
| `pnpm tsx scripts/smoke.ts` | API 레벨 종단 점검 (전부 PASS 여야 함) |
| `pnpm tsx scripts/verify-gate.ts` | 페이서·할당량 불변식을 Postgres에 직접 검증 |

---

## 설계에서 되돌리기 전에 읽어야 할 것들

의도적으로 그렇게 한 것들입니다. 바꾸기 전에 이유를 확인해 주세요.

- **`devices.generation_count` 컬럼이 없습니다.** 할당량은 `jobs` 에 대한 파생 COUNT입니다.
  저장된 카운터에는 증감 쌍이 있고, 그건 하필 중요한 오후에 어긋납니다. 감소 경로가 없으므로
  "실패는 횟수를 차감하지 않는다"가 구조적으로 성립합니다.
- **갤러리는 폴링합니다.** Supabase Realtime의 `postgres_changes` 는 구독자별로 RLS를 평가하므로
  `public.images` 를 anon 역할에 열고 컬럼 grant를 손으로 관리해야 합니다. 폴링은 서버가
  `id, url, tags` 세 컬럼만 고르므로 익명성이 리뷰 가능한 한 곳에서 강제됩니다.
- **"내 그림" 확인은 갤러리 목록과 분리돼 있습니다.** `/api/gallery/{코드}` 는 `id, url, tags` 세
  컬럼만 돌려주고, ETag(개수 + 최신 id)를 교실의 모든 폰이 공유해서 대부분 304로 끝납니다.
  여기에 소유 표시를 얹으면 응답이 기기마다 달라져 그 304가 통째로 깨집니다. 그래서 소유 확인은
  `POST /api/gallery/{코드}/mine` 이라는 별도 경로이고, 기기 ID는 URL이 아니라 본문으로 보냅니다
  (접근 로그에 남지 않게).
- **기기별 "남은 횟수"는 그림 장수가 아니라 `jobs` 파생 카운트입니다.** 대기 중인 작업도 횟수를
  차지하고, "횟수 초기화"는 그림 장수를 움직이지 않습니다. 두 숫자를 같은 것으로 합치면
  초기화 버튼이 아무 일도 안 한 것처럼 보입니다. 규칙은 `src/lib/device-usage.ts` 에 있고
  `used_quota()` 와 짝지어 테스트로 고정돼 있습니다.
- **'학생이 고를 수 있는 그림'은 서버가 강제합니다.** 학생 폰은 `allowed_styles` 를 입장할 때 **한 번만**
  읽습니다. 그래서 수업 중에 스타일을 끄면, 이미 그 카드를 보고 있는 폰 — 15분짜리 수업에서는 사실상
  교실 전체 — 에게는 클라이언트 필터가 아무 일도 하지 않습니다. `POST /api/jobs` 가 세션의 현재 목록과
  대조해 거절하고, **거절 응답에 새 목록을 실어 보냅니다.** 그래야 5번 화면에서 죽은 카드가 사라지고
  같은 탭이 무한히 거절당하지 않습니다. 횟수는 차감되지 않고 답변도 남습니다.
- **장당 단가는 `src/lib/pricing.ts` 한 곳에만 있습니다.** 교사 화면의 '예상 비용'과 화질 버튼에 적힌
  숫자가 같은 상수를 씁니다. 이 파일은 `server-only` 가 아니어서 클라이언트도 그대로 import 합니다 —
  값을 두 벌 두면 버튼의 가격과 청구서의 가격이 갈라집니다.
- **브라우저는 Supabase 키를 전혀 갖지 않습니다.** `NEXT_PUBLIC_SUPABASE_*` 변수를 만들지 마세요.
- **`moderation: 'auto'` 는 하드코딩입니다.** 설정할 수 있는 것은 언젠가 설정됩니다.
- **자유 문장(`raw_text_ko`)은 완료 시 NULL로 지웁니다.** 애플리케이션은 `jobs` 대신 `jobs_public`
  뷰만 읽으므로 실수로 `SELECT *` 를 해도 새어 나가지 않습니다.
- **프롬프트에 비율 단어(3:4 등)가 없습니다.** 크기는 API 파라미터이고, 프롬프트 속 비율 단어는
  가끔 테두리를 그리게 만듭니다. (참고로 1024×1536은 2:3입니다.)
- **금칙어는 hard-block 과 soft-strip 으로 나뉩니다.** 유튜브·포켓몬 같은 건 차단하지 않고
  번역 단계에서 조용히 일반화합니다. 차단하면 훌륭한 답변의 상당수가 거부됩니다.
- **`archiver` 는 `^7` 로 고정돼 있습니다.** v8은 ESM 네임드 export로 API가 바뀌어 조용히 실패합니다.

## 알려진 제약

- Vercel Hobby는 계약상 비상업 전용이며, 위반 시 조치는 프로젝트 일시정지입니다. RUNBOOK 참고.
- Supabase Free는 7일 무활동 시 일시정지됩니다. 일일 keep-alive cron이 이를 막습니다.
- 교사의 "숨기기"는 갤러리에서 감추지만 이미 URL을 아는 사람에게서 회수하지는 않습니다.
  키는 추측 불가능하며, 진짜 회수가 필요하면 private 버킷 + 서명 URL로 바꿔야 합니다.
