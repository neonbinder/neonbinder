import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import {
  INTAKE_NEEDS_PRICE,
  INTAKE_NEEDS_PRICE_LINE,
  intakeSavePriceCents,
  type IntakeReason,
} from "@/convex/lib/intakeMatch";
import { ENTRY_TOO_MANY_PIXELS, type RejectedSummary, type RejectionKind } from "@/convex/lib/extractRejections";
import { MAX_PRICE_CENTS } from "@/lib/collection/price-cap";
import { asPendingPhotoEdit } from "@/lib/photo-edit/geometry";
import type { CopyPhotos, PhotoUrls } from "../data/types";

/**
 * NEO-382 — the signed-in intake screen's lanes, worked out from the three
 * live reads it subscribes to: the placeholder job's images and pairs, and the
 * run's matches. Pure, so the stage rules are tested without Convex.
 *
 * Every photo is in exactly one lane, left to right as the pipeline works:
 *
 *   Reading:  uploaded, not cropped and read yet;
 *   Pairing:  read (or failed) and not in a pair: the loose pile;
 *   Matching: in a pair the matcher has not answered yet;
 *   Needs you: matched (or not), waiting for the collector;
 *   Saved:    saved by the collector. A pair or loose photo set aside sits apart.
 */

export type IntakeImage = FunctionReturnType<typeof api.placeholderPipeline.listPlaceholderImages>[number];
export type IntakePair = FunctionReturnType<typeof api.placeholderPipeline.listPlaceholderPairs>[number];
export type IntakeMatchRow = FunctionReturnType<typeof api.intakeRuns.listIntakeMatches>[number];
export type CardSummary = IntakeMatchRow["candidates"][number];

/** What was read off a pair: the number and the names, either side. */
export interface PairRead {
  number: string | null;
  players: string[];
}

export interface Lanes {
  reading: IntakeImage[];
  loose: IntakeImage[];
  matching: IntakePair[];
  review: IntakeMatchRow[];
  saved: IntakeMatchRow[];
  setAside: IntakeMatchRow[];
  /** NEO-446: loose photos the collector set aside. They sit with `setAside` and hold nothing open. */
  looseAside: IntakeImage[];
}

export const EMPTY_LANES: Lanes = { reading: [], loose: [], matching: [], review: [], saved: [], setAside: [], looseAside: [] };

const pairKey = (frontIndex: number, backIndex: number) => `${frontIndex}-${backIndex}`;

export function laneOf(images: IntakeImage[], pairs: IntakePair[], matches: IntakeMatchRow[]): Lanes {
  const paired = new Set<number>();
  for (const p of pairs) {
    paired.add(p.frontIndex);
    paired.add(p.backIndex);
  }
  const answered = new Set(matches.map((m) => pairKey(m.frontIndex, m.backIndex)));
  const byIndex = (a: IntakeImage, b: IntakeImage) => a.entryIndex - b.entryIndex;
  const unpaired = images.filter((i) => (i.status === "done" || i.status === "failed") && !paired.has(i.entryIndex));
  return {
    reading: images.filter((i) => i.status !== "done" && i.status !== "failed").sort(byIndex),
    loose: unpaired.filter((i) => !i.setAside).sort(byIndex),
    looseAside: unpaired.filter((i) => i.setAside).sort(byIndex),
    matching: pairs
      .filter((p) => !answered.has(pairKey(p.frontIndex, p.backIndex)))
      .sort((a, b) => a.frontIndex - b.frontIndex),
    review: matches.filter((m) => m.savedAt === undefined && !m.setAside),
    saved: matches.filter((m) => m.savedAt !== undefined).sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0)),
    setAside: matches.filter((m) => m.savedAt === undefined && m.setAside),
  };
}

/**
 * NEO-370 Rev 4 — every column but Saved is clear: nothing reading, pairing,
 * matching or waiting on the collector (a pair or loose photo set aside sits
 * apart and does not hold the run open). Once it is, after "Done adding photos", the
 * run's cards sync to the collector's marketplaces.
 */
export function columnsClear(lanes: Pick<Lanes, "reading" | "loose" | "matching" | "review">): boolean {
  return lanes.reading.length + lanes.loose.length + lanes.matching.length + lanes.review.length === 0;
}

/**
 * How a control names each loose photo: its file name, or with several photos of
 * one name (a phone can send every photo as image.jpg) the file name and which
 * photo of the run it is, so no two controls read the same.
 */
export function photoLabels(images: readonly Pick<IntakeImage, "entryIndex" | "originalName">[]): Map<number, string> {
  const uses = new Map<string, number>();
  for (const image of images) uses.set(image.originalName, (uses.get(image.originalName) ?? 0) + 1);
  return new Map(
    images.map((image) => [
      image.entryIndex,
      (uses.get(image.originalName) ?? 0) > 1 ? `${image.originalName}, photo ${image.entryIndex + 1}` : image.originalName,
    ]),
  );
}

