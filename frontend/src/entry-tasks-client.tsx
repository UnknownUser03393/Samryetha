import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { TasksStandalone } from "./tasks-standalone";

hydrateRoot(
  document.getElementById("root")!,
  <StrictMode>
    <TasksStandalone />
  </StrictMode>,
);
