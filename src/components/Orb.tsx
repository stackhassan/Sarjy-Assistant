export type AssistantStatus = "idle" | "listening" | "transcribing" | "thinking" | "speaking";

const LABELS: Record<AssistantStatus, string> = {
  idle: "Tap to talk",
  listening: "Listening… tap to send",
  transcribing: "Transcribing…",
  thinking: "Thinking…",
  speaking: "Speaking… tap to interrupt",
};

export function Orb({ status, onClick, disabled }: { status: AssistantStatus; onClick: () => void; disabled?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-5">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={LABELS[status]}
        data-status={status}
        className="orb relative size-40 rounded-full outline-none focus-visible:ring-4 focus-visible:ring-sky-400/60 disabled:opacity-50 sm:size-48"
      >
        <span className="orb-glow" aria-hidden />
        <span className="orb-core" aria-hidden />
      </button>
      <p className="text-sm tracking-wide text-slate-400" aria-live="polite">
        {LABELS[status]}
      </p>
    </div>
  );
}
