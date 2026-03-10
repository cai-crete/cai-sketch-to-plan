# 구현 계획안 - Hybrid Auth (하이브리드 인증)

## 개요

현재 앱은 빌드 타임에 `GEMINI_API_KEY`를 Vite `define`으로 번들에 직접 포함합니다. 이 방식은 AI Studio 배포 환경에서는 편리하지만, 다음 상황을 수용하지 못합니다:

- **로컬 배포**: 사용자가 자신의 키를 직접 입력해 쓰길 원하는 경우
- **팀/공개 배포**: 서버 측 키를 노출 없이 공유해야 하는 경우
- **키 미보유 사용자**: API 키가 없는 사용자도 서비스를 이용하게 하려는 경우

**Hybrid Auth**는 두 가지 모드를 동적으로 전환할 수 있는 구조입니다.

---

## 현재 상태 분석

| 항목 | 현재 값 | 문제점 |
|---|---|---|
| AI SDK | `@google/genai` v1.29 | — |
| 키 관리 | `vite.config.ts` `define` → 번들 내 하드코딩 | 클라이언트에 키 노출 |
| AI 인스턴스 | `App.tsx:6` 모듈 레벨 고정 | 키 교체 불가 |
| 백엔드 | `express`, `better-sqlite3`, `dotenv` 설치됨 | **미구현** |
| 배포 환경 | Google AI Studio (1차), **Vercel (목표)** | 키 공유 전략 없음 |

핵심 파일:
- [src/App.tsx](src/App.tsx) — AI 호출 로직 (`ai.models.generateContent`, line 6, 978~988, 1016~1026)
- [vite.config.ts](vite.config.ts) — API 키 주입 (`define: { 'process.env.GEMINI_API_KEY': ... }`)
- [src/constants.ts](src/constants.ts) — 모델명 상수 (변경 없음)

---

## 목표 아키텍처: Hybrid Auth

```
┌─────────────────────────────────────────────────┐
│                   클라이언트 (React)              │
│                                                  │
│  useApiKey() hook                                │
│  ┌──────────────────┐   ┌─────────────────────┐ │
│  │  개인 키 있음     │   │   개인 키 없음        │ │
│  │  (BYOK Mode)     │   │ (Server Proxy Mode) │ │
│  └────────┬─────────┘   └──────────┬──────────┘ │
│           │                        │            │
└───────────┼────────────────────────┼────────────┘
            │                        │
            ▼                        ▼
   GoogleGenAI (직접)      POST /api/generate/*
   (키: localStorage)      (키: 서버 환경변수)
                                     │
                            ┌────────▼─────────┐
                            │  Express Server   │
                            │  server/index.ts  │
                            │  GEMINI_API_KEY   │
                            │  (환경변수, 비공개) │
                            └──────────────────┘
```

### 모드 결정 우선순위

1. `localStorage['gemini_api_key']` 값 존재 → **BYOK Mode** (직접 호출)
2. 빌드 타임 `process.env.GEMINI_API_KEY` 존재 → **BYOK Mode** (AI Studio 호환)
3. 둘 다 없음 → **Server Proxy Mode** (`/api/generate/*` 경유)
4. 서버도 키 없음 → UI에서 키 입력 요청

---

## 구현 계획

### Phase 1: Vercel Serverless Functions (Backend Proxy)

**신규 파일: `api/generate/analysis.ts` 및 `api/generate/image.ts`**

Vercel 환경에서는 Express 서버 대신 개별 API 엔드포인트를 파일 기반으로 작성하여 서버리스 함수로 동작하게 합니다.

```typescript
import { GoogleGenAI } from '@google/genai';
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'No server API key' });

  const { model: modelName, contents } = req.body;
  
  try {
    const genAI = new GoogleGenAI({ apiKey });
    const model = (genAI as any).getGenerativeModel({ model: modelName });
    const result = await model.generateContent(contents);
    const response = await result.response;
    return res.status(200).json({ response });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
}
```

**`package.json` 의존성:**
- `@vercel/node` 설치 완료 (`npm install @vercel/node -D`)

---

### Phase 2: `useApiKey` 훅

**신규 파일: `src/hooks/useApiKey.ts`**

