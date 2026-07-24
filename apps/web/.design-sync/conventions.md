## Using this design system

No root wrapper or provider is required — every component either has no context
dependency, or is self-contained (`Tabs`, `NavigationMenu`, and `Menubar` each provide
their own internal React context; just render `<Tabs defaultValue="...">` etc. directly,
no external setup). Fonts (`Lexend`, plus the brand display font `Neon`) and all color
tokens below load automatically once you `import "./styles.css"` at your app root — do
that once, nothing else to configure.

### Styling idiom: Tailwind utility classes, brand color family

Style everything with Tailwind utility classes. This system's brand palette is exposed as
named color utilities — use these instead of generic Tailwind colors (`green-500`,
`pink-500`, etc.) whenever a NeonBinder brand color is called for:

| Utility | Hex | Use |
|---|---|---|
| `neon-green` | `#00D558` | Primary actions, success, default/primary buttons |
| `neon-pink` | `#FF2E9A` | Destructive actions, errors, cancel |
| `neon-yellow` | `#FFE600` | Warnings, accents |
| `neon-blue` | `#00C2FF` | Links, info, accents |
| `neon-purple` | `#A44AFF` | Tabs/secondary UI accents |
| `neon-orange` | `#FF9E00` | Admin/gated-feature accents |

Apply as `bg-neon-green`, `text-neon-blue`, `border-neon-pink`, `hover:bg-neon-green/85`,
etc. — full Tailwind opacity/hover/focus modifier support. Everything else (spacing,
typography, layout, neutral grays) is plain standard Tailwind (`slate-*`, `px-4`, `rounded-md`,
`text-sm`, `flex`, ...) — don't invent new brand-color names beyond the six above.

### Where the truth lives

- `styles.css` (and its `@import` of `_ds_bundle.css`) — the compiled stylesheet; read it if
  a token or class doesn't look right.
- Each component's `.d.ts` in this bundle — the authoritative prop contract; check it before
  guessing a prop name.
- Each component's `.prompt.md` — usage notes and examples for that specific component.

### Example: a realistic composed form

```tsx
import { Input, Button, Checkbox } from "neonbinder";

function AddCardForm() {
  return (
    <form className="flex flex-col gap-4 max-w-sm">
      <Input label="Card name" placeholder="2024 Topps Chrome" />
      <Input label="SKU" helperText="Auto-generated, cannot be edited" disabled />
      <Checkbox label="List on eBay" description="Auto-relist if it expires unsold" />
      <div className="flex gap-3">
        <Button variant="primary">Save Card</Button>
        <Button variant="ghost">Cancel</Button>
      </div>
    </form>
  );
}
```