/** What leaving asks after "Done adding photos", until the columns clear. */
export const LEAVE_INTAKE_LINE =
  "This run isn't finished: some cards are still working or need you. Leave anyway? Anything headed to your marketplaces goes up on the next 15-minute round instead.";

/** Said out loud when the collector's close lands (the panel's own line is not a live region). */
export const RUN_CLOSED_LINE = "That's a wrap on this run's photos!";

/** What preprocess read off a pair's two photos, front first. */
export function readOf(images: Map<number, IntakeImage>, frontIndex: number, backIndex: number): PairRead {
  const front = images.get(frontIndex);
  const back = images.get(backIndex);
  const players = [...(front?.players ?? []), ...(back?.players ?? [])].filter(
    (p, i, all) => all.indexOf(p) === i,
  );
  return { number: back?.cardNumber ?? front?.cardNumber ?? null, players };
}

/** "#47 Le'Veon Bell", with the variation when it has one. */
export function cardLabel(card: CardSummary | null | undefined): string {
  if (!card) return "No card picked";
  return `#${card.cardNumber} ${card.cardName}${card.variation ? ` (${card.variation})` : ""}`;
}

/**
 * A card's name on the screen: the card it was matched to, or, with none yet,
 * what was read off it and which photo, so no two unmatched cards share a name.
 */
export function tileLabel(row: Pick<IntakeMatchRow, "card" | "frontIndex">, read: PairRead): string {
  if (row.card) return cardLabel(row.card);
  const what = [read.number ? `#${read.number}` : null, read.players.join(", ") || null].filter(Boolean).join(" ");
  return `Unmatched photo ${row.frontIndex + 1}${what ? `, read ${what}` : ""}`;
}

/** Why a card can't be saved yet; empty when it can. */
export function whyNotSave(row: Pick<IntakeMatchRow, "cardId" | "repeatOfPairId" | "repeatIsSecondCopy">): string {
  if (!row.cardId) return "Pick which card this is first.";
  if (row.repeatOfPairId && !row.repeatIsSecondCopy) return "Say whether this is a second copy first.";
  return "";
}

/** Why the matcher decided what it did, in a collector's words. */
export function reasonText(row: Pick<IntakeMatchRow, "reason" | "candidates">, read: PairRead): string {
  const number = read.number ? `#${read.number}` : "no number";
  const reasons: Record<IntakeReason, string> = {
    numberAndPlayer: "The number and the player both match.",
    numberOnly: "Matched on the number. No player was read, so check the name.",
    playerUnconfirmed: `The number matches, but the name read (${read.players.join(", ") || "none"}) is on no card in this set.`,
    numberPlayerConflict: `The number reads ${number}, but the name reads ${read.players.join(", ")}. One of them is misread: check which card this is.`,
    numberSharedPlayerPicked: `More than one card is ${number}. The player picked this one.`,
    numberShared: `More than one card is ${number}. Pick the right one.`,
    numberFuzzy: `The number only matched after reading look-alike characters (O as 0, I as 1). Check it.`,
    playerOnly: `No card in this set is ${number}. Matched on the player.`,
    playerShared: `No card in this set is ${number}, and the player is on more than one card. Pick one.`,
    noMatch: "Nothing in this set matches what was read.",
    nothingRead: "Couldn't read a number or a player off this card.",
    noVariant: "Pick the set above and this card is matched in it.",
    byUser: "You picked this card.",
  };
  return reasons[row.reason];
}

/** NEO-427 — the words on a Saved tile for where its photos are. Nothing for a pair saved before photos came along. */
export function photoLine(row: Pick<IntakeMatchRow, "photos" | "photoFailure">): string | null {
  switch (row.photos) {
    case "pending":
      return "Slipping in the photos…";
    case "attached":
      return "Photos are in!";
    case "failed":
      if (row.photoFailure === "scanGone") return "The scans aged out.";
      if (row.photoFailure === "unusable") return "These scans won't cut it.";
      return "Photos didn't stick.";
    default:
      return null;
  }
}

/** Where a row's photos are, for spotting a change. */
export type PhotoStates = ReadonlyMap<string, string>;

type PhotoRow = Pick<IntakeMatchRow, "pairId" | "photos" | "photoFailure" | "photoCanRetry">;

export function photoStates(rows: readonly PhotoRow[]): PhotoStates {
  return new Map(rows.map((row) => [row.pairId, `${row.photos ?? ""}:${row.photoFailure ?? ""}:${row.photoCanRetry ?? ""}`]));
}

