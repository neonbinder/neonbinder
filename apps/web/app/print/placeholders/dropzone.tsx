import { useCallback, useId, useRef, useState, type ReactNode, type Ref } from "react";
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
 *
 * ## Always open (NEO-452)
 * A caller that isn't ready to send takes the files anyway and holds them
 * itself (the intake screen's tray), so this zone is never held back: the only
 * thing that stops a drop is `disabled`, while a send is running. Its headline
 * and accessible name never change for a caller's state; `hint` carries what to
 * expect and `describedBy` the reason, so a keyboard or screen-reader user hears
 * why on arrival. `disabled` is `aria-disabled`, never the native attribute: a send
 * starting would otherwise drop the focus of whoever is on the input to the page's
 * top, on every send. `tray` is the caller's row for what it is holding, inside the
 * zone's frame and its drag target, so a drop on it counts instead of sending
 * the browser off to open the file.
 */
export function Dropzone({
  files,
  onFiles,
  disabled,
  onFilesWhileDisabled,
  quiet = false,
  describedBy,
  hint,
  inputRef,
  tray,
  trayFilled = false,
}: {
  files: File[];
  onFiles: (files: File[]) => void;
  disabled: boolean;
  /** Files arrived anyway while `disabled`. They are not taken; the caller can say so. */
  onFilesWhileDisabled?: () => void;
  /** The caller announces progress itself; only a refused selection is said here. */
  quiet?: boolean;
  /** The ids of the text that explains what happens to a drop right now. */
  describedBy?: string;
  /** Replaces the usual line under the headline. */
  hint?: string;
  inputRef?: Ref<HTMLInputElement>;
  /** Drawn inside the zone's frame, under the label. */
  tray?: ReactNode;
  /** The tray has something in it: the zone's frame runs on round it, and its bottom edge is the tray's. */
  trayFilled?: boolean;
}) {
  const inputId = useId();
  const headlineId = useId();
  const hintId = useId();
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
      <div
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
          else if (e.dataTransfer.files.length > 0) onFilesWhileDisabled?.();
        }}
      >
        <label
          htmlFor={inputId}
          className={[
            "flex cursor-pointer flex-col items-center justify-center gap-2",
            trayFilled ? "rounded-t-xl" : "rounded-xl",
            "border-2 border-dashed px-6 py-10 text-center transition-colors",
            "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus",
            dragging
              ? "border-neon-purple bg-neon-purple/10"
              : "border-rule-strong hover:border-control hover:bg-field/40",
            disabled ? "cursor-not-allowed opacity-60" : "",
          ].join(" ")}
        >
          <span id={headlineId} className="text-base font-medium text-ink-2">
            {dragging
              ? "Drop them here"
              : disabled
                ? intake?.kind === "zip"
                  ? "Sending your zip…"
                  : "Sending your photos…"
                : "Drag your card photos here"}
          </span>
          <span className="text-sm text-ink-3">
            or <span className="text-neon-blue-text underline">browse your files</span>
          </span>
          <span id={hint ? hintId : undefined} className="text-xs text-ink-3">
            {hint ??
              "JPEG, PNG or WebP, or a single zip of them. Uploading starts as soon as you choose — keep them in scan order (front, back, front, back), because that order is what pairs them."}
          </span>
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            // What the service takes, loose or zipped: PLACEHOLDER_IMAGE_EXTENSION_BY_CONTENT_TYPE
            // (convex/lib/placeholderObjects.ts) and `sniff_image_type` (preprocess zipsafe.py).
            accept=".zip,image/jpeg,image/png,image/webp"
            multiple
            aria-disabled={disabled || undefined}
            aria-describedby={[disabled ? headlineId : null, hint ? hintId : null, describedBy].filter(Boolean).join(" ") || undefined}
            // The visible label's full text (title + hint + the instructional
            // paragraph) would otherwise BE the accessible name — every word in
            // the <label> counts, so without this a screen reader announces all
            // three sentences every time focus lands here. Kept short but still
            // built from the literal visible phrase ("Drag your card photos
            // here" / "browse your files") so the visible label stays part of
            // the accessible name (WCAG 2.5.3, Label in Name).
            aria-label="Drag your card photos here, or browse your files"
            className="sr-only"
            onClick={(e) => {
              if (disabled) e.preventDefault();
            }}
            onChange={(e) => {
              // A file picker opened before the send began can still answer during it.
              if (!disabled) setDropped(e.target.files);
              else if (e.target.files?.length) onFilesWhileDisabled?.();
              // Or picking the same files again (after the caller removed them) fires no change.
              e.target.value = "";
            }}
          />
        </label>
        {/* One frame with the label above it, lit with it during a drag. Always this
            div: a caller's tray keeps a live region that must not remount. */}
        <div
          className={
            trayFilled
              ? [
                  "rounded-b-xl border-2 border-t-0 border-dashed transition-colors",
                  dragging ? "border-neon-purple bg-neon-purple/10" : "border-rule-strong",
                ].join(" ")
              : ""
          }
        >
          {tray}
        </div>
      </div>

      {/* Always mounted so the message is announced when it appears, and keyed
          so the element remounts when the role itself flips between "status"
          and "alert" — some AT/browser combinations cache a live region's
          politeness at insertion time and never notice an attribute-only role
          change (same fix as the notice region in intake.tsx). `aria-live` is
          left unset for the alert case: role="alert" already implies assertive
          live-region semantics, and pairing it with an explicit "polite" here
          would have downgraded an invalid-file error to a non-interrupting
          announcement. */}
      <p
        key={problem ? "problem" : "ok"}
        role={problem ? "alert" : "status"}
        aria-live={problem ? undefined : "polite"}
        className={`text-sm ${problem ? "text-neon-pink-text" : "text-ink-3"}`}
      >
        {problem
          ? problem
          : quiet
            ? ""
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
