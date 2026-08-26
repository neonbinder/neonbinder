import { useCallback, useId, useRef, useState } from "react";
import { classifyIntake } from "@/lib/placeholders/intake-kind";

/**
 * The one control that takes everything (NEO-152).
 *
 * A collector arrives holding a folder of phone photos or an archive off a
 * scanner, and should not have to work out which of those this page wants.
 * Drop either, or click to browse; `classifyIntake` decides the path and the
 * user never learns there was one.
 *
 * ## Why a label wrapping a hidden input, not a div with onClick
 * The drop target has to BE the file control for keyboard and screen-reader
 * users — a clickable div gets a mouse affordance and nothing else. A real
 * `<input type="file">` visually hidden inside a `<label>` keeps native focus,
 * Space/Enter activation and the "N files selected" announcement for free, and
 * the drag handlers ride on the same element. `sr-only` rather than
 * `display:none`, because a hidden input is not focusable.
 *
 * ## There is no Start button, on purpose
 * Choosing files IS starting the upload. A scanner session is a stream, and a
 * confirm step between "I picked these" and "send them" is a form habit, not
 * something the flow needs — it only adds a click and a state where the page
 * looks ready but nothing is happening.
 *
 * That makes the invalid case load-bearing rather than cosmetic: two zips, or a
 * zip mixed with photos, must be REFUSED here and reported beside the selection,
 * because there is no button press left to intercept it.
 */
export function Dropzone({
  files,
  onFiles,
  disabled,
}: {
  files: File[];
  onFiles: (files: File[]) => void;
  disabled: boolean;
}) {
  const inputId = useId();
  const [dragging, setDragging] = useState(false);
  // Drag events fire for every child element, so a boolean flips off the moment
  // the pointer crosses an inner node. Counting enter/leave is what keeps the
  // highlight steady while moving across the zone.
  const depth = useRef(0);

  const setDropped = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      onFiles(Array.from(list));
    },
    [onFiles],
  );

  const intake = files.length > 0 ? classifyIntake(files) : null;
  const problem = intake?.kind === "invalid" ? intake.reason : null;

  return (
    <div className="space-y-2">
      <label
        htmlFor={inputId}
        onDragEnter={(e) => {
          e.preventDefault();
          depth.current += 1;
          if (!disabled) setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          depth.current -= 1;
          if (depth.current <= 0) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          depth.current = 0;
          setDragging(false);
          if (!disabled) setDropped(e.dataTransfer.files);
        }}
        className={[
          "flex cursor-pointer flex-col items-center justify-center gap-2",
          "rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
          "focus-within:ring-2 focus-within:ring-neon-purple focus-within:ring-offset-2 focus-within:ring-offset-slate-950",
          dragging
            ? "border-neon-purple bg-neon-purple/10"
            : "border-slate-700 hover:border-slate-500 hover:bg-slate-900/40",
          disabled ? "cursor-not-allowed opacity-60" : "",
        ].join(" ")}
      >
        <span className="text-base font-medium text-slate-200">
          {dragging
            ? "Drop them here"
            : disabled
              ? "Sending your photos…"
              : "Drag your card photos here"}
        </span>
        <span className="text-sm text-slate-400">
          or <span className="text-neon-blue underline">browse your files</span>
        </span>
        <span className="text-xs text-slate-500">
          JPEG or PNG, or a single zip. Uploading starts as soon as you choose —
          keep them in scan order (front, back, front, back), because that order
          is what pairs them.
        </span>
        <input
          id={inputId}
          type="file"
          accept=".zip,image/jpeg,image/png"
          multiple
          disabled={disabled}
          className="sr-only"
          onChange={(e) => setDropped(e.target.files)}
        />
      </label>

      {/* Always mounted so the message is announced when it appears. */}
      <p
        role={problem ? "alert" : "status"}
        aria-live="polite"
        className={`text-sm ${problem ? "text-neon-pink" : "text-slate-400"}`}
      >
        {problem
          ? problem
          : disabled
            ? "Sending…"
            : files.length === 0
              ? "Nothing selected yet."
              : intake?.kind === "zip"
                ? `${files[0].name} sent.`
                : `${files.length} photo${files.length === 1 ? "" : "s"} sent.`}
      </p>
    </div>
  );
}
