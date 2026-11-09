import { ModeRadioGroup } from "@/components/primitives/ModeRadioGroup";
import DemoThemeToggle from "@/app/collection/final/DemoThemeToggle";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import { PERSONAS } from "../fake-data";
import DashboardScreen from "../screen/DashboardScreen";
import { useDemoDashboard } from "./fixture";
import { usePersona } from "./persona";

/**
 * NEO-464 — the dashboard, logged out, on fake data: the Dashboard tab of the
 * demo shell (`DashboardDemoLayout`). The screen is the same one the signed-in
 * dashboard will render; this page only supplies the fake data and the demo's
 * controls ("Viewing as" and Light / Dark), which are not part of the app.
 */
export default function DashboardDemoPage() {
  useDocumentTitle("Dashboard | Neon Binder");
  const data = useDemoDashboard();
  return (
    <div className="flex flex-col gap-6">
      <DemoControls />
      <DashboardScreen data={data} />
    </div>
  );
}

/** Who is looking and Light / Dark: switches for judging the demo, not part of the app. */
function DemoControls() {
  const [persona, setPersona] = usePersona();

  return (
    <section aria-label="Demo controls" className="flex flex-col gap-3 rounded-xl border border-dashed border-rule-strong bg-raised px-4 py-3">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-2">
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-neon-blue" />
        <span className="font-semibold text-ink">Demo controls</span>
        <span>UI prototype · fake data</span>
      </p>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <ModeRadioGroup label="Viewing as" value={persona} options={PERSONAS} onChange={setPersona} className="sm:flex-1" />
        <DemoThemeToggle className="sm:flex-1" />
      </div>
    </section>
  );
}
