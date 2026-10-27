import { useEffect, useId, useMemo, useRef } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { FOCUS, LABEL } from "../../prototypes/p1/ui";
import { PHOTO_TYPES, photoProblem } from "./photos";

/**
 * One optional photo for a request: a file picker (the camera on a phone),
 * a thumbnail once picked, and Remove. A file that isn't an image, or is
 * over 10 MB, is turned away here, before it uploads.
 */
export default function PhotoField({
  label,
  file,
  onFile,
  onProblem,
}: {
  label: string;
  file: File | null;
  onFile: (file: File | null) => void;
  onProblem: (problem: string | null) => void;
}) {
  const id = useId();
  const name = label.replace(/ \(optional\)$/, "");
  const input = useRef<HTMLInputElement>(null);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      {file && preview ? (
        <div className="mb-2 flex items-center gap-3">
          <img src={preview} alt={`${name}, picked`} className="h-16 w-auto rounded border border-rule-strong" />
          <NeonButton
            type="button"
            variant="secondary"
            outline
            aria-label={`Remove ${name.toLowerCase()}`}
            onClick={() => {
              onFile(null);
              if (input.current) {
                input.current.value = "";
                // The button goes with the photo; the keyboard goes to the picker.
                input.current.focus();
              }
            }}
          >
            Remove
          </NeonButton>
        </div>
      ) : null}
      <input
        ref={input}
        id={id}
        type="file"
        accept={PHOTO_TYPES.join(",")}
        className={`block w-full rounded-md text-sm text-ink-2 file:mr-3 file:min-h-11 sm:file:min-h-9 file:rounded-md file:border file:border-control file:bg-transparent file:px-3 file:text-ink-2 ${FOCUS}`}
        onChange={(e) => {
          const picked = e.target.files?.[0] ?? null;
          if (!picked) return;
          const problem = photoProblem(picked);
          onProblem(problem);
          if (problem) {
            e.target.value = "";
            return;
          }
          onFile(picked);
        }}
      />
    </div>
  );
}
