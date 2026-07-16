# Favorites / i18n / PIN Dropdown Bug Fix Checklist

**Created**: 2026-07-16
**Goal**: Root-cause fix three reported issues; verify with vue-tsc and targeted grep.

## Issues

1. **Favorites card "+" move-to-collection click has no effect and no feedback**
   - Likely cause: dropdown inside `.fav-card-actions` with opacity hover makes interaction fragile; `addToCollection` may not be reached.
2. **i18n incomplete in FavoritesView**
   - Hardcoded Chinese: `标签:`, `全部`, `文本 12 项`, group labels, empty states, tag editor labels, etc.
3. **PIN timeout dropdown uses native `<select>` and shows raw i18n keys**
   - Must use the same `CustomSelect`/`CustomSelectOption` components as Language/Sync interval/Max history.

## Checklist

- [x] 1. Scan FavoritesView for all hardcoded Chinese strings and missing i18n keys.
- [x] 2. Fix FavoritesView move-to-collection dropdown: keep dropdown clickable, ensure feedback toast, refresh counts, update active view.
- [x] 3. Add i18n keys for all hardcoded FavoritesView strings to `useI18n.ts` (en + zh).
- [x] 4. Replace Settings PIN `<select>` with `CustomSelect`/`CustomSelectOption`; bind model as string.
- [x] 5. Fix PIN timeout label and option display values (use proper i18n keys, not raw keys).
- [x] 6. Run `vue-tsc --noEmit` and fix any type errors.
- [ ] 7. Commit changes.
