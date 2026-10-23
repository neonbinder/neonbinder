/**
 * NEO-356 — `theme/neon-button-only`: an action button with a neon fill is a
 * `<NeonButton>`, never a hand-rolled `<button className="bg-neon-...">`.
 *
 * Jason, 2026-10-23: "we should be using that button everywhere so that when
 * we try to update things like the color again it is one single button". The
 * button colours were re-decided three times in one ticket (pink, red, pink);
 * each time every hand-rolled copy had to be found by grep. NeonButton
 * (components/modules/NeonButton.tsx) is now the one place a button's colour
 * is decided, and this rule keeps it that way.
 *
 * Flagged: a lowercase `<button>` whose className carries, unconditionally and
 * with no variant prefix, a neon fill (`bg-neon-<hue>` or `bg-neon-<hue>-hover`
 * at full strength). The className is read from a string, a template literal's
 * static chunks, the string arguments of a call (`cn(...)`), or a module
 * constant holding one of those.
 *
 * Not flagged, because they are not action buttons or not fills:
 *   - a fill behind a variant (`hover:bg-neon-pink`, `aria-pressed:...`) or a
 *     condition (`${on ? "bg-neon-green" : ""}`): a selected chip, tab or
 *     toggle lights up; that is state, not a button colour;
 *   - a wash (`bg-neon-pink/10`) or the hue as text or edge;
 *   - a `<button>` that declares itself a toggle or a choice (`aria-pressed`,
 *     `aria-selected`, `aria-checked`, or a tab/switch/radio/option/checkbox
 *     role).
 * Borders are deliberately not linted: outline classes have too many
 * legitimate non-button uses.
 */
import path from "node:path";
import { splitVariants, WEB_ROOT } from "./no-raw-palette.mjs";

/** Files the rule never checks. */
export const NEON_BUTTON_EXEMPT = [
  // The one place a button's colour is decided.
  "components/modules/NeonButton.tsx",
  // The frozen NEO-350 reference prototypes (/collection/1-5), forced dark
  // and never migrated.
  "app/collection/prototypes/",
];

const NEON_FILL = /^bg-neon-[a-z]+(?:-hover)?$/;

/** The unconditional neon fills in one class string. */
export function findNeonFills(text) {
  const found = [];
  for (const token of text.split(/[\s"'`{}]+/)) {
    if (!token) continue;
    const { variants, utility } = splitVariants(token);
    if (variants.length === 0 && NEON_FILL.test(utility) && !utility.endsWith("-text")) {
      found.push(token);
    }
  }
  return found;
}

const TOGGLE_ROLES = new Set(["tab", "switch", "radio", "option", "checkbox", "menuitemradio", "menuitemcheckbox"]);
const TOGGLE_ATTRS = new Set(["aria-pressed", "aria-selected", "aria-checked"]);

function attrName(attr) {
  return attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" ? attr.name.name : null;
}

function relativePath(filename) {
  return path.relative(WEB_ROOT, filename).split(path.sep).join("/");
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "A neon-filled action button is a <NeonButton>, so its colour is decided in one place",
    },
    schema: [],
    messages: {
      neonFill:
        "`{{token}}` on a raw <button>: use <NeonButton variant=\"primary|secondary|tertiary|negative\"> (components/modules/NeonButton.tsx), the one place a button's colour is decided.",
    },
  },
  create(context) {
    const rel = relativePath(context.filename ?? context.getFilename());
    if (NEON_BUTTON_EXEMPT.some((p) => (p.endsWith("/") ? rel.startsWith(p) : rel === p))) return {};
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    /** The unconditional class text an expression contributes. */
    const staticText = (node, scopeNode, seen = new Set()) => {
      if (!node) return "";
      switch (node.type) {
        case "Literal":
          return typeof node.value === "string" ? node.value : "";
        case "TemplateLiteral":
          // Static chunks only; `${...}` holes are conditional or dynamic.
          return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(" ");
        case "JSXExpressionContainer":
          return staticText(node.expression, scopeNode, seen);
        case "BinaryExpression":
          return node.operator === "+"
            ? `${staticText(node.left, scopeNode, seen)} ${staticText(node.right, scopeNode, seen)}`
            : "";
        case "CallExpression":
          return node.arguments
            .filter((a) => a.type === "Literal" || a.type === "TemplateLiteral")
            .map((a) => staticText(a, scopeNode, seen))
            .join(" ");
        case "Identifier": {
          if (seen.has(node.name)) return "";
          seen.add(node.name);
          let scope = sourceCode.getScope ? sourceCode.getScope(scopeNode) : context.getScope();
          while (scope) {
            const variable = scope.set.get(node.name);
            if (variable) {
              const def = variable.defs[0];
              if (def && def.type === "Variable" && def.parent.kind === "const" && def.node.init) {
                return staticText(def.node.init, scopeNode, seen);
              }
              return "";
            }
            scope = scope.upper;
          }
          return "";
        }
        default:
          return "";
      }
    };

    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "button") return;
        let className = null;
        for (const attr of node.attributes) {
          const name = attrName(attr);
          if (!name) continue;
          if (TOGGLE_ATTRS.has(name)) return;
          if (name === "role" && attr.value?.type === "Literal" && TOGGLE_ROLES.has(attr.value.value)) return;
          if (name === "className") className = attr.value;
        }
        if (!className) return;
        for (const token of findNeonFills(staticText(className, node))) {
          context.report({ node: className, messageId: "neonFill", data: { token } });
        }
      },
    };
  },
};

export default rule;
