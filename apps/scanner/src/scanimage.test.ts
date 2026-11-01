import { describe, expect, test } from "vitest";
import {
  DEFAULT_SETTINGS,
  duplexSource,
  fujitsuPlan,
  nearestResolution,
  paperLoadedIn,
  parseOptions,
  parseScanners,
  reportedArgs,
  scanArgs,
  wholeCards,
} from "./scanimage.js";

describe("wholeCards", () => {
  test("holds back the newest file while the scan runs", () => {
    expect(wholeCards(["1", "2", "3"], false)).toEqual({ pairs: [["1", "2"]], orphan: undefined });
    expect(wholeCards(["1", "2"], false)).toEqual({ pairs: [], orphan: undefined });
  });
  test("once the scan ends every file counts, and a lone last side is an orphan", () => {
    expect(wholeCards(["1", "2", "3", "4"], true)).toEqual({ pairs: [["1", "2"], ["3", "4"]], orphan: undefined });
    expect(wholeCards(["1", "2", "3"], true)).toEqual({ pairs: [["1", "2"]], orphan: "3" });
    expect(wholeCards([], true)).toEqual({ pairs: [], orphan: undefined });
  });
});

describe("scanner discovery", () => {
  test("names each scanner and which backend drives it", () => {
    expect(parseScanners("pixma:04A9|CANON TS3300\nfujitsu:fi-7160:1234|FUJITSU fi-7160\ncanon_dr:libusb:001:004|CANON DR-C225\n")).toEqual([
      { device: "pixma:04A9", backend: undefined, name: "CANON TS3300" },
      { device: "fujitsu:fi-7160:1234", backend: "fujitsu", name: "FUJITSU fi-7160" },
      { device: "canon_dr:libusb:001:004", backend: "canon_dr", name: "CANON DR-C225" },
    ]);
    expect(parseScanners("epsonds:libusb:002:003|\n")).toEqual([
      { device: "epsonds:libusb:002:003", backend: "epsonds", name: "epsonds:libusb:002:003" },
    ]);
  });
  test("reads the hopper sensor, by whichever name the backend gives it", () => {
    expect(paperLoadedIn("    --page-loaded[=(yes|no)] [yes] [hardware]\n")).toBe(true);
    expect(paperLoadedIn("    --page-loaded[=(yes|no)] [no] [hardware]\n")).toBe(false);
    expect(paperLoadedIn("    --adf-loaded[=(yes|no)] [yes] [hardware]\n", "--adf-loaded")).toBe(true);
    expect(paperLoadedIn("")).toBe(false);
  });
});

describe("Fujitsu scan args", () => {
  test("keeps the card-stock sensor fixes and buffer mode off", () => {
    const args = scanArgs(fujitsuPlan("fujitsu:x", DEFAULT_SETTINGS), "/tmp/raw-%04d.jpg").join(" ");
    expect(args).toContain("--paper-protect Off --adv-paper-protect Off --df-action Continue --df-recovery Off");
    expect(args).toContain("--buffermode Off");
    expect(args).toContain("--source ADF Duplex");
    expect(args).toContain("--hwdeskewcrop=yes");
    expect(args).toContain("--overscan Off");
    expect(args).toMatch(/--batch=\/tmp\/raw-%04d\.jpg --batch-start=1$/);
  });
  test("raw mode trades the hardware crop for overscan", () => {
    const args = scanArgs(fujitsuPlan("fujitsu:x", { ...DEFAULT_SETTINGS, raw: true }), "/tmp/r.jpg").join(" ");
    expect(args).toContain("--hwdeskewcrop=no");
    expect(args).toContain("--overscan On");
  });
});

// Shaped like `scanimage -A` from each backend (option names from their SANE
// sources); values are illustrative.
const CANON = `
All options specific to device \`canon_dr:libusb:001:004':
  Standard:
    --source Flatbed|ADF Front|ADF Back|ADF Duplex [ADF Duplex]
        Selects the scan source.
    --mode Lineart|Gray|Color [Lineart]
    --resolution 100|150|200|300|400|600dpi [300]
  Geometry:
    -x 0..216mm [215.872]
    -y 0..355.6mm [279.364]
    --page-width 0..216mm [215.872]
    --page-height 0..355.6mm [279.364]
  Advanced:
    --df-length[=(yes|no)] [no]
    --df-thickness[=(yes|no)] [yes]
    --rollerdeskew[=(yes|no)] [inactive]
    --swdeskew[=(yes|no)] [no]
    --swcrop[=(yes|no)] [no]
    --stapledetect[=(yes|no)] [inactive]
    --buffermode[=(yes|no)] [inactive]
    --hwcrop[=(yes|no)] [inactive]
  Sensors:
    --adf-loaded[=(yes|no)] [no] [hardware]
`;
const EPSONDS = `
    --mode Lineart|Gray|Color [Color]
    --resolution 75..600dpi [300]
    -x 0..215.9mm [215.9]
    -y 0..297mm [297]
    --source ADF Front|ADF Duplex [ADF Front]
    --eject [inactive]
    --adf-skew[=(yes|no)] [no]
    --adf-crp[=(yes|no)] [inactive]
`;
const EPSON2 = `
    --mode Binary|Gray|Color [Binary]
    --resolution 75|150|300|600|1200dpi [75]
    --source Flatbed|Automatic Document Feeder [Flatbed]
    --adf-mode Simplex|Duplex [inactive]
    -x 0..215.9mm [215.9]
`;

