export type AssistantStatus = "idle" | "listening" | "transcribing" | "thinking" | "speaking";

export const STATUS_LABELS: Record<AssistantStatus, string> = {
  idle: "Tap to talk",
  listening: "Listening… tap to send",
  transcribing: "Transcribing…",
  thinking: "Thinking…",
  speaking: "Speaking… tap to interrupt",
};

/**
 * Sarjy's orb: its colour and motion follow the status. Large on the empty start
 * screen; small inside the message bar once a conversation is going, where it doubles
 * as the mic button.
 */
export function Orb({
  status,
  onClick,
  disabled,
  size = "lg",
}: {
  status: AssistantStatus;
  onClick: () => void;
  disabled?: boolean;
  size?: "lg" | "sm";
}) {
  const dims = size === "lg" ? "size-36 sm:size-44" : "size-10";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={STATUS_LABELS[status]}
      title={STATUS_LABELS[status]}
      data-status={status}
      data-size={size}
      className={`orb relative shrink-0 rounded-full outline-none focus-visible:ring-4 focus-visible:ring-sky-400/60 disabled:opacity-50 ${dims}`}
    >
      <span className="orb-glow" aria-hidden />
      <span className="orb-core" aria-hidden />
      {size === "sm" && <MicGlyph listening={status === "listening"} />}
    </button>
  );
}

function MicGlyph({ listening }: { listening: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="absolute inset-0 m-auto size-5 text-white drop-shadow">
      {listening ? (
        <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
      ) : (
        <path
          fill="currentColor"
          d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm5-3a1 1 0 1 1 2 0 7 7 0 0 1-6 6.92V20h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2.08A7 7 0 0 1 5 11a1 1 0 1 1 2 0 5 5 0 0 0 10 0Z"
        />
      )}
    </svg>
  );
}
