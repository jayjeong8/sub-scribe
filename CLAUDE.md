# Sub-Scribe

YouTube 자막으로 언어를 학습하는 웹앱 (타이핑/말하기/빈칸채우기 모드).

## 기술 스택
- Next.js 16 (App Router, Turbopack)
- React 19, TypeScript 5
- Tailwind CSS 4, PostCSS
- Biome (lint + format)

## 프로젝트 구조
```
src/app/
├── layout.tsx / page.tsx / globals.css / style.css / icon.svg
├── _components/sub-scribe.tsx   ← 메인 클라이언트 컴포넌트
├── _hooks/                      ← use-captions, use-typing-engine, use-youtube-player
├── _lib/                        ← types, speech-recognition.d.ts
└── api/captions/route.ts        ← YouTube 자막 프록시 API
```

## 컨벤션
- Biome: `lineWidth: 100`, `indentStyle: space`, `indentWidth: 2`
- CSS: 서비스 전용 스타일은 `style.css`에 `ss-` 접두사 클래스로 작성
- 폰트: `--font-ss-sans` (Inter), `--font-ss-display` (DM Serif Display), `--font-mono` (시스템 모노스페이스)

## 커맨드
- `pnpm dev` — 개발 서버
- `pnpm build` — 프로덕션 빌드
- `pnpm lint` — Biome 검사
- `pnpm lint:fix` — Biome 자동 수정
- `pnpm format` — Biome 포맷팅