describe("scanners other than Fujitsu", () => {
  test("parses scanimage -A into flags, values and whether each is active", () => {
    const o = parseOptions(CANON);
    expect(o.get("--source")).toEqual({ values: ["Flatbed", "ADF Front", "ADF Back", "ADF Duplex"], active: true });
    expect(o.get("--resolution")?.values).toEqual(["100", "150", "200", "300", "400", "600"]);
    expect(o.get("-x")).toEqual({ values: null, active: true });
    expect(o.get("--swcrop")).toEqual({ values: ["yes", "no"], active: true });
    expect(o.get("--hwcrop")?.active).toBe(false);
    expect(o.get("--adf-loaded")?.active).toBe(true);
    // Description lines are not options.
    expect([...o.keys()].some((k) => k.startsWith("--Selects"))).toBe(false);
  });

  test("picks the source that scans both sides", () => {
    expect(duplexSource(parseOptions(CANON))).toEqual(["--source=ADF Duplex"]);
    expect(duplexSource(parseOptions(EPSONDS))).toEqual(["--source=ADF Duplex"]);
    // epson2 lists --adf-mode once the feeder is the source.
    const epson2Feeder = parseOptions(EPSON2.replace("Simplex|Duplex [inactive]", "Simplex|Duplex [Simplex]"));
    expect(duplexSource(epson2Feeder)).toEqual(["--source=Automatic Document Feeder", "--adf-mode=Duplex"]);
    expect(duplexSource(parseOptions("    --source Flatbed [Flatbed]\n"))).toBeUndefined();
    expect(duplexSource(parseOptions("    --source Flatbed|ADF Front [Flatbed]\n"))).toBeUndefined();
  });

  test("rounds the resolution to one the scanner lists", () => {
    expect(nearestResolution({ values: ["75", "150", "300", "600"], active: true }, 400)).toBe(300);
    expect(nearestResolution({ values: ["200", "600"], active: true }, 400)).toBe(600);
    expect(nearestResolution({ values: null, active: true }, 400)).toBe(400);
    expect(nearestResolution(undefined, 400)).toBe(400);
  });

  test("Canon: double-feed checks off, software crop when there's no hardware crop, its loaded sensor", () => {
    const plan = reportedArgs("canon_dr:x", "canon_dr", DEFAULT_SETTINGS, ["--source=ADF Duplex"], parseOptions(CANON));
    expect(plan.args).toEqual([
      "-d", "canon_dr:x", "--source=ADF Duplex",
      "--mode=Color", "--resolution=400",
      "--page-width=110", "--page-height=130", "-x", "110", "-y", "130",
      "--df-thickness=no", "--df-length=no",
      "--swcrop=yes", "--swdeskew=yes",
    ]);
    expect(plan.sensor).toBe("--adf-loaded");
    expect(plan.resolution).toBe(400);
    const raw = reportedArgs("canon_dr:x", "canon_dr", { ...DEFAULT_SETTINGS, raw: true }, ["--source=ADF Duplex"], parseOptions(CANON));
    expect(raw.args).not.toContain("--swcrop=yes");
  });

  test("Epson: only the options it reports, and no sensor to wait on", () => {
    const plan = reportedArgs("epsonds:x", "epsonds", DEFAULT_SETTINGS, ["--source=ADF Duplex"], parseOptions(EPSONDS));
    expect(plan.args).toEqual([
      "-d", "epsonds:x", "--source=ADF Duplex",
      "--mode=Color", "--resolution=400", "-x", "110", "-y", "130",
      "--adf-skew=yes",
    ]);
    expect(plan.sensor).toBeUndefined();
    const epson2 = reportedArgs("epson2:x", "epson2", DEFAULT_SETTINGS, ["--source=Automatic Document Feeder", "--adf-mode=Duplex"], parseOptions(EPSON2));
    expect(epson2.args).toEqual([
      "-d", "epson2:x", "--source=Automatic Document Feeder", "--adf-mode=Duplex",
      "--mode=Color", "--resolution=300", "-x", "110",
    ]);
    expect(epson2.resolution).toBe(300);
  });
});
