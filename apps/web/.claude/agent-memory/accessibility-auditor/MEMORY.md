# Accessibility Auditor Memory — NeonBinder apps/web

- [Maestro/aria-label coupling](maestro-aria-label-coupling.md) — never add an `id` to fix a dangling `htmlFor`; check `.maestro/flows/**` before touching any aria-label text
- [Disabled-but-reachable button pattern](disabled-button-pattern.md) — native `disabled` removes focus entirely; use `aria-disabled` + `aria-describedby` for "temporarily inert" controls
- [Known contrast failures](contrast-failures.md) — `#FF2EB3` text-on-light and `text-gray-400` both measured below AA; systemic, not yet fixed app-wide
- [Virtualized list a11y pattern](virtualized-list-a11y.md) — react-virtuoso parent/child rows: bake relationships into row text, don't reach for tree/aria-owns
- [Target size in dense list rows](target-size-list-rows.md) — icon-only buttons in `SetSelector` row components tend to ship with no padding, well under the 24×24 CSS px minimum
