# ADR 001 — Cascaded STT → LLM → TTS pipeline

**Status:** Accepted · 2026-09-28

## Context
Sarjy's deep dive is guardrails. Speech-to-speech models (Gemini Live, OpenAI Realtime) have lower latency but produce audio directly from audio, leaving no text checkpoint to screen before the user hears it.

## Decision
Use a cascaded pipeline: Groq Whisper (STT) → LLM with tools → browser TTS. The server streams only *screened* sentences to the client, and the client only speaks those.

## Consequences
- Two enforcement points: after transcription (input guards) and before synthesis (output guards).
- Extra latency from separate STT and TTS hops, reduced by running input guards in parallel with the LLM and screening sentence-by-sentence while earlier sentences play.
- Each stage can fail independently, which makes per-stage timeouts and fallbacks both necessary and testable.
