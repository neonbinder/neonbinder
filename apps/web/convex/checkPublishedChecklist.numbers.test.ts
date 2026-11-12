/**
 * NEO-489 security audit — `checkPublishedChecklist` refuses a card number
 * holding any character outside `[#A-Za-z0-9. -]`, naming the row. Defence
 * in depth: the client parser never sends one, so every number it does send
 * must still pass.
 */

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { checkPublishedChecklist } from "./selectorOptions";
import { parsePublishedChecklist } from "../lib/checklists/parse-published-checklist";

const row = (number: string) => ({ number, players: ["Mike Trout"], teams: [] as string[] });

describe("checkPublishedChecklist — card number characters", () => {
  test.each(["NNO", "a", "PPR-DLa", "TBD", "#12", "1.5", "No. 12", "BCP-12", "US1", "1a", ""])(
    "accepts %j",
    (number) => {
      const checked = checkPublishedChecklist({ rows: [row(number)] })!;
      expect(checked.rows[0].number).toBe(number.trim());
    },
  );

  test.each(["1<script>", "12\u0000", "12/99", "12;DROP", "１２", "12\t3", "1_2", "12*"])(
    "refuses %j, naming the row",
    (number) => {
      const call = () => checkPublishedChecklist({ rows: [row("1"), row(number)] });
      expect(call).toThrow(ConvexError);
      expect(call).toThrow(/Row 2 of the official checklist has a card number/);
    },
  );

  test("every number the client parser keeps passes the re-check unchanged", () => {
    const text = [
      "Card #,Player,Team",
      "NNO,Mike Trout,Los Angeles Angels",
      "a,Mike Trout,Los Angeles Angels",
      "PPR-DLa,Derrek Lee,Chicago Cubs",
      "TBD,Mike Trout,No Team",
      "#12,Mike Trout,Los Angeles Angels",
      "1.5,Mike Trout,Los Angeles Angels",
      "1a,Mike Trout,Los Angeles Angels",
      "RA-MT,Mike Trout,Los Angeles Angels",
    ].join("\n");
    const lines = ["60 Rhett Lowder - Cincinnati Reds", "#7 Mike Trout - Angels", "US1 Mike Trout"].join(
      "\n",
    );
    const parsed = [...parsePublishedChecklist(text).rows, ...parsePublishedChecklist(lines).rows];
    expect(parsed.map((r) => r.number)).toEqual([
      "NNO",
      "a",
      "PPR-DLa",
      "TBD",
      "12",
      "1.5",
      "1a",
      "RA-MT",
      "60",
      "7",
      "US1",
    ]);
    const checked = checkPublishedChecklist({
      rows: parsed.map(({ number, players, teams, noNumber, noTeam }) => ({
        number,
        players,
        teams,
        ...(noNumber ? { noNumber } : {}),
        ...(noTeam ? { noTeam } : {}),
      })),
    })!;
    expect(checked.rows.map((r) => r.number)).toEqual(parsed.map((r) => r.number));
  });
});
