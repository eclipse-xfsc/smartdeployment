<!-- SPDX-License-Identifier: Apache-2.0 -->

# OCM W-Stack UI: accessibility review (WCAG 2.1 AA)

## Scope and method

**Scope.** This review covers the browser UI of the application ORCE, version 12.6.4, served at `https://<tenant>/orce/`. It is based on:

- `charts-runtime/files/ui/index.html` (16 lines)
- `charts-runtime/files/ui/index.css` (880 lines)
- `charts-runtime/files/ui/index.js` (2581 lines; Vue 3 render functions, no templates)

It does not cover the deployer node form (`ocmwstack.html`), the Node-RED editor (`/orce/editor/`), or the Argo CD and Grafana dashboards.

**Method: code review only.** The UI was **not** run for this review. The statuses mean:

- **Pass**: no problem found in the code. It still has to be confirmed by testing.
- **Partial**: some parts meet the criterion and some do not, or the result depends on runtime behaviour.
- **Fail**: the code shows a failure, or an estimate falls below the threshold.
- **Not verified**: the result can only be determined on the rendered page.

Line numbers refer to the files above on this branch.

**Still required.** Before any conformance statement:

- a manual keyboard test, and
- automated axe and Lighthouse runs (or the equivalent browser audit) in **Chrome, Firefox, Safari and Edge** on the deployed instance.

