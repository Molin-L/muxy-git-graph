import "./styles/global.css";
import * as log from "./log.ts";
import { Panel } from "./view/panel.ts";

log.useSurface("panel");

const root = document.getElementById("root");
if (root) void start(root);

async function start(host: HTMLElement): Promise<void> {
  // Before the panel starts: the transport ladder runs during `start()`, and its
  // debug lines are the ones worth having when a workspace misbehaves.
  await log.restoreVerbose();
  log.info("panel starting", {
    extension: globalThis.muxy?.extensionID,
    verbose: log.isVerbose(),
  });
  await new Panel(host).start();
}
