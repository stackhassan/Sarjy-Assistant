"use client";

import { useEffect, useRef } from "react";

type Props = {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * A small confirm modal, used instead of the browser's confirm(). Built on <dialog>:
 * showModal() gives focus trapping, Escape to close and an inert page for free.
 * Focus starts on Cancel, so Enter never deletes by accident.
 */
export function ConfirmDialog({ open, title, body, confirmLabel, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      cancelRef.current?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault(); // Escape: let the parent close it, so state stays in sync
        onCancel();
      }}
      onClick={(e) => e.target === ref.current && onCancel()} // click on the backdrop
      aria-labelledby="confirm-title"
      className="m-auto w-[min(22rem,calc(100vw-2rem))] rounded-2xl bg-slate-900 p-0 text-slate-100 shadow-2xl ring-1 ring-white/10 backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      <div className="p-5">
        <h2 id="confirm-title" className="text-base font-medium">
          {title}
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-full px-4 py-2 text-sm text-slate-300 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-full bg-rose-500/90 px-4 py-2 text-sm font-medium text-white transition hover:bg-rose-500"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
