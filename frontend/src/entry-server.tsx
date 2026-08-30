import { renderToString } from "react-dom/server";
import { RootApp } from "./root-app";

export function render(url: string) {
  const requestUrl = new URL(url, "http://localhost");
  return renderToString(<RootApp pathname={requestUrl.pathname} />);
}
