# Reliability

Principle: **every failure ends in something useful and honest being said, quickly.** Sarjy never goes silent, never shows a raw error, and never covers a failed data source by inventing an answer.

Measured results, with faults injected into live turns: [`evals/reliability.md`](evals/reliability.md).

> That report is from the 13:28 UTC run. Its ❌ rows were followed up:
> - **"none" and "guards unavailable"** were grader false alarms. "Cats make over 100 sounds" on a chat turn was flagged as ungrounded; the grader now only checks turns that used a tool.
> - **"all weather sources down, cached"** was a real bug. The model read out a stale forecast without saying so. The server now speaks the disclaimer itself, covered by the unit test `always discloses stale weather before the answer`.
>
> It wasn't re-run the same day because gpt-oss-120b had used its 200k tokens/day free-tier cap. A "healthy" baseline would have failed over to 20b, and primary-only faults couldn't be exercised. Re-run with `npm run evals:reliability` once the quota resets.

**Unplanned live test.** During the final guardrail eval, the primary model hit that daily cap, and 73 of 120 turns were served by the fallback model with no errors and no user-visible change. 429s now honour the provider's retry-after (a daily-cap 429 asks for minutes), so the breaker skips the capped model for that long instead of spending a doomed request every 30 s.

## Failure handling by component

| Component | Failure | What happens | What the user hears | Latency cost |
|---|---|---|---|---|
| **LLM** | Primary (gpt-oss-120b) errors / 429 / 5xx | Fail over to gpt-oss-20b on the same key (then Gemini if configured). Circuit breaker skips the failed model for 30 s | Normal answer | One failed request (usually < 0.3 s) |
| | Primary hangs | 6 s header timeout, then fail over | Normal answer, late | Up to 6 s (see trade-off below) |
| | Stream stalls mid-way | 5 s idle timeout on chunks | as below | |
| | Stream dies **before anything was spoken** | Drop the partial text and retry the round on the next model | Normal answer; the user never knows | One failed partial stream |
| | Stream dies **after** a sentence was spoken | Finish the sentences already approved, then add a signed apology | "…Sorry, I lost my train of thought there. Could you ask me that again?" | none |
| | Every provider down | Spoken, signed fallback line; UI stays usable | "Sorry, I'm having trouble thinking right now…" | Fails fast |
| **Weather** | Open-Meteo fails fast (503, network) | Retry once with jitter **and** start MET Norway at once (hedge) | Normal answer | ~0 |
| | Open-Meteo slow | **Hedged request**: MET Norway starts after 1.5 s and the first success wins | Normal answer | ≤ ~1.5 s + MET Norway |
| | Geocoding slow | Duplicate request hedged after 1 s; results cached 24 h | Normal answer | ≤ ~1 s |
| | All sources down, recent forecast cached | Serve the cache (≤ 3 h). The **server** speaks the disclaimer before the answer, because the eval showed the model sometimes skipped it | "Heads up: the live weather service is down, so this forecast is from 12 minutes ago. …" | ~0 |
| | All sources down, nothing cached | Tool returns `unavailable`; L3 blocks any figures | "I can't reach the weather service right now, so I won't guess." | ≤ 7 s budget |
| **Guard models** | Prompt Guard / safeguard down | L1 → heuristics only; L2 → narrow keyword fallback; L4 fails **closed** only on risky sentences. Inspector shows `degraded` | Normal answers; clear attacks still blocked | ~0 |
| **STT** | Whisper turbo fails | Whisper large-v3 (same key, separate capacity) | Normal | + the failed attempt |
| | Both fail | UI notice, plus a spoken line via the browser voice | "Sorry, I couldn't hear that properly. Could you try again, or type it instead?" | |
| | Silence / noise heard as "Thank you." | Hallucination filter: punctuation-only output and known Whisper phantoms at low confidence are dropped | Nothing spurious; "I didn't catch that" | |
| **TTS** | Orpheus error / timeout | That clip is spoken with the browser voice | Same words, plainer voice | ~0 |
| | Orpheus rate-limited (429) | Browser voice until `Retry-After` passes | Same words, plainer voice | ~0 |
| **Client** | `/api/turn` unreachable | Local spoken apology | "Sorry, I couldn't reach my brain just now." | |

## Techniques

- **Hedged requests** ([`hedge.ts`](../src/lib/reliability/hedge.ts)). Free public APIs have terrible tail latency: we measured Open-Meteo geocoding at 0.9 s typical and 11 s worst on the same day. Waiting for a timeout before failing over makes the user pay the whole timeout. Hedging starts the backup early and takes the first success, so the tail is capped near the hedge delay. Used only for idempotent reads with no quota cost.
- **Retry fast failures, fail over on slow ones.** A quick 503 is worth one jittered retry. A timeout means the service is struggling, so retrying just doubles the wait.
- **Deadlines everywhere.** Per stage: STT 4 s + 6 s, LLM headers 6 s / 5 s, stream idle 5 s, guards 1.2–1.5 s, weather 7 s total. Retries never start past the deadline.
- **Circuit breaker** per model, so a known-bad provider doesn't cost every turn a timeout.
- **Failover never splices** two models' output into one reply. It happens before any text is spoken, or not at all.
- **Everything is visible.** Each recovery emits a `recovery` event the Inspector shows (for example `↻ llm failover · groq/gpt-oss-120b → next provider (503)`), so a smooth recovery is still observable in a demo.

## Trade-offs and next steps

- **Slow primary LLM costs up to 6 s.** Hedging the LLM like the weather API would fix this, but it doubles token use under an 8k tokens/min free tier. With a paid tier, I'd hedge LLM requests after ~2.5 s.
- **State is per instance.** Circuit breakers and caches live in memory, and serverless instances don't share them. Upstash Redis (free tier) would share them.
- **One API key is a single point of failure** for the Groq models. Adding `GEMINI_API_KEY` gives a genuinely independent third provider; the code already supports it.

## Fault injection

Every failure above can be triggered on purpose, for tests, the eval suite, or a live demo:

- **UI:** open `/?chaos=llm_primary_down,weather_slow`. A banner shows which faults are active, and the Inspector shows each recovery.
- **API:** send header `x-sarjy-chaos: llm_midstream_drop`.
- **Flags:** `llm_primary_down`, `llm_all_down`, `llm_slow`, `llm_midstream_drop`, `weather_down`, `weather_all_down`, `weather_slow`, `guard_down`, `stt_down`, `tts_down`.

Flags only affect the request that carries them, so it's safe to leave this on the public demo. The guard bypass used for baseline measurements exists only inside the eval harness, never over HTTP.

**Guard-weakening faults (`guard_down`) are not honoured in production** (unless `CHAOS_ALLOW_GUARD_FAULTS=1` is set on the server). The red-team showed that taking the classifiers offline is, in effect, a guard bypass: it got medication dosing that way. In development and evals the flag still works, so degraded mode stays testable.
