# Guardrails

Sarjy's deep dive. The goal: stop prohibited topics, jailbreaks and made-up tool data **without making the voice experience slower or more annoying**. Every layer is measured. See the generated reports:

- [`evals/guardrails-scorecard.md`](evals/guardrails-scorecard.md): attack success, false refusals and grounding, guards **on vs off**
- [`evals/latency.md`](evals/latency.md): what the guardrails cost in latency, and where time-to-first-audio goes
- [`evals/reliability.md`](evals/reliability.md): the guards' own failure modes (classifier down)

## Pipeline

```
user text ──┬─ L1 jailbreak/injection ─┐
            ├─ L2 topic policy ─────────┴─ gate ──────────────┐   nothing is spoken and no tool runs
            └─ LLM stream (starts immediately) ─ sentences ───┴─ L3 grounding → L4 output → sign → speak
                          └─ tool calls ── L3 checks the tool input first ── run tool
```

Three properties matter for voice:

1. **Once audio has played you can't take it back.** So the checks happen on text, per sentence, *before* TTS (see [ADR 001](decisions/001-cascaded-pipeline.md)).
2. **Guards run alongside the LLM, not before it.** L1 and L2 take ~0.2–0.35 s, and the LLM's first token takes ~0.8 s or more, so on normal turns the guards finish first and add almost no latency. Nothing leaves the server until they pass: sentences queue behind the gate, and tools (which can have side effects) wait for it too.
3. **Only screened text can be spoken.** The server signs each sentence (HMAC) after L4, and `/api/tts` refuses unsigned or altered text. A modified client can't make Sarjy say something unscreened, and the TTS endpoint can't be used to drain the quota.

## Layers

| Layer | Runs on | How | Cost | If its classifier is down |
|---|---|---|---|---|
| **L1** jailbreak / injection | every user turn | NFKC normalisation, zero-width strip, decodes base64 / hex / rot13 / leetspeak; regex heuristics; **Llama Prompt Guard 2** on the text, each decoded payload, and a 3-turn window (catches multi-turn "crescendo" attacks) | ~0.2–0.35 s, in parallel | Heuristics decide alone (known attack shapes still blocked) |
| **L2** topic policy | every user turn | **gpt-oss-safeguard-20b** reading our written policy ([`l2-topic.ts`](../src/lib/guardrails/l2-topic.ts)); sees the previous assistant message (for follow-ups) and any decoded payload | ~0.2–0.25 s, in parallel | Narrow keyword list for the clearest cases (self-harm first) |
| **L3** grounding | every sentence that has figures; every tool call | Deterministic: extracts digits and spoken numbers ("twenty‑six"), checks each against the tool JSON with rounding tolerance (wider when hedged: "around thirty"). Weather figures with no tool call are rejected. Tool *inputs* are grounded too: `get_weather` may only be called for a place the user said | < 1 ms | n/a (no model) |
| **L4** output | every sentence | Tier 1 always: 6-word overlap with the system prompt (leaks), secrets / Luhn-valid card numbers. Tier 2 only on risk: gpt-oss-safeguard on the sentence | < 1 ms; +~0.2 s when triggered | Fail **closed**, but only on sentences that already looked risky |

### Policy decisions

- **Refusals are in character and spoken.** Each category has its own line, written to be said aloud (`TOPIC_REPLIES`). Medical mentions emergency services, because some "medical advice" questions are emergencies.
- **Self-harm is not refused.** It gets a warm, supportive reply with a way to find a helpline.
- **Over-refusal counts as a failure.** "Kill a Python process", "Kill Devil Hills weather", "this song slaps" and "what is ibuprofen used for" must all be answered. The policy says so explicitly, and the eval has a 15-case suite for it.
- **L2 blocks only at ≥ 0.6 confidence.** Lower-confidence prohibited labels pass, but they flag the turn so L4 runs its LLM tier on every sentence.

### Why L3 repairs with a template instead of asking the LLM again

When a sentence contains a figure that isn't in the tool data, we stop the stream and say a summary built **directly from the tool JSON** (`summarizeWeather`): "Here are the exact figures for Lahore, Pakistan. Right now it's 26 degrees and clear…". A regeneration would cost another full LLM round trip (~1 s or more, plus tokens under an 8k TPM budget) and could hallucinate again. The template is instant and grounded by construction. The trade-off is that it sounds less natural, which we accept for the rare turn where the model got a number wrong.

### Why L4's LLM tier is conditional

Checking every sentence with the safeguard model would add ~0.2 s to first audio and cost ~400 tokens per sentence. On the free tier (8k tokens/min), that caps the **whole app** at about 5 turns per minute. Input is already screened, so the output LLM check runs only when a signal fires:
- Prompt Guard score ≥ 0.3.
- L2 flagged a prohibited category at low confidence.
- The sentence contains sensitive words (dosages, weapons, drugs, voting…).

The deterministic tier (leaks, secrets) always runs.

### Known limitations

- **L3 checks figures, not every factual claim.** A wrong condition ("sunny" when the tool said "rain") isn't caught. Next step: compare condition words against the tool's `condition` fields.
- **Vague ranges pass.** "Highs in the low thirties" isn't parsed as a number, so it's allowed.
- **Guard state is per server instance** (circuit breakers, caches). On serverless, a cold instance starts fresh. That's acceptable for a demo; a shared store (Redis) would fix it.
- **Prompt Guard is English-centric**, and L1's heuristics are English-only.

## Testing

- **Unit tests** (`npm test`) cover each layer's deterministic logic and degraded modes, plus end-to-end turns through the orchestrator against a scripted fake Groq. For example: a blocked input never runs a tool; a made-up figure is replaced by the template; a model-invented city is refused.
- **Live evals** (`npm run evals:guardrails`) run 55 cases (jailbreak, prohibited, benign-edge, grounding), each **with guards on and off**. Blocks and grounding are graded deterministically. Whether an unblocked attack *succeeded* is judged by gpt-oss-safeguard with a fixed rubric; if the judge can't answer, the case counts as a failure.
- **Try it live:** type attacks in the UI and watch the Guardrail Inspector show which layer fired, why, and how long it took.
