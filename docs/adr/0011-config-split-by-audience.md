# Manifest settings for user preferences, `muxy.storage` for view state

Muxy offers three persistence mechanisms and the shipped extensions disagree about
which to use. Manifest `settings` supports only `string`/`bool`/`number`, is global
rather than per-project, appears as a row in Muxy's Settings sidebar, and has no
change event. `muxy.storage` takes any JSON (1 MB per value, 5 MB total, behind
`storage:read`/`storage:write`) but is per-extension only, with no per-project
scoping and no UI. `localStorage` is undocumented and per-webview.

We split by audience. Manifest `settings` holds the handful a user would go looking
for in Settings — date format, commit order, initial load count, mute rules, default
column visibility. `muxy.storage` holds everything the view owns — column widths,
branch filter, expanded state, last selected commit — namespaced by repository path,
since storage has no project scoping. Settings are read once on tab load; there is
no live update to be had.

The `database` extension's hybrid was explicitly rejected. It declares settings in
the manifest, reads them via an optional-chained `muxy.settings?.get` with a storage
fallback, duplicates every default in a `PREF_DEFAULTS` object, and — the actual bug
— writes only to storage in `setPref` while preferring settings in `getPref`, so a
value the user changes in-app can be silently overridden by the manifest value.

## Consequences

- All of it sits behind one `prefs.ts` module with typed accessors and a single
  defaults table, so which mechanism backs a given key stays an implementation
  detail and the `muxy.settings?.get` availability question is handled in one place.
- We are capped at three scalar types. Anything that grows into a list — git-graph's
  `customBranchGlobPatterns`, `customEmojiShortcodeMappings` and
  `customPullRequestProviders` are all arrays — cannot be a manifest setting and
  must move to storage with a bespoke editor. All three are Tier 4 and deferred by
  ADR-0004.