```typescript
import { useState, useCallback } from 'react';
import { GoogleGenAI } from '@google/genai';

const LS_KEY = 'gemini_api_key';

export type AuthMode = 'byok' | 'proxy';

export function useApiKey() {
  const [personalKey, setPersonalKey] = useState<string>(
    () => localStorage.getItem(LS_KEY) || ''
  );

  // 모드 결정: 개인 키 또는 빌드 타임 키 → BYOK, 없으면 → proxy
  const resolvedKey = personalKey || process.env.GEMINI_API_KEY || '';
  const authMode: AuthMode = resolvedKey ? 'byok' : 'proxy';

  const saveKey = useCallback((key: string) => {
    key ? localStorage.setItem(LS_KEY, key) : localStorage.removeItem(LS_KEY);
    setPersonalKey(key);
  }, []);

  // BYOK: GoogleGenAI 인스턴스 반환
  const getDirectClient = useCallback((): GoogleGenAI | null => {
    return resolvedKey ? new GoogleGenAI({ apiKey: resolvedKey }) : null;
  }, [resolvedKey]);

  // Server Proxy: /api/generate/* 호출
  const proxyGenerate = useCallback(
    async (endpoint: 'analysis' | 'image', body: object) => {
      const res = await fetch(`/api/generate/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Proxy request failed');
      }
      return res.json();
    },
    []
  );

  return { authMode, personalKey, resolvedKey, saveKey, getDirectClient, proxyGenerate };
}
```

---

### Phase 3: API Key 설정 UI 컴포넌트

**신규 파일: `src/components/ApiKeyModal.tsx`**

```typescript
interface ApiKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentKey: string;
  onSave: (key: string) => void;
  authMode: AuthMode;
}
```

UI 구성:
- 현재 모드 배지: `● 개인 키 사용 중 (BYOK)` / `● 서버 프록시 사용 중`
- API 키 입력 필드 (비밀번호 마스킹, 복사 방지)
- 저장 / 키 삭제 버튼
- 키 발급 안내 텍스트 (`aistudio.google.com/apikey`)

**헤더 통합:** `App.tsx` 헤더에 Settings 아이콘 버튼 추가 → 모달 열기

---

### Phase 4: `App.tsx` 통합

**수정 지점 1 — 모듈 레벨 `ai` 인스턴스 제거 (line 6):**

```typescript
// 제거
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
```

**수정 지점 2 — `handleGenerate` 내 호출 분기 (line ~978, ~1016):**

```typescript
// handleGenerate 함수 상단에 추가
const directClient = getDirectClient();

// Sketch Analysis 호출
let analysisResponse;
if (directClient) {
  try {
    analysisResponse = await directClient.models.generateContent({
      model: SKETCH_ANALYSIS,
      contents: { parts: [...] }
    });
  } catch {
    analysisResponse = await directClient.models.generateContent({
      model: SKETCH_ANALYSIS_FALLBACK,
      contents: { parts: [...] }
    });
  }
} else {
  // Server Proxy Mode
  analysisResponse = await proxyGenerate('analysis', {
    model: SKETCH_ANALYSIS,
    contents: { parts: [...] }
  });
}

// Plan Image Generation 호출도 동일 패턴 적용
```

---

### Phase 5: `vite.config.ts` 개발 프록시 설정

개발 환경에서 프론트엔드(`:3000`)와 백엔드(`:3001`) 분리 운영 시 CORS 없이 API 호출:

```typescript
// vite.config.ts server 블록에 추가
server: {
  hmr: process.env.DISABLE_HMR !== 'true',
  proxy: {
    '/api': {
      target: 'http://localhost:3001',
      changeOrigin: true,
    },
  },
},
```

---

## 파일 변경 요약

| 파일 | 작업 | 주요 변경 |
|---|---|---|
| `api/generate/analysis.ts` | **신규** | Vercel 분석 프록시 함수 |
| `api/generate/image.ts` | **신규** | Vercel 이미지 생성 프록시 함수 |
| `src/hooks/useApiKey.ts` | **신규** | 인증 모드 결정 훅 |
| `src/components/ApiKeyModal.tsx` | **신규** | 키 입력 UI 모달 |
| `src/App.tsx` | **수정** | 모듈 레벨 `ai` 제거, 훅 통합, 헤더 Settings 버튼 추가 |
| `vite.config.ts` | **수정** | 개발 프록시 `/api` 추가 |

---

## 보안 고려사항

- **BYOK Mode**: 키는 `localStorage`에만 존재. HTTPS 환경 강력 권장.
- **Server Proxy Mode**: 서버 키는 환경 변수에만 존재, 클라이언트 번들에 포함되지 않음.
- **Rate Limiting**: 프록시 남용 방지를 위해 `express-rate-limit` 추가 권장 (Phase 1 이후).
- **`better-sqlite3`**: 향후 사용자별 요청 쿼터 추적에 활용 가능 (이미 설치됨).

---

## AI Studio 호환성 유지

AI Studio 환경에서 `process.env.GEMINI_API_KEY`가 빌드 타임에 주입되는 경우, `useApiKey` 훅이 이를 감지하여 자동으로 BYOK Mode로 동작합니다. 기존 AI Studio 배포에서 코드 변경 없이 완전 호환됩니다.

---

## 검증 계획

1. **BYOK 모드**: localStorage에 키 저장 후 직접 Gemini 호출 동작 확인
2. **Proxy 모드**: 키 없는 상태에서 `/api/generate/*` 경유 생성 확인
3. **폴백 UI**: 키 미입력 + 서버 미설정 → API Key 입력 안내 표시 확인
4. **AI Studio 호환**: 빌드 타임 키 주입 환경에서 기존 동작 동일 확인
5. **키 교체**: 런타임 중 키 변경 후 즉시 적용 확인