/** How long a run's photos stay quiet before what landed is said at once. */
export const PHOTO_NEWS_QUIET_MS = 1500;

export type PhotoNewsKind = "attached" | "retry" | "stuck" | "scanGone" | "unusable";
/** What just happened to some rows' photos, by pair: a later word on a pair replaces an earlier one. */
export type PhotoChanges = ReadonlyMap<string, { kind: PhotoNewsKind; card: string }>;

function newsKindOf(row: PhotoRow): PhotoNewsKind | null {
  if (row.photos === "attached") return "attached";
  if (row.photos !== "failed") return null;
  if (row.photoFailure === "scanGone" || row.photoFailure === "unusable") return row.photoFailure;
  return row.photoCanRetry ? "retry" : "stuck";
}

/**
 * NEO-427 — the rows whose photos landed or failed since `before`. A row not
 * seen before says nothing, so opening a finished run stays quiet; going back
 * to pending says nothing, because focus lands on the line itself.
 */
export function photoChanges(before: PhotoStates, rows: readonly IntakeMatchRow[]): PhotoChanges {
  const now = photoStates(rows);
  const changes = new Map<string, { kind: PhotoNewsKind; card: string }>();
  for (const row of rows) {
    const kind = newsKindOf(row);
    if (kind && before.has(row.pairId) && before.get(row.pairId) !== now.get(row.pairId)) {
      changes.set(row.pairId, { kind, card: cardLabel(row.card) });
    }
  }
  return changes;
}

/** The one polite line for some changes: by name for one card, as a count for many. */
export function photoNewsOf(changes: PhotoChanges): string {
  const all = [...changes.values()];
  const say = (kind: PhotoNewsKind, one: (card: string) => string, many: (n: number) => string) => {
    const found = all.filter((change) => change.kind === kind);
    return found.length === 0 ? "" : found.length === 1 ? one(found[0].card) : many(found.length);
  };
  return [
    say(
      "attached",
      (card) => `Photos are in for ${card}.`,
      (n) => `Photos are in for ${n} cards.`,
    ),
    say(
      "retry",
      (card) => `Photos didn't stick on ${card}. Try again from its tile in Saved.`,
      (n) => `Photos didn't stick on ${n} cards. Try again from their tiles in Saved.`,
    ),
    say(
      "stuck",
      (card) => `Photos didn't stick on ${card}. Add a photo from its tile in Saved.`,
      (n) => `Photos didn't stick on ${n} cards. Add photos from their tiles in Saved.`,
    ),
    say(
      "scanGone",
      (card) => `The scans for ${card} aged out. Add a photo from its tile in Saved.`,
      (n) => `The scans for ${n} cards aged out. Add photos from their tiles in Saved.`,
    ),
    say(
      "unusable",
      (card) => `The scans for ${card} won't cut it. Add a photo from its tile in Saved.`,
      (n) => `The scans for ${n} cards won't cut it. Add photos from their tiles in Saved.`,
    ),
  ]
    .filter(Boolean)
    .join(" ");
}

export function photoNews(before: PhotoStates, rows: readonly IntakeMatchRow[]): string {
  return photoNewsOf(photoChanges(before, rows));
}

/** The line's count once saved: what is already here, plus this scan. */
export function proposedCount(row: Pick<IntakeMatchRow, "haveHere">): number {
  return row.haveHere + 1;
}

/**
 * NEO-411: how many times one photo may be sent again with Try again. The
 * server's cap is PLACEHOLDER_MAX_IMAGE_RETRIES (convex/placeholderStream.ts);
 * this copy only decides whether the button is drawn, the server still refuses.
 */
export const MAX_PHOTO_RETRIES = 3;

/**
 * Whether a failed photo can still be sent again (the run must also be open).
 * Never one over the pixel ceiling: the same bytes can only fail the same way.
 */
export function canRetryPhoto(image: Pick<IntakeImage, "status" | "retries" | "errorCode">): boolean {
  return (
    image.status === "failed" &&
    image.errorCode !== ENTRY_TOO_MANY_PIXELS &&
    (image.retries ?? 0) < MAX_PHOTO_RETRIES
  );
}

/**
 * The photo size limit as a collector reads it. Mirrors MAX_IMAGE_PIXELS in
 * services/preprocess/app/imaging.py (65,000,000, so that real 64 megapixel
 * phones at 64,144,128 px pass). Change both together. Spelled out because a card
 * dealer reads "MP" as Moderately Played.
 */
const PHOTO_LIMIT = "64 megapixels";

/**
 * What "too big" means for a zip entry, which also has a size cap: mirrors
 * MAX_ENTRY_UNCOMPRESSED_BYTES in services/preprocess/app/jobs/zipsafe.py. Only a
 * loose photo's failure is known to be the pixels alone.
 */
