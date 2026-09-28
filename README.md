# Sarjy

A voice assistant with layered, measured guardrails — built for the Sarj take-home.

- **Design:** [docs/PRD.md](docs/PRD.md) · decisions in [docs/decisions/](docs/decisions/)
- **Deep dive:** Guardrails & Reliability

## Stack

Next.js 16 (App Router, TypeScript) · Groq (Whisper STT, Llama 3.3 chat, guard models) · Gemini fallback · Open-Meteo weather · Supabase memory · browser TTS · Vercel.

## Run locally

Requires Node ≥ 20.9 (`.nvmrc` pins 24).

```bash
cp .env.example .env.local   # add your GROQ_API_KEY
npm install
npm run dev
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm test` | Unit tests (Vitest) |
| `npm run lint` | ESLint |
| `npm run typecheck` | Route typegen + `tsc` |
| `npm run build` | Production build |

## Layout

```
src/app/api/stt     speech-to-text (Groq Whisper)
src/app/api/turn    one conversational turn, streamed as SSE
src/lib/orchestrator.ts   turn pipeline: guards ∥ LLM → tools → per-sentence screening
src/lib/guardrails/ L1–L5 guard layers
src/lib/llm/        providers with failover + circuit breaker; pinned model IDs
src/lib/tools/      get_weather (Open-Meteo)
src/components/     Orb, transcript, Guardrail Inspector
```
