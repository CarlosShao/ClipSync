# Template Variable / Snippet Placeholder Design Research

**Date:** 2026-07-18
**Scope:** How mainstream tools fill template variables — per-use manual entry vs global/persistent variables vs defaults/recent values.
**Purpose:** Inform the design of ClipSync's snippet variable system (global variable store + default values).

---

## TL;DR

- **Every tool supports per-insert manual entry** for at least some variables, usually via a popup/form/modal.
- **Only Espanso offers a true config-level persistent global variable store** (`global_vars`), reused across many snippets. TextExpander has per-field *default values* but no cross-snippet persistent store; VS Code/Alfred/Raycast/Notion/Obsidian variables are mostly context-derived or per-insert.
- **The dominant UX pattern is "default value pre-fill + user override"** (TextExpander default, VS Code `${1:default}`, Espanso form `default:`, Obsidian `{{prompt:name:default}}`, Templater `tp.system.prompt(..., default_value)`). This is the sweet spot between friction and flexibility.
- **"Remember last value" (prefill from previous input)** is rare in first-party tools; it is the missing hybrid feature worth adding.
- **Vocabulary is inconsistent**: fill-ins, placeholders, dynamic placeholders, form fields, choice placeholders, global variables, snippet variables, template variables, user prompts.

---

## 1. TextExpander — "Fill-ins"

**Model:** Per-expansion interactive prompt. Five fill-in types: Single Line Field, Multi-Line Field, Date Picker, Popup Menu, Optional Section.