const ZIP_PHOTO_LIMIT = `${PHOTO_LIMIT} or 32 MB`;

/** What to do with a photo that has had its tries. */
const SEND_FRESH_LINE = "Send a fresh one.";

/** Try again refused because the photo has had its tries (the tile usually says this first). */
export const PHOTO_OUT_OF_TRIES_LINE = `Couldn't read it. ${SEND_FRESH_LINE}`;

/** Try again refused because the run closed since the button was drawn. */
export const PHOTO_RUN_CLOSED_LINE = "This run is closed. Send a fresh one in a new run.";

/** Try again refused because the photo was set aside since the button was drawn. */
export const PHOTO_SET_ASIDE_LINE = "That photo was set aside. Bring it back to pair it.";

/** A photo over the limit: on its tile, and if a stale Try again is refused for it. */
export const PHOTO_TOO_BIG_LINE = `Too big (over ${PHOTO_LIMIT}). Shrink it and send it again.`;

/**
 * Why a photo in the pile failed, in a collector's words. With no Try again on
 * offer (the run is closed, or the photo has had its tries), it says what to do.
 */
export function failedText(image: Pick<IntakeImage, "errorCode">, retryOffered: boolean): string {
  if (image.errorCode === ENTRY_TOO_MANY_PIXELS) return PHOTO_TOO_BIG_LINE;
  const why = image.errorCode === "PHOTO_TIMED_OUT" ? "Took too long to read" : "Couldn't read it";
  return retryOffered ? why : `${why}. ${SEND_FRESH_LINE}`;
}

/**
 * NEO-446 — the order a zip's entries are unpacked in, for loose photos too, so
 * the same pile pairs the same way however it arrives: digit runs by value, the
 * rest ignoring case. Mirrors `_natural_sort_key` in
 * services/preprocess/app/jobs/zipsafe.py, down to comparing a digit run by
 * length then text, so a very long run never leaves the safe integer range.
 */
