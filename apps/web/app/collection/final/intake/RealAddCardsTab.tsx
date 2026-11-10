import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { useSearchParams } from "react-router";
import { useAuth } from "@clerk/clerk-react";
import { useAction, useMutation, useQuery } from "convex/react";
import NeonButton from "@/components/modules/NeonButton";
import { LiveLine, RunGlyph, type RunLineKind } from "@/components/modules/RunLedger";
import { Input } from "@/components/primitives/Input";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ENTRY_TOO_MANY_PIXELS } from "@/convex/lib/extractRejections";
import { classifyIntake } from "@/lib/placeholders/intake-kind";
import { usePlaceholderUpload } from "@/src/hooks/usePlaceholderUpload";
import { useWarmPreprocess } from "@/src/hooks/useWarmPreprocess";
import { useLeaveGuard } from "@/src/hooks/useLeaveGuard";
import { Dropzone } from "@/app/print/placeholders/dropzone";
import { ScanImage } from "@/app/print/placeholders/scan-image";
import CardPhotoViewer, { VIEWER_WORDS } from "@/components/modules/CardPhotoViewer/CardPhotoViewer";
import ScanPhotoViewer from "@/components/modules/CardPhotoViewer/ScanPhotoViewer";
import { CardPhoto } from "@/components/modules/CardPhotoViewer/EditedPhoto";
import { copyPreviewKey } from "@/components/modules/CardPhotoViewer/convexEdits";
import { ON_THE_WAY_REASON, viewOnlySource } from "@/components/modules/CardPhotoViewer/sources";
import type { PhotoSource } from "@/components/modules/CardPhotoViewer/types";
import { PHOTO_OPENER_ATTR, photoOpenerProps, usePhotoViewer } from "@/components/modules/CardPhotoViewer/usePhotoViewer";
import { asPendingPhotoEdit } from "@/lib/photo-edit/geometry";
import Overlay from "../../prototypes/p1/Overlay";
import Cascade from "../catalog/Cascade";
import { EMPTY_DRILL, type Drill } from "../catalog/drill";
import { useDrillState } from "../catalog/useDrillState";
import {
  homesOnSide,
  useCollectionActions,
  useCommonPrices,
  useContainers,
  useCopyPhotos,
  useDefaultCondition,
  useListingGate,
  useSide,
  writeErrorMessage,
} from "../data/store";
import type { CopyPhotos } from "../data/types";
import { intakeGateLine, ListingGateNote, SyncStatusLink, useIntakeRunLock } from "../inventory/listing/ListingGate";
import { usePageApi } from "../pageApi";
import {
  EMPTY_LANES,
  canRetryPhoto,
  cardLabel,
  columnsClear,
  EDIT_RENDERING_LINE,
  editStateOf,
  parseMinPrice,
  LINE_VIEW_ONLY_LINE,
  lineRetryLine,
  scanOpenerKey,
  linePhotosOf,
  loneTarget,
  STILL_READING_LINE,
  pairTarget,
  type PhotoSideName,
  type PhotoViewerTarget,
  pressEnterIn,
  INTAKE_NEEDS_PRICE_LINE,
  isNeedsPriceRefusal,
  pricePrefill,
  waitingForPriceLine,
  waitsForPrice,
  savedPhotoTarget,
  tilePrice,
  failedText,
  inNaturalOrder,
  LEAVE_INTAKE_LINE,
  laneOf,
  photoLabels,
  PHOTO_NEWS_QUIET_MS,
  PHOTO_OUT_OF_TRIES_LINE,
  PHOTO_RUN_CLOSED_LINE,
  PHOTO_SET_ASIDE_LINE,
  PHOTO_TOO_BIG_LINE,
  photoChanges,
  photoLine,
  photoNewsOf,
  photoStates,
  type PhotoChanges,
  type PhotoStates,
  proposedCount,
  readOf,
  reasonText,
  RUN_CLOSED_LINE,
  runNotice,
  runSummary,
  type IntakeImage,
  type IntakeMatchRow,
  type PairRead,
  tileLabel,
  whyNotSave,
  zipOverLimitLine,
  type Lanes,
} from "./realLanes";
import { HomeSelect, PRICE_ATTR, PriceInput, QTY_ATTR, RING, StageBadge } from "./ui";
import { DRAWER_PARAM } from "../drawerParams";
import { ScannerJoin, SPEECH_AFTER_FOCUS_MS, startRefusal } from "./ScannerJoin";
import {
  beginSend,
  finishSend,
  heldIntakeKey,
  holdFiles,
  readHeld,
  removeHeld,
  retryHeld,
  sayHeld,
  updateHeldSetup,
  useHeldIntake,
  type Condition,
  type Grader,
  type RunDefaults,
  type VariantPick,
} from "./heldIntake";
import "./intake.css";

/**
 * The photos dropped in this tab, by file name, as object URLs: a photo still
 * cropping has no crop to sign yet, so its tile shows the file as picked.
 * Gone after a reload, when the tile falls back to its name alone.
 */
const LocalPhotos = createContext<ReadonlyMap<string, string>>(new Map());

/**
 * NEO-382 — Add cards from photos, signed in: the NEO-369 demo's "Mission
 * Control" screen on the real pipeline. One screen on both sides (the
 * collection files into binders, the inventory into boxes).
 *
 * A run is the unit: one placeholder upload session filing into one home,
 * matched in one variant (`convex/intakeRuns.ts`). It lives on the URL
 * (`?run=`), so it survives a closed tab, and recent runs are listed when no
 * run is open. The run starts with the first photos dropped; more photos join
 * it while its session is open.
 *
 * Every photo travels the lanes left to right (`./realLanes`): reading,
 * pairing, matching, then "Needs you". Automation is "correct but fixable"
 * (Jason, 2026-10-27): the matcher proposes and explains, and nothing saves
 * until the collector says yes (Yes, Enter in the count, or "Save all
 * matched"). Each save is idempotent per pair, so a double click never
 * counts a card twice; a card scanned twice in one run asks first.
 *
 * Keys on the selected card (as in the demo): j/k move, y saves, o opens,
 * e opens its front photo, p jumps to its price (box runs), s swaps sides,
 * u unpairs, d sets it aside, v steps through its other pictures. In the count
 * field only digits type; Enter saves and moves on.
 *
 * Photos can be dropped at any time (NEO-452). Nothing leaves the browser until
 * the run has a home, a set and, for a box that lists on marketplaces for a
 * collector set up for syncing (NEO-370), a price and a condition: the run's Min
 * price (Defaults), else the collector's common price for the set. Until then
 * the photos wait in the zone's tray (`./heldIntake`), then go up by themselves.
 * The server refuses a run with no set, and an unready run and each save the
 * same way. After "Done adding photos" on a run into a box that lists, "See
 * what's syncing" links to Inventory → Sync status.
 *
 * With no set picked there is no price to ask about. Picking a set with no price
 * shows the note and opens Defaults once; "Save as common price" there turns the
 * Min price into the collector's own price for that set. No Start button, and
 * nothing here goes in the URL but `?tab=add` and `?run=`: the tray and the
 * panels are in-view state.
 *
 * Photos go up in this order: open a session, start the run, open it, then
 * upload into it. A refusal then comes before any bytes move, and the run is
 * there to take edits while a big drop uploads. A zip has to upload first (it
 * starts its own job), so it reads the setup as it stands afterwards.
 *
 * A saved card takes its scans with it (NEO-427): the server puts the pair on
 * the saved line after the save, and the tile says how that went (`PhotoLine`),
 * with one polite line for what landed (`usePhotoNews`).
 *
 * Past collecting, one line says where the run stands (NEO-446, `runNotice`),
 * from the job row alone so a refresh on `?run=` says the same. A run that went
 * wrong offers "Start a new run"; one where nothing reached the lanes hides them.
 *
 * Every photo on the screen opens the card photo viewer (NEO-481): a loose
 * photo, a pair in Matching or Needs you, the review drawer's, and a Saved
 * tile's, failed and unread photos too ("Crop by hand"), where auto crop most
 * often misses. There the collector turns a photo a quarter turn or crops it
 * by hand, and saving makes a new image file (the viewer is a dialog, so it
 * stays out of the URL). The server decides per open what can be edited and
 * from what. A save is accepted at once and renders in the background: the
 * tile says "Touching it up…" (its thumbnail already turned) until the new
 * version lands, or what went wrong with Try again, the old photo staying up
 * meanwhile. A pair not saved yet is read and matched again after a new crop.
 *
 * A box run's tiles and its drawer also carry each card's own price (NEO-481;
 * binders never do): prefilled with the run's Min price, else the common
 * price. Left as it started, or blank, it writes nothing, so the default never
 * freezes onto the copy; a different price goes on that card alone, never on
 * a common price.
 *
 * Not yet: finding the set from the photos (the public demo's "Set: from the
 * photos" stays a demo).
 */

export const RUN_PARAM = "run";


const TILE_ATTR = "data-intake-tile";
const REVIEW_HEADING_ID = "intake-needs-you";
const PAIRING_HEADING_ID = "intake-pairing";
/** The card drawer's heading: its dialog is the one dialog the page's keys still act in. */
const DRAWER_TITLE_ID = "intake-drawer-title";
/** Saved lines whose photos one read asks for (the server's `MAX_PHOTOS_OF`). */
const MAX_LINE_PHOTOS = 100;
/** Marks "Done adding photos" for focus moves (a control carries no DOM id). */
const DONE_ATTR = "data-intake-done";
/** Marks a lane's section, so a photo's viewer can fall back to that lane's heading. */
const LANE_ATTR = "data-intake-lane";

/**
 * NEO-481 — the photo button keyed `key` that can take focus (one in the card
 * drawer can share a key with the tile under it, which is inert then).
 */
function liveOpener(key: string): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(`[${PHOTO_OPENER_ATTR}="${key}"]`);
  return Array.from(all).find((el) => !el.closest("[inert]")) ?? null;
}

/**
 * A stable place for focus that lost its own: "Done adding photos" when it is
 * drawn, else the Pairing column's heading. Used after a Back the user answered
 * "Stay" (`useLeaveGuard`), and when a close takes away the control that held
 * focus (NEO-459). False while neither is drawn yet (the page is still loading),
 * so the leave guard tries again.
 */
function parkFocus(): boolean {
  const target =
    document.querySelector<HTMLElement>(`[${DONE_ATTR}]`) ?? document.getElementById(PAIRING_HEADING_ID);
  if (!target) return false;
  target.focus({ preventScroll: true });
  target.scrollIntoView?.({ block: "nearest" });
  return true;
}

/**
 * NEO-411: a Try again moves the photo out of the pile, so its button unmounts
 * and focus would fall to the page. On the next frame, if it did, land on the
 * next photo left in the pile, or else on the pile's heading (WCAG 2.4.3).
 * NEO-446: Set aside moves a photo the same way. Bring back has its own path
 * (`settleReturningPhoto`), because it knows which tile to land on.
 */
function refocusInPile(entryIndex: number): void {
  // Always move: the photo's own tile and button leave where they are once its
  // row changes, which can land after this frame, so focus left on them would
  // drop to the page when they unmount.
  requestAnimationFrame(() => {
    const next = Array.from(document.querySelectorAll<HTMLElement>("[data-loose-photo]")).find(
      (el) => el.dataset.loosePhoto !== String(entryIndex),
    );
    (next ?? document.getElementById(PAIRING_HEADING_ID))?.focus();
  });
}

/** How long a brought-back photo's tile keeps its fallback, in case a re-pair takes the tile away. */
const RETURNED_TILE_WATCH_MS = 10_000;

/** A photo brought back, until focus has landed for it. `landedUntil` is set once it is on the tile. */
interface ReturningPhoto {
  entryIndex: number;
  landedUntil?: number;
}

/**
 * NEO-446: where focus goes after Bring back, called each time the lanes change.
 * Its button stays mounted until the photo repaints, so this waits on the lanes
 * rather than a timer. Then the photo's tile takes focus, or the Pairing heading
 * if it came back as something else. A done photo can re-pair a moment after
 * that and take the tile with it, which also falls to the heading. Focus the
 * collector has moved elsewhere is left alone. Answers what to keep watching.
 */
function settleReturningPhoto(wanted: ReturningPhoto, lanes: Lanes): ReturningPhoto | null {
  const { entryIndex, landedUntil } = wanted;
  if (lanes.looseAside.some((i) => i.entryIndex === entryIndex)) return wanted;
  const active = document.activeElement;
  const focusIsFree = !active || active === document.body || !active.isConnected;
  const watching = landedUntil !== undefined && Date.now() <= landedUntil;
  const tile = lanes.loose.some((i) => i.entryIndex === entryIndex)
    ? document.querySelector<HTMLElement>(`[data-loose-photo="${entryIndex}"]`)
    : null;
  if (tile) {
    if (landedUntil === undefined && focusIsFree) {
      tile.focus();
      return { entryIndex, landedUntil: Date.now() + RETURNED_TILE_WATCH_MS };
    }
    return watching && active === tile ? wanted : null;
  }
  if (focusIsFree && (landedUntil === undefined || watching)) {
    document.getElementById(PAIRING_HEADING_ID)?.focus();
  }
  return null;
}

const CONDITIONS: Condition[] = ["Mint", "Near Mint", "Excellent", "Very Good", "Good", "Poor"];
const GRADERS: Grader[] = ["PSA", "BGS", "SGC", "CGC", "TAG"];

/** The zone's line while a drop would wait rather than go. */
const WAITING_HINT =
  "JPEG, PNG, WebP or one zip. Drop them whenever. They wait here until the run is set up, then go up on their own. Keep them in scan order (front, back, front, back): that's how they pair.";

const today = () => new Date().toISOString().slice(0, 10);

const KEY_HELP: { keys: string; does: string }[] = [
  { keys: "j k ↓ ↑", does: "next, previous card" },
  { keys: "y", does: "yes, save it" },
  { keys: "o", does: "open it" },
  { keys: "e", does: "open its front photo to turn or crop" },
  { keys: "p", does: "jump to its price (boxes)" },
  { keys: "v", does: "its next picture (variation)" },
  { keys: "s", does: "swap front and back" },
  { keys: "u", does: "unpair" },
  { keys: "d", does: "set it aside" },
  { keys: "Enter", does: "in a count: save, next card" },
];

export default function RealAddCardsTab() {
  const side = useSide();
  const { userId } = useAuth();
  const heldKey = heldIntakeKey(userId, side);
  // Keyed: the setup below is seeded once from the photos held for this key.
  return <AddCardsScreen key={heldKey} heldKey={heldKey} />;
}

/** What `createIntakeRun` was sent, to compare with the setup once the run has loaded. */
interface Handover {
  runId: Id<"intakeRuns">;
  homeId: string;
  variantId: Id<"selectorOptions">;
  defaults: RunDefaults;
}

