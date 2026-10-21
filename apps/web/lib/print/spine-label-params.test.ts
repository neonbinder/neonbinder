import { describe, expect, it } from "vitest";
import {
  MAX_PREFILL_NAME_LENGTH,
  parseSpineLabelParams,
  spineLabelPrintHref,
} from "./spine-label-params";

/**
 * NEO-350 — the Print Shop's spine-label designer opened with a label filled
 * in: each param read on its own, and anything not valid dropped silently.
 */

describe("parseSpineLabelParams", () => {
  it("reads a full prefill, colours without the hash", () => {
    expect(parseSpineLabelParams("?name=All+Reggie+White&bg=203731&fg=FFB612&font=teko")).toEqual({
      name: "All Reggie White",
      background: "#203731",
      text: "#ffb612",
      fontId: "teko",
    });
  });

  it("takes url-encoded hashes and three-digit hex", () => {
    expect(parseSpineLabelParams("bg=%23000&fg=%23FfF")).toEqual({ background: "#000000", text: "#ffffff" });
  });

  it("takes parsed params as well as a string", () => {
    expect(parseSpineLabelParams(new URLSearchParams({ name: "Packers PC" }))).toEqual({ name: "Packers PC" });
  });

  it("is empty with no params, so the designer starts as it always has", () => {
    expect(parseSpineLabelParams("")).toEqual({});
    expect(parseSpineLabelParams("?utm_source=x")).toEqual({});
  });

  it("drops a colour that is not hex, keeping the rest", () => {
    expect(parseSpineLabelParams("name=Red+Wings&bg=red&fg=ffffff")).toEqual({ name: "Red Wings", text: "#ffffff" });
    expect(parseSpineLabelParams("bg=12345&fg=gggggg")).toEqual({});
    expect(parseSpineLabelParams("bg=000;background:url(x)")).toEqual({});
    expect(parseSpineLabelParams("bg=")).toEqual({});
  });

  it("drops a font that is not a spine font", () => {
    expect(parseSpineLabelParams("font=comic-sans")).toEqual({});
    expect(parseSpineLabelParams("font=ANTON")).toEqual({});
    expect(parseSpineLabelParams("font=system")).toEqual({ fontId: "system" });
  });

  it("trims the name and drops a blank or overlong one", () => {
    expect(parseSpineLabelParams("name=%20%20Slab+case%20")).toEqual({ name: "Slab case" });
    expect(parseSpineLabelParams("name=%20%20")).toEqual({});
    expect(parseSpineLabelParams(`name=${"x".repeat(MAX_PREFILL_NAME_LENGTH + 1)}`)).toEqual({});
    expect(parseSpineLabelParams(`name=${"x".repeat(MAX_PREFILL_NAME_LENGTH)}`).name).toHaveLength(
      MAX_PREFILL_NAME_LENGTH,
    );
  });

  it("keeps a name with markup as plain text (the sheet escapes it)", () => {
    expect(parseSpineLabelParams("name=%3Cb%3E'96%3C%2Fb%3E").name).toBe("<b>'96</b>");
  });
});

describe("spineLabelPrintHref", () => {
  it("writes readable params, colours without the hash", () => {
    expect(
      spineLabelPrintHref({ name: "All Reggie White", background: "#203731", text: "#FFB612", fontId: "anton" }),
    ).toBe("/print/spine-label?name=All+Reggie+White&bg=203731&fg=ffb612&font=anton");
  });

  it("round-trips through the parser", () => {
    const label = { name: "'96 Contenders & co", background: "#005a9c", text: "#ef3e42", fontId: "bungee" };
    const href = spineLabelPrintHref(label);
    expect(parseSpineLabelParams(href.slice(href.indexOf("?")))).toEqual(label);
  });

  it("leaves out what the designer would throw away", () => {
    expect(spineLabelPrintHref({ name: "Mine", background: "#12", text: "#ffffff", fontId: "nope" })).toBe(
      "/print/spine-label?name=Mine&fg=ffffff",
    );
    expect(spineLabelPrintHref({})).toBe("/print/spine-label");
  });
});
