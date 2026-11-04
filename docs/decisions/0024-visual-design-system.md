# ADR-0024: Visual design system
Status: Accepted · 2026-11-04 · Requested by the product owner, who found the screens text-heavy and flat.

**Decision.** The look lives in the theme and shared components, so pages inherit it.
- `index.css` holds the tokens: forest green (`brand-*`), a warm amber accent (`harvest-*`), warm neutrals, and
  three shadow levels. `surface-card` is the one panel surface and `surface-forest` the one dark surface.
- `components/ui` gained `IconTile`, `Avatar`, `FilterBar` and `Skeleton`. `Stat`, `Card` and `EmptyState` take an
  icon. Use these, and theme neutrals rather than `slate-*`.
- Inter and Manrope are installed from npm and bundled, because the security policy allows fonts only from our
  own origin (`font-src 'self'`).
- The sidebar groups pages as Overview, Records and Administration. Home shows role-based shortcuts and how many
  records wait on this person.

**Charts.** The stage ramp moved from blue to green and still passes the ordinal palette validator on white
(`chartTheme.ts`). The map's area colours use the same ramp. Home's stage bars now show each stage's share of the
total, where they used to be scaled to the largest stage.

**Accessibility.** Text pairs were measured at WCAG AA (4.5:1) or better, including on the brightest part of the
dark gradient. Text on that gradient must be `brand-200` or lighter: `brand-300` measures 3.5:1.

**Not done.** No dark mode.
