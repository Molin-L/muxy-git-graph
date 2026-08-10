/**
 * Standalone harness for the changed-files pane — `npm run dev`, then open
 * /panel/dev-file-tree.html. Muxy is not running here, so the pane is fed a
 * fixed set of changes and rendered against the real stylesheet. It is not a
 * build input; nothing here ships.
 */
import "./styles/global.css";
import type { ChangedFile } from "./data/repo.ts";
import { el } from "./view/dom.ts";
import { fileViewIcon, fileViewMode, renderFileView, setFileViewMode } from "./view/file-tree.ts";
import type { FileViewMode } from "./view/file-tree.ts";

/* A deep chain to exercise compaction, a branch point, sibling files at several
   levels, and every status letter. */
const FILES: ChangedFile[] = [
  { path: "README.md", status: "M", additions: 4, deletions: 1 },
  { path: "package.json", status: "M", additions: 2, deletions: 2 },
  { path: "src/main.ts", status: "M", additions: 1, deletions: 0 },
  { path: "src/view/file-tree.ts", status: "A", additions: 263, deletions: 0 },
  { path: "src/view/commit-details.ts", status: "M", additions: 54, deletions: 40 },
  { path: "src/view/panel.ts", status: "M", additions: 14, deletions: 1 },
  { path: "src/styles/global.css", status: "M", additions: 47, deletions: 0 },
  { path: "src/data/remote/transport/relay.ts", status: "A", additions: 88, deletions: 0 },
  { path: "src/data/legacy.ts", status: "D", additions: 0, deletions: 120 },
  { path: "src/graph/types.ts", oldPath: "src/graph/model.ts", status: "R" },
  { path: "resources/icon.svg", status: "C" },
  { path: "tests/file-tree.test.ts", status: "?" },
  { path: "tests/conflicted.ts", status: "U" },
];

const root = document.getElementById("root");
if (root) {
  const pane = el("div", "details__files");
  const list = el("div", "details__filelist");

  const draw = (): void => {
    list.replaceChildren();
    renderFileView(list, FILES, { openDiff: (file) => console.log("openDiff", file.path) }, "dev");
  };

  const count = el("div", "details__filecount");
  count.append(
    el("span", "details__filecount-num", String(FILES.length)),
    el("span", "details__filecount-label", "files changed"),
  );

  const group = el("span", "fileview");
  const buttons = new Map<FileViewMode, HTMLElement>();
  for (const mode of ["tree", "list"] as const) {
    const button = el("button", "fileview__btn");
    button.title = mode === "tree" ? "File Tree View" : "File List View";
    button.classList.toggle("fileview__btn--on", fileViewMode() === mode);
    button.appendChild(fileViewIcon(mode));
    button.addEventListener("click", () => {
      setFileViewMode(mode);
      for (const [each, other] of buttons) other.classList.toggle("fileview__btn--on", each === mode);
      draw();
    });
    buttons.set(mode, button);
    group.appendChild(button);
  }
  count.appendChild(group);

  pane.append(count, list);
  root.appendChild(pane);
  draw();
}
