# Dashboard components

Use `components.ts` for new or revised UI. Keep domain-specific content in the
view, but do not duplicate the structural HTML of these components:

- `pageHeader`: title, description and navigation.
- `panel`: shared padding, heading and body spacing.
- `field`: label, control and help text.
- `actionButton`: typed action, disabled state and visible progress feedback.
- `actionBar`: primary/secondary action layout.
- `operationStatus`: running/result text with accessible status semantics.
- `endpoint`: readable source/destination, with wrapping and no display scheme.
- `technicalDetails`: secondary IDs and diagnostic details, collapsed by default.
- `tabs`: section navigation and selected-tab semantics.
- `filePath`: compact, wrapping local path display.
- `secretEditor`: masked stored-key hint, replacement form and optional removal;
  accepts typed actions and signal paths, never the stored secret itself.

Only typed `Html`, `Url`, `Expr` and signal helpers cross component boundaries.
Never insert raw HTML or manually construct Datastar attributes. Shared styling
lives in the `ui-*` section of `app.css`. Existing views migrate incrementally;
the presence of legacy markup is not a template for new views.

Action labels describe the actual effect. Read-only preparation may start on
page entry; mutations must remain explicit. Errors must stop automatic retries.
Unknown outcomes are not failures or successes. A status refresh must visibly
start and report its result even when the underlying status is unchanged.

Contract tests cover escaping, layout structure, progress and mutation safety.
They do not replace visual inspection of desktop/mobile layouts and every
loading, empty, success, failure and uncertain state.