Use the [checklist](#manual-test-checklist) and record the outcome in the [results tables](#results). Step 15 of [ACCEPTANCE-TEST-CHECKLIST.md](ACCEPTANCE-TEST-CHECKLIST.md) points here.

**Contrast method.** Ratios are **estimates**. They were computed with the WCAG 2.x relative-luminance formula from the hex colours in `index.css` and `index.js`, for each foreground colour against the background declared on its container. They do not include anti-aliasing, browser zoom, user style sheets, or colours the browser adds itself. Disabled controls (`opacity: .5`, `index.css:49-52`) are exempt under 1.4.3. All text in the UI is below the large-text size (24 px, or 18.66 px bold) except some headings, so the 4.5:1 threshold applies.

## Summary of findings

| # | Finding | Criterion | Status | Evidence |
| --- | --- | --- | --- | --- |
| 1 | No `autocomplete` tokens on username, password, e-mail and name fields | 1.3.5 | Fail | `index.js:1801-1811` (shared `input()` helper sets no `autocomplete`), login `2511-2512`, password change `2500-2502`, user editor `2273-2280` |
| 2 | Text contrast below 4.5:1: active navigation item 3.68:1, brand caption 4.39:1, muted text on the page background 4.44:1, small SVG text on credential nodes 4.37:1 | 1.4.3 | Fail (estimate) | `index.css:236-239`, `204-209`, `494-496` with `4`; `index.js:1094`, `1104` |
| 3 | Input borders 1.48:1 and provenance graph edges 2.56:1 against white | 1.4.11 | Fail (estimate) | `index.css:90-100` (border `#cbd5e1`), `index.js:1081` |
| 4 | Current navigation item, menu toggle and "raw" toggle expose no state (`aria-current`, `aria-expanded`) | 4.1.2, 1.3.1 | Partial | `index.js:2525-2528`, `2465`, `1937-1938` |
| 5 | Most backend error codes have no UI text, so the raw code is shown; the login error is generic; errors are not linked to fields | 3.3.1, 3.3.3 | Partial | `index.js:2537-2546`, `2509-2511`, `1592`; 114 of 130 codes raised in `flows.json` have no locale entry |
| 6 | Dialog focus trap ignores `summary` elements; the background is not made inert; focus can be lost after deletion or when the mobile menu closes | 2.4.3, 2.1.2 | Partial | `index.js:1865-1879`, `1117-1122`, `1853-1858`, `2525-2527` |
| 7 | No skip link (landmarks exist) | 2.4.1 | Partial | `index.js:2461`, `2516-2517`, `2531` |
| 8 | List views refresh every 10 s with no pause control | 2.2.2 | Partial | `index.js:2433-2444` |
| 9 | Hard-coded English strings | 3.1.1 (context), i18n | Partial | `index.js:2523` |

## WCAG 2.1 Level A and AA criteria

| Criterion | Level | Status | Evidence (file:line) |
| --- | --- | --- | --- |
| 1.1.1 Non-text content | A | Partial | Logos have `alt="FACIS"` (`index.js:2505-2508`, `2520-2523`). The offer QR code has `alt` "Credential offer QR code" and the offer URL is shown as text (`1318-1328`). The provenance SVG has `role="img"` and `aria-label` "Provenance" only (`1057-1060`). Identity links (`1109-1115`) and the verification history table (`1960-1964`) partly replace it, but credential nodes and edge roles exist only as SVG text and `<title>`. |
| 1.2.1–1.2.3 Audio/video (prerecorded) | A | Pass | No time-based media. |
| 1.2.4 Captions (live), 1.2.5 Audio description | AA | Pass | No time-based media. |
| 1.3.1 Info and relationships | A | Partial | Labels are linked with `for`/`id` (`1801-1821`, `1986-1999`); tables use `thead`/`th scope="col"` (`1827-1835`); permission groups use `fieldset`/`legend` (`2186-2193`, `2320-2327`). Missing: required state of fields, current navigation item (`2525-2528`), row headers. |
| 1.3.2 Meaningful sequence | A | Pass | DOM order follows the visual order: header, nav, main, dialog (`2458-2577`). |
| 1.3.3 Sensory characteristics | A | Pass | No instructions that rely on shape or position were found in the locale strings (`index.js:9-943`). |
| 1.3.4 Orientation | AA | Pass | No orientation lock; responsive rules at 1100/760/640 px (`index.css:679`, `701`, `872`). |
| 1.3.5 Identify input purpose | AA | Fail | No `autocomplete` attribute anywhere in `index.js`. Affects username and password (`2511-2512`), current and new password (`2500-2502`), and user e-mail, first and last name, which are `type="text"` (`2273-2275`). |
| 1.4.1 Use of colour | A | Partial | The verification result has a text heading as well as colour (`1923-1928`). The active navigation item differs only by colour (`index.css:236-239`); the view name is repeated in the `h2` (`index.js:2533`). |
| 1.4.2 Audio control | A | Pass | No audio. |
| 1.4.3 Contrast (minimum) | AA | Fail (estimate) | See [Contrast](#contrast). Below 4.5:1: active nav 3.68:1, brand caption 4.39:1, muted text on page 4.44:1, SVG secondary text 4.37:1. |
| 1.4.4 Resize text | AA | Not verified | Font sizes are in `px` (`index.css:5`, `135-155`); browser zoom must be tested at 200 %. |
| 1.4.5 Images of text | AA | Pass | Only the logo SVG. |
| 1.4.10 Reflow | AA | Not verified | Below 760 px the navigation collapses behind a menu button (`index.css:701-719`). Tables scroll inside `.table-wrap` (`355-361`) and the graph has `min-width: 640px` (`625-629`); both are allowed 2D exceptions. Buttons use `white-space: nowrap` (`40`). Test at 320 CSS px. |
| 1.4.11 Non-text contrast | AA | Fail (estimate) | Input, select and textarea borders `#cbd5e1` on white are 1.48:1 (`index.css:93`). Graph edges `#94a3b8` are 2.56:1 (`index.js:1081`). The focus ring `#a855f7` is 3.65–3.96:1 (pass, `index.css:85-88`). The checkbox accent is 5.17:1 (pass). |
| 1.4.12 Text spacing | AA | Not verified | Needs a bookmarklet test; check fixed-height elements (`min-height` only, `index.css:37`, `99`). |
| 1.4.13 Content on hover or focus | AA | Pass | Only native SVG `<title>` tooltips (`index.js:1084`, `1106`); no custom hover content. |
| 2.1.1 Keyboard | A | Partial (to confirm in a browser) | The two `summary` elements in the detail dialog (`1117`, `1121`) are probably not reachable by Tab, because the focus trap list (`1868`) leaves out `summary`. All other controls are native `button`, `input`, `select`, `textarea`, `a`, `summary`. The only click handler is in the `button()` helper (`1792-1799`). Filters use a real `<form>` with a submit button (`1445-1475`). |
| 2.1.2 No keyboard trap | A | Partial | The dialog trap is intentional; Escape and Close leave it (`1865-1866`, `1890`). Because the trap list ignores `summary` (`1868`), Tab wraps to Close and skips the two `summary` elements after the last listed control (`1117`, `1121`); this makes them unreachable rather than trapping focus (to confirm in a browser). Native `confirm()` is used for destructive actions (`1772`, `1227`). |
| 2.1.4 Character key shortcuts | A | Pass | No single-key shortcuts. |
| 2.2.1 Timing adjustable | A | Pass | 24-hour absolute session; the 20-hour exception applies. When it expires, a 401 sends the user to the login page without warning (`1642-1646`). |
| 2.2.2 Pause, stop, hide | A | Partial | Lists poll every 10 s when visible and idle (`2433-2444`); there is no pause control. A reviewer must decide whether this counts as auto-updating content that needs a control. |
| 2.3.1 Three flashes | A | Pass | No flashing content. |
| 2.4.1 Bypass blocks | A | Partial | `header`, `nav` (with `aria-label`) and `main` landmarks exist (`2461`, `2516-2517`, `2531`), but there is no skip link before up to 11 navigation buttons. |
| 2.4.2 Page titled | A | Partial | The title is always "OCM W-Stack" (`index.html:7`); it does not change with the view or the login state. |
| 2.4.3 Focus order | A | Partial | Opening the detail dialog moves focus to its first button (`1850`); closing returns focus (`1837`, `1857`). After deleting from the dialog, the stored element may no longer exist (`1775`). On narrow screens the navigation is hidden after a choice while it still has focus (`2525-2527`). The view change does not move focus to the new heading (`1755-1770`). |
| 2.4.4 Link purpose (in context) | A | Pass | Links show the identity label or provider URL (`1111-1115`, `1212-1216`). Repeated "View", "Save" and "Block" are buttons with row context (`1489`, `1172-1179`); see recommendation R7. |
| 2.4.5 Multiple ways | AA | Partial | The navigation menu is the only way to reach views; there is a credential search (`1453`). A reviewer must decide whether the views form a "set of web pages". |
| 2.4.6 Headings and labels | AA | Pass | `h1` app name, `h2` per view and dialog, `h3`/`h4` sections (`2465`, `2533`, `1888`); visible labels for fields. |
| 2.4.7 Focus visible | AA | Pass | Global `:focus-visible` outline 3 px with offset (`index.css:85-88`); no rule removes outlines. |
| 2.5.1 Pointer gestures | A | Pass | No path or multipoint gestures. |
| 2.5.2 Pointer cancellation | A | Pass | Native click activation only. |
| 2.5.3 Label in name | A | Pass | Button names equal their visible text (`1792-1799`). The language select has `aria-label` "Language" and visible values EN/DE/FR (`2469-2480`). |
| 2.5.4 Motion actuation | A | Pass | Not used. |
| 3.1.1 Language of page | A | Pass | `<html lang="en">` (`index.html:2`); `document.documentElement.lang` is updated after the preferences load and on every language change (`index.js:2427`, `2474`). |
| 3.1.2 Language of parts | AA | Pass | No mixed-language UI text, except user data, which cannot be marked, and the hard-coded strings listed under [Language attributes and i18n](#language-attributes-and-i18n). |
| 3.2.1 On focus | A | Pass | No focus handlers. |
| 3.2.2 On input | A | Pass | Filters require submit (`1445-1475`). The language select changes only the UI language, which is a change of content, not of context (`2472-2478`). |
| 3.2.3 Consistent navigation | AA | Pass | One navigation list in a fixed order, filtered by permission (`1594-1606`, `2525`). |
| 3.2.4 Consistent identification | AA | Pass | Shared `button()`, `input()`, `select()`, `table()` helpers with locale keys. |
| 3.3.1 Error identification | A | Partial | Errors appear in a `role="alert"` banner with a heading, a message, the HTTP status and a request ID (`2537-2546`). Login shows only "The request could not be completed." (`2509-2511`). No `aria-invalid` and no link from the error to the field. |
| 3.3.2 Labels or instructions | A | Partial | All fields have visible labels, except the language select (`aria-label` only). The password rules are shown only after a failed attempt (`PASSWORD_POLICY`). Required claim fields are not marked (`1299-1300`). |
| 3.3.3 Error suggestion | AA | Partial | Some codes have helpful text (for example `PASSWORD_POLICY`, `LOGIN_RATE_LIMITED`, `CSRF_INVALID`, `index.js:286-290`). Most backend codes (for example `VALIDATION_ERROR`, `RELATIONSHIP_HOST_NOT_ALLOWED`, `UNSUPPORTED_FORMAT`) fall back to the raw code (`1592`). |
| 3.3.4 Error prevention (legal, financial, data) | AA | Pass | Revoke, delete, relationship and issuance actions ask for confirmation (`1771-1772`); the clearing request confirms the endpoint (`1227`). |
| 4.1.1 Parsing | A | Not verified | The DOM is generated by Vue. Field IDs come from label keys (`f-<label>`, `s-<label>`, `a-<label>`, `1802`, `1987`, `1815`); duplicate IDs are unlikely but must be checked with axe (`duplicate-id`). |
| 4.1.2 Name, role, value | A | Partial | Native controls supply names and roles. The dialog has `role="dialog"`, `aria-modal`, `aria-labelledby` (`1880-1884`). Missing: `aria-current` on the active navigation button (`2525-2528`), `aria-expanded`/`aria-controls` on the menu button (`2465`), and expanded state on the "raw" toggle (`1937-1938`). |
| 4.1.3 Status messages | AA | Partial | `role="status"` is used for notices, the degraded banner, the verification result and the clearing state (`2533-2537`, `2546-2549`, `1923-1925`, `1217-1225`); errors use `role="alert"`. The "Loading…" live region is inserted together with its text (`2549-2551`), and many screen readers do not announce that. Clearing job cards are `aria-live="polite"` and are re-rendered on every poll (`1240-1243`). |

## Keyboard navigation

- Every interactive element is a native control, and no `tabindex` is used, so the tab order follows the DOM: header (menu button below 760 px, language, Change password, Logout), navigation, then the main content.
- Login and password change are **not** `<form>` elements (`2496-2513`). Enter in the password field does not sign in; the user must Tab to the button. The credential filter is a form, so Enter submits there (`1445-1475`).
- Wide tables and the provenance graph are in scroll containers (`index.css:355-361`, `618-629`) without `tabindex`. Some browsers do not let keyboard users scroll them (axe rule `scrollable-region-focusable`). Test with the keyboard at narrow widths.
- Native `confirm()` is used for destructive actions; its keyboard behaviour depends on the browser.

## Focus management

- **Focus indicator**: `:focus-visible { outline: 3px solid #a855f7; outline-offset: 3px }` (`index.css:85-88`). Its contrast is 3.96:1 on white and 3.65–3.69:1 on the page and navigation backgrounds, which passes the 3:1 non-text threshold.
- **Dialog open**: the element that had focus is stored (`index.js:1837`), and focus moves to the first button of the dialog, Close, in a microtask after loading (`1850`). Whether this runs after the dialog has rendered must be checked at runtime.
- **Dialog close**: focus returns to the stored element (`1857`). After **Delete** (`1775`) or **Replacement** (`1950-1952`), the stored "View" button may have been re-rendered or removed, so focus can fall to `body`.
- **View change**: focus is not moved to the new `h2` (`1755-1770`). On narrow screens, choosing a view hides the navigation while its button has focus (`2525-2527`).
- **Login, logout, password change**: these reload the page (`983`, `998`, `1006`), so focus starts at the top.

## Dialogs

| Aspect | Status | Evidence |
| --- | --- | --- |
| Role and name | Pass | `section role="dialog" aria-modal="true" aria-labelledby="detail-title"`; the `h2` has `id="detail-title"` (`index.js:1880-1889`) |
| Escape closes | Pass (when focus is inside) | `keydown` handler on the overlay (`1865-1866`) |
| Focus trap | Partial | Tab and Shift+Tab wrap between the first and last of `button,input,textarea,select,a[href]` (`1867-1878`). `summary` elements (`1117`, `1121`) are not in the list. |
| Background | Partial | Main content is not set `inert` or `aria-hidden`. Only `aria-modal` limits screen-reader access to the background. |
| Overlay click | n/a | Clicking outside does not close the dialog, which is acceptable. |
| Other dialogs | Pass | Confirmations use native `window.confirm()` (`1772`, `1227`). |

## Labels

- `input()`, `area()` and `select()` render a visible `<label for>` that matches the control `id` (`index.js:1801-1821`, `1986-1999`). Checkboxes are wrapped in their `<label>` (`2051-2054`, `2188-2193`, `2275-2278`, `2321-2327`).
- The language `select` has no visible label and uses `aria-label` (`2469-2471`).
- The registry editor section has `aria-label` "Credential type editor" (`2033-2036`).
- Claim fields of the issuance form use the claim key as the label text, without translation (`1299-1300`).
- Help texts, such as the temporary password help (`2280-2282`), are not linked with `aria-describedby`.
- Buttons inside table rows all have the same name: "View" in the credential list (`1489`); "View", "Save", "Block", "Unblock", "Remove" in relationships (`1172-1179`); "Manage access", "Edit" in users (`2302-2307`).

## Contrast

Estimated ratios, see [method](#scope-and-method). Normal text needs 4.5:1; non-text elements need 3:1.

| Element | Foreground / background | Ratio | Result | Evidence |
| --- | --- | ---: | --- | --- |
| Body text on page / card | `#111827` / `#f5f7fb`, `#ffffff` | 16.54 / 17.74 | Pass | `index.css:3-4`, `282` |
| Secondary button text | `#334155` / `#ffffff` | 10.35 | Pass | `31-33` |
| Primary button | `#ffffff` / `#2563eb` | 5.17 | Pass | `54-59` |
| Danger button | `#b91c1c` / `#ffffff` | 6.47 | Pass | `66-70` |
| Link on card / page | `#1d4ed8` / `#ffffff`, `#f5f7fb` | 6.70 / 6.25 | Pass | `76-79` |
| Field label, legend | `#475569` / `#ffffff` | 7.58 | Pass | `121-126`, `547-550` |
| Navigation item | `#4b5563` / `#f3f6fb` | 6.98 | Pass | `220-228`, `181-185` |
| **Navigation item, active** | `#ffffff` / `#3b82f6` | **3.68** | **Fail** | `236-239` |
| **Brand caption (10 px)** | `#64748b` / `#f3f6fb` | **4.39** | **Fail** | `204-209` |
| Muted text on card | `#64748b` / `#ffffff` | 4.76 | Pass | `494-496` |
| **Muted text on page background** (for example status help above the table) | `#64748b` / `#f5f7fb` | **4.44** | **Fail** | `494-496`, `4`; `index.js:1476-1478` |
| Header subtitle (12 px) | `#64748b` / `#ffffff` | 4.76 | Pass | `171-173` |
| Table header (12 px) | `#64748b` / `#f8fafc` | 4.55 | Pass (marginal) | `373-380` |
| Row ID (11 px) | `#64748b` / `#ffffff` | 4.76 | Pass | `398-404` |
| Status pill (11 px, bold) | `#475569` / `#f1f5f9` | 6.92 | Pass | `415-424` |
| Stat label | `#6b7280` / `#ffffff` | 4.83 | Pass | `319-322` |
| Info / error banner | `#1e40af` / `#eff6ff`; `#9f1239` / `#fff1f2` | 8.01 / 7.30 | Pass | `470-489` |
| Verification valid / invalid / indeterminate | `#166534` / `#f0fdf4`; `#9f1239` / `#fff1f2`; `#92400e` / `#fffbeb` | 6.81 / 7.30 / 6.84 | Pass | `801-818` |
| **Graph secondary text (11 px) on credential node** | `#64748b` / `#eff6ff` | **4.37** | **Fail** | `index.js:1094`, `1104` |
| Focus ring | `#a855f7` / `#ffffff`, `#f5f7fb`, `#f3f6fb` | 3.96 / 3.69 / 3.65 | Pass (3:1) | `index.css:85-88` |
| **Input / select / textarea border** | `#cbd5e1` / `#ffffff` | **1.48** | **Fail (1.4.11)** | `90-100` |
| Secondary button border | `#d1d5db` / `#ffffff` | 1.47 | Not required (the text label identifies the button) | `31` |
| **Graph edge** | `#94a3b8` / `#ffffff` | **2.56** | **Fail (1.4.11)** | `index.js:1081` |
| Root node border / checkbox accent | `#2563eb` / `#ffffff` | 5.17 | Pass | `index.js:1095`, `index.css:111` |

## Reduced motion

`@media (prefers-reduced-motion: reduce)` turns off transitions and smooth scrolling (`index.css:786-791`). The style sheet defines no transitions or animations, and `index.js` uses no animation APIs, so the UI has no motion to reduce. **Pass.** The 10-second data refresh is a content update, not motion; see 2.2.2.

## Language attributes and i18n

- Three locales, `en`, `de` and `fr`, each with **309 keys** and the same key set (`index.js:9-943`).
- The language is chosen in the header, saved to the user's preferences (`2472-2478`) and restored after login (`2425-2427`).
- `lang` on `<html>` is updated on both occasions (`2427`, `2474`). Before login, the page starts in English (`index.html:2`; default `locale: 'en'` at `1520`).
- Dates use `toLocaleString(s.locale)` (`1972`, `2558`) and `toLocaleDateString` (`1489`).
- The lookup `t(k)` falls back to the key itself (`1592`). As a result:
  - 114 of the 130 error codes raised in `flows.json` are shown as raw codes in all languages;
  - claim names from credential types appear untranslated.
- Hard-coded English or fixed strings:
  - `"Organizational Credential Manager"` (`2523`);
  - the `"HTTP "` prefixes in error lines (`2542-2543`, `1249`);
  - server-provided text such as provider names, protocol, trust scope and graph labels (`1212-1216`, `1101`).
- The language option labels are the abbreviations `EN`, `DE`, `FR` (`2479-2481`); consider the full language names, each marked with its own `lang`.

## Error messages

- **Global errors**: a `div.banner.error` with `role="alert"` (`2537-2546`). It shows a heading ("You do not have permission…" for `PERMISSION_DENIED`, a last-administrator message for `LAST_ROLE_MANAGER`, otherwise "The request could not be completed."), then the translated or raw code, the HTTP status, the upstream service and status, and the request ID.
- **Login**: only the generic message, with `role="alert"` (`2509-2511`). The rate-limit text exists (`LOGIN_RATE_LIMITED`, `index.js:290`) but is not shown on the login page.
- **Password change**: shows the translated code, for example the password policy, with `role="alert"` (`2498-2500`).
- **Verification failures**: shown in the result card with `role="alert"` and code and request ID (`1931-1936`).
- **Clearing job errors**: shown with `role="status"` (`1247-1249`).
- There is no client-side validation, no `aria-invalid`, and no focus move to the first field with an error.

## Tables

- The shared `table()` helper (`index.js:1827-1835`) renders `table > thead > tr > th[scope=col]` and `tbody`. The empty-state text appears after the table, not inside it.
- There is no `<caption>`. Tables are introduced by the view `h2` or a section `h3`; for example, the verification history table follows an `h3` (`1962`). Consider `aria-labelledby` or a caption.
- The first column, the type or user, is a `td`; a `th scope="row"` would give row context to the repeated action buttons.
- Sorting is chosen with separate `select` controls (`1453-1469`); column headers are not interactive, so `aria-sort` is not needed.
- Tables scroll horizontally inside `.table-wrap` (`index.css:355-361`); see the keyboard note above.

## Recommendations (for the development backlog)

| ID | Change | Criteria |
| --- | --- | --- |
| R1 | Add `autocomplete="username"`, `current-password`, `new-password`, `email`, `given-name`, `family-name`, and `type="email"`; wrap login and password change in `<form>` | 1.3.5, usability |
| R2 | Darken the active navigation background (for example `#2563eb`, 5.17:1 with white), the muted and caption grey on tinted backgrounds (for example `#475569`), and the graph secondary text; add a non-colour indicator to the active item | 1.4.3, 1.4.1 |
| R3 | Use a field border of at least 3:1 (for example `#64748b`, 4.76:1) and darker graph edges | 1.4.11 |
| R4 | `aria-current="page"` on the active navigation button; `aria-expanded` and `aria-controls` on the menu and "raw" toggles | 4.1.2 |
| R5 | Add locale texts for all backend error codes; on login, show the rate-limit and authentication messages; link field errors with `aria-invalid` and `aria-describedby` | 3.3.1, 3.3.3 |
| R6 | Include `summary` and `[tabindex]` in the focus-trap selector; set `inert` on the background while the dialog is open; after delete or close, move focus to the view heading when the original element no longer exists | 2.4.3, 2.1.2 |
| R7 | Give repeated row buttons names with context, for example `aria-label="View <type>"`, or use row headers | 2.4.6 (advisory) |
| R8 | Add a skip link to `main`; set `document.title` per view | 2.4.1, 2.4.2 |
| R9 | Keep a persistent live region for loading and status messages; offer a pause for automatic refresh | 4.1.3, 2.2.2 |
| R10 | Translate or remove the hard-coded strings; take the version from the runtime | i18n |

## Manual test checklist

Run on the deployed instance, for example `https://ocm-osc.facis.cloud/orce/` and `https://ocm-ionos.facis.cloud/orce/`. Use a test account, never production credentials. Do not paste passwords into evidence.

1. **Keyboard only** (no mouse), at 100 % and 200 % zoom:
   1. Login page: Tab order, visible focus, sign in with the keyboard.
   2. First-login password change.
   3. Each navigation view: reach every control; Enter/Space activate buttons; the filter form submits with Enter.
   4. Credential list: open a detail with **View**. Focus must go into the dialog; Tab and Shift+Tab must stay inside, including `details` summaries; Escape must close it; focus must return to **View**.
   5. In the dialog: Verify, Raw, Download; Revoke and Delete with the native confirmation (keyboard OK/Cancel).
   6. Narrow window (≤ 760 px): menu button, choose a view, check where focus goes.
   7. Language switch EN → DE → FR: check `<html lang>` in DevTools; check for untranslated strings.
2. **Screen reader spot check**: NVDA with Firefox or Chrome on Windows; VoiceOver with Safari on macOS.
   - Landmarks, headings, the dialog announcement, error banner announcement, the "Loading…" announcement, and table header association.
3. **Reflow**: 320 CSS px width (1280 px at 400 % zoom). Check that there is no horizontal scrolling except for tables and the graph.
4. **Text spacing**: apply line height 1.5, paragraph spacing 2, letter spacing 0.12, word spacing 0.16. Check that no text is clipped.
5. **Reduced motion**: enable the operating-system setting and confirm there is no motion.
6. **Contrast**: confirm the estimates of this report with a colour picker on the rendered page, including hover and focus states.
7. **Automated runs**: on login, credential list, credential detail dialog, receive, issue, relationships, clearing, users/roles, audit and health:
   - axe DevTools in Chrome, Firefox and Edge;
   - Lighthouse (Accessibility category) in Chrome and Edge;
   - Safari: Web Inspector *Audit* → *Accessibility*, or axe-core injected from the console.
   - Save the reports as evidence.

## Results

Fill in during testing: P = pass, F = fail with issue ID, n/a. Store the reports with the acceptance evidence (see [ACCEPTANCE-TEST-CHECKLIST.md](ACCEPTANCE-TEST-CHECKLIST.md)).

**Manual checks**

| Check | Chrome | Firefox | Safari | Edge | Notes / issue |
| --- | --- | --- | --- | --- | --- |
| 1.1 Login by keyboard |  |  |  |  |  |
| 1.2 Password change |  |  |  |  |  |
| 1.3 All views reachable and operable |  |  |  |  |  |
| 1.4 Detail dialog: focus in, trap, Escape, focus return |  |  |  |  |  |
| 1.5 Dialog actions and native confirmation |  |  |  |  |  |
| 1.6 Narrow-screen menu |  |  |  |  |  |
| 1.7 Language switch and `lang` |  |  |  |  |  |
| 2 Screen reader spot check |  |  |  |  |  |
| 3 Reflow at 320 px |  |  |  |  |  |
| 4 Text spacing |  |  |  |  |  |
| 5 Reduced motion |  |  |  |  |  |
| 6 Contrast confirmed |  |  |  |  |  |

**Automated runs**

| Page / view | axe Chrome (violations) | axe Firefox | axe Edge | Lighthouse Chrome (score) | Lighthouse Edge | Safari audit |
| --- | --- | --- | --- | --- | --- | --- |
| Login |  |  |  |  |  |  |
| Credential list |  |  |  |  |  |  |
| Credential detail dialog |  |  |  |  |  |  |
| Receive |  |  |  |  |  |  |
| Issue |  |  |  |  |  |  |
| Relationships |  |  |  |  |  |  |
| Clearing |  |  |  |  |  |  |
| Users / roles |  |  |  |  |  |  |
| Audit |  |  |  |  |  |  |
| Health |  |  |  |  |  |  |

| Field | OSC | IONOS |
| --- | --- | --- |
| Instance URL |  |  |
| Release commit / module version |  |  |
| Browser versions |  |  |
| Tester and date |  |  |
| Evidence location |  |  |

Reviewer sign-off: ____________________ Date: __________