export function compareNaturalNames(a: string, b: string): number {
  const left = a.toLowerCase().split(/([0-9]+)/);
  const right = b.toLowerCase().split(/([0-9]+)/);
  const compareText = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const isDigits = i % 2 === 1;
    const x = isDigits ? left[i].replace(/^0+/, "") : left[i];
    const y = isDigits ? right[i].replace(/^0+/, "") : right[i];
    const order = (isDigits ? x.length - y.length : 0) || compareText(x, y);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

/** The files in that order, as a new array; names that compare equal keep their order. */
export function inNaturalOrder(files: readonly File[]): File[] {
  return [...files].sort((a, b) => compareNaturalNames(a.name, b.name));
}

/** The job fields the screen's run line is worked out from. */
export type NoticeJob = Pick<
  NonNullable<FunctionReturnType<typeof api.placeholderPipeline.getPlaceholderJob>>,
  "status" | "mode" | "totalImages" | "failedImages" | "rejectedEntries" | "errorCode" | "rejected"
>;

export interface RunNotice {
  line: string;
  /**
   * `line` in pieces, for drawing: odd indexes are quoted file names, which go in
   * a `<bdi>` so a right-to-left name can't reorder the sentence around it. Joined,
   * they are exactly `line`, so no invisible character reaches the page.
   */
  parts: string[];
  /** Something went wrong, and the way forward is a new run: draws the warning look and "Start a new run". */
  problem: boolean;
  /** Nothing ever reached the lanes, so a row of zeros would only say something false. */
  hideWorkspace: boolean;
}

/** Marks a file name while a line is built; `notice` takes the marks back out. */
const fileName = (name: string) => `\u2068"${name.replace(/\p{C}/gu, "")}"\u2069`;

function notice(marked: string, problem = true, hideWorkspace = false): RunNotice {
  const parts = marked.split(/\u2068([^\u2069]*)\u2069/);
  return { line: parts.join(""), parts, problem, hideWorkspace };
}

const ALL_IN_LINE = "This run's photos are all in. To add more, start a new run.";
const UNPACKING_LINE = "Unpacking your zip…";
const SNAG_LINE = "Our photo reader hit a snag. That's on us. Start a new run and send them again.";
const SNAG_WITH_PHOTOS_LINE = "Our photo reader hit a snag. That's on us. Anything below is still yours to save. Send the rest in a new run.";
const WOULD_NOT_OPEN_LINE = "That zip wouldn't open. Zip your photos again (up to 1,000 photos, 500 MB) and start a new run.";
const WOULD_NOT_OPEN_CODES = new Set(["ZIP_REJECTED", "EXTRACT_REJECTED", "INPUT_TOO_LARGE", "INVALID_IDENTIFIER"]);

/** A zip over the upload limit, as the intake screen words it. */
export function zipOverLimitLine(limitMb: number): string {
  return `Couldn't send that zip: it's over ${limitMb} MB. Split it into smaller zips, each card's front and back together, one per run.`;
}

/** `"IMG_1.jpg", "IMG_2.jpg" and 3 more`, or the bare count when no name can be shown. */
function rejectedSubject(rejected: RejectedSummary, kind: RejectionKind): string {
  const count = rejected[kind];
  const names = rejected.examples
    .filter((example) => example.kind === kind)
    .map((example) => fileName(example.name))
    .slice(0, count);
  if (names.length === 0) return String(count);
  const more = count - names.length;
  return more > 0 ? `${names.join(", ")} and ${more} more` : names.join(", ");
}

/** What is wrong with `count` of a kind, after their subject: "is too big (over 64 megapixels or 32 MB)". */
function rejectedProblem(kind: RejectionKind, count: number): string {
  const one = count === 1;
  switch (kind) {
    case "tooBig":
      return `${one ? "is" : "are"} too big (over ${ZIP_PHOTO_LIMIT})`;
    case "wrongFormat":
      return one ? "isn't a JPEG or PNG" : "aren't JPEGs or PNGs";
    case "unreadable":
      return "couldn't be read";
  }
}

const REJECTION_KINDS: RejectionKind[] = ["tooBig", "wrongFormat", "unreadable"];

function kindsIn(rejected: RejectedSummary): RejectionKind[] {
  return REJECTION_KINDS.filter((kind) => rejected[kind] > 0);
}

/** One clause per kind of problem, naming what it can. */
function rejectedClauses(rejected: RejectedSummary): string {
  return kindsIn(rejected)
    .map((kind) => `${rejectedSubject(rejected, kind)} ${rejectedProblem(kind, rejected[kind])}`)
    .join("; ");
}

/**
 * Where a rejected photo goes. It is one side of a card, and its partner may
 * already be in this run, so the new run needs the other side too.
 */
function dropInNewRun(count: number): string {
  return count === 1 ? "drop it in a new run, with its other side." : "drop them in a new run, with their other sides.";
}

/** What to do about entries rejected from a run that still has photos in it. */
function rejectedFix(rejected: RejectedSummary, count: number): string {
  const one = count === 1;
  const them = one ? "it" : "them";
  const drop = dropInNewRun(count);
  const kinds = kindsIn(rejected);
  if (kinds.length !== 1) return `Fix ${them} and ${drop}`;
  switch (kinds[0]) {
    case "tooBig":
      return `Shrink ${them} and ${drop}`;
    case "wrongFormat":
      return `Convert ${them} to ${one ? "JPEG" : "JPEGs"} and ${drop}`;
    case "unreadable":
      return `Check ${one ? "it opens" : "they open"} on your end, then ${drop}`;
  }
}

/** Some of the zip made it in, some didn't. */
function someRejectedLine(job: NoticeJob): string {
  const count = job.rejectedEntries;
  const made = `${job.totalImages} photo${job.totalImages === 1 ? "" : "s"} made it in.`;
  if (!job.rejected) return `${made} ${count} didn't. Check ${count === 1 ? "it" : "them"} and ${dropInNewRun(count)}`;
  return `${made} ${count} didn't: ${rejectedClauses(job.rejected)}. ${rejectedFix(job.rejected, count)}`;
}

/** Nothing in the zip made it in, and each entry said why. */
function allRejectedLine(job: NoticeJob): string {
  const { rejected, rejectedEntries: count } = job;
  const one = count === 1;
  const them = one ? "it" : "them";
  const unreadable = `We couldn't read the ${one ? "photo" : "photos"} in that zip. Check ${one ? "it opens" : "they open"} on your end, then start a new run.`;
  if (!rejected) return unreadable;
  const kinds = kindsIn(rejected);
  if (kinds.length > 1) {
    const counts = kinds.map((kind) => `${rejected[kind]} ${rejectedProblem(kind, rejected[kind])}`);
    return `Nothing in that zip made it in: ${counts.join("; ")}. Fix ${them}, zip ${them} up again, and start a new run.`;
  }
  if (kinds[0] === "tooBig") {
    return one
      ? `Whoa, that photo is too big! It's over ${ZIP_PHOTO_LIMIT}. Shrink it, zip it up again, and start a new run.`
      : `Whoa, those photos are too big! All ${count} are over ${ZIP_PHOTO_LIMIT}. Use your camera's normal setting or shrink them, zip them up again, and start a new run.`;
  }
  if (kinds[0] === "wrongFormat") {
    return `No JPEGs or PNGs in that zip, and we can't read iPhone HEICs. Convert ${them} to JPEG, zip ${them} up again, and start a new run.`;
  }
  return unreadable;
}

function failedNotice(job: NoticeJob): RunNotice {
  const nothingIn = !job.totalImages;
  const failed = (line: string) => notice(line, true, nothingIn);
  switch (job.errorCode) {
    case "CANCELED":
      return failed("This run was stopped.");
    case "INPUT_NOT_FOUND":
      return failed("Your zip never landed. Send it again in a new run.");
    case "TOO_MANY_IMAGE_FAILURES": {
      if (!nothingIn) {
        const most = "Most of these photos wouldn't read. Anything below is still yours to save. Re-shoot the rest, sharp and well lit, in a new run, with their other sides.";
        return failed(
          job.rejectedEntries > 0 && job.rejected
            ? `${most} ${job.rejectedEntries} more didn't make it in: ${rejectedClauses(job.rejected)}.`
            : most,
        );
      }
      if (job.mode === "stream") return failed("No photos came in before this run closed. Start a new run and drop some in.");
      return failed(job.rejectedEntries > 0 ? allRejectedLine(job) : "No photos in that zip.");
    }
    default:
      if (job.errorCode && WOULD_NOT_OPEN_CODES.has(job.errorCode)) return failed(WOULD_NOT_OPEN_LINE);
      // Cards from this run may already be saved, and sending them all again could count them twice.
      return failed(nothingIn ? SNAG_LINE : SNAG_WITH_PHOTOS_LINE);
  }
}

/**
 * NEO-446 — what the screen says about a run past collecting, from its job row
 * alone, so a refresh on `?run=` says the same thing. Null while the run is
 * still collecting (the drop zone is the message then). A null job is a row
 * that is gone: the line says so, and the lanes stay in case they hold saved
 * cards.
 */
export function runNotice(job: NoticeJob | null): RunNotice | null {
  if (!job) return notice(SNAG_LINE);
  if (job.status === "collecting") return null;
  if (job.status === "failed") return failedNotice(job);
  if (job.status === "pending" || job.status === "uploaded" || job.status === "extracting") {
    return notice(UNPACKING_LINE, false);
  }
  const isZip = (job.mode ?? "zip") === "zip";
  // Between registration and the terminal decision, a zip with nothing in it is
  // still on its way to saying so; "0 photos made it in" would only flash by.
  if (isZip && job.status !== "succeeded" && job.totalImages === 0) return notice(UNPACKING_LINE, false);
  if (job.rejectedEntries > 0) return notice(someRejectedLine(job));
  return notice(ALL_IN_LINE, false);
}

/** The run's one-line status. A failed photo is not "read", so it never says everything is. */
export function runSummary(s: {
  loading: boolean;
  working: number;
  waiting: number;
  saved: number;
  unread: number;
}): string {
  if (s.loading) return "Loading this run…";
  const note = s.unread > 0 ? ` ${s.unread} photo${s.unread === 1 ? "" : "s"} couldn't be read.` : "";
  if (s.working > 0) {
    return `Working on ${s.working} photo${s.working === 1 ? "" : "s"}. ${s.waiting} waiting for you, ${s.saved} saved.${note}`;
  }
  if (s.waiting > 0) {
    return s.unread > 0
      ? `Done reading. ${s.waiting} waiting for you, ${s.saved} saved.${note}`
      : `Everything is read. ${s.waiting} waiting for you, ${s.saved} saved.`;
  }
  return `${s.saved} saved.${note}`;
}

/* ------------------------------------------------------------------ */
/* NEO-481: hand edits of a scan, the viewer, and the per-card price    */
/* ------------------------------------------------------------------ */

/** A side of a card photo. */
export type PhotoSideName = "front" | "back";

/**
 * NEO-481 — what a photo click on Add cards asks the viewer to open. The
 * server decides per open whether a scan or copy photo can be edited, and from
 * what (`photoEdits.photoEditSource`); `viewOnly` is only the cases this
 * screen already knows can't be (a saved pair whose photos are on their way).
 *
 * - `scan`: a pair's two scans (the viewer switches between them), or one
 *   loose photo (`back` absent). `label` names them in the viewer's heading
 *   ("Front of <label>").
 * - `copy`: a saved line's own photos (`copyPhotos`).
 * - `local`: a photo still being read, shown from this browser.
 */
export type PhotoViewerTarget =
  | {
      kind: "scan";
      label: string;
      front: number;
      back?: number;
      side: PhotoSideName;
      /** Set when the screen knows it opens view-only, with the line that says why. */
      viewOnly?: string;
    }
  | { kind: "copy"; copyId: string; label: string; side: PhotoSideName }
  /** A photo still uploading or being read: this browser's own copy of it, view-only. */
  | { kind: "local"; url: string; label: string; side: "front" };

/** Said in the viewer on a photo still being read: it has no scan to edit yet. */
export const STILL_READING_LINE = "Still reading this one. Turn or crop it once it's read.";
/** Said in the viewer on a saved line's photos where the page can't edit them. */
export const LINE_VIEW_ONLY_LINE = "These photos can't be turned or cropped here.";

/** Under a Saved tile whose line photo edit failed: the viewer holds Try again. */
export function lineRetryLine(side: PhotoSideName): string {
  return `Open the ${side} photo to try again.`;
}

/** A pair's scans in the viewer, opened on `side`. */
export function pairTarget(
  pair: { frontIndex: number; backIndex: number },
  label: string,
  side: PhotoSideName,
): PhotoViewerTarget {
  return { kind: "scan", label, front: pair.frontIndex, back: pair.backIndex, side };
}

/** One loose photo in the viewer (no pair yet, so no back). */
export function loneTarget(entryIndex: number, label: string): PhotoViewerTarget {
  return { kind: "scan", label, front: entryIndex, side: "front" };
}

/**
 * Said in the viewer on a Saved tile's scans when the saved line has no photo
 * of its own to show here (taken off in its drawer): a saved card's photos are
 * changed from the collection, so the scans only look.
 */
export const SAVED_SCANS_LINE =
  "This card's saved, so these scans can't be turned or cropped here. Change its photos in your collection.";

/**
 * What a Saved tile's photo opens. `linePhotos` is whether the saved line has
 * a photo to show: `true`, `false` (the answer came and it has none), or
 * `"loading"` (no answer yet).
 *
 * - An attached line opens its own photos, also while they load: the viewer
 *   follows them in, so a click before the answer still gets the tools.
 * - A pending line opens the scans view-only (`onTheWay` is what the viewer says).
 * - An attached line with no photo of its own opens the scans view-only
 *   (`SAVED_SCANS_LINE`): the server refuses a saved pair's scans anyway.
 * - Anything else opens the scans, and the server says whether they edit.
 */
export function savedPhotoTarget(
  row: Pick<IntakeMatchRow, "photos" | "savedCopyId" | "frontIndex" | "backIndex" | "card">,
  linePhotos: boolean | "loading",
  onTheWay: string,
): PhotoViewerTarget {
  const label = cardLabel(row.card);
  if (row.photos === "attached" && row.savedCopyId && linePhotos !== false) {
    return { kind: "copy", copyId: row.savedCopyId, label, side: "front" };
  }
  const viewOnly = row.photos === "pending" ? onTheWay : row.photos === "attached" ? SAVED_SCANS_LINE : undefined;
  return { ...pairTarget(row, label, "front"), ...(viewOnly ? { viewOnly } : {}) };
}


/**
 * NEO-481 — the key a scan's photo button carries in every lane
 * (`photoOpenerProps`), so the viewer can put focus back on it after its tile
 * moved lanes while the viewer was open.
 */
export function scanOpenerKey(entryIndex: number): string {
  return `scan:${entryIndex}`;
}

/** Said on a tile while a saved edit renders in the background (the old photo stays up). */
export const EDIT_RENDERING_LINE = "Touching it up…";
/** Said when the render failed and the server gave no reason a collector can read. */
export const EDIT_FAILED_LINE = "That edit didn't take. Your old photo is still here.";
/** The render found the scan's original gone (`ENTRY_NOT_FOUND`): the plan's own words. */
export const EDIT_ORIGINAL_GONE_LINE =
  "The original scan just aged out. Your crop wasn't saved; open it again to crop the saved photo.";

export type EditState = { kind: "rendering" } | { kind: "failed"; line: string } | null;

/** The part of an edit in flight (a scan's `pendingEdit`, a line photo's `edits` entry) the words come from. */
export interface EditFlag {
  status: "rendering" | "failed";
  error?: string;
}

/**
 * Where a scan's last edit stands: still rendering, failed (with the words to
 * show beside Try again), or nothing to say. A server reason that is a bare
 * code (`ENTRY_NOT_FOUND`) is never shown as it is.
 */
export function editStateOf(image: { pendingEdit?: EditFlag | null } | undefined): EditState {
  const pending = image?.pendingEdit;
  if (!pending) return null;
  if (pending.status === "rendering") return { kind: "rendering" };
  const error = pending.error?.trim();
  if (error === "ENTRY_NOT_FOUND") return { kind: "failed", line: EDIT_ORIGINAL_GONE_LINE };
  if (!error || /^[A-Z][A-Z0-9_]*$/.test(error)) return { kind: "failed", line: EDIT_FAILED_LINE };
  return { kind: "failed", line: error };
}

/**
 * The Min price field's text as cents: blank is none (`undefined`), "$1,250.5"
 * is 125050; anything else, or more than two decimals, is "invalid".
 */
export function parseMinPrice(text: string): number | undefined | "invalid" {
  const t = text.trim().replace(/[$,\s]/g, "");
  if (t === "") return undefined;
  if (!/^\d+(\.\d{0,2})?$|^\.\d{1,2}$/.test(t)) return "invalid";
  return Math.round(Number(t) * 100);
}

/**
 * NEO-481 — what a box-run tile's price starts at: the run's Min price, else
 * the collector's common price for the set (in dollars, as the store answers
 * it). Null when there is neither.
 */
export function pricePrefill(runMinCents: number | undefined, commonDollars: number | null | undefined): number | null {
  if (runMinCents !== undefined) return runMinCents;
  return typeof commonDollars === "number" ? Math.round(commonDollars * 100) : null;
}

/**
 * NEO-481 (Jason, 2026-11-10) — a box card's save needs a price: `ownCents`
 * (typed at the save, else kept on the tile), else the run's Min price, else
 * the common price for the run's set. True when it has none, so the save
 * waits. The server holds the same rule (`intakeRuns.saveIntakeMatch`).
 */
export function waitsForPrice(
  ownCents: number | undefined,
  runMinCents: number | undefined,
  commonDollars: number | null | undefined,
): boolean {
  return intakeSavePriceCents(ownCents, runMinCents, pricePrefill(undefined, commonDollars)) === null;
}

/** The server refused a save for want of a price (`INTAKE_NEEDS_PRICE`). */
export function isNeedsPriceRefusal(error: unknown): boolean {
  const data = (error as { data?: unknown } | null)?.data;
  return !!data && typeof data === "object" && (data as { code?: unknown }).code === INTAKE_NEEDS_PRICE;
}

/** "Save N matched" left cards behind for want of a price. */
export function waitingForPriceLine(n: number): string {
  return `${n === 1 ? "1 card waits" : `${n} cards wait`} for a price. Type one on the card, or set a common price.`;
}

export { INTAKE_NEEDS_PRICE_LINE };

/** A price that doesn't parse. */
export const PRICE_INVALID_LINE = "That price doesn't look right. Try something like 1.50.";
/** A price past the cap. */
export const PRICE_TOO_HIGH_LINE = "Whoa, that's more than any card sells for. Try a lower price.";

/**
 * NEO-481 — a tile's typed price, as the row should keep it. `own` undefined
 * is "the run's default": blank, or the same as what the field started at, so
 * the default is never frozen onto the copy. Only ever this card's own price;
 * a common price is never written from a tile.
 */
export function tilePrice(text: string, prefill: number | null): { ok: true; own: number | undefined } | { ok: false; line: string } {
  const problem = priceProblem(text);
  if (problem) return { ok: false, line: problem };
  const parsed = parseMinPrice(text) as number | undefined;
  return { ok: true, own: parsed === undefined || parsed === prefill ? undefined : parsed };
}

/** Presses Enter in a field, as the keyboard would: its own handler decides what Enter does (y in a price). */
export function pressEnterIn(field: Element): void {
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

/**
 * NEO-481 — what's wrong with a typed card price, in the words shown under
 * the field; null when it's a price (or blank, which is the default).
 */
export function priceProblem(text: string): string | null {
  const parsed = parseMinPrice(text);
  if (parsed === "invalid") return PRICE_INVALID_LINE;
  if (parsed !== undefined && parsed > MAX_PRICE_CENTS) return PRICE_TOO_HIGH_LINE;
  return null;
}

/** NEO-481 — a `copyPhotos.photosOf` row: a saved line's photos, with each side's edit in flight. */
export type RawLinePhotos = FunctionReturnType<typeof api.copyPhotos.photosOf>[number];

/**
 * A `photosOf` row as the line's photos, the newest edit of each side on it.
 * Keep in step with `photosOfRow` in `../data/convexStore` (this tab reads the
 * query itself: it has no `Copy` to ask the store with).
 */
export function linePhotosOf(row: RawLinePhotos): CopyPhotos {
  const side = (s: "front" | "back"): PhotoUrls | undefined => {
    const urls = row[s];
    if (!urls) return undefined;
    const pending = asPendingPhotoEdit(row.edits?.find((e) => e.side === s));
    return { imageUrl: urls.imageUrl, thumbUrl: urls.thumbUrl, ...(pending ? { pending } : {}) };
  };
  const front = side("front");
  const back = side("back");
  return { ...(front ? { front } : {}), ...(back ? { back } : {}) };
}