function AddCardsScreen({ heldKey }: { heldKey: string }) {
  useWarmPreprocess();
  const side = useSide();
  const kind = side === "inventory" ? "box" : "binder";
  const containers = useContainers();
  const homes = homesOnSide(containers, side);
  const { notify } = usePageApi();
  const [params, setParams] = useSearchParams();
  const runParam = params.get(RUN_PARAM);
  // A hand-edited `?run=` that is not an id at all would throw in the query's
  // validator; it reads as a run that is gone instead.
  const runId = (runParam && /^[a-z0-9]{16,64}$/.test(runParam) ? runParam : null) as Id<"intakeRuns"> | null;

  const run = useQuery(api.intakeRuns.getIntakeRun, runId ? { runId } : "skip");
  const recent = useQuery(api.intakeRuns.listMyIntakeRuns, runParam ? "skip" : {});
  // NEO-416 — loading is not "nothing there": until the homes and the `?run=`
  // run load, a drop or "Use a scanner" would read as no home ("Make a binder
  // first") or no run (a second run, and the URL moved off this one).
  const loading = containers === undefined || (runId !== null && run === undefined);

  // Setup before the run exists. Once it does, the run's own fields rule.
  // Photos already held bring back the setup they were waiting on.
  const [homeId, setHomeId] = useState<string>(() => readHeld(heldKey).setup?.homeId ?? "");
  const [variant, setVariant] = useState<VariantPick | null>(() => readHeld(heldKey).setup?.variant ?? null);
  const [defaults, setDefaults] = useState<RunDefaults>(() => readHeld(heldKey).setup?.defaults ?? { acquiredOn: today() });
  const [panel, setPanel] = useState<null | "set" | "defaults">(null);
  const pickedHome = homes.some((h) => h.id === homeId) ? homeId : (homes[0]?.id ?? "");
  // Leaving a run (New run, Back) leaves its Min price behind: carried over, it
  // would lift the hold and send the next drop into a listing box with no press.
  // During render, so no commit ever pairs the bare URL with the old Min.
  const [shownParam, setShownParam] = useState(runParam);
  if (shownParam !== runParam) {
    setShownParam(runParam);
    if (!runParam) setDefaults((setup) => ({ ...setup, minPriceCents: undefined }));
  }

  const startStream = useMutation(api.placeholderStream.startPlaceholderStream);
  const closeStream = useMutation(api.placeholderStream.closePlaceholderStream);
  const cancelBatch = useMutation(api.placeholderPipeline.cancelPlaceholderBatch);
  const createRun = useMutation(api.intakeRuns.createIntakeRun);
  const setRunVariant = useMutation(api.intakeRuns.setIntakeRunVariant);
  const setRunDefaults = useMutation(api.intakeRuns.setIntakeRunDefaults);
  const setRunHome = useMutation(api.intakeRuns.setIntakeRunHome);
  const usualCondition = useDefaultCondition();
  const { upload } = usePlaceholderUpload();
  const held = useHeldIntake(heldKey);
  /** A pile `classifyIntake` refused, for the zone to explain. */
  const [refusedPile, setRefusedPile] = useState<File[]>([]);
  const [localPhotos, setLocalPhotos] = useState<ReadonlyMap<string, string>>(new Map());
  const localUrls = useRef<string[]>([]);
  useEffect(() => () => localUrls.current.forEach((u) => URL.revokeObjectURL(u)), []);
  const say = (text: string) => sayHeld(heldKey, text);

  const job = useQuery(api.placeholderPipeline.getPlaceholderJob, run ? { jobId: run.jobId } : "skip");
  // Still loading the run's job reads as collecting, so the drop zone and the
  // scanner code don't blink out while a just-started run catches up.
  const collecting = !run || job === undefined || job?.status === "collecting";
  // NEO-459 — the collector closed this run, here or from anywhere else (the
  // scanner app's `d`). The idle sweep's close is not this: nobody said "done".
  const closedByUser = job?.streamClosedBy === "user";

  // NEO-459 — any close, the idle sweep's too, takes the drop zone, the scanner
  // code and "Done adding photos" with it. Focus inside them would fall to the
  // page, so it is parked. Focus anywhere else is left alone, which is why this
  // asks the leaving controls whether they held it (a ref cleanup runs while they
  // are still in the document) rather than only checking where focus ended up.
  //
  // Every commit, so "Done adding photos" leaving without a close (its job is
  // reloading) can't leave the flag set for a later one. A layout effect, so
  // `focusParked` is answered before RunWorkspace's landing effect reads it:
  // passive effects run children first.
  const focusWentWithClose = useRef(false);
  const focusParked = useRef(false);
  const wasCollecting = useRef(collecting);
  const watchFocus = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    return () => {
      if (el.contains(document.activeElement)) focusWentWithClose.current = true;
    };
  }, []);
  useLayoutEffect(() => {
    const went = focusWentWithClose.current;
    const closed = wasCollecting.current && !collecting;
    focusWentWithClose.current = false;
    wasCollecting.current = collecting;
    focusParked.current = went && closed && focusFell() && parkFocus();
  });
  const notice = collecting ? null : runNotice(job);

  // NEO-370, NEO-452 — the gate, on what the run (or the setup) will give its cards.
  const shownDefaults: RunDefaults = run?.defaults ?? defaults;
  const homeKind = run ? run.homeKind : kind;
  const homeName = run ? run.homeName : (homes.find((h) => h.id === pickedHome)?.name ?? `the ${kind}`);
  const targetHome: string | null = run ? run.homeId : pickedHome || null;
  const targetVariantId: string | null = run ? (run.variantId ?? null) : (variant?.variantId ?? null);
  const targetTitle = run
    ? variant && variant.variantId === run.variantId
      ? variant.title
      : (run.variantName ?? null)
    : (variant?.title ?? null);
  const lock = useIntakeRunLock({
    homeId: targetHome,
    variantId: targetVariantId,
    condition: shownDefaults.condition ?? usualCondition,
    ownPriceCents: shownDefaults.minPriceCents,
    graded: shownDefaults.grading !== undefined,
  });
  const gateLine = lock.locked ? intakeGateLine(homeName, targetTitle, lock, { collecting }) : "";
  const noHome = !loading && !run && !pickedHome;
  /**
   * May the photos go up by themselves? `lock.loaded` is not redundant with
   * `lock.ready`: this is the guard that keeps a set pick from auto-sending with
   * the price still unknown. Elsewhere a loading gate reads as open, because a
   * person is about to press something and the server still refuses. Here nobody
   * presses anything, so "don't know yet" has to mean "wait".
   */
  const ready =
    !loading && lock.loaded && lock.ready && targetHome !== null && (run ? job?.status === "collecting" : true);
  /**
   * What can change the server's answer to a send; a failure isn't retried until
   * this moves. Only those fields: every refused start spends the shared hourly job
   * budget, so typing a Cost, Location, Notes or Acquired must never fire another.
   */
  const config = JSON.stringify([
    targetHome,
    targetVariantId,
    shownDefaults.minPriceCents,
    shownDefaults.condition ?? usualCondition,
    shownDefaults.grading !== undefined,
  ]);
  const gateNoteId = useId();
  const trayId = useId();
  const dropInput = useRef<HTMLInputElement>(null);
  const setButton = useRef<HTMLButtonElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  const conditionRef = useRef<HTMLSelectElement>(null);
  /** The note's button: open Defaults with the missing field focused (once the panel is drawn). */
  const openMissingField = (field: "price" | "condition") => {
    setPanel("defaults");
    requestAnimationFrame(() => (field === "price" ? priceRef.current : conditionRef.current)?.focus());
  };

  const openRun = (id: Id<"intakeRuns"> | null) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (id) next.set(RUN_PARAM, id);
      else next.delete(RUN_PARAM);
      return next;
    });

  // Read by what lands after an await or a frame: the closure that started it
  // may be several renders old by then. Declared first, so the effects below
  // read this render's values.
  const latest = useRef({ run, shownDefaults, homeId: pickedHome, variant, defaults, config, gateLine });
  /** Each run's defaults as last seen, for an Undo that lands after the screen moved off it. */
  const seenRunDefaults = useRef(new Map<Id<"intakeRuns">, RunDefaults>());
  useEffect(() => {
    latest.current = { run, shownDefaults, homeId: pickedHome, variant, defaults, config, gateLine };
    if (run) seenRunDefaults.current.set(run._id, run.defaults ?? {});
  });
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    updateHeldSetup(heldKey, { homeId, variant, defaults });
  }, [heldKey, homeId, variant, defaults]);

  /** Into the run if there is one, else into the setup. */
  const writeDefaults = async (next: RunDefaults) => {
    const open = latest.current.run;
    if (!open) {
      setDefaults(next);
      return;
    }
    await setRunDefaults({ runId: open._id, defaults: next });
  };
  const [defaultsEpoch, setDefaultsEpoch] = useState(0);
  const handover = useRef<Handover | null>(null);
  /** The last run this setup became. */
  const lastStarted = useRef<Id<"intakeRuns"> | null>(null);

  /**
   * Undo's first step for a common price save, taken at the press: it puts the Min
   * back where that save took it from, never on whatever is open by the time Undo
   * is pressed. A save made before the run existed follows the setup into the run
   * it became (the mouse race below), and only that one.
   */
  const minRestorer = () => {
    const savedOn = latest.current.run?._id ?? handover.current?.runId ?? null;
    const startedBefore = lastStarted.current;
    return async (cents: number) => {
      const runId = savedOn ?? (lastStarted.current !== startedBefore ? lastStarted.current : null);
      const seen = runId ? seenRunDefaults.current.get(runId) : undefined;
      if (runId && seen) await setRunDefaults({ runId, defaults: { ...seen, minPriceCents: cents } });
      // No run, or one that hasn't loaded yet, and its handover carries the setup across.
      else setDefaults((setup) => ({ ...setup, minPriceCents: cents }));
    };
  };

  // Leaving a run takes the button that asked for it off the screen, so focus
  // lands on the drop zone, which is the next thing to do, once it is drawn. The
  // ask waits while the URL is still on the old run ("leaving") and for the zone
  // to draw ("arrived"). A run in the URL after arriving is a Back: the ask is over.
  const dropArea = useRef<HTMLDivElement>(null);
  // NEO-459 — the zone's wrapper also tells a close whether focus went with it (`watchFocus`).
  const dropAreaRef = useCallback(
    (el: HTMLDivElement | null) => {
      dropArea.current = el;
      const leaving = watchFocus(el);
      return () => {
        leaving?.();
        dropArea.current = null;
      };
    },
    [watchFocus],
  );
  const focusDropzone = useRef<null | "leaving" | "arrived">(null);
  const startNewRun = () => {
    say("");
    focusDropzone.current = "leaving";
    openRun(null);
  };
  useEffect(() => {
    if (!focusDropzone.current) return;
    if (runParam) {
      if (focusDropzone.current === "arrived") focusDropzone.current = null;
      return;
    }
    focusDropzone.current = "arrived";
    const area = dropArea.current;
    if (!area) return;
    // A disabled input (a send still going) can't take focus, so the zone itself does.
    (area.querySelector<HTMLElement>('input[type="file"]:not(:disabled)') ?? area).focus();
    focusDropzone.current = null;
  }, [runParam, collecting]);

  /* ---------------------------------------------------------------- */
  /* A drop, and when it goes up                                       */
  /* ---------------------------------------------------------------- */

  const onFiles = (chosen: File[]) => {
    if (chosen.length === 0 || held.sending) return;
    setRefusedPile([]);
    if (noHome) {
      say(`Make a ${kind} first: the cards need somewhere to go.`);
      return;
    }
    const refused = holdFiles(heldKey, chosen, { homeId, variant, defaults });
    if (refused) setRefusedPile(refused);
  };

  // A drop while the shelf loaded, onto a shelf that loaded empty.
  useEffect(() => {
    if (!noHome || held.files.length === 0 || held.sending) return;
    removeHeld(heldKey);
    sayHeld(heldKey, `Make a ${kind} first: the cards need somewhere to go.`);
  }, [noHome, held.files.length, held.sending, heldKey, kind]);

  /** Start the run over this job, from the setup as it stands now. */
  const startRun = async (jobId: string) => {
    const setup = latest.current;
    if (!setup.variant) throw new Error("Pick a set first: cards are matched in it.");
    const sent = { homeId: setup.homeId, variantId: setup.variant.variantId, defaults: setup.defaults };
    const id = await createRun({
      jobId,
      homeId: sent.homeId as Id<"collectionContainers">,
      variantId: sent.variantId,
      defaults: sent.defaults,
    });
    handover.current = { runId: id, ...sent };
    lastStarted.current = id;
    // Gone from this tab already: `openRun` would pull the collector back to it.
    if (mounted.current) openRun(id);
  };

  /** Answers what the status line should say, and whether the files are up. */
  const sendPile = async (pile: File[]): Promise<{ sent: boolean; note: string }> => {
    const isZip = classifyIntake(pile).kind === "zip";
    // A zip's counts are the archive's, not its photos: the job row speaks for it now.
    const sentWords = (out: { kind: "zip" | "images"; uploaded: number; failed: number; total: number }) =>
      out.kind === "zip"
        ? ""
        : out.failed === 0
          ? `Sent ${out.uploaded} photo${out.uploaded === 1 ? "" : "s"}.`
          : `Sent ${out.uploaded} of ${out.total} photos. ${out.failed} failed.`;
    const refused = (out: { reason: string; overLimitMb?: number }) => ({
      sent: false,
      note:
        out.overLimitMb !== undefined
          ? zipOverLimitLine(out.overLimitMb)
          : `${isZip ? "Couldn't send that zip" : "Couldn't send these photos"}: ${out.reason}.`,
    });
    // Scan order is upload order, and a zip is unpacked in natural filename
    // order, so loose photos go up the same way. Here and not in the hook: the
    // seed page uploads in the exact order it is handed, backs first on purpose.
    const ordered = isZip ? pile : inNaturalOrder(pile);
    const open = latest.current.run;
    if (open) {
      const out = await upload(ordered, { source: "web", jobId: open.jobId });
      return out.ok ? { sent: true, note: sentWords(out) } : refused(out);
    }
    if (isZip) {
      // A zip starts its own job, so it can't go after the run.
      const out = await upload(pile, { source: "web" });
      if (!out.ok) return refused(out);
      try {
        await startRun(out.jobId);
      } catch (error) {
        // That batch is already running, and paid for. Left alone it reads cards for
        // a run that doesn't exist, and a retry would start a second one beside it.
        await cancelBatch({ jobId: out.jobId }).catch(() => {});
        throw error;
      }
      return { sent: true, note: sentWords(out) };
    }
    const session = await startStream({ source: "web" });
    if (!session.started || !session.jobId) return { sent: false, note: startRefusal(session.reason) };
    try {
      await startRun(session.jobId);
    } catch (error) {
      // A session with no run would hold an active-batch slot until the idle sweep.
      void closeStream({ jobId: session.jobId }).catch(() => {});
      throw error;
    }
    const out = await upload(ordered, { source: "web", jobId: session.jobId });
    return out.ok ? { sent: true, note: sentWords(out) } : refused(out);
  };

  const sendHeld = useEffectEvent(async () => {
    const claimed = beginSend(heldKey);
    if (!claimed) return;
    const pile = [...claimed];
    const added = new Map(localPhotos);
    for (const file of pile) {
      // Only types every browser draws; a HEIC photo keeps its name alone.
      if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type) || added.has(file.name)) continue;
      const url = URL.createObjectURL(file);
      localUrls.current.push(url);
      added.set(file.name, url);
    }
    setLocalPhotos(added);
    say(classifyIntake(pile).kind === "zip" ? "Sending your zip…" : "Sending your photos…");
    let outcome: { sent: boolean; note: string };
    try {
      outcome = await sendPile(pile);
    } catch (error) {
      outcome = { sent: false, note: writeErrorMessage(error) };
    }
    finishSend(heldKey, pile, outcome.sent ? null : latest.current.config);
    say(outcome.note);
  });
  useEffect(() => {
    if (held.files.length === 0 || held.sending || !ready || held.failedConfig === config) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- starts the async send; its one synchronous write is the thumbnails, made from the files as the send claims them
    void sendHeld();
  }, [held.files.length, held.sending, held.failedConfig, ready, config]);

  // A late gate answer can take the tray away with focus on one of its buttons (the
  // tray steps aside in the same commit that makes the screen ready, before any
  // effect can look). `HeldTray` flags it while the button is still there.
  const trayFocusGone = useRef(false);
  const flagTrayFocus = useCallback(() => {
    trayFocusGone.current = true;
  }, []);
  useEffect(() => {
    if (!trayFocusGone.current) return;
    trayFocusGone.current = false;
    const focused = document.activeElement;
    if (!focused || focused === document.body) statusLine.current?.focus({ preventScroll: true });
  });

  /* ---------------------------------------------------------------- */
  /* The handover: from the setup to the run                           */
  /* ---------------------------------------------------------------- */

  /**
   * Between `createRun` and the run's first load, a change lands in the setup,
   * where the run never reads it. Once it loads, write across whatever moved, once.
   *
   * This looks like a nicety and is the one thing standing between a mouse and a
   * wrong price. On "Save as common price", mousedown blurs the Min price field:
   * the price commits, the hold lifts and the send starts, all before the click
   * lands. So `createRun` goes out carrying the Min, and the click's clear lands
   * in the setup. Without this the run keeps the Min, and every copy it saves
   * carries that floor forever, never following the common price just set.
   */
  const reconcileHandover = useEffectEvent((id: Id<"intakeRuns">) => {
    const sent = handover.current;
    if (!sent || sent.runId !== id) return;
    handover.current = null;
    const refused = (e: unknown) => notify(writeErrorMessage(e));
    if (pickedHome && pickedHome !== sent.homeId) {
      setRunHome({ runId: id, homeId: pickedHome as Id<"collectionContainers"> }).catch(refused);
    }
    if (variant && variant.variantId !== sent.variantId) {
      setRunVariant({ runId: id, variantId: variant.variantId }).catch(refused);
    }
    if (JSON.stringify(defaults) !== JSON.stringify(sent.defaults)) {
      setRunDefaults({ runId: id, defaults }).catch(refused);
    }
  });
  const loadedRunId = run?._id;
  useEffect(() => {
    if (loadedRunId) reconcileHandover(loadedRunId);
  }, [loadedRunId]);

  // The URL moved off the run this screen just started (or was never on it): that
  // handover must not write onto the run if it's reopened later, and what the status
  // line said belonged to where we were. Unless a send is still going to say more.
  const noteParam = useRef(runParam);
  useEffect(() => {
    if (noteParam.current === runParam) return;
    noteParam.current = runParam;
    if (handover.current?.runId === runParam) return;
    handover.current = null;
    if (!readHeld(heldKey).sending) sayHeld(heldKey, "");
  }, [heldKey, runParam]);
  // A send that finishes after this still says so, once, on the way back.
  useEffect(() => () => sayHeld(heldKey, ""), [heldKey]);

  /* ---------------------------------------------------------------- */
  /* Opening Defaults once, on a new set or home with no price         */
  /* ---------------------------------------------------------------- */

  /**
   * A pick or home change waiting on its answer. Consumed once, so closing the
   * panel, clearing the Min price or an Undo never opens it again. An effect, not
   * a `setPanel` in the pick: `onPick` runs before the Set panel's `close()`, whose
   * `setPanel(null)` would overwrite it.
   */
  const pendingOpen = useRef<{ via: "pick" | "home"; variantId?: string; homeId?: string } | null>(null);
  const [pickNonce, setPickNonce] = useState(0);
  const [opened, setOpened] = useState<{ via: "pick" | "home" } | null>(null);
  /** The warning, for a screen reader, when focus doesn't carry it (the note itself isn't a live region). */
  const [gateNews, setGateNews] = useState("");
  // Said once. Left standing, the hold coming back would read it out a second time.
  if (gateNews && (!lock.locked || panel === null)) setGateNews("");
  // Clearing the Min can bring the hold back, and nothing else would say so.
  const minSet = shownDefaults.minPriceCents !== undefined;
  const [hadMin, setHadMin] = useState(minSet);
  if (hadMin !== minSet) {
    setHadMin(minSet);
    if (hadMin && lock.needsPrice) setGateNews(gateLine);
  }
  /**
   * A set pick that leaves the photos waiting on a price moves focus to Min price,
   * whose note says so. The tray's region is muted from the pick until then, or it
   * talks over the field ("2 photos waiting on a price"). A pick that opens nothing
   * has the tray say it again instead, remounting its words so the region speaks.
   */
  const [trayQuiet, setTrayQuiet] = useState(false);
  const [trayEpoch, setTrayEpoch] = useState(0);
  const sayTrayAgain = () => {
    setTrayQuiet(false);
    setTrayEpoch((n) => n + 1);
  };
  const expectOpen = (next: NonNullable<typeof pendingOpen.current>) => {
    pendingOpen.current = next;
    setGateNews("");
    setPickNonce((n) => n + 1);
  };
  const settlePendingOpen = useEffectEvent(() => {
    const pending = pendingOpen.current;
    if (!pending || loading) return;
    // An open run answers through the server: wait for its fields to get there.
    if (pending.variantId !== undefined && pending.variantId !== targetVariantId) return;
    if (pending.homeId !== undefined && pending.homeId !== targetHome) return;
    if (!lock.loaded) return;
    pendingOpen.current = null;
    if (!lock.needsPrice) {
      // Nothing opens, so nothing else says what the pick did to the waiting photos.
      if (trayQuiet) sayTrayAgain();
      return;
    }
    setPanel((current) => current ?? "defaults");
    setOpened({ via: pending.via });
  });
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one edge, consumed once, on the server's answer for a pick; a value derived in render would reopen the panel after every close
    settlePendingOpen();
  }, [loading, targetHome, targetVariantId, pickNonce, lock.loaded, lock.needsPrice]);
  useEffect(() => {
    if (!opened) return;
    // A frame on, and after `close()`'s own frame that returns focus to Set.
    const frame = requestAnimationFrame(() => {
      const focused = document.activeElement;
      const free = !focused || focused === document.body || focused === setButton.current;
      // A home change opens the panel but never moves focus (WCAG 3.2.2).
      if (opened.via === "pick" && free && priceRef.current) priceRef.current.focus();
      else setGateNews(latest.current.gateLine);
      // Either way something has said it: the field and its note, or the status line.
      setTrayQuiet(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [opened]);

  /* ---------------------------------------------------------------- */

  const setupBar = (
    <div className="flex flex-wrap items-end gap-4 rounded-lg border border-panel-rule bg-panel p-4 shadow-offset">
      {run && run.homeKind !== kind ? (
        // A run opened from the other side (a box run under Collection) keeps
        // its home; it moves only among homes of its own kind.
        <p className="m-0 flex flex-col gap-1 text-sm">
          <span className="text-xs font-semibold text-ink-2">Going into</span>
          <span className="font-semibold text-ink">{run.homeName}</span>
        </p>
      ) : (
        <HomeSelect
          value={run ? run.homeId : pickedHome}
          homes={homes}
          label={kind === "box" ? "Put them in this box" : "Put them in this binder"}
          onChange={(id) => {
            expectOpen({ via: "home", homeId: id });
            if (!run) return setHomeId(id);
            const name = homes.find((h) => h.id === id)?.name ?? `the ${kind}`;
            setRunHome({ runId: run._id, homeId: id as Id<"collectionContainers"> })
              .then(() => say(`The next cards you save go into ${name}.`))
              .catch((e: unknown) => {
                if (pendingOpen.current?.homeId === id) pendingOpen.current = null;
                notify(writeErrorMessage(e));
              });
          }}
        />
      )}
      <RealSetButton
        open={panel === "set"}
        onOpenChange={(o) => setPanel(o ? "set" : null)}
        current={targetTitle}
        buttonRef={setButton}
        onPick={(pick) => {
          setVariant(pick);
          if (!pick) return;
          expectOpen({ via: "pick", variantId: pick.variantId });
          setTrayQuiet(true);
          if (run) {
            setRunVariant({ runId: run._id, variantId: pick.variantId }).catch((e: unknown) => {
              if (pendingOpen.current?.variantId === pick.variantId) pendingOpen.current = null;
              sayTrayAgain();
              notify(writeErrorMessage(e));
            });
          }
        }}
      />
      <NeonButton
        variant="secondary"
        outline
        aria-expanded={panel === "defaults"}
        aria-controls="intake-defaults-panel"
        onClick={() => setPanel(panel === "defaults" ? null : "defaults")}
      >
        Defaults: {shownDefaults.condition ?? usualCondition}
        {shownDefaults.grading ? `, ${shownDefaults.grading.grader}` : ""}
        {homeKind === "box" && shownDefaults.minPriceCents !== undefined ? `, $${centsText(shownDefaults.minPriceCents)}` : ""}
      </NeonButton>
      {run && (
        <NeonButton variant="secondary" outline className="ml-auto" onClick={startNewRun}>
          New run
        </NeonButton>
      )}
      {/* In the bar, right above the panel: on a phone it would fall below a tall panel otherwise. */}
      {lock.locked && (
        <div className="w-full">
          <ListingGateNote id={gateNoteId} line={gateLine}>
            <NeonButton
              size="1"
              variant="secondary"
              outline
              className="max-sm:min-h-11"
              onClick={() => openMissingField(lock.needsPrice ? "price" : "condition")}
            >
              {lock.needsPrice ? "Set a Min price" : "Pick a condition"}
            </NeonButton>
          </ListingGateNote>
        </div>
      )}
      {panel === "defaults" && (
        <div id="intake-defaults-panel" className="w-full border-t border-rule pt-3">
          <DefaultsFields
            key={defaultsEpoch}
            value={shownDefaults}
            showPrice={homeKind === "box"}
            priceRef={priceRef}
            conditionRef={conditionRef}
            priceDescribedBy={lock.locked ? gateNoteId : undefined}
            priceMissing={lock.needsPrice}
            commonPrice={
              targetVariantId
                ? {
                    variantId: targetVariantId as Id<"selectorOptions">,
                    title: targetTitle ?? "this set",
                    syncing: lock.syncing,
                    minRestorer,
                    reseed: () => setDefaultsEpoch((n) => n + 1),
                  }
                : null
            }
            onChange={writeDefaults}
            onRefused={(e) => notify(writeErrorMessage(e))}
          />
        </div>
      )}
    </div>
  );

  const failed = held.failedConfig === config;
  // The tray steps aside while they're going up, or about to: the status line has it then.
  const goingUp = ready && !failed;
  const waiting = held.sending || goingUp ? [] : held.files;
  const jobClosed = !!run && !collecting;
  const trayLine =
    waiting.length === 0
      ? ""
      : jobClosed
        ? `${pileWords(waiting)} waiting. This run's all in, so start a new run.`
        : !loading && lock.needsSet
          ? `${pileWords(waiting)} waiting. Pick a set and they're off.`
          : lock.setHasNoCards
            ? "That set has no cards to match against yet. Pick another one."
            : lock.needsPrice
              ? `${pileWords(waiting)} waiting on a price.`
              : lock.needsCondition
                ? `${pileWords(waiting)} waiting on a condition.`
                : `${pileWords(waiting)} waiting.`;
  const tray = (
    <HeldTray
      id={trayId}
      line={trayLine}
      quiet={trayQuiet}
      epoch={trayEpoch}
      alone={jobClosed}
      onFocusGoing={flagTrayFocus}
      onRemove={() => {
        removeHeld(heldKey);
        setRefusedPile([]);
        (dropInput.current ?? statusLine.current)?.focus();
        say("Photos removed.");
      }}
      onRetry={
        failed && ready
          ? () => {
              retryHeld(heldKey);
              // The old failure is still there, and focus would read it out again.
              say("Trying again…");
              // The button is about to go with the tray; the status line says how it goes.
              statusLine.current?.focus({ preventScroll: true });
            }
          : undefined
      }
    />
  );
  // An open run can still mint its code, set or no set.
  const scannerHold =
    run || !pickedHome
      ? undefined
      : lock.needsSet
        ? "Pick a set first, then get a code."
        : lock.setHasNoCards
          ? "That set has no cards to match against yet. Pick another one, then get a code."
          : lock.needsPrice
            ? "Set a price first, then get a code."
            : lock.needsCondition
              ? "Pick a condition first, then get a code."
              : undefined;

  return (
    <div data-motion="high" className="space-y-4">
      {setupBar}
      {runParam && (!runId || run === null) && (
        <p className="m-0 rounded-md border border-rule p-3 text-sm text-ink-2">
          That run isn&apos;t yours or is gone.{" "}
          <button type="button" className={`text-neon-blue-text underline ${RING}`} onClick={startNewRun}>
            Start a new one
          </button>
        </p>
      )}
      {collecting && (
        <div ref={dropAreaRef} tabIndex={-1} className="space-y-4 outline-none">
          <Dropzone
            quiet
            files={refusedPile}
            disabled={held.sending}
            onFilesWhileDisabled={() => say("Still sending. Drop the rest in a moment.")}
            inputRef={dropInput}
            hint={ready || noHome ? undefined : WAITING_HINT}
            describedBy={[lock.locked ? gateNoteId : null, trayLine ? trayId : null].filter(Boolean).join(" ") || undefined}
            tray={tray}
            trayFilled={trayLine !== ""}
            onFiles={onFiles}
          />
          <ScannerJoin
            runId={run?._id ?? null}
            newRun={
              pickedHome && variant
                ? { homeId: pickedHome as Id<"collectionContainers">, variantId: variant.variantId, defaults }
                : null
            }
            kind={kind}
            loading={loading || (!run && !lock.loaded)}
            heldReason={scannerHold}
            onRunStarted={openRun}
          />
        </div>
      )}
      <div>
        {/* The run's line (NEO-446). The live region is always mounted, so a line landing in it
            is announced; the button stays outside it, so it isn't read out as part of the line. */}
        <div
          className={
            notice
              ? `mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border p-3 text-sm ${
                  notice.problem ? "border-notice-warn-rule bg-notice-warn-bg text-notice-warn-ink" : "border-rule text-ink-2"
                }`
              : undefined
          }
        >
          <p role="status" aria-live="polite" className="m-0 min-w-0 flex-1 basis-64 [overflow-wrap:anywhere]">
            {notice?.parts.map((part, i) => (i % 2 === 1 ? <bdi key={i}>{part}</bdi> : part))}
          </p>
          {notice?.problem && (
            // Outlined when the run has photos: cards may be waiting on the collector here.
            <NeonButton size="1" variant="primary" outline={!!job?.totalImages} className="max-sm:min-h-11" onClick={startNewRun}>
              Start a new run
            </NeonButton>
          )}
        </div>
        {/* Photos still held when the run closed: no zone to sit in, so the tray stands alone. */}
        {!collecting && trayLine && <div className="mb-2">{tray}</div>}
        <p
          ref={statusLine}
          tabIndex={-1}
          role="status"
          aria-live="polite"
          aria-label="Add cards status"
          className={`m-0 min-h-5 rounded-sm text-sm text-ink-2 ${RING}`}
        >
          {held.note}
          {lock.locked && gateNews && <span className="sr-only"> {gateNews}</span>}
        </p>
      </div>
      {run ? (
        !notice?.hideWorkspace && (
          <LocalPhotos.Provider value={localPhotos}>
            {/* Keyed so one run's Done, close line and open/closed memory can't carry to another on Back or Forward. */}
            <RunWorkspace
              key={run._id}
              run={run}
              jobOpen={job?.status === "collecting"}
              sendingPhotos={held.sending}
              closedByUser={closedByUser}
              doneRef={watchFocus}
              focusParked={focusParked}
            />
          </LocalPhotos.Provider>
        )
      ) : (
        !runParam && <RecentRuns runs={(recent ?? []).filter((r) => r.homeKind === kind)} onOpen={openRun} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Setup pieces                                                        */
/* ------------------------------------------------------------------ */

/** Cents as the Min price field shows them ("1.50"); blank for none. */
function centsText(cents: number | undefined): string {
  return cents === undefined ? "" : (cents / 100).toFixed(2);
}

/** "2 photos" or, for the one zip a pile can hold, "1 zip". */
function pileWords(files: readonly File[]): string {
  if (classifyIntake([...files]).kind === "zip") return "1 zip";
  return files.length === 1 ? "1 photo" : `${files.length} photos`;
}

/**
 * The photos waiting for the run to be ready, as a row inside the drop zone's
 * frame. Always mounted (the words are a live region, and speak only a change);
 * it draws nothing until there is something in it.
 */
function HeldTray({
  id,
  line,
  quiet = false,
  epoch = 0,
  alone = false,
  onFocusGoing,
  onRemove,
  onRetry,
}: {
  id: string;
  line: string;
  /** Change the words without saying them: focus is on its way to what explains them. */
  quiet?: boolean;
  /** A change remounts the words, so the region says them again. */
  epoch?: number;
  /** No drop zone above it: the run's job has closed. */
  alone?: boolean;
  /** A button is leaving with focus on it. Called while it is still in the page. */
  onFocusGoing: () => void;
  onRemove: () => void;
  onRetry?: () => void;
}) {
  const filled = line !== "";
  // A ref's cleanup runs before the button leaves the page; by a parent's effect,
  // focus is already gone and there is no telling it was ever here.
  const watchFocus = useCallback(
    (button: HTMLButtonElement | null) => {
      if (!button) return;
      return () => {
        if (document.activeElement === button) onFocusGoing();
      };
    },
    [onFocusGoing],
  );
  return (
    <div
      // Under a drop zone, the zone draws the frame, so a drag lights the tray with it.
      className={
        filled
          ? `flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 text-sm text-ink-2 ${alone ? "rounded-xl border-2 border-dashed border-rule-strong" : ""}`
          : ""
      }
    >
      {/* The id is on the words, not the region: `aria-describedby` reads a node's own
          name first, so the zone would be described as "Waiting photos". */}
      <p role="status" aria-live={quiet ? "off" : "polite"} aria-label="Waiting photos" className="m-0 min-w-0 flex-1">
        <span key={epoch} id={id}>
          {line}
        </span>
      </p>
      {filled && onRetry && (
        <NeonButton
          ref={watchFocus}
          size="1"
          variant="secondary"
          outline
          className="max-sm:min-h-11"
          aria-label="Try again: send the waiting photos"
          onClick={onRetry}
        >
          Try again
        </NeonButton>
      )}
      {filled && (
        <NeonButton ref={watchFocus} size="1" variant="negative" outline className="max-sm:min-h-11" onClick={onRemove}>
          Remove photos
        </NeonButton>
      )}
    </div>
  );
}

/**
 * The set pick: the collection's own cascade (sport to variant) behind one
 * button that folds back once a variant is picked (the demo's `SetButton`,
 * on the real catalog).
 */
function RealSetButton({
  open,
  onOpenChange,
  current,
  onPick,
  buttonRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: string | null;
  onPick: (pick: VariantPick | null) => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  const [drill, setDrill] = useState<Drill>(EMPTY_DRILL);
  const state = useDrillState(drill, open);
  const close = () => {
    onOpenChange(false);
    requestAnimationFrame(() => buttonRef.current?.focus());
  };
  return (
    <>
      <NeonButton
        ref={buttonRef}
        variant="secondary"
        outline
        aria-expanded={open}
        aria-controls="intake-set-panel"
        onClick={() => onOpenChange(!open)}
      >
        Set: {current ?? "pick one"}
      </NeonButton>
      {open && (
        <div id="intake-set-panel" className="order-last w-full space-y-3 border-t border-rule pt-3">
          <p className="m-0 text-sm text-ink-2">
            Pick the set down to the variant. Cards are matched in it.
          </p>
          <Cascade
            state={state}
            onDrill={setDrill}
            label="Sport, year, brand, set and variant"
            onReachedChecklist={() => {
              const variantId = state.checklist?.variantId;
              if (!state.checklist || !variantId) return false;
              onPick({
                variantId: variantId as Id<"selectorOptions">,
                title: state.checklistTitle ?? state.checklist.name,
              });
              close();
              return true;
            }}
          />
        </div>
      )}
    </>
  );
}

const FIELD = `rounded-md border border-field-rule bg-field px-2 py-1 text-sm text-ink ${RING}`;

/** The run's batch defaults: every card starts with these. */
function DefaultsFields({
  value,
  onChange,
  onRefused,
  showPrice,
  priceRef,
  conditionRef,
  priceDescribedBy,
  priceMissing = false,
  commonPrice,
}: {
  value: RunDefaults;
  /** Writes the whole defaults; rejects when the server refuses. */
  onChange: (next: RunDefaults) => Promise<void>;
  onRefused: (error: unknown) => void;
  /** A box run: the cards can carry a Min price (NEO-378). */
  showPrice: boolean;
  priceRef?: Ref<HTMLInputElement>;
  conditionRef?: Ref<HTMLSelectElement>;
  /** The listing note, when it shows: the field is what it's asking for. */
  priceDescribedBy?: string;
  /** No Min price and no common price: blank would not sell at all. */
  priceMissing?: boolean;
  /** The set the Min price could become the common price of; null with no set known. */
  commonPrice: CommonPriceTarget | null;
}) {
  const priceHelpId = useId();
  const priceErrorId = useId();
  // No "your usual" choice: the field shows the seller's default (Profile →
  // Settings) until they pick another.
  const usualCondition = useDefaultCondition();
  // Seeded once, when the panel opens; every change is written straight back.
  const [draft, setDraft] = useState(value);
  // The freshest draft for a write that lands after an await (the common price
  // button clears the Min once its own save is back).
  const latestDraft = useRef(value);
  const write = (patch: Partial<RunDefaults>) => {
    const next = { ...latestDraft.current, ...patch };
    latestDraft.current = next;
    setDraft(next);
    return onChange(next);
  };
  const commit = (patch: Partial<RunDefaults>) => {
    write(patch).catch(onRefused);
  };
  const g = draft.grading;
  const cost = draft.costCents === undefined ? "" : (draft.costCents / 100).toFixed(2);
  const [priceText, setPriceText] = useState(() => centsText(value.minPriceCents));
  const [priceBad, setPriceBad] = useState(false);
  /** Min price: blank clears it, a price sets it (shown back to the cent), anything else is refused in place. */
  const commitPrice = () => {
    const cents = parseMinPrice(priceText);
    if (cents === "invalid") {
      setPriceBad(true);
      return;
    }
    setPriceBad(false);
    setPriceText(centsText(cents));
    if (cents !== draft.minPriceCents) commit({ minPriceCents: cents });
  };
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="flex flex-col gap-1 text-xs text-ink-3">
        Condition
        <select
          ref={conditionRef}
          className={FIELD}
          value={draft.condition ?? usualCondition}
          onChange={(e) => commit({ condition: e.target.value as Condition })}
        >
          {CONDITIONS.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-3">
        Graded by
        <select
          className={FIELD}
          value={g?.grader ?? ""}
          onChange={(e) =>
            commit({ grading: e.target.value ? { grader: e.target.value as Grader, grade: g?.grade ?? "", cert: g?.cert } : undefined })
          }
        >
          <option value="">Raw</option>
          {GRADERS.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </label>
      {g && (
        <label className="flex flex-col gap-1 text-xs text-ink-3">
          Grade
          <Input bare className={FIELD} defaultValue={g.grade} onBlur={(e) => commit({ grading: { ...g, grade: e.target.value } })} />
        </label>
      )}
      <label className="flex flex-col gap-1 text-xs text-ink-3">
        Cost each
        <Input
          bare
          className={FIELD}
          inputMode="decimal"
          placeholder="$0.00"
          defaultValue={cost}
          key={cost}
          onBlur={(e) => {
            const n = Number(e.target.value);
            commit({ costCents: e.target.value && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined });
          }}
        />
      </label>
      {showPrice && (
        <div className="flex flex-col gap-1 text-xs text-ink-3">
          {/* The help sits outside the label, so the field's name is "Min price" alone. */}
          <label className="flex flex-col gap-1">
            Min price
            <Input
              ref={priceRef}
              bare
              className={FIELD}
              type="text"
              inputMode="decimal"
              placeholder="Common price"
              value={priceText}
              aria-invalid={priceBad || undefined}
              aria-describedby={[priceBad ? priceErrorId : null, priceHelpId, priceDescribedBy].filter(Boolean).join(" ")}
              onChange={(e) => setPriceText(e.target.value)}
              onBlur={commitPrice}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitPrice();
                }
              }}
            />
          </label>
          {priceBad && (
            <span id={priceErrorId} role="alert" className="text-notice-danger-ink">
              Type a price like 1.50
            </span>
          )}
          <span id={priceHelpId}>
            {priceMissing && commonPrice
              ? `Or save it as your common price for ${commonPrice.title}.`
              : "Leave it blank to sell at your common price."}
          </span>
        </div>
      )}
      {/* Its own full row, right under the price: "Replace $12.50 common price" doesn't
          fit a third of the panel. Next in the DOM, so Tab goes Min price, then this. */}
      {showPrice && commonPrice && (
        <div className="flex flex-col gap-1 text-xs text-ink-3 sm:col-span-3">
          <SaveAsCommonPrice
            target={commonPrice}
            text={priceText}
            onSaved={async () => {
              await write({ minPriceCents: undefined });
              setPriceText("");
              setPriceBad(false);
            }}
          />
        </div>
      )}
      <label className="flex flex-col gap-1 text-xs text-ink-3">
        Acquired
        <Input bare type="date" className={FIELD} value={draft.acquiredOn ?? ""} onChange={(e) => commit({ acquiredOn: e.target.value || undefined })} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-3">
        Location
        <Input bare className={FIELD} placeholder="Row 2" defaultValue={draft.location ?? ""} onBlur={(e) => commit({ location: e.target.value || undefined })} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-3 sm:col-span-3">
        Notes
        <Input bare className={FIELD} defaultValue={draft.notes ?? ""} onBlur={(e) => commit({ notes: e.target.value || undefined })} />
      </label>
    </div>
  );
}

/** What "Save as common price" needs from the screen. */
interface CommonPriceTarget {
  variantId: Id<"selectorOptions">;
  title: string;
  /** The collector syncs, so a new common price can reach cards already listed. */
  syncing: boolean;
  /** Called at the press. Answers Undo's first step: put the Min price back where this save took it from. */
  minRestorer: () => (cents: number) => Promise<void>;
  /** Undo's last step: `DefaultsFields` seeds its draft once, so draw it afresh. */
  reseed: () => void;
}

/**
 * NEO-452 — the Min price as the collector's own common price for this set. The
 * value is the field's text at the press, not what was last committed. No dialog
 * even when it replaces a different price: the label says it, the line beneath
 * says what moves, and the status line has Undo, as `CommonPrice` does.
 *
 * The Min is cleared once the price is saved (Jason, 2026-11-06). A kept Min
 * would become each copy's own floor, and those copies would never follow a later
 * common price. Copies this run already saved keep the floor they have. Common
 * price first, then the clear, so the hold never flashes back.
 */
function SaveAsCommonPrice({
  target,
  text,
  onSaved,
}: {
  target: CommonPriceTarget;
  text: string;
  /** Clears the Min price. */
  onSaved: () => Promise<void>;
}) {
  const { variantId, title, syncing, minRestorer, reseed } = target;
  const page = usePageApi();
  const writes = useCollectionActions();
  const prices = useCommonPrices([variantId]);
  const common = prices === undefined ? undefined : (prices[variantId] ?? null);
  const helpId = useId();
  const whyNotId = useId();
  const saving = useRef(false);
  const parsed = parseMinPrice(text);
  const cents = typeof parsed === "number" ? parsed : null;
  // Nothing typed replaces nothing, including just after a save has cleared the field.
  const replaces = typeof common === "number" && cents !== null && Math.round(common * 100) !== cents;
  const label = replaces ? `Replace $${common.toFixed(2)} common price` : "Save as common price";
  // Blank, not a price, or still loading what it would replace: a Tab stop that does nothing.
  const usable = cents !== null && common !== undefined;
  const whyNot =
    parsed === undefined
      ? "Type a Min price first."
      : parsed === "invalid"
        ? "Fix the Min price first."
        : common === undefined
          ? "Checking your common price…"
          : null;
  const save = () => {
    if (cents === null || !usable || saving.current) return;
    saving.current = true;
    const dollars = cents / 100;
    const restoreMin = minRestorer();
    void page
      .run(
        async () => {
          const saved = await writes.setCommonPrice(variantId, dollars);
          await onSaved();
          return {
            undo: async () => {
              await restoreMin(cents);
              await saved.undo();
              reseed();
            },
          };
        },
        () => `Common price for ${title} is $${dollars.toFixed(2)}`,
      )
      .finally(() => {
        saving.current = false;
      });
  };
  return (
    <>
      <NeonButton
        size="1"
        variant="secondary"
        outline
        className="mt-1 self-start max-sm:min-h-11"
        aria-label={`${label} for ${title}`}
        aria-disabled={!usable}
        aria-describedby={whyNot ? `${whyNotId} ${helpId}` : helpId}
        onClick={save}
      >
        {label}
      </NeonButton>
      {whyNot && (
        <span id={whyNotId} className="sr-only">
          {whyNot}
        </span>
      )}
      <span id={helpId}>
        Cards from {title} with no price of their own sell at it.
        {syncing && " That includes any you've already listed, so those change too."}
      </span>
    </>
  );
}

type RunSummary = NonNullable<ReturnType<typeof useRunSummaryType>>;
// Only for the type: the shape `getIntakeRun` answers.
function useRunSummaryType() {
  return useQuery(api.intakeRuns.getIntakeRun, "skip");
}

function RecentRuns({ runs, onOpen }: { runs: RunSummary[]; onOpen: (id: Id<"intakeRuns">) => void }) {
  if (runs.length === 0) return null;
  return (
    <section aria-labelledby="intake-recent" className="space-y-2">
      <h2 id="intake-recent" className="m-0 text-sm font-semibold text-ink">
        Recent runs
      </h2>
      <ul className="m-0 list-none space-y-1 p-0">
        {runs.map((r) => (
          <li key={r._id}>
            <button type="button" onClick={() => onOpen(r._id)} className={`text-sm text-neon-blue-text underline ${RING}`}>
              Into {r.homeName}
              {r.variantName ? `, ${r.variantName}` : ""}, {new Date(r.lastActivityAt).toLocaleString()}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* The live workspace                                                  */
/* ------------------------------------------------------------------ */

/**
 * NEO-370 Rev 4 — the runs this tab saw "Done adding photos" pressed on.
 * Outside component state so a Back that the leave guard sends straight back
 * (a remount) still knows the run is waiting on its columns. NEO-459: a close
 * from elsewhere that lands while the screen is watching counts as that press.
 */
const doneRuns = new Set<string>();

const LANE_LABEL = {
  reading: "Cropping & reading",
  pairing: "Pairing",
  matching: "Matching",
  review: "Needs you",
  saved: "Saved",
} as const;

function RunWorkspace({
  run,
  jobOpen,
  sendingPhotos,
  closedByUser,
  doneRef,
  focusParked,
}: {
  run: RunSummary;
  jobOpen: boolean;
  /** Photos are on their way up; closing the job now would refuse the rest. */
  sendingPhotos: boolean;
  /** The job says the collector closed it, on this screen or anywhere else (NEO-459). */
  closedByUser: boolean;
  doneRef: Ref<HTMLButtonElement>;
  /** This commit's close just moved focus to the Pairing heading (NEO-459). */
  focusParked: RefObject<boolean>;
}) {
  const { notify, inform } = usePageApi();
  const doneWhyId = useId();
  const images = useQuery(api.placeholderPipeline.listPlaceholderImages, { jobId: run.jobId });
  const pairs = useQuery(api.placeholderPipeline.listPlaceholderPairs, { jobId: run.jobId });
  const matches = useQuery(api.intakeRuns.listIntakeMatches, { runId: run._id });
  const lanes = useMemo(
    () => (images && pairs && matches ? laneOf(images, pairs, matches) : EMPTY_LANES),
    [images, pairs, matches],
  );
  const byIndex = useMemo(() => new Map((images ?? []).map((i) => [i.entryIndex, i])), [images]);
  const labels = useMemo(() => photoLabels(images ?? []), [images]);
  const returning = useRef<ReturningPhoto | null>(null);
  useEffect(() => {
    if (returning.current && images && pairs && matches) {
      returning.current = settleReturningPhoto(returning.current, lanes);
    }
  }, [lanes, images, pairs, matches]);

  const save = useMutation(api.intakeRuns.saveIntakeMatch);
  const setMatchPrice = useMutation(api.intakeRuns.setIntakeMatchPrice);
  const pick = useMutation(api.intakeRuns.pickIntakeCard);
  const answerRepeat = useMutation(api.intakeRuns.answerIntakeRepeat);
  const aside = useMutation(api.intakeRuns.setIntakeMatchAside);
  const photoAside = useMutation(api.intakeRuns.setIntakePhotoAside);
  const swap = useMutation(api.placeholderPairing.swapPairSides);
  const unpair = useMutation(api.placeholderPairing.unpairPlaceholderImages);
  const pairUp = useMutation(api.placeholderPairing.manuallyPairPlaceholderImages);
  const closeStream = useMutation(api.placeholderStream.closePlaceholderStream);
  const [done, setDone] = useState(() => doneRuns.has(run._id));
  const markDone = (on: boolean) => {
    if (on) doneRuns.add(run._id);
    else doneRuns.delete(run._id);
    setDone(on);
  };
  // NEO-459 — the collector's close landing while this screen watches is an
  // event: it does what the button does, once, and is said out loud. Opening a
  // closed run is not that event, nor is a close first seen while the job loads
  // (`jobOpen` is false then), nor is the idle sweep's. Only if not done already:
  // a press on a run whose columns were clear has already been forgotten. The
  // line waits for a focus move to be read first; with none, it has no reason to.
  const [closeLanded, setCloseLanded] = useState(false);
  const closeLineTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closeLineTimer.current), []);
  const onCloseLanded = useEffectEvent(() => {
    if (focusParked.current) {
      closeLineTimer.current = setTimeout(() => setCloseLanded(true), SPEECH_AFTER_FOCUS_MS);
    } else {
      setCloseLanded(true);
    }
    if (!done) markDone(true);
  });
  const wasOpen = useRef(jobOpen);
  useEffect(() => {
    const landed = wasOpen.current && !jobOpen && closedByUser;
    wasOpen.current = jobOpen;
    if (landed) onCloseLanded();
  }, [jobOpen, closedByUser]);
  const retry = useMutation(api.placeholderStream.retryPlaceholderImage);
  // NEO-370: after Done, a run into a box that syncs links to Sync status.
  const syncsHere = useListingGate(run.homeId, null)?.applies === true;

  const [selected, setSelected] = useState<Id<"placeholderPairs"> | null>(null);
  const [openId, setOpenId] = useState<Id<"placeholderPairs"> | null>(null);
  /**
   * NEO-481 — the photos open in the viewer (a dialog: in-view state, never
   * the URL). `viewer` puts focus back on the photo that opened it.
   *
   * A tile can change lanes while the viewer is open (a scan is read, a pair
   * is saved), and its button goes with it. So every photo button carries its
   * scan's key (`scanOpenerKey`), and on close focus goes to the button that
   * now shows `shown` (the photo opened), else the one showing the tile's
   * front (`tile`), else the heading of the lane it was opened from.
   */
  const viewer = usePhotoViewer();
  const [viewTarget, setViewTarget] = useState<PhotoViewerTarget | null>(null);
  const viewing = viewer.side && viewTarget ? viewTarget : null;
  const openPhoto = (target: PhotoViewerTarget, opener: HTMLElement | undefined, shown: number, tile = shown) => {
    setViewTarget(target);
    const from = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const lane = from?.closest(`[${LANE_ATTR}]`)?.querySelector<HTMLElement>("h2") ?? null;
    viewer.open(target.side, opener, {
      key: scanOpenerKey(shown),
      fallback: () => liveOpener(scanOpenerKey(shown)) ?? liveOpener(scanOpenerKey(tile)) ?? lane,
    });
  };
  // NEO-481 — the saved lines' own photos, for the Saved tiles (a line with none is absent).
  const savedCopyIds = useMemo(
    () => [...new Set(lanes.saved.flatMap((r) => (r.photos === "attached" && r.savedCopyId ? [r.savedCopyId] : [])))].slice(0, MAX_LINE_PHOTOS),
    [lanes.saved],
  );
  const savedKey = savedCopyIds.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `savedKey` is `savedCopyIds`, spelled stably
  const linePhotoArgs = useMemo(() => (savedCopyIds.length > 0 ? { copyIds: savedCopyIds } : "skip"), [savedKey]);
  const linePhotoRows = useQuery(api.copyPhotos.photosOf, linePhotoArgs);
  const linePhotos = useMemo(
    () => new Map((linePhotoRows ?? []).map((r) => [r.copyId as string, linePhotosOf(r)])),
    [linePhotoRows],
  );
  const editNews = useEditNews(images, labels);
  // NEO-481 — each card's own price, on a box run only: a binder card never shows one.
  const priced = run.homeKind === "box";
  const commonPrices = useCommonPrices(priced && run.variantId ? [run.variantId] : null);
  const commonDollars = run.variantId ? commonPrices?.[run.variantId] : undefined;
  const prefill = pricePrefill(run.defaults?.minPriceCents, commonDollars);
  /**
   * NEO-481 — the price a tile kept (`keepPrice`) as the screen knows it before
   * the row comes back with it, so a price typed and then Yes clicked saves.
   * Keyed by the card too: a price set for one card never carries to another.
   * null is "back to the default".
   */
  const [kept, setKept] = useState<Record<string, number | null>>({});
  const keptKey = (row: IntakeMatchRow) => `${row.pairId}:${row.cardId ?? ""}`;
  const ownPrice = (row: IntakeMatchRow) => {
    const key = keptKey(row);
    return key in kept ? (kept[key] ?? undefined) : row.minPriceCents;
  };
  // The common price is still on its way: let the server judge, say nothing yet.
  const pricesLoading = run.defaults?.minPriceCents === undefined && !!run.variantId && commonPrices === undefined;
  /**
   * NEO-481 (Jason, 2026-11-10) — a box card saves with a price: typed at the
   * save, else kept on the tile, else the run's Min price, else the common
   * price. A common price set anywhere counts as soon as it lands.
   */
  const waitsAt = (own: number | undefined) =>
    priced && !pricesLoading && waitsForPrice(own, run.defaults?.minPriceCents, commonDollars);
  const waits = (row: IntakeMatchRow, priceCents?: number) => waitsAt(priceCents ?? ownPrice(row));
  /** Send the collector to the card's Price field: the open drawer's, else its tile's. */
  const toPrice = (pairId: Id<"placeholderPairs">) =>
    requestAnimationFrame(() => {
      const field =
        document.querySelector<HTMLInputElement>(`[role="dialog"] [${PRICE_ATTR}="${pairId}"]:not(:disabled)`) ??
        document.querySelector<HTMLInputElement>(`[${PRICE_ATTR}="${pairId}"]:not(:disabled)`);
      if (!field) return;
      field.scrollIntoView({ block: "nearest" });
      field.focus({ preventScroll: true });
    });
  /** Counts typed but not saved yet, per pair. */
  const [counts, setCounts] = useState<Record<string, number>>({});
  const saving = useRef(new Set<string>());

  const fail = (e: unknown) => notify(writeErrorMessage(e));
  const setPhotoAside = (image: IntakeImage, setAside: boolean) => {
    const label = labels.get(image.entryIndex) ?? image.originalName;
    // Before the write: the lanes can repaint ahead of the promise resolving.
    if (!setAside) returning.current = { entryIndex: image.entryIndex };
    void photoAside({ runId: run._id, entryIndex: image.entryIndex, setAside })
      .then(() => {
        inform(setAside ? `Set aside ${label}.` : `Brought back ${label}.`);
        if (setAside) refocusInPile(image.entryIndex);
      })
      .catch((e: unknown) => {
        if (!setAside) returning.current = null;
        fail(e);
      });
  };
  const photoLiveLine = usePhotoNews(matches);
  const canSave = (row: IntakeMatchRow) => !!row.cardId && !(row.repeatOfPairId && !row.repeatIsSecondCopy);
  const actions: RowActions = {
    save: (row, total, priceCents) => {
      if (!canSave(row)) {
        notify(whyNotSave(row));
        return true;
      }
      if (saving.current.has(row.pairId)) return true;
      const quantity = (total ?? counts[row.pairId] ?? proposedCount(row)) - row.haveHere;
      if (quantity < 1) {
        notify("The count must go up by at least one to save.");
        return true;
      }
      // NEO-481: no price, no save. The line under the Price field says why.
      if (waits(row, priceCents)) {
        toPrice(row.pairId);
        return false;
      }
      saving.current.add(row.pairId);
      // NEO-481: a price typed on the tile wins at the save (the server's own
      // order: this, then the row's kept price, then the run's Min price).
      save({
        runId: run._id,
        pairId: row.pairId,
        quantity,
        ...(priceCents !== undefined ? { details: { minPriceCents: priceCents } } : {}),
      })
        .catch((e: unknown) => {
          if (isNeedsPriceRefusal(e)) toPrice(row.pairId);
          fail(e);
        })
        .finally(() => saving.current.delete(row.pairId));
      return true;
    },
    setCount: (row, total) => setCounts((c) => ({ ...c, [row.pairId]: total })),
    count: (row) => counts[row.pairId] ?? proposedCount(row),
    pick: (row, cardId) => void pick({ runId: run._id, pairId: row.pairId, cardId }).catch(fail),
    repeat: (row, secondCopy) => void answerRepeat({ runId: run._id, pairId: row.pairId, secondCopy }).catch(fail),
    aside: (row, setAside) => void aside({ runId: run._id, pairId: row.pairId, setAside }).catch(fail),
    swap: (row) => void swap({ jobId: run.jobId, frontIndex: row.frontIndex, backIndex: row.backIndex }).catch(fail),
    unpair: (row) => void unpair({ jobId: run.jobId, frontIndex: row.frontIndex, backIndex: row.backIndex }).catch(fail),
    nextVariation: (row) => {
      const ring = [...new Set([row.card?._id, ...row.variations.map((v) => v._id)].filter(Boolean))] as Id<"cardChecklist">[];
      if (ring.length < 2 || !row.cardId) return;
      const at = ring.indexOf(row.cardId);
      void pick({ runId: run._id, pairId: row.pairId, cardId: ring[(at + 1) % ring.length] }).catch(fail);
    },
  };
  const readFor = (row: IntakeMatchRow) => readOf(byIndex, row.frontIndex, row.backIndex);
  const openFront = (row: IntakeMatchRow, opener?: HTMLElement) =>
    openPhoto(pairTarget(row, tileLabel(row, readFor(row)), "front"), opener, row.frontIndex);

  /**
   * NEO-481 — keep a tile's typed price on its row, so a refresh and "Save all
   * matched" keep it. Blank, or what the field started at, is the default:
   * the row's own price is cleared, never set to the default. The field
   * itself refuses a text that isn't a price (under it); null here too, as a
   * backstop.
   */
  const keepPrice = (row: IntakeMatchRow, text: string): { own: number | undefined } | null => {
    const typed = tilePrice(text, prefill);
    if (!typed.ok) {
      notify(typed.line);
      return null;
    }
    if (typed.own !== row.minPriceCents) {
      void setMatchPrice({ runId: run._id, pairId: row.pairId, priceCents: typed.own ?? null }).catch(fail);
    }
    const key = keptKey(row);
    if (kept[key] !== (typed.own ?? null)) setKept((k) => ({ ...k, [key]: typed.own ?? null }));
    return typed;
  };
  /** Enter (or y) in a tile's price: keep it and save the card at it. True when it saved. */
  const savePriced = (row: IntakeMatchRow, text: string): boolean => {
    if (!canSave(row)) {
      notify(whyNotSave(row));
      return false;
    }
    const typed = keepPrice(row, text);
    if (!typed) return false;
    // A blank here (or the default) with no default to fall back on leaves the
    // card waiting, focus where it is. The kept price above lands a render later.
    if (typed.own === undefined && waitsAt(undefined)) {
      toPrice(row.pairId);
      return false;
    }
    return actions.save(row, undefined, typed.own);
  };
  const price: TilePrice | undefined = priced ? { prefill, keep: keepPrice, enter: savePriced } : undefined;

  const review = lanes.review;
  const matched = review.filter((r) => r.band === "matched" && canSave(r));
  const find = (id: Id<"placeholderPairs"> | null) => review.find((r) => r.pairId === id) ?? null;
  const open = find(openId);

  const focusTile = (id: Id<"placeholderPairs"> | null, preferCount: boolean) => {
    setSelected(id);
    if (!id) {
      // The last card is done: land on the lane, never on the page body.
      requestAnimationFrame(() => document.getElementById(REVIEW_HEADING_ID)?.focus({ preventScroll: true }));
      return;
    }
    requestAnimationFrame(() => {
      const tile = document.querySelector<HTMLElement>(`[${TILE_ATTR}="${id}"]`);
      if (!tile) return;
      tile.scrollIntoView({ block: "nearest" });
      const qty = tile.querySelector<HTMLInputElement>(`[${QTY_ATTR}]:not(:disabled)`);
      ((preferCount && qty) || tile.querySelector<HTMLElement>("button:not(:disabled)"))?.focus({ preventScroll: true });
    });
  };
  const after = (id: Id<"placeholderPairs">) => {
    const at = review.findIndex((r) => r.pairId === id);
    return (review[at + 1] ?? review[at - 1])?.pairId ?? null;
  };

  // Keys act only on the card that has focus (WCAG 2.1.4), or on the open
  // drawer's card; read through a ref so the listener is added once.
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // The viewer is a dialog with keys of its own ([, ], c): none of these reach past it.
    if (viewing) return;
    const target = e.target as HTMLElement | null;
    // Nor from any dialog but the card drawer (the viewer, a confirm), wherever it was opened from.
    const dialog = target?.closest?.('[role="dialog"]');
    if (dialog && dialog.getAttribute("aria-labelledby") !== DRAWER_TITLE_ID) return;
    const inQty = !!target?.closest?.(`[${QTY_ATTR}]`);
    const inPrice = !!target?.closest?.(`[${PRICE_ATTR}]`);
    const inField = inQty || inPrice;
    if (!inField && target?.closest?.('input, textarea, select, [contenteditable="true"], [role="combobox"]')) return;
    if (inField && (e.key.length !== 1 || (inPrice ? /[\d.]/ : /\d/).test(e.key))) return;
    const run1 = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (openId) {
      if (!open || !dialog) return;
      if (e.key === "s") run1(() => actions.swap(open));
      else if (e.key === "e") run1(() => openFront(open));
      else if (e.key === "p" && priced) {
        const field = dialog.querySelector<HTMLInputElement>(`[${PRICE_ATTR}]:not(:disabled)`);
        if (field) run1(() => field.focus());
      } else if (e.key === "v") run1(() => actions.nextVariation(open));
      else if (e.key === "u") run1(() => closeAndMoveOn(open, () => actions.unpair(open)));
      else if (e.key === "d") run1(() => closeAndMoveOn(open, () => actions.aside(open, true)));
      return;
    }
    const tile = target?.closest?.(`[${TILE_ATTR}]`);
    const row = find((tile?.getAttribute(TILE_ATTR) as Id<"placeholderPairs"> | null) ?? null);
    if (!row) return;
    const key = e.key === "ArrowDown" ? "j" : e.key === "ArrowUp" ? "k" : e.key;
    if (key === "j" || key === "k") {
      const at = review.findIndex((r) => r.pairId === row.pairId);
      const to = review[key === "j" ? at + 1 : at - 1];
      if (to) run1(() => focusTile(to.pairId, inField));
      return;
    }
    if (key === "y") run1(() => {
      if (!canSave(row)) return notify(whyNotSave(row));
      // y in a price is Enter there: the field checks the price (and says
      // what's wrong under it), keeps it and saves the card.
      if (inPrice && target) return void pressEnterIn(target);
      const typed = inQty ? Number.parseInt((target as HTMLInputElement).value, 10) : NaN;
      if (actions.save(row, Number.isFinite(typed) ? typed : undefined)) focusTile(after(row.pairId), inQty);
    });
    else if (key === "o") run1(() => setOpenId(row.pairId));
    else if (key === "e") run1(() => openFront(row));
    else if (key === "p") {
      const field = tile?.querySelector<HTMLInputElement>(`[${PRICE_ATTR}]:not(:disabled)`);
      if (field) run1(() => field.focus());
    }
    else if (key === "v") run1(() => actions.nextVariation(row));
    else if (key === "s") run1(() => actions.swap(row));
    else if (key === "u") run1(() => { focusTile(after(row.pairId), false); actions.unpair(row); });
    else if (key === "d") run1(() => { focusTile(after(row.pairId), false); actions.aside(row, true); });
  };
  /** Close the drawer after an action that takes its card off the lane, landing on the next card. */
  const closeAndMoveOn = (row: IntakeMatchRow, act: () => void) => {
    const next = after(row.pairId);
    act();
    setOpenId(null);
    focusTile(next, false);
  };
  const keyRef = useRef(onKey);
  useEffect(() => {
    keyRef.current = onKey;
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const loading = images === undefined || pairs === undefined || matches === undefined;
  const working = lanes.reading.length + lanes.matching.length;
  // NEO-411: a photo that failed is not "read", so the summary says so.
  const unread = lanes.loose.filter((i) => i.status === "failed").length;
  const summary = runSummary({ loading, working, waiting: review.length, saved: lanes.saved.length, unread });
  // After Done and until every column but Saved clears, leaving warns (the
  // sync waits on those columns; leave anyway and the 15-minute round sends it).
  const clear = !loading && columnsClear(lanes);
  useEffect(() => {
    if (done && clear) doneRuns.delete(run._id);
  }, [done, clear, run._id]);
  // A Back answered "Stay" leaves focus nowhere (the page may have remounted):
  // park it on "Done adding photos" when it is drawn, else the first column's heading.
  useLeaveGuard(done && !loading && !clear, LEAVE_INTAKE_LINE, { onStay: parkFocus });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <dl className="m-0 flex flex-wrap gap-x-5 gap-y-1">
          {(
            [
              ["Reading", lanes.reading.length, "text-neon-blue-text"],
              ["Pairing", lanes.loose.length, "text-neon-purple-text"],
              ["Matching", lanes.matching.length, "text-neon-teal-text"],
              ["Needs you", review.length, "text-notice-warn-ink"],
              ["Saved", lanes.saved.length, "text-neon-green-text"],
            ] as const
          ).map(([label, n, tone]) => (
            <div key={label} className="flex items-baseline gap-1.5">
              <dt className="text-xs text-ink-3">{label}</dt>
              <dd className={`m-0 text-lg font-bold tabular-nums ${tone}`}>{n}</dd>
            </div>
          ))}
        </dl>
        <p aria-hidden="true" className="m-0 text-sm text-ink-2">
          {summary}
        </p>
        {/* Said once while the photos work, then when they're done: not every tick. */}
        <p role="status" aria-live="polite" className="sr-only">
          {loading ? "" : working > 0 ? "Working on your photos." : summary}
        </p>
        <LiveLine text={photoLiveLine} />
        <LiveLine text={editNews} />
        <LiveLine text={closeLanded ? RUN_CLOSED_LINE : ""} />
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {/* A scanner run (NEO-386) opens before any photo, so it closes with none. */}
          {jobOpen && (
            <NeonButton
              ref={doneRef}
              size="1"
              variant="secondary"
              outline
              aria-disabled={sendingPhotos || undefined}
              aria-describedby={sendingPhotos ? doneWhyId : undefined}
              {...{ [DONE_ATTR]: "" }}
              onClick={() => {
                if (sendingPhotos) return;
                markDone(true);
                void closeStream({ jobId: run.jobId }).catch((e: unknown) => {
                  markDone(false);
                  fail(e);
                });
              }}
            >
              Done adding photos
            </NeonButton>
          )}
          {jobOpen && sendingPhotos && (
            <span id={doneWhyId} className="sr-only">
              Photos are still going up.
            </span>
          )}
          {/* Always mounted (a live region announces what lands in it), empty until Done. */}
          <span role="status">{done && syncsHere && <SyncStatusLink className="inline-block max-sm:py-2" />}</span>
        </div>
      </div>

      <details className="rounded-md border border-rule px-3 py-2 text-sm text-ink-2">
        <summary className={`cursor-pointer rounded-sm text-ink ${RING}`}>Keyboard shortcuts</summary>
        <p className="mt-2 text-xs text-ink-3">Click or tab to a card to select it (it turns green), then:</p>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[auto_1fr_auto_1fr]">
          {KEY_HELP.map((k) => (
            <div key={k.keys} className="contents">
              <dt>
                <kbd className="font-mono text-ink">{k.keys}</kbd>
              </dt>
              <dd className="m-0">{k.does}</dd>
            </div>
          ))}
        </dl>
      </details>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[repeat(3,minmax(0,0.8fr))_minmax(0,1.5fr)_minmax(0,0.9fr)]">
        <Lane label={LANE_LABEL.reading} count={lanes.reading.length}>
          {lanes.reading.map((i) => (
            <li key={i.entryIndex} className="intake-arrive">
              <PhotoTile
                image={i}
                label={labels.get(i.entryIndex) ?? i.originalName}
                onOpen={(url, opener) =>
                  openPhoto({ kind: "local", url, label: labels.get(i.entryIndex) ?? i.originalName, side: "front" }, opener, i.entryIndex)
                }
              />
            </li>
          ))}
        </Lane>
        <Lane label={LANE_LABEL.pairing} count={lanes.loose.length} headingId={PAIRING_HEADING_ID}>
          <LoosePile
            jobId={run.jobId}
            loose={lanes.loose}
            labels={labels}
            onOpen={(image, opener) =>
              openPhoto(loneTarget(image.entryIndex, labels.get(image.entryIndex) ?? image.originalName), opener, image.entryIndex)
            }
            onSetAside={(image) => setPhotoAside(image, true)}
            onPair={(front, back) =>
              void pairUp({ jobId: run.jobId, frontIndex: front, backIndex: back }).catch(fail)
            }
            onRetry={
              jobOpen
                ? (image) =>
                    void retry({ jobId: run.jobId, entryIndex: image.entryIndex })
                      .then((r) => {
                        if (r.retried) {
                          inform(`Trying ${labels.get(image.entryIndex) ?? image.originalName} again.`);
                          refocusInPile(image.entryIndex);
                        } else if (r.reason === "too many tries") {
                          notify(PHOTO_OUT_OF_TRIES_LINE);
                        } else if (r.reason === "closed") {
                          notify(PHOTO_RUN_CLOSED_LINE);
                        } else if (r.reason === "too big") {
                          notify(PHOTO_TOO_BIG_LINE);
                        } else if (r.reason === "set aside") {
                          notify(PHOTO_SET_ASIDE_LINE);
                        }
                      })
                      .catch(fail)
                : undefined
            }
          />
        </Lane>
        <Lane label={LANE_LABEL.matching} count={lanes.matching.length}>
          {lanes.matching.map((p) => {
            const name = labels.get(p.frontIndex) ?? "scan";
            return (
              <li key={`${p.frontIndex}-${p.backIndex}`} className="intake-arrive">
                <div className={`${TILE_ROW} border-rule`}>
                  <ScanThumb
                    jobId={run.jobId}
                    entryIndex={p.frontIndex}
                    image={byIndex.get(p.frontIndex)}
                    name={`Open front of ${name}`}
                    alt={`Front of ${name}`}
                    className="h-14 w-auto rounded"
                    onOpen={(opener) => openPhoto(pairTarget(p, name, "front"), opener, p.frontIndex)}
                  />
                  <span className={TILE_WORDS}>
                    <span className="block truncate font-medium text-ink-2">{p.player ?? "Matching…"}</span>
                    <span className="block text-ink-3">{p.cardNumber ? `#${p.cardNumber}` : "Matching…"}</span>
                    <EditLine jobId={run.jobId} image={byIndex.get(p.frontIndex)} label={name} />
                    <EditLine jobId={run.jobId} image={byIndex.get(p.backIndex)} label={labels.get(p.backIndex) ?? "scan"} />
                  </span>
                </div>
              </li>
            );
          })}
        </Lane>
        <Lane
          label={LANE_LABEL.review}
          count={review.length}
          review
          action={
            // Always there, so the cards below it never shift when it would appear.
            <NeonButton
              size="1"
              variant="primary"
              className="mb-2"
              disabled={matched.length === 0}
              onClick={() => {
                // NEO-481: the priced cards save; the rest wait, said, with focus on the first one's price.
                const waiting = matched.filter((r) => waits(r));
                matched.filter((r) => !waiting.includes(r)).forEach((r) => actions.save(r));
                if (waiting.length > 0) {
                  notify(waitingForPriceLine(waiting.length));
                  setSelected(waiting[0].pairId);
                  toPrice(waiting[0].pairId);
                  return;
                }
                focusTile(review.find((r) => !matched.includes(r))?.pairId ?? null, false);
              }}
            >
              Save {matched.length} matched
            </NeonButton>
          }
        >
          {review.map((row) => (
            <li
              key={row.pairId}
              {...{ [TILE_ATTR]: row.pairId }}
              onFocusCapture={() => setSelected(row.pairId)}
              onClick={(e) => {
                setSelected(row.pairId);
                if (!(e.target as HTMLElement).closest("button, input, select, a, label")) {
                  e.currentTarget.querySelector<HTMLInputElement>(`[${QTY_ATTR}]:not(:disabled)`)?.focus();
                }
              }}
              className="intake-arrive"
            >
              <ReviewTile
                row={row}
                jobId={run.jobId}
                images={[byIndex.get(row.frontIndex), byIndex.get(row.backIndex)]}
                onOpenPhoto={(side, opener) =>
                  openPhoto(
                    pairTarget(row, tileLabel(row, readFor(row)), side),
                    opener,
                    side === "back" ? row.backIndex : row.frontIndex,
                    row.frontIndex,
                  )
                }
                price={price}
                waitsForPrice={canSave(row) && waits(row)}
                read={readFor(row)}
                selected={row.pairId === selected}
                actions={actions}
                canSave={canSave(row)}
                onOpen={() => setOpenId(row.pairId)}
                onSaved={() => focusTile(after(row.pairId), true)}
                onAnswered={(movesOn) => focusTile(movesOn ? after(row.pairId) : row.pairId, false)}
              />
            </li>
          ))}
        </Lane>
        <Lane label={LANE_LABEL.saved} count={lanes.saved.length}>
          {lanes.saved.map((row) => (
            <li key={row.pairId} className="intake-arrive intake-saved rounded-md">
              <div className={`${TILE_ROW} border-rule`}>
                <SavedPhoto
                  row={row}
                  jobId={run.jobId}
                  image={byIndex.get(row.frontIndex)}
                  photos={row.savedCopyId ? linePhotos.get(row.savedCopyId) : undefined}
                  onOpen={(target, opener) => openPhoto(target, opener, row.frontIndex)}
                />
                <span className={TILE_WORDS}>
                  <span className="block truncate font-medium text-ink-2">{cardLabel(row.card)}</span>
                  <span className="block text-neon-green-text">Saved +{row.savedQuantity ?? 1}</span>
                  <PhotoLine row={row} />
                  <LineEditLine photos={row.savedCopyId ? linePhotos.get(row.savedCopyId) : undefined} />
                </span>
              </div>
            </li>
          ))}
          {lanes.setAside.length + lanes.looseAside.length > 0 && (
            <li className="list-none border-t border-rule pt-2">
              <h3 className="m-0 mb-1 text-xs font-semibold text-ink-2">Set aside</h3>
              <ul className="m-0 list-none space-y-1 p-0">
                {lanes.setAside.map((row) => (
                  <li key={row.pairId} className="flex flex-col items-start text-xs text-ink-3">
                    <span className="max-w-full wrap-anywhere">{tileLabel(row, readFor(row))}</span>
                    <button
                      type="button"
                      className={`py-1.5 text-neon-blue-text underline ${RING}`}
                      onClick={() => {
                        actions.aside(row, false);
                        focusTile(null, false);
                      }}
                      aria-label={`Bring back ${tileLabel(row, readFor(row))}`}
                    >
                      Bring back
                    </button>
                  </li>
                ))}
                {lanes.looseAside.map((image) => (
                  <li key={image.entryIndex} className="flex flex-col items-start text-xs text-ink-3">
                    <span className="max-w-full wrap-anywhere" title={image.originalName}>
                      {labels.get(image.entryIndex) ?? image.originalName}
                    </span>
                    <button
                      type="button"
                      className={`py-1.5 text-neon-blue-text underline ${RING}`}
                      onClick={() => setPhotoAside(image, false)}
                      aria-label={`Bring back ${labels.get(image.entryIndex) ?? image.originalName}`}
                    >
                      Bring back
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          )}
        </Lane>
      </div>

      {open && (
        <Overlay labelledBy={DRAWER_TITLE_ID} onClose={() => setOpenId(null)}>
          <Drawer
            row={open}
            run={run}
            images={[byIndex.get(open.frontIndex), byIndex.get(open.backIndex)]}
            onOpenPhoto={(side, opener) =>
              openPhoto(
                pairTarget(open, cardLabel(open.card), side),
                opener,
                side === "back" ? open.backIndex : open.frontIndex,
                open.frontIndex,
              )
            }
            price={price}
            waitsForPrice={canSave(open) && waits(open)}
            read={readFor(open)}
            actions={actions}
            canSave={canSave(open)}
            onClose={() => setOpenId(null)}
            onMoveOn={(act) => closeAndMoveOn(open, act)}
          />
        </Overlay>
      )}
      {/* After the drawer, so it opens over it; Escape closes only the viewer. Mounted only while open. */}
      {viewing?.kind === "scan" && (
        <IntakeScanViewer jobId={run.jobId} target={viewing} byIndex={byIndex} side={viewer.side ?? "front"} onClose={viewer.close} />
      )}
      {viewing?.kind === "local" && (
        <CardPhotoViewer
          source={viewOnlySource(viewing.label, { front: viewing.url }, STILL_READING_LINE, "reading")}
          onClose={viewer.close}
        />
      )}
      {viewing?.kind === "copy" && (
        <LinePhotoViewer
          copyId={viewing.copyId}
          label={viewing.label}
          photos={linePhotos.get(viewing.copyId)}
          side={viewer.side ?? "front"}
          onClose={viewer.close}
        />
      )}
    </div>
  );
}

/**
 * NEO-481 — what to say out loud when a background render lands or fails. The
 * first read only learns where things stand, so opening a run says nothing.
 * A live region speaks only a change, so the same words twice differ by a
 * trailing space the ear can't hear (as `usePhotoNews` does).
 */
function useEditNews(images: IntakeImage[] | undefined, labels: ReadonlyMap<number, string>): string {
  const [news, setNews] = useState("");
  const seen = useRef<Map<number, string> | null>(null);
  const said = useRef(0);
  useEffect(() => {
    if (!images) return;
    const before = seen.current;
    const now = new Map(images.map((i) => [i.entryIndex, i.pendingEdit?.status ?? ""]));
    seen.current = now;
    if (!before) return;
    const lines: string[] = [];
    for (const image of images) {
      const was = before.get(image.entryIndex);
      const is = now.get(image.entryIndex);
      if (was === undefined || was === is) continue;
      const name = labels.get(image.entryIndex) ?? image.originalName;
      const state = editStateOf(image);
      if (was === "rendering" && is === "") lines.push(`All touched up: ${name}.`);
      else if (state?.kind === "failed") lines.push(`${name}: ${state.line}`);
    }
    const say = () => {
      said.current += 1;
      const line = lines.join(" ");
      setNews(said.current % 2 === 0 ? `${line}\u00A0` : line);
    };
    if (lines.length) say();
  }, [images, labels]);
  return news;
}

/**
 * NEO-427 — what to say out loud about the run's photos. The first read only
 * learns where things stand, so opening a run says nothing. Rows land one by one
 * during a "Save all", so they gather into one line: said after a quiet spell,
 * or as soon as nothing is on its way. A failure starts a window that later
 * rows don't push back. A live region speaks only a change, so the same words
 * twice differ by a trailing space the ear can't hear.
 */
function usePhotoNews(matches: IntakeMatchRow[] | undefined): string {
  const [news, setNews] = useState("");
  const seen = useRef<PhotoStates | null>(null);
  const gathered = useRef<PhotoChanges>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const said = useRef(0);
  useEffect(() => {
    if (!matches) return;
    const before = seen.current;
    seen.current = photoStates(matches);
    if (!before) return;
    gathered.current = new Map([...gathered.current, ...photoChanges(before, matches)]);
    if (gathered.current.size === 0) return;
    const say = () => {
      timer.current = null;
      const line = photoNewsOf(gathered.current);
      gathered.current = new Map();
      if (!line) return;
      said.current += 1;
      setNews(said.current % 2 === 0 ? `${line}\u00A0` : line);
    };
    const failing = [...gathered.current.values()].some((change) => change.kind !== "attached");
    if (timer.current !== null && failing && matches.some((row) => row.photos === "pending")) return;
    if (timer.current !== null) clearTimeout(timer.current);
    if (matches.some((row) => row.photos === "pending")) timer.current = setTimeout(say, PHOTO_NEWS_QUIET_MS);
    else say();
  }, [matches]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  return news;
}

/** The glyph's colour: the shape says the state (`RunGlyph`), and these clear 4.5:1 on a tile in both modes. */
const PHOTO_TONES: Record<RunLineKind, string> = {
  waiting: "text-ink-3",
  building: "text-neon-blue-text motion-safe:animate-spin",
  built: "text-neon-green-text",
  skipped: "text-ink-3",
  blocked: "text-notice-warn-ink",
  stopped: "text-ink-3",
  failed: "text-notice-warn-ink",
  unfinished: "text-notice-warn-ink",
};
/**
 * A tile's only action, so a thumb gets 44px on a phone. The text still takes
 * one line of the stack. The extra reaches up over the words above, and down
 * only as far as the tile's own padding and border: past them it would give the
 * lane's scrolling list something to scroll. `relative` keeps it above those words.
 */
const PHOTO_ACTION = `-my-1.5 block py-1.5 max-sm:relative max-sm:-mb-2 max-sm:-mt-5 max-sm:min-w-11 max-sm:pb-2 max-sm:pt-5 text-neon-blue-text underline aria-disabled:cursor-not-allowed aria-disabled:opacity-60 ${RING}`;

/**
 * A lane tile: picture, then words. A lane can be ~120px wide at 1024px, so the
 * words drop under the picture rather than push the tile past its column (a
 * column that overflows is a scroll container a keyboard can't reach).
 */
const TILE_ROW = "flex flex-wrap items-center gap-2 rounded-md border-2 bg-surface p-1.5 text-xs";
const TILE_WORDS = "min-w-0 flex-1 basis-[5.5rem]";

/** Focus has nowhere to be: it fell to the page with something that unmounted. */
const focusFell = () => !document.activeElement || document.activeElement === document.body;

/**
 * NEO-427 — a Saved tile's second word: its photos on their way, on the line,
 * or what to do about them. Failing never touches the save above it. A press
 * takes its own button away: Try again as the row goes back to pending, Add a
 * photo once the drawer's photo answers it (the drawer returns focus to the
 * button, if the button is still there). Whichever, focus that fell to the page
 * lands on this line's own words (WCAG 2.4.3); focus that is somewhere else
 * stays there.
 */
function PhotoLine({ row }: { row: IntakeMatchRow }) {
  const { notify, openCard } = usePageApi();
  const retryPhotos = useAction(api.intakePhotos.retryIntakePhotos);
  const [params] = useSearchParams();
  const words = useRef<HTMLSpanElement>(null);
  const [retrying, setRetrying] = useState(false);
  const pressing = useRef(false);
  const refocus = useRef(false);
  const addedFrom = useRef(false);
  const failed = row.photos === "failed";
  const drawerOpen = params.has(DRAWER_PARAM);
  const land = () => {
    if (focusFell()) words.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (failed || !refocus.current) return;
    refocus.current = false;
    land();
  }, [failed]);
  useEffect(() => {
    if (drawerOpen || !addedFrom.current) return;
    addedFrom.current = false;
    land();
  }, [drawerOpen]);
  const line = photoLine(row);
  if (!line) return null;
  const label = cardLabel(row.card);
  const kind: RunLineKind = failed ? "failed" : row.photos === "pending" ? "building" : "built";
  return (
    <>
      <span className={`mt-0.5 flex items-start gap-1 ${failed ? "text-notice-warn-ink" : "text-ink-2"}`}>
        <RunGlyph kind={kind} tones={PHOTO_TONES} />
        <span ref={words} tabIndex={-1} className={`rounded-sm ${RING}`}>
          {line}
        </span>
      </span>
      {failed && row.photoCanRetry && (
        <button
          type="button"
          className={PHOTO_ACTION}
          aria-label={`Try again: photos for ${label}`}
          aria-disabled={retrying || undefined}
          onClick={() => {
            if (pressing.current) return;
            pressing.current = true;
            refocus.current = true;
            setRetrying(true);
            retryPhotos({ matchId: row._id })
              .catch((e: unknown) => {
                refocus.current = false;
                notify(writeErrorMessage(e));
              })
              .finally(() => {
                pressing.current = false;
                setRetrying(false);
              });
          }}
        >
          Try again
        </button>
      )}
      {failed && !row.photoCanRetry && row.cardId && (
        <button
          type="button"
          className={PHOTO_ACTION}
          aria-label={`Add a photo to ${label}`}
          onClick={() => {
            if (!row.cardId) return;
            addedFrom.current = true;
            openCard(row.cardId, { copyId: row.savedCopyId, edit: true });
          }}
        >
          Add a photo
        </button>
      )}
    </>
  );
}

interface RowActions {
  /**
   * `priceCents`: this card's own price (NEO-481), else the row's kept one, else the run's.
   * False when the card waits for a price: focus went to its Price field, so the caller leaves it there.
   */
  save: (row: IntakeMatchRow, total?: number, priceCents?: number) => boolean;
  setCount: (row: IntakeMatchRow, total: number) => void;
  count: (row: IntakeMatchRow) => number;
  pick: (row: IntakeMatchRow, cardId: Id<"cardChecklist"> | null) => void;
  repeat: (row: IntakeMatchRow, secondCopy: boolean) => void;
  aside: (row: IntakeMatchRow, setAside: boolean) => void;
  swap: (row: IntakeMatchRow) => void;
  unpair: (row: IntakeMatchRow) => void;
  nextVariation: (row: IntakeMatchRow) => void;
}

/** NEO-481 — a box run's per-card price, handed to its tiles and drawer (absent for a binder). */
interface TilePrice {
  /** What the field starts at: the run's Min price, else the common price. */
  prefill: number | null;
  /** Focus left the field with a change: keep it on the row. */
  keep: (row: IntakeMatchRow, text: string) => void;
  /** Enter: keep it and save the card. True when it saved. */
  enter: (row: IntakeMatchRow, text: string) => boolean;
}

/**
 * NEO-481 — a scan's thumbnail as a button that opens the viewer (the shared
 * `ScanImage`). Its edit version mints a new signed URL; while an edit
 * renders it shows the viewer's preview with "Touching it up…" over it.
 */
function ScanThumb({
  jobId,
  entryIndex,
  image,
  name,
  alt,
  className,
  onOpen,
}: {
  jobId: string;
  entryIndex: number;
  image: IntakeImage | undefined;
  /** The button's name: what it opens ("Open front of #47 Le'Veon Bell"). */
  name: string;
  /** What the picture is ("Front of #47 Le'Veon Bell"). */
  alt: string;
  className: string;
  onOpen: (opener: HTMLElement) => void;
}) {
  // The shared `ScanImage` draws the button, so its viewer key goes on from here
  // (`scanOpenerKey`): every render, as the picture inside can redraw it.
  const wrap = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    wrap.current?.querySelector("button")?.setAttribute(PHOTO_OPENER_ATTR, scanOpenerKey(entryIndex));
  });
  return (
    <span ref={wrap} {...{ [THUMB_ATTR]: entryIndex }} className="flex shrink-0">
      <ScanImage
        jobId={jobId}
        entryIndex={entryIndex}
        alt={alt}
        className={className}
        version={image?.editVersion}
        pending={asPendingPhotoEdit(image?.pendingEdit)}
        onOpen={onOpen}
        openLabel={name}
      />
    </span>
  );
}

/**
 * NEO-481 — the viewer on a pair's scans (or one loose photo), with the rows
 * the page already holds, so it follows a pending edit and a new version.
 */
function IntakeScanViewer({
  jobId,
  target,
  byIndex,
  side,
  onClose,
}: {
  jobId: string;
  target: Extract<PhotoViewerTarget, { kind: "scan" }>;
  byIndex: ReadonlyMap<number, IntakeImage>;
  side: PhotoSideName;
  onClose: () => void;
}) {
  const frontImage = byIndex.get(target.front);
  const backImage = target.back === undefined ? undefined : byIndex.get(target.back);
  const front = useMemo(() => ({ entryIndex: target.front, image: frontImage }), [target.front, frontImage]);
  const back = useMemo(
    () => (target.back === undefined ? undefined : { entryIndex: target.back, image: backImage }),
    [target.back, backImage],
  );
  return (
    <ScanPhotoViewer
      jobId={jobId}
      label={target.label}
      front={front}
      back={back}
      viewOnly={target.viewOnly}
      initialSide={side}
      onClose={onClose}
    />
  );
}

/** A saved line's photos when the store has no viewer source (a test's): look, no edits. */
function useViewOnlyLine(_copy: { id: string }, label: string, photos: CopyPhotos | undefined): PhotoSource {
  return viewOnlySource(label, { front: photos?.front?.imageUrl, back: photos?.back?.imageUrl }, LINE_VIEW_ONLY_LINE);
}

/** NEO-481 — the viewer on a saved line's own photos (the collection's copy-photo source). */
function LinePhotoViewer({
  copyId,
  label,
  photos,
  side,
  onClose,
}: {
  copyId: string;
  label: string;
  photos: CopyPhotos | undefined;
  side: PhotoSideName;
  onClose: () => void;
}) {
  const ext = useCopyPhotos();
  // A store either has a viewer source or it does not, for its whole life: the hook order never changes.
  const usePhotoSourceOf = ext?.usePhotoSource ?? useViewOnlyLine;
  const copy = useMemo(() => ({ id: copyId }), [copyId]);
  const source = usePhotoSourceOf(copy, label, photos);
  return <CardPhotoViewer source={source} initialSide={side} onClose={onClose} />;
}

/**
 * NEO-481 — a Saved tile's picture: the saved line's own photo once it is
 * there (with its edit in flight or failed), else the front scan. Either
 * opens the viewer on what it shows.
 */
function SavedPhoto({
  row,
  jobId,
  image,
  photos,
  onOpen,
}: {
  row: IntakeMatchRow;
  jobId: string;
  image: IntakeImage | undefined;
  photos: CopyPhotos | undefined;
  onOpen: (target: PhotoViewerTarget, opener: HTMLElement) => void;
}) {
  const card = cardLabel(row.card);
  const name = `Open saved photo of ${card}`;
  const side: PhotoSideName = photos?.front ? "front" : "back";
  const shown = photos?.[side];
  const target = savedPhotoTarget(row, !!shown, ON_THE_WAY_REASON);
  if (shown && target.kind === "copy") {
    return (
      <button
        type="button"
        aria-label={name}
        {...photoOpenerProps(scanOpenerKey(row.frontIndex))}
        className="flex shrink-0 rounded focus-outline"
        onClick={(e) => onOpen({ ...target, side }, e.currentTarget)}
      >
        <CardPhoto
          src={shown.thumbUrl}
          alt={`${side === "front" ? "Front" : "Back"} of ${card}`}
          className="h-14 w-auto rounded"
          pending={shown.pending}
          previewKey={copyPreviewKey(target.copyId, side)}
          chip={false}
        />
      </button>
    );
  }
  return (
    <ScanThumb
      jobId={jobId}
      entryIndex={row.frontIndex}
      image={image}
      name={name}
      alt={`Front of ${card}`}
      className="h-14 w-auto rounded"
      onOpen={(opener) => onOpen(target, opener)}
    />
  );
}

/**
 * NEO-481 — where a saved line's photo edit stands, under its Saved tile's
 * words. The viewer holds Try again and Keep the old photo, so a failure here
 * says to open it.
 */
function LineEditLine({ photos }: { photos: CopyPhotos | undefined }) {
  const state = (["front", "back"] as const)
    .map((side) => ({ side, state: editStateOf({ pendingEdit: photos?.[side]?.pending }) }))
    .find((s) => s.state);
  if (!state?.state) return null;
  if (state.state.kind === "rendering") return <EditRenderingLine />;
  return (
    <span className="mt-0.5 flex items-start gap-1 text-notice-warn-ink">
      <RunGlyph kind="failed" tones={PHOTO_TONES} />
      <span>
        {state.state.line} {lineRetryLine(state.side)}
      </span>
    </span>
  );
}

/** NEO-481 — "Touching it up…" under a tile's words, for an edit in flight with no thumbnail chip to say it. */
function EditRenderingLine() {
  return (
    <span className="mt-0.5 flex items-start gap-1 text-ink-2">
      <RunGlyph kind="building" tones={PHOTO_TONES} />
      <span>{EDIT_RENDERING_LINE}</span>
    </span>
  );
}

/** Marks a scan thumbnail, so focus can land back on it. */
const THUMB_ATTR = "data-scan-thumb";

/**
 * NEO-481 — a scan's failed hand edit, under its tile's words: what went
 * wrong, with Try again (the same save again) and Keep the old photo (drop the
 * failed edit). The old photo stays up throughout; while an edit renders the
 * thumbnail says so itself, or, on a tile with no thumbnail (`noThumb`: a
 * loose photo auto crop couldn't read, cropped by hand), this line does.
 * Either press takes its buttons away, so focus that fell to the page lands
 * on the photo itself.
 */
function EditLine({
  jobId,
  image,
  label,
  noThumb = false,
}: {
  jobId: string;
  image: IntakeImage | undefined;
  label: string;
  noThumb?: boolean;
}) {
  const { notify } = usePageApi();
  const saveEdit = useAction(api.photoEdits.saveScanEdit);
  const dismiss = useAction(api.photoEdits.dismissPhotoEditFailure);
  const pressing = useRef(false);
  const [busy, setBusy] = useState(false);
  const edit = image;
  const state = editStateOf(edit);
  // While it renders, the thumbnail's own chip says so ("Touching it up…"); with no thumbnail, this line does.
  if (state?.kind === "rendering") return noThumb ? <EditRenderingLine /> : null;
  if (!state || !edit) return null;
  const pending = edit.pendingEdit;
  const press = (box: Element | null, write: () => Promise<unknown>) => {
    if (pressing.current) return;
    pressing.current = true;
    setBusy(true);
    write()
      .then(() =>
        requestAnimationFrame(() => {
          if (focusFell()) box?.querySelector<HTMLElement>(`[${THUMB_ATTR}="${edit.entryIndex}"] button`)?.focus();
        }),
      )
      .catch((e: unknown) => notify(writeErrorMessage(e)))
      .finally(() => {
        pressing.current = false;
        setBusy(false);
      });
  };
  const container = (el: HTMLElement) => el.closest("article, li, [role='dialog']");
  return (
    <>
      <span className="mt-0.5 flex items-start gap-1 text-notice-warn-ink">
        <RunGlyph kind="failed" tones={PHOTO_TONES} />
        <span>{state.line}</span>
      </span>
      <span className="flex flex-wrap gap-x-3">
        {pending && (
          <button
            type="button"
            className={PHOTO_ACTION}
            aria-label={`Try again: touch up ${label}`}
            aria-disabled={busy || undefined}
            onClick={(e) =>
              press(container(e.currentTarget), () =>
                saveEdit({
                  jobId,
                  entryIndex: edit.entryIndex,
                  edit: { turns: pending.turns, crop: pending.crop },
                  expectVersion: edit.editVersion ?? 0,
                }),
              )
            }
          >
            Try again
          </button>
        )}
        <button
          type="button"
          className={PHOTO_ACTION}
          aria-label={`${VIEWER_WORDS.keepOld}: ${label}`}
          aria-disabled={busy || undefined}
          onClick={(e) =>
            press(container(e.currentTarget), () =>
              dismiss({ ref: { kind: "scan", jobId, entryIndex: edit.entryIndex } }),
            )
          }
        >
          {VIEWER_WORDS.keepOld}
        </button>
      </span>
    </>
  );
}

/**
 * Past this many tiles a lane stops growing and scrolls. About what fills its
 * 34rem; below it the list is plain flow content, with no scroller and no Tab stop.
 */
const LANE_SCROLL_AFTER = 6;

function Lane({
  label,
  count,
  review = false,
  headingId,
  action,
  children,
}: {
  label: string;
  count: number;
  review?: boolean;
  /** The heading's id, for focus moves that name it (every lane heading takes programmatic focus). */
  headingId?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  // Never the review lane: it grows, and its tiles take the keyboard themselves.
  // `focused`: a lane draining past the threshold must not pull the Tab stop from
  // under whoever is scrolling it, which would drop them to the top of the page.
  const scrolls = !review && (count > LANE_SCROLL_AFTER || focused);
  const list = <ul className="m-0 list-none space-y-2 p-0">{children}</ul>;
  return (
    <section
      {...{ [LANE_ATTR]: "" }}
      aria-label={`${label}, ${count}`}
      className={`flex min-h-[16rem] flex-col rounded-lg border p-2 ${review ? "border-notice-warn-rule bg-notice-warn-bg/40" : "border-rule bg-raised"}`}
    >
      <header className="mb-2 flex items-center justify-between px-1">
        <h2
          id={review ? REVIEW_HEADING_ID : headingId}
          // Focusable in every lane: a photo's viewer falls back to its lane's heading.
          tabIndex={-1}
          className={`m-0 text-sm font-semibold text-ink ${RING}`}
        >
          {label}
        </h2>
        <span className="text-sm font-bold tabular-nums text-ink-2">{count}</span>
      </header>
      {action}
      {/* A scroller a keyboard can't focus can't be scrolled from the keyboard. Both
          branches are one div to React, so crossing the threshold never remounts a tile. */}
      {scrolls ? (
        <div
          role="group"
          aria-label={`${label} list`}
          tabIndex={0}
          onFocus={() => setFocused(true)}
          onBlur={(e) => {
            // Blur bubbles from every tile; only leaving the lane counts.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
          }}
          className="max-h-[34rem] overflow-y-auto rounded-sm focus-outline"
        >
          {list}
        </div>
      ) : (
        // No overflow of any kind: a scroll container here would need a Tab stop.
        <div>{list}</div>
      )}
    </section>
  );
}

function PhotoTile({
  image,
  label,
  onOpen,
}: {
  image: IntakeImage;
  /** The photo's name for its control (`photoLabels`). */
  label: string;
  /** NEO-481: open this browser's copy of it in the viewer (still reading, so view-only there). */
  onOpen: (url: string, opener: HTMLElement) => void;
}) {
  const failed = image.status === "failed";
  const local = useContext(LocalPhotos).get(image.originalName);
  return (
    <div className={`${TILE_ROW} border-rule`}>
      {local && (
        <button
          type="button"
          aria-label={`Open photo ${label}`}
          {...photoOpenerProps(scanOpenerKey(image.entryIndex))}
          onClick={(e) => onOpen(local, e.currentTarget)}
          className={`block shrink-0 cursor-zoom-in rounded ${RING}`}
        >
          <img src={local} alt="" className="h-14 w-10 rounded object-cover" />
        </button>
      )}
      <span className={TILE_WORDS}>
        <span className="block truncate font-medium text-ink-2" title={image.originalName}>
          {image.originalName}
        </span>
        <span className="block">
          {failed ? (
            <span className="text-neon-pink-text">Couldn&apos;t read this photo</span>
          ) : (
            <StageBadge stage={image.status === "awaiting_upload" ? "uploading" : "reading"} />
          )}
        </span>
      </span>
    </div>
  );
}

/**
 * The loose pile: read photos not in a pair yet. Pick two (the front first)
 * and pair them by hand; pairing usually finds them on its own.
 */
function LoosePile({
  jobId,
  loose,
  labels,
  onOpen,
  onSetAside,
  onPair,
  onRetry,
}: {
  jobId: string;
  loose: IntakeImage[];
  /** Each photo's name for its controls (`photoLabels`). */
  labels: ReadonlyMap<number, string>;
  /** NEO-481: open a photo in the viewer; a failed one is cropped by hand there. */
  onOpen: (image: IntakeImage, opener: HTMLElement) => void;
  /** NEO-446: take a photo out of the pile. Brought back from the Set aside list. */
  onSetAside: (image: IntakeImage) => void;
  onPair: (front: number, back: number) => void;
  /** NEO-411: send a failed photo through again; absent once the run is closed. */
  onRetry?: (image: IntakeImage) => void;
}) {
  const [chosen, setChosen] = useState<number[]>([]);
  const live = chosen.filter((n) => loose.some((i) => i.entryIndex === n));
  const toggle = (n: number) =>
    setChosen(live.includes(n) ? live.filter((x) => x !== n) : [...live, n].slice(-2));
  return (
    <>
      {loose.map((i) => (
        <li key={i.entryIndex} className="intake-arrive">
          {/* The photo opens the viewer; the words beside it pick it for pairing. */}
          <div className={`${TILE_ROW} ${live.includes(i.entryIndex) ? "border-neon-green-text" : "border-rule"}`}>
            {i.status !== "failed" && (
              <ScanThumb
                jobId={jobId}
                entryIndex={i.entryIndex}
                image={i}
                name={`Open photo ${labels.get(i.entryIndex) ?? i.originalName}`}
                alt={labels.get(i.entryIndex) ?? i.originalName}
                className="h-14 w-auto rounded"
                onOpen={(opener) => onOpen(i, opener)}
              />
            )}
            <button
              type="button"
              data-loose-photo={i.entryIndex}
              aria-pressed={live.includes(i.entryIndex)}
              aria-describedby={i.status === "failed" ? `loose-why-${i.entryIndex}` : undefined}
              onClick={() => toggle(i.entryIndex)}
              className={`${TILE_WORDS} self-stretch rounded-sm text-left ${RING}`}
            >
              <span className="block truncate font-medium text-ink-2">{i.originalName}</span>
              <span className="block text-ink-3" id={i.status === "failed" ? `loose-why-${i.entryIndex}` : undefined}>
                {i.status === "failed"
                  ? failedText(i, !!onRetry && canRetryPhoto(i))
                  : [i.side, i.players?.join(", "), i.cardNumber ? `#${i.cardNumber}` : null].filter(Boolean).join(" · ") ||
                    "Waiting for its other side"}
              </span>
            </button>
          </div>
          {/* A failed photo has no thumbnail to carry "Touching it up…" while its hand crop renders, so the line says it. */}
          <EditLine
            jobId={jobId}
            image={i}
            label={labels.get(i.entryIndex) ?? i.originalName}
            noThumb={i.status === "failed"}
          />
          <div className="mt-1 flex flex-wrap gap-2">
            {/* NEO-481: auto crop missed it; the collector can cut it out by hand (never one over the pixel ceiling). */}
            {i.status === "failed" && i.errorCode !== ENTRY_TOO_MANY_PIXELS && (
              <NeonButton
                size="1"
                variant="tertiary"
                outline
                className="min-h-11 sm:min-h-8"
                aria-label={`Crop by hand: ${labels.get(i.entryIndex) ?? i.originalName}`}
                aria-describedby={`loose-why-${i.entryIndex}`}
                {...photoOpenerProps(scanOpenerKey(i.entryIndex))}
                onClick={(e) => onOpen(i, e.currentTarget)}
              >
                Crop by hand
              </NeonButton>
            )}
            {/* Not while a hand crop renders: a read started now would race it. */}
            {onRetry && canRetryPhoto(i) && editStateOf(i)?.kind !== "rendering" && (
              <NeonButton
                size="1"
                variant="secondary"
                outline
                className="min-h-11 sm:min-h-8"
                aria-label={`Try again: ${labels.get(i.entryIndex) ?? i.originalName}`}
                aria-describedby={`loose-why-${i.entryIndex}`}
                onClick={() => onRetry(i)}
              >
                Try again
              </NeonButton>
            )}
            <NeonButton
              size="1"
              variant="negative"
              outline
              className="min-h-11 sm:min-h-8"
              aria-label={`Set aside ${labels.get(i.entryIndex) ?? i.originalName}`}
              aria-describedby={i.status === "failed" ? `loose-why-${i.entryIndex}` : undefined}
              onClick={() => onSetAside(i)}
            >
              Set aside
            </NeonButton>
          </div>
        </li>
      ))}
      {loose.length > 1 && (
        <li className="list-none">
          <NeonButton
            size="1"
            variant="secondary"
            outline
            aria-disabled={live.length !== 2 || undefined}
            // Wraps inside its border where the lane is narrowest (about 768-800px).
            className="h-auto min-h-11 max-w-full whitespace-normal py-1 sm:min-h-8"
            onClick={() => {
              if (live.length !== 2) return;
              onPair(live[0], live[1]);
              setChosen([]);
            }}
          >
            {live.length === 2 ? "Pair Images" : live.length === 1 ? "Select Partner" : "Select 2 to Pair"}
          </NeonButton>
        </li>
      )}
    </>
  );
}

/** The band, as a pill: matched, check this, or no match. */
function Band({ row }: { row: IntakeMatchRow }) {
  const pct = `${row.confidence}%`;
  if (row.byUser) {
    return <span className="inline-block max-w-full rounded-xl bg-wash-green px-2 py-0.5 text-xs font-semibold text-neon-green-text">You picked</span>;
  }
  if (row.band === "matched") {
    return <span className="inline-block max-w-full rounded-xl bg-wash-green px-2 py-0.5 text-xs font-semibold text-neon-green-text">Matched {pct}</span>;
  }
  if (row.band === "check") {
    return <span className="inline-block max-w-full rounded-xl bg-notice-warn-bg px-2 py-0.5 text-xs font-semibold text-notice-warn-ink">Check this {pct}</span>;
  }
  return <span className="inline-block max-w-full rounded-xl border border-neon-pink-text bg-wash-pink px-2 py-0.5 text-xs font-semibold text-ink">No match</span>;
}

function edge(row: IntakeMatchRow, selected: boolean): string {
  if (selected) return "border-neon-green-text";
  if (row.byUser) return "border-rule";
  return row.band === "none" ? "border-neon-pink-text" : row.band === "check" ? "border-notice-warn-rule" : "border-rule";
}

function readLine(read: PairRead): string {
  const parts = [read.number ? `#${read.number}` : null, read.players.join(", ") || null].filter(Boolean);
  return parts.length ? `Read: ${parts.join(" · ")}` : "Nothing read yet";
}

/**
 * A card waiting for you. Its first line is the scans beside the title;
 * its second starts with Yes, so the top card's Yes stays in one spot and
 * the next card slides up under the pointer.
 */
function ReviewTile({
  row,
  jobId,
  images,
  onOpenPhoto,
  price,
  waitsForPrice,
  read,
  selected,
  actions,
  canSave,
  onOpen,
  onSaved,
  onAnswered,
}: {
  row: IntakeMatchRow;
  jobId: string;
  /** The pair's two photos, front first (NEO-481: their edit state). */
  images: [IntakeImage | undefined, IntakeImage | undefined];
  onOpenPhoto: (side: "front" | "back", opener: HTMLElement) => void;
  /** NEO-481: the card's own price, on a box run only. */
  price: TilePrice | undefined;
  /** NEO-481: a box card with no price anywhere; it can't be saved yet. */
  waitsForPrice: boolean;
  read: PairRead;
  selected: boolean;
  actions: RowActions;
  canSave: boolean;
  onOpen: () => void;
  onSaved: () => void;
  onAnswered: (movesOn: boolean) => void;
}) {
  const label = tileLabel(row, read);
  const reasonId = useId();
  const waitId = useId();
  const waiting = price && waitsForPrice ? { id: waitId, line: INTAKE_NEEDS_PRICE_LINE } : null;
  return (
    <article aria-label={label} className={`rounded-md border-2 bg-surface p-2 ${edge(row, selected)}`}>
      <div className="flex flex-wrap gap-2">
        <div className="flex shrink-0 gap-1">
          <ScanThumb
            jobId={jobId}
            entryIndex={row.frontIndex}
            image={images[0]}
            name={`Open front of ${label}`}
            alt={`Front of ${label}`}
            className="h-24 w-auto rounded"
            onOpen={(opener) => onOpenPhoto("front", opener)}
          />
          <ScanThumb
            jobId={jobId}
            entryIndex={row.backIndex}
            image={images[1]}
            name={`Open back of ${label}`}
            alt={`Back of ${label}`}
            className="h-24 w-auto rounded"
            onOpen={(opener) => onOpenPhoto("back", opener)}
          />
        </div>
        {/* Under the scans when the lane is too narrow for both (768 to about 900px). */}
        <div className="min-w-0 flex-1 basis-[7rem] space-y-1">
          <p className="m-0 truncate text-sm font-semibold text-ink">{cardLabel(row.card)}</p>
          <Band row={row} />
          <p className="m-0 text-xs text-ink-3">{readLine(read)}</p>
          {!row.byUser && row.band !== "matched" && <p className="m-0 text-xs text-ink-3">{reasonText(row, read)}</p>}
          <div className="text-xs empty:hidden">
            <EditLine jobId={jobId} image={images[0]} label={`the front of ${label}`} />
            <EditLine jobId={jobId} image={images[1]} label={`the back of ${label}`} />
          </div>
          {!canSave && (
            <p id={reasonId} className="sr-only">
              {whyNotSave(row)}
            </p>
          )}
        </div>
      </div>
      <Prompts row={row} actions={actions} onAnswered={onAnswered} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <NeonButton
          size="1"
          variant="primary"
          // aria-disabled keeps it reachable, so its reason can be heard.
          aria-disabled={!canSave || !!waiting}
          aria-describedby={!canSave ? reasonId : waiting ? waiting.id : undefined}
          aria-keyshortcuts="y"
          aria-label={`Yes, save ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            if (actions.save(row) && canSave) onSaved();
          }}
        >
          Yes
        </NeonButton>
        <NeonButton size="1" variant="secondary" outline aria-keyshortcuts="o" onClick={onOpen} aria-label={`Review ${label}`}>
          Review
        </NeonButton>
        <CountField row={row} actions={actions} disabled={!canSave} onEnter={onSaved} />
        {price && (
          <PriceInput
            owner={row.pairId}
            cardLabel={label}
            cents={row.minPriceCents ?? price.prefill}
            disabled={!row.cardId}
            waiting={waiting}
            onCommit={(text) => price.keep(row, text)}
            onEnter={(text) => {
              if (price.enter(row, text)) onSaved();
            }}
          />
        )}
      </div>
    </article>
  );
}

/** The questions only the collector can answer, with one-click answers. */
function Prompts({
  row,
  actions,
  onAnswered,
}: {
  row: IntakeMatchRow;
  actions: RowActions;
  /** The answer's button is gone; where focus goes. True when the card leaves the lane. */
  onAnswered: (movesOn: boolean) => void;
}) {
  const answer = (act: () => void, movesOn = false) => {
    act();
    onAnswered(movesOn);
  };
  const parts: ReactNode[] = [];
  if (row.repeatOfPairId && !row.repeatIsSecondCopy) {
    parts.push(
      <Prompt key="repeat" text="This card is already in this run. Is it a second copy, or the same card scanned twice?">
        <NeonButton size="1" variant="secondary" onClick={() => answer(() => actions.repeat(row, true))}>
          Second copy
        </NeonButton>
        <NeonButton size="1" variant="negative" outline onClick={() => answer(() => actions.repeat(row, false), true)}>
          Same card, set it aside
        </NeonButton>
      </Prompt>,
    );
  }
  const others = row.candidates.filter((c) => c._id !== row.cardId);
  if (!row.byUser && others.length > 0) {
    parts.push(
      <Prompt key="cands" text={row.cardId ? "Or is it:" : "Which card is it?"}>
        {others.map((c) => (
          <NeonButton key={c._id} size="1" variant="secondary" outline onClick={() => answer(() => actions.pick(row, c._id))}>
            {cardLabel(c)}
          </NeonButton>
        ))}
      </Prompt>,
    );
  }
  if (row.variations.length > 0) {
    parts.push(
      <Prompt key="vars" text="This card has other pictures (variations). Is it one of these?">
        {[row.card, ...row.variations]
          .filter((c): c is NonNullable<typeof c> => !!c && c._id !== row.cardId)
          .map((c) => (
            <NeonButton key={c._id} size="1" variant="secondary" outline onClick={() => answer(() => actions.pick(row, c._id))}>
              {c.variation ?? "The regular picture"}
            </NeonButton>
          ))}
      </Prompt>,
    );
  }
  return parts.length ? <div className="mt-2 space-y-2">{parts}</div> : null;
}

function Prompt({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-notice-warn-rule bg-notice-warn-bg px-3 py-2">
      <p className="m-0 text-sm text-notice-warn-ink">{text}</p>
      {children && <div className="mt-2 flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

/**
 * "Had 3 → 4": the count already in this home and the line's count once
 * saved. Enter saves at the number shown and moves on. Only digits type: any
 * other key is a shortcut for this card.
 */
function CountField({
  row,
  actions,
  disabled,
  onEnter,
}: {
  row: IntakeMatchRow;
  actions: RowActions;
  disabled: boolean;
  onEnter?: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(actions.count(row));
  return (
    <div className="flex items-center gap-2 text-sm">
      <label htmlFor={id} className="whitespace-nowrap text-ink-3">
        {row.haveHere > 0 ? `Had ${row.haveHere} →` : "Count"}
      </label>
      <Input
        bare
        id={id}
        {...{ [QTY_ATTR]: row.pairId }}
        inputMode="numeric"
        value={shown}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const n = Number.parseInt(shown, 10);
            let went = true;
            if (Number.isFinite(n)) {
              actions.setCount(row, n);
              went = actions.save(row, n);
            }
            setDraft(null);
            // A card waiting for a price keeps it: focus went to the card's Price field.
            if (went) onEnter?.();
          } else if (e.key === "Escape") {
            // Undo the typing only; inside the drawer this must not close it too.
            if (draft !== null) e.stopPropagation();
            setDraft(null);
          } else if (e.key.length === 1 && !/\d/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
          }
        }}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => {
          if (draft === null) return;
          const n = Number.parseInt(draft, 10);
          if (Number.isFinite(n)) actions.setCount(row, n);
          setDraft(null);
        }}
        className={`w-14 rounded-md border border-field-rule bg-field px-2 py-1 text-right tabular-nums text-ink max-sm:min-h-11 ${RING}`}
        aria-describedby={`${id}-hint`}
        aria-keyshortcuts="Enter"
      />
      <span id={`${id}-hint`} className="sr-only">
        Enter saves and moves to the next card.
      </span>
    </div>
  );
}

/** Search the run's variant and pick the card by hand. */
function CardSearch({ row, run, actions, onDone }: { row: IntakeMatchRow; run: RunSummary; actions: RowActions; onDone: () => void }) {
  const id = useId();
  const [q, setQ] = useState("");
  const hits = useQuery(api.intakeRuns.searchIntakeCards, { runId: run._id, q });
  const [active, setActive] = useState(0);
  const list = hits ?? [];
  const choose = (cardId: Id<"cardChecklist">) => {
    actions.pick(row, cardId);
    onDone();
  };
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-xs font-semibold text-ink-2">
        Find the card in {run.variantName ?? "this set"}
      </label>
      <Input
        bare
        id={id}
        role="combobox"
        aria-expanded="true"
        aria-controls={`${id}-list`}
        aria-activedescendant={list[active] ? `${id}-${list[active]._id}` : undefined}
        autoFocus
        value={q}
        placeholder="Number or player"
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(list.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter" && list[active]) {
            e.preventDefault();
            choose(list[active]._id);
          } else if (e.key === "Escape") {
            e.stopPropagation();
            onDone();
          }
        }}
        className={`w-full rounded-md border border-field-rule bg-field px-2 py-1.5 text-sm text-ink ${RING}`}
      />
      <ul id={`${id}-list`} role="listbox" aria-label="Cards" className="m-0 max-h-56 list-none space-y-0.5 overflow-auto p-0">
        {list.map((c, n) => (
          <li
            key={c._id}
            id={`${id}-${c._id}`}
            role="option"
            aria-selected={n === active}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(c._id)}
            className={`cursor-pointer rounded-md px-2 py-1 text-sm ${n === active ? "bg-pick-blue text-pick-blue-ink" : "text-ink-2 hover:bg-list-hover"}`}
          >
            {cardLabel(c)}
          </li>
        ))}
        {hits !== undefined && list.length === 0 && <li className="px-2 py-1 text-sm text-ink-3">Nothing in this set matches.</li>}
      </ul>
    </div>
  );
}

function Drawer({
  row,
  run,
  images,
  onOpenPhoto,
  price,
  waitsForPrice,
  read,
  actions,
  canSave,
  onClose,
  onMoveOn,
}: {
  row: IntakeMatchRow;
  run: RunSummary;
  /** The pair's two photos, front first (NEO-481: their edit state). */
  images: [IntakeImage | undefined, IntakeImage | undefined];
  onOpenPhoto: (side: "front" | "back", opener: HTMLElement) => void;
  /** NEO-481: the card's own price, on a box run only. */
  price: TilePrice | undefined;
  /** NEO-481: a box card with no price anywhere; it can't be saved yet. */
  waitsForPrice: boolean;
  read: PairRead;
  actions: RowActions;
  canSave: boolean;
  onClose: () => void;
  /** Do something that takes the card off the lane, close, and land on the next card. */
  onMoveOn: (act: () => void) => void;
}) {
  const [searching, setSearching] = useState(false);
  const waitId = useId();
  const waiting = price && waitsForPrice ? { id: waitId, line: INTAKE_NEEDS_PRICE_LINE } : null;
  // A control that took focus with it (a prompt answer, the search): focus goes back to the title.
  const toTitle = () => requestAnimationFrame(() => document.getElementById(DRAWER_TITLE_ID)?.focus());
  const tool = `min-h-11 rounded-md border border-rule bg-button-neutral px-2 py-1 text-xs text-ink-2 hover:bg-button-neutral-hover sm:min-h-8 ${RING}`;
  return (
    <div className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-2">
        <h2 id={DRAWER_TITLE_ID} tabIndex={-1} className="m-0 text-xl font-bold text-ink">
          {cardLabel(row.card)}
        </h2>
        <NeonButton size="1" variant="secondary" outline onClick={onClose}>
          Close
        </NeonButton>
      </div>
      <Band row={row} />
      <p className="m-0 text-sm text-ink-2">{readLine(read)}</p>
      <p className="m-0 text-sm text-ink-3">{reasonText(row, read)}</p>
      <div className="flex gap-3">
        <ScanThumb
          jobId={run.jobId}
          entryIndex={row.frontIndex}
          image={images[0]}
          name={`Open front of ${cardLabel(row.card)}`}
          alt={`Front of ${cardLabel(row.card)}`}
          className="h-64 w-auto rounded"
          onOpen={(opener) => onOpenPhoto("front", opener)}
        />
        <ScanThumb
          jobId={run.jobId}
          entryIndex={row.backIndex}
          image={images[1]}
          name={`Open back of ${cardLabel(row.card)}`}
          alt={`Back of ${cardLabel(row.card)}`}
          className="h-64 w-auto rounded"
          onOpen={(opener) => onOpenPhoto("back", opener)}
        />
      </div>
      <div className="text-sm empty:hidden">
        <EditLine jobId={run.jobId} image={images[0]} label={`the front of ${cardLabel(row.card)}`} />
        <EditLine jobId={run.jobId} image={images[1]} label={`the back of ${cardLabel(row.card)}`} />
      </div>
      <Prompts row={row} actions={actions} onAnswered={(movesOn) => (movesOn ? onMoveOn(() => {}) : toTitle())} />
      {searching ? (
        <CardSearch
          row={row}
          run={run}
          actions={actions}
          onDone={() => {
            setSearching(false);
            toTitle();
          }}
        />
      ) : (
        <button type="button" onClick={() => setSearching(true)} className={`text-sm text-neon-blue-text underline ${RING}`}>
          Wrong card? Find it
        </button>
      )}
      <div role="group" aria-label="Fix this scan" className="flex flex-wrap gap-1.5">
        <button type="button" className={tool} aria-keyshortcuts="s" onClick={() => actions.swap(row)}>
          <kbd className="mr-1 font-mono">s</kbd>Swap sides
        </button>
        <button type="button" className={tool} aria-keyshortcuts="u" onClick={() => onMoveOn(() => actions.unpair(row))}>
          <kbd className="mr-1 font-mono">u</kbd>Unpair
        </button>
        {row.byUser && (
          <button
            type="button"
            className={tool}
            onClick={() => {
              actions.pick(row, null);
              toTitle();
            }}
          >
            Let the matcher pick again
          </button>
        )}
        <NeonButton size="1" variant="negative" outline aria-keyshortcuts="d" className="min-h-11 sm:min-h-8" onClick={() => onMoveOn(() => actions.aside(row, true))}>
          <kbd className="mr-1 font-mono">d</kbd>Set aside
        </NeonButton>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-rule pt-3">
        <CountField row={row} actions={actions} disabled={!canSave} onEnter={() => onMoveOn(() => {})} />
        {price && (
          <PriceInput
            owner={row.pairId}
            cardLabel={cardLabel(row.card)}
            cents={row.minPriceCents ?? price.prefill}
            disabled={!row.cardId}
            waiting={waiting}
            onCommit={(text) => price.keep(row, text)}
            onEnter={(text) => {
              if (price.enter(row, text)) onMoveOn(() => {});
            }}
          />
        )}
        <NeonButton
          variant="primary"
          aria-disabled={!canSave || !!waiting}
          aria-describedby={canSave && waiting ? waiting.id : undefined}
          onClick={() => {
            if (!canSave) return void actions.save(row);
            if (actions.save(row)) onMoveOn(() => {});
          }}
        >
          Save this card
        </NeonButton>
      </div>
    </div>
  );
}
