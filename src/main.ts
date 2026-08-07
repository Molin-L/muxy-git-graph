import "./styles/global.css";
import { Panel } from "./view/panel.ts";

const root = document.getElementById("root");
if (root) void new Panel(root).start();