- **Default values:** Yes — each field supports a `Default Value` ("text which will always appear there instead"). Text and popup fill-ins support defaults. [Source: https://textexpander.com/learn/using/snippets/advanced-snippet-elements/advanced-fill-ins — accessed 2026-07-18]
- **Same-name linking:** Fields with the same `Field Name` are treated as one — fill one, all sync within that expansion. This is *intra-snippet* linking, **not** a cross-snippet persistent store. [Same source]
- **Syntax (advanced/macro):** `%filltext:name=quantity:default=1:width=4%`, `%fillpopup:name=ship:today:default=tomorrow:next week%`, `%fillarea:name=custom:default=...%`, `%fillpart:name=Payment:default=yes%...%fillpartend%`. [Same source]
- **Persistent global variables:** **No** first-party global variable store. Preferences are app-level (expansion delimiters, case, etc.), not a snippet-variable store. [Source: https://textexpander.com/help/desktop/preferences.html — accessed 2026-07-18] Dynamic content comes from Date/Time/Math macros and nested `%snippet:...%` references, not user-defined persistent globals.
- **UX note:** All fields optional; "works even if you don't change any of the defaults." [advanced-fill-ins source]

---

## 2. Raycast Snippets — "Dynamic Placeholders"

**Model:** Curly-brace `{}` placeholders, resolved automatically at insert. Mostly *system/dynamic* values, not user-filled text.

- **Supported placeholders:** `{clipboard}`, `{cursor}`, `{date}`, `{time}`, `{datetime}`, `{day}`, `{uuid}`, `{selection}`, `{argument}` (prompts in search bar, max 3), `{snippet name="..."}`, `{browser-tab}`. [Source: https://manual.raycast.com/v1/dynamic-placeholders — accessed 2026-07-18]
- **Default values for user text:** **No** editable per-field default. Placeholders are dynamic/system-derived. `{argument}` is the only user-prompt-style placeholder (search-bar input, not a form field). [Same source]
- **Modifiers / transforms:** `uppercase`, `lowercase`, `trim`, `percent-encode`, `json-stringify`, `raw`; date/time offsets `{date offset="+2y +5M"}` and custom formats `{date format="yyyy-MM-dd"}`. [Same source]
- **Persistent global variables:** **No.** [Same source + https://manual.raycast.com/windows/snippets — accessed 2026-07-18]
- **UX note:** "When you type a valid placeholder, the curly braces turn blue." No modal friction for dynamic values; `{argument}` adds one lightweight prompt.

---

## 3. VS Code Snippets — "Placeholders & Variables"

**Model:** TextMate-style snippet grammar. Tab-stop navigation; variables resolved at insert.

- **Placeholders with defaults:** `${1:foo}` (placeholder text pre-selected, editable). [Source: https://code.visualstudio.com/docs/editor/userdefinedsnippets — accessed 2026-07-18]
- **Choice placeholders:** `${1|one,two,three|}` opens a quick-pick on insert. [Same source]
- **Variables + defaults:** `$name` or `${name:default}`; if unset, inserts default or empty. Built-ins: `TM_SELECTED_TEXT`, `TM_FILENAME`, `CLIPBOARD`, `CURRENT_YEAR`, `CURRENT_DATE`, `CURRENT_SECONDS_UNIX`, `UUID`, `WORKSPACE_NAME`, etc. [Same source]
- **Transforms:** `${TM_FILENAME/(.*)\..+$/$1/}` — regex format + options (`i`,`g`,`m`) with `/upcase`,`/downcase`,`/capitalize`. Placeholder-transforms also supported. [Same source]
- **Persistent global variables:** **No.** Variables are context-derived (editor state) or placeholder defaults; nothing user-defined that persists across snippets/runs. [Same source]
- **UX note:** Linked tabstops (`$1` used twice) update in sync — the VS Code equivalent of TextExpander's same-name linking.

---

## 4. Notion Templates — "Database Template Properties"

**Model:** Per-page-instance defaults. Templates set default *property values* and/or insert content blocks.

- **Default values:** Yes, but as **default property values per template** (e.g., Priority = P1, assigned PM = Fig). Applied once when a page is created from the template; each new page is an independent copy. [Source: https://www.notion.com/help/database-templates — accessed 2026-07-18]
- **Per-page vs global:** Templates are **per-database** ("only available in the specific database where you created them"). No workspace-wide variable store. A "default template" can be designated per database/view. [Same source; also https://developers.notion.com/docs/creating-pages-from-templates — accessed 2026-07-18]
- **Dynamic placeholders:** `@now` / `@today` resolve at duplication time (timezone-aware). [developers.notion.com source]
- **User-prompted fill-ins:** **No** native prompt-on-insert. Values are either preset defaults or filled manually after creation. Template Buttons insert blocks (can include AI blocks) but don't prompt for variables. [https://www.xray.tech/post/templates-in-notion — accessed 2026-07-18]
- **UX note:** "If you change a template, your changes won't auto-update pages where you've already applied it" — templates are recipes, not live bindings. [https://thomasjfrank.com/docs/ultimate-brain/working-with-database-templates/ — accessed 2026-07-18]

---

## 5. Espanso — "Matches, Variables, Global Variables, Forms" (Open Source, Rust, GPL-3)

**Model:** YAML config of `matches`. Variables filled by *extensions*. Supports **both** per-insert forms **and** a persistent global variable store.

- **Global variables (persistent, config-level):** `global_vars:` defined above matches, available to all matches in that file and children. Implemented via the `echo` extension (fixed value) or `shell`/`script` (computed). This is the closest first-party analog to a "global variable store."
  ```yaml
  global_vars:
    - name: myname
      type: echo
      params: { echo: "John" }
  matches:
    - trigger: ":greet"
      replace: "Hello {{myname}}"
  ```
  [Source: https://espanso.org/docs/next/matches/basics/ — accessed 2026-07-18; also DeepWiki https://deepwiki.com/espanso/website/4-matches-and-extensions — accessed 2026-07-18]
- **Local variables:** `vars:` scoped to a single match. Extensions: `date`, `choice`, `random`, `clipboard`, `echo`, `script`, `shell`, `form`. [Same sources]
- **Form extension (per-insert, interactive):** pauses expansion, shows a dialog. Field types: `text` (default), `multiline`/paragraph, `choice` (dropdown), `list` (scrollable). **Per-field `default:` supported.**
  ```yaml
  - trigger: ":note"
    form: |
      Title: [[title]]
      Content: [[content]]
    form_fields:
      content:
        multiline: true
        default: "Type your note here..."
      fruit:
        type: choice
        values: [Apple, Banana, Orange]
        default: Banana
  ```
  [Source: DeepWiki https://deepwiki.com/espanso/website/4.3.1-form-extension — accessed 2026-07-18]
- **Clipboard extension:** `type: clipboard` injects current clipboard; can be combined with forms/scripts. [DeepWiki extensions source]
- **Persistent across runs?** `global_vars` persist for the app lifetime (config file). Form values are **ephemeral per expansion** (not remembered). There is **no built-in "remember last entered value"** — a gap Espanso shares with others.
- **Open-source reference:** GitHub `espanso/espanso` (Rust). The variable/extension architecture (vars ↔ extensions, global_vars, form extension) is the best blueprint for a "global variable store + default value" feature. [https://espanso.org/ — accessed 2026-07-18]

---

## 6. Alfred Snippets — "Dynamic Placeholders"

**Model:** Curly-brace `{}` dynamic placeholders, auto-resolved. Powerpack feature.

- **Supported:** `{date}`, `{time}`, `{datetime}`, `{clipboard}` (+ `{clipboard:1}` offset into history), `{cursor}`, `{query}` (workflows), ISO variants `{isodate}` etc., with date arithmetic (`{date +1D}`) and format modifiers. [Source: https://support.alfredapp.com/kb:using-dynamic-placeholders-in-snippets — accessed 2026-07-18; https://alfredapp.com/help/features/snippets/ — accessed 2026-07-18]
- **User-filled text fields:** **No.** Placeholders are dynamic/system values. Clipboard History is a separate persistent *clipboard* store (`Persist for` setting), not a named variable store. [alfredapp.com snippets source]
- **Persistent global variables:** **No** in the snippet system. Workflows have variables, but those are per-run, not a user-managed persistent store. [Same sources]

---

## 7. Obsidian — Templater & QuickAdd (plus native `{{prompt}}`)

**Model:** Plugin-driven; native core supports a few static variables.

- **Native Obsidian:** `{{title}}`, `{{date}}`, `{{time}}`, date formats `{{date:YYYY-MM-DD}}`. **User prompt with default:** `{{prompt:variable_name:default_value}}` — pops a dialog, uses default if unchanged. [Source: https://ask.csdn.net/questions/8997513 (citing Obsidian native behavior) — accessed 2026-07-18]
- **Templater:** `tp.system.prompt(prompt_text?, default_value?)` → text modal; `tp.system.suggester(text_items, items)` → dropdown. **Default values supported per prompt.** `tp.user` for custom scripts; `tp.variables` for execution-scoped state. **No built-in cross-run persistent variable store** (would require a script reading/writing a file or frontmatter). [Source: DeepWiki https://deepwiki.com/SilentVoid13/Templater/2.2-the-tp-object-and-internal-functions — accessed 2026-07-18; https://readmedium.com/prompts-suggestion-menus-with-templater-22f8e62d28b3 — accessed 2026-07-18]
- **QuickAdd:** `{{VALUE:name}}` prompts per-insert (ephemeral); `{{VALUE:sharedName}}` reuses one prompt across a macro; `{{VDATE:name, format}}` for dates; `{{DATE:format}}` auto-inserts. Variables are **per-template/ephemeral**, not persisted. [Source: https://readmedium.com/obsidian-quickadd-automate-the-boring-stuff-934dea38ea00 — accessed 2026-07-18; QuickAdd guide https://quickadd.obsidian.guide/docs/next/Choices/MacroChoice — accessed 2026-07-18]
- **obsidian-scripts prompt helper:** config object with `prompt`, `display`, `value` (default), `multiple`, supporting default values and value references `{{ path }}`. [http://obsidian-scripts.mihaiconstantin.com/docs/prompt.html — accessed 2026-07-18]

---

## Answers to the Research Questions

### Q1. Per-use fill every time vs default/global value?

| Tool | Per-use manual entry | Default value (pre-fill) | Persistent global variable store |
|------|---------------------|--------------------------|----------------------------------|
| TextExpander | Yes (fill-ins) | Yes (per-field `Default Value`) | **No** (only intra-snippet same-name linking) |
| Raycast | `{argument}` only | No (dynamic/system placeholders) | **No** |
| VS Code | Yes (tabstop placeholders) | Yes (`${1:default}`, `${name:default}`) | **No** |
| Notion | No (manual after creation) | Yes (default property values, per template) | **No** (per-database) |
| Espanso | Yes (form extension) | Yes (form `default:`) | **Yes** (`global_vars`, config-level) |
| Alfred | No (dynamic placeholders only) | No | **No** |
| Obsidian (Templater/QuickAdd) | Yes (`tp.system.prompt`, `{{VALUE}}`) | Yes (`default_value`, `{{prompt:name:default}}`) | **No** (needs script/frontmatter) |

### Q2. How is `{{name}}` / `%name%` prompt flow handled? Pre-fill from previous input or settings?

- **Modal/popup at insert** is universal for manual entry: TextExpander fill-in window, Espanso form dialog, VS Code inline tabstop, Obsidian/Templater modal, QuickAdd modal, Raycast search-bar `{argument}`.
- **Pre-fill from a default** is common (see Q1 table).
- **Pre-fill from previous input ("remember last value")** is **not** a first-party feature in any tool surveyed. Espanso `global_vars` can be *manually edited* in config to simulate it, but no tool auto-remembers the last typed value per variable name. **This is the clearest product opportunity for ClipSync.**
- **Settings-panel variable store** exists only in Espanso (`global_vars` in config). Others either derive variables from context (VS Code, Alfred, Raycast) or set defaults inside each template (TextExpander, Notion, Obsidian).

### Q3. UX trade-offs: ephemeral per-insert vs persistent global?

**Ephemeral per-insert (forms/placeholders):**
- ✅ Always fresh; correct for one-off or frequently-changing values (names, amounts, dates).
- ✅ No stale-data risk.
- ❌ Repetitive friction for stable values (your name, email, signature, team name).
- ❌ Modal dialogs interrupt flow.

**Persistent global (Espanso `global_vars`):**
- ✅ Set-once convenience for stable values; consistent across all snippets.
- ✅ Reduces prompts dramatically.
- ❌ Can go stale; surprising when a value changed elsewhere.
- ❌ Harder to override per instance (Espanso requires editing config, not a per-expansion override).
- ❌ Not discoverable; lives in a config file, not a UI.

**Recommended hybrid (best of both):**
1. **Default value** pre-fills each prompt (TextExpander/VS Code/Espanso/Obsidian all prove this).
2. **Optional "save as default / remember last"** checkbox in the prompt UI → writes to a persistent global store.
3. **Per-insert override** always possible (global is a starting point, not a lock).
This matches Espanso's architecture (global_vars + per-match form defaults) and adds the missing "remember last" auto-sync.

### Q4. Typical vocabulary

| Term | Used by |
|------|---------|
| Fill-in / Fill-in field | TextExpander |
| Placeholder / Choice placeholder | VS Code |
| Dynamic placeholder | Raycast, Alfred |
| Variable / Global variable / Form / Extension | Espanso |
| Template variable / Default property value | Notion |
| User prompt / Suggester / `tp.system.prompt` / `{{VALUE}}` / `{{prompt:name:default}}` | Obsidian (Templater, QuickAdd, native) |
| Snippet variable | general |

Common sub-concepts: **default value**, **choice/select**, **transform/modifier**, **linked/synced fields** (same-name in TextExpander, repeated tabstop in VS Code), **cursor position** (`{cursor}`, `$|$`, `$0`).

### Q5. Open-source implementations to reference

- **Espanso** (Rust, GPL-3, `espanso/espanso`): the strongest reference for a **global variable store** (`global_vars`) + **default values** (form `default:`) + **per-insert forms**. Architecture: matches ↔ `vars` ↔ extensions; `global_vars` at file scope; Form Extension as the only UI-blocking extension. [https://espanso.org/ — accessed 2026-07-18]
- **VS Code snippet engine** (TextMate grammar, open source in `microsoft/vscode`): reference for placeholder/default/choice/transform syntax (`${1:default}`, `${1|a,b,c|}`, `${var/regex/format/options}`). [https://code.visualstudio.com/docs/editor/userdefinedsnippets — accessed 2026-07-18]
- **Obsidian Templater** (TS, `SilentVoid13/Templater`): reference for `tp.system.prompt(text, default_value)` and `tp.system.suggester` as a programmatic prompt API with defaults. [DeepWiki Templater source — accessed 2026-07-18]
- **`text-expander` (Python, PyPI, MIT)** — a small open-source TE clone; useful as a lightweight structural reference (triggers/replacements, no advanced variables). [https://pypi.org/project/text-expander/ — accessed 2026-07-18]

---

## Recommended Design for ClipSync

Based on the above:

1. **Two-tier variable model** (mirrors Espanso):
   - *Snippet-local placeholders* — prompted per insert, with an optional **default value**.
   - *Global variable store* — user-managed key/value pairs (name, email, team, signature) editable in a settings panel; any placeholder can reference a global.
2. **Prompt flow:** On insert, show a modal pre-filled with (a) the placeholder's own default, or (b) the linked global's current value. User can override; a **"remember as default"** checkbox persists the entered value back to the global store.
3. **"Remember last value"** as the auto-sync of global ↔ last input — the gap none of the surveyed tools fill first-party.
4. **Field types:** text, multiline, choice/select (dropdown), date — covering TextExpander's 5 types and Espanso's form controls.
5. **Linked fields:** same variable name → synced within one expansion (TextExpander same-name, VS Code repeated tabstop).
6. **Dynamic/system placeholders** for clipboard, date, cursor, UUID (Raycast/Alfred/VS Code parity) as non-prompted globals.
7. **Transforms/modifiers** (uppercase/lowercase/trim, date format) for output shaping (VS Code transforms, Raycast modifiers).

---

### Source list (all accessed 2026-07-18)

1. TextExpander fill-ins — https://textexpander.com/learn/using/snippets/advanced-snippet-elements/advanced-fill-ins
2. TextExpander preferences — https://textexpander.com/help/desktop/preferences.html
3. Raycast dynamic placeholders — https://manual.raycast.com/v1/dynamic-placeholders
4. Raycast Windows snippets — https://manual.raycast.com/windows/snippets
5. VS Code snippets — https://code.visualstudio.com/docs/editor/userdefinedsnippets
6. Notion database templates — https://www.notion.com/help/database-templates
7. Notion API templates — https://developers.notion.com/docs/creating-pages-from-templates
8. Espanso matches basics — https://espanso.org/docs/next/matches/basics/
9. Espanso extensions (DeepWiki) — https://deepwiki.com/espanso/website/4-matches-and-extensions
10. Espanso form extension (DeepWiki) — https://deepwiki.com/espanso/website/4.3.1-form-extension
11. Espanso homepage — https://espanso.org/
12. Alfred dynamic placeholders — https://support.alfredapp.com/kb:using-dynamic-placeholders-in-snippets
13. Alfred snippets — https://alfredapp.com/help/features/snippets/
14. Obsidian Templater tp object (DeepWiki) — https://deepwiki.com/SilentVoid13/Templater/2.2-the-tp-object-and-internal-functions
15. Templater prompts article — https://readmedium.com/prompts-suggestion-menus-with-templater-22f8e62d28b3
16. Obsidian native prompt vars — https://ask.csdn.net/questions/8997513
17. QuickAdd macros — https://quickadd.obsidian.guide/docs/next/Choices/MacroChoice
18. QuickAdd walkthrough — https://readmedium.com/obsidian-quickadd-automate-the-boring-stuff-934dea38ea00
19. Obsidian-scripts prompt helper — http://obsidian-scripts.mihaiconstantin.com/docs/prompt.html
20. text-expander (PyPI) — https://pypi.org/project/text-expander/
