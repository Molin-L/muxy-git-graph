# MIT, published as "Git Graph", with mhutchie's copyright retained

`vscode-git-graph` is MIT, "Copyright (c) 2019-present, mhutchie". ADR-0001 and
ADR-0005 commit us to porting its `graph.ts` geometry closely, which is a
substantial portion, so MIT's obligation to retain the copyright notice and licence
text is live rather than optional.

The extension therefore ships MIT with a dual copyright line, vendors upstream's
licence as `licenses/vscode-git-graph-LICENSE`, and carries the credit in three
places: the first paragraph of the README, the marketplace listing description, and
a `NOTICE` file. The marketplace `author` field names this project's maintainer,
since that field identifies who maintains the listing rather than who originated the
idea.

It keeps the name **Git Graph** (`manifest.name: "git-graph"`). That is what users
will search for, and MIT permits it. The risk it carries is not legal but social —
some users will read the listing as mhutchie's own work — which the attribution
above is there to answer.

Upstream also vendors `LICENSE_MICROSOFT` and `LICENSE_OCTICONS` for borrowed code
and icons. Those bind us only if we take icons or Microsoft-derived code, which the
ADR-0001 rewrite does not.

## Consequences

- Before publishing, open an issue on `mhutchie/vscode-git-graph` to tell them. No
  permission is required, but a marketplace listing under their product's name is
  something they should hear about from us rather than from a user.
- "Git Graph for Muxy" is explicitly *not* the name — it reads as an official port.
