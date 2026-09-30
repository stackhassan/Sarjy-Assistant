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
| **LLM** | Primary (gpt-oss-120b) errors / 429 / 5xx | Fail over along the chain: Groq gpt-oss-20b → SambaNova gpt-oss-120b → Mistral → Gemini flash-lite (each only if its key is set). Circuit breaker skips a failed model for 30 s; for **10 min** after an auth/billing error (401/402/403) | Normal answer | One failed request (usually < 0.3 s) |
| | Every Groq model down | Cross-provider failover to the next configured provider. Gemini's tool calls carry a `thought_signature` that's passed back with the tool result | Normal answer (verified live: Gemini answered with grounded figures) | A few failed requests |
| | Primary consistently slow | **Latency-based switching:** first content over 2.5 s on 2 turns in a row sets the provider aside for 60 s. One slow turn isn't enough | Normal answers, faster | Only the two slow turns |
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
| **Guard models** | Primary guard model down | **Backups:** Prompt Guard 86m → 22m; gpt-oss-safeguard → gpt-oss-20b (same written policy) → Mistral → Gemini flash-lite | Normal answers (verified live: L2 "allowed via backup gpt-oss-20b") | 0.5-3 s on backup models |
| | Every guard backup down or rate-limited | **Fail closed** (default): no free-form model text while blind; weather still answered from the grounded template. The `restricted` policy (development only) uses rule-based backups instead | "Sorry, my safety checks are having a moment… I can still check the weather for you." Weather questions still get exact figures | ~0 |
| **STT** | Whisper turbo fails | Whisper large-v3 (same key, separate capacity) | Normal | + the failed attempt |
| | Both fail, or nothing was heard | **Escalating reprompts** (Google's conversation-design pattern): 1st miss asks again briefly; 2nd in a row adds help and focuses the text box. Spoken in Sarjy's normal voice (fixed app lines are voiced by id) | 1st: "Sorry, I didn't catch that. Could you say it again?" 2nd: "I'm having trouble hearing you. You can also type your message below." | |
| | Silence / noise heard as "Thank you." | Hallucination filter: punctuation-only output and known Whisper phantoms at low confidence are dropped | Nothing spurious; "I didn't catch that" | |
| **TTS** | Orpheus error / timeout | Browser voice, **announced once per outage**; the rest of that answer stays on the fallback voice (no mid-answer flip-flop); the next answer tries Orpheus again. Closest-sounding browser voice (female, en-US) | "Quick heads-up, my voice might sound a bit different for a moment. …" then the answer | ~0 |
| | Orpheus rate-limited (429) | Same, and stays on the browser voice until `Retry-After` passes | As above | ~0 |
| | No voice works at all | Replies show as text; the UI says voice is unavailable for now | (on screen) "Voice isn't available right now, so I'll show my replies here. Try again later for voice." | — |
| **Any slow start** | Nothing heard within 2 s (failover, slow weather API) | A soft synthesised "thinking" chime, repeating gently until audio starts (progressive-response pattern; no network or TTS quota) | *chime* | — |
| **Client** | `/api/turn` unreachable | Local spoken apology | "Sorry, I couldn't reach my brain just now." | |

## Voice UX principles

Researched against voice-framework and assistant-design guidance: [VideoSDK fallback adapter](https://docs.videosdk.live/ai_agents/core-components/fallback-adapter), [Alexa progressive responses](https://developer.amazon.com/en-US/docs/alexa/custom-skills/send-the-user-a-progressive-response.html), [Google conversation design: errors](https://developers.google.com/assistant/conversation-design/errors), [SimbaVoice on mid-call crashes](https://simbavoice.ai/resources/ai-voice-agent-crashes-mid-call).

- **Model switches are invisible.** The user talks to one assistant, Sarjy. Announcing "I'm a different model now" breaks the persona and leaks internals, so failover is silent.
- **Perceivable changes are acknowledged once.** A different voice, a long wait or reduced ability gets one short, honest line, then Sarjy carries on.
- **No dead air.** A soft chime covers slow starts.
- **Reprompts escalate,** and "try again later" is only said when the answer really couldn't be delivered.

## Techniques

- **Hedged requests** ([`hedge.ts`](../src/lib/reliability/hedge.ts)). Free public APIs have terrible tail latency: we measured Open-Meteo geocoding at 0.9 s typical and 11 s worst on the same day. Waiting for a timeout before failing over makes the user pay the whole timeout. Hedging starts the backup early and takes the first success, so the tail is capped near the hedge delay. Used only for idempotent reads with no quota cost.
- **Retry fast failures, fail over on slow ones.** A quick 503 is worth one jittered retry. A timeout means the service is struggling, so retrying just doubles the wait.
- **Deadlines everywhere.** Per stage: STT 4 s + 6 s, LLM headers 6 s / 5 s, stream idle 5 s, guards 1.2–1.5 s, weather 7 s total. Retries never start past the deadline.
- **Circuit breaker** per model, so a known-bad provider doesn't cost every turn a timeout.
- **Failover never splices** two models' output into one reply. It happens before any text is spoken, or not at all.
- **Streamed, gapless voice** ([`pcm.ts`](../src/lib/client/pcm.ts), [`speaker.ts`](../src/lib/client/speaker.ts)). Orpheus streams WAV about 6× faster than real time, but each clip has 0.25–0.6 s of silence at both ends. Played as whole files, sentences had a 0.6–1.1 s dead gap between them, and the first sound waited for the full clip (0.9–2 s). Now the WAV is decoded as it arrives, padding is trimmed as it streams to an 80 ms lead and a 200 ms tail, and every clip is scheduled on one Web Audio clock right where the previous one ends. Measured in the browser: zero scheduling gaps across a three-sentence answer, and first audio 1.7 s after Send (was ~2.9 s). If Web Audio isn't available, it falls back to whole-file playback, then to the browser voice.
- **Spoken bridge for slow tools.** If a weather lookup has taken 900 ms and nothing has been said yet, Sarjy says a fixed "One sec, checking the weather." It never repeats the place name, which is user text. Fast (cached) lookups answer before the bridge would fire.
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
