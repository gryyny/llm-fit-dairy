import { useEffect, useState } from "react";

export type Route =
  | { name: "today" }
  | { name: "day"; date: string }
  | { name: "history" | "foods" | "body" | "settings" }
  | { name: "connect" | "join" | "privacy" | "terms" | "support" | "notFound" };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** WB-1: the website's paths; anything else is not found. */
export function parseRoute(path: string): Route {
  const publicPage = /^\/uk\/(privacy|terms|support)$/.exec(path)?.[1];
  if (publicPage) return { name: publicPage as "privacy" | "terms" | "support" };
  const day = /^\/day\/([^/]+)$/.exec(path)?.[1];
  if (day !== undefined) {
    return ISO_DATE.test(day) && !Number.isNaN(Date.parse(day))
      ? { name: "day", date: day }
      : { name: "notFound" };
  }
  switch (path) {
    case "/":
      return { name: "today" };
    case "/history":
    case "/foods":
    case "/body":
    case "/settings":
    case "/connect":
    case "/join":
    case "/privacy":
    case "/terms":
    case "/support":
      return { name: path.slice(1) as "history" };
    default:
      return { name: "notFound" };
  }
}

const CHANGE = "app:navigate";

export function navigate(path: string): void {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(CHANGE));
  window.scrollTo(0, 0);
}

/** The current route, following links inside the app and the browser's back and forward buttons. */
export function useRoute(): Route {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => {
      setPath(window.location.pathname);
    };
    window.addEventListener("popstate", update);
    window.addEventListener(CHANGE, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(CHANGE, update);
    };
  }, []);
  return parseRoute(path);
}
