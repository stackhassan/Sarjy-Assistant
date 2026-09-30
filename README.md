# Sarjy

A voice assistant with layered, measured guardrails, built for the Sarj take-home.

**Deep dive: Guardrails & Reliability.** On 60 live eval cases with guards on: **0/30 attacks succeeded, 0/20 benign questions refused, 0/10 weather answers with invented figures**. The guards add **0 ms at p50** to first audio, because they run alongside the LLM rather than before it.

| Doc | What's in it |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Product and technical design |
| [docs/guardrails.md](docs/guardrails.md) | The guard layers, results, the red-team's 9 breaks and their fixes, trade-offs |
| [docs/reliability.md](docs/reliability.md) | How every failure (LLM, weather, guards, STT, TTS, memory) is handled |
| [docs/memory.md](docs/memory.md) | How memory works: anonymous sign-in, RLS, the L5 write guard, recall, forget |
| [docs/evals/](docs/evals/) | Generated reports: scorecard, latency, reliability |
| [docs/decisions/](docs/decisions/) | Architecture decision records |

## Stack

Next.js 16 (App Router, TypeScript) · Groq: Whisper STT, gpt-oss-120b (20b fallback), Prompt Guard 2, gpt-oss-safeguard, Orpheus TTS · Open-Meteo with MET Norway as backup · Supabase (memory) · Vercel.

## Run locally

Requires Node ≥ 20.9 (`.nvmrc` pins 24).

```bash
cp .env.example .env.local   # add your GROQ_API_KEY
npm install
npm run dev
```

Orpheus TTS needs a one-time terms acceptance in the Groq console. Until then, Sarjy uses the browser voice.

## Try to break it

- Type a jailbreak and watch the **Guardrail Inspector**: which layer fired, why, and in how many ms.
- Inject failures from the URL: `/?chaos=llm_primary_down,weather_slow`. Flags: `llm_primary_down`, `llm_all_down`, `llm_slow`, `llm_midstream_drop`, `weather_down`, `weather_all_down`, `weather_slow`, `guard_down`, `stt_down`, `tts_down`. They affect only your own requests. `guard_down` is ignored in production (it would weaken the guardrails), and no flag can disable them.

## Production settings

| Variable | Default | Meaning |
|---|---|---|
| `GUARD_DEGRADED_POLICY` | `fail_closed` | If a guard model is unavailable: speak no free-form model text (weather still answered from grounded data). `restricted` = rule-based backups, development only |
| `NEXT_PUBLIC_SARJY_DEMO_MODE` | on in dev, off in prod | Show guard internals and the Guardrail Inspector. Set `1` on the public demo so reviewers can see it |
| `CHAOS_ALLOW_GUARD_FAULTS` | off | Honour `guard_down` in production |
| `TTS_SIGNING_SECRET` | derived from the API key | Set it explicitly so rotating the key doesn't invalidate signatures |

See [docs/guardrails.md → Demo vs production](docs/guardrails.md#demo-vs-production).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm test` | 97 unit + end-to-end tests (scripted fake Groq, no network) |
| `npm run evals:guardrails` | 60 live cases × guards on / off / off-on-fallback (~45 min on the free tier) |
| `npm run evals:reliability` | Every injected fault against live APIs |
| `npm run evals:latency` | Guards on vs off, guard cost, time-to-first-audio breakdown |
| `EVAL_REGRADE=1 npm run evals:guardrails` | Rebuild the scorecard from saved turns (no API calls) |
| `npm run lint` · `npm run typecheck` · `npm run build` | The usual |

## Layout

```
src/app/api/{stt,turn,tts}   speech-to-text · one conversational turn (SSE) · signed-sentence TTS
src/lib/orchestrator.ts      guards ∥ LLM → tools → per-sentence L3/L4 → sign → emit
src/lib/guardrails/          L1 input · L2 topic · L3 grounding · L4 output · classifiers
src/lib/reliability/         fault-injection context · hedged requests · retry · caches
src/lib/llm/                 providers, failover, circuit breaker, stall detection
src/lib/tools/weather.ts     Open-Meteo + MET Norway, hedged, cached, stale-if-error
src/components/              orb, transcript, Guardrail Inspector
evals/                       live eval suites, cases, harness
```
