import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { DiscussionApp, type View } from "./discussion-app";
import { PostPage } from "./post-page";
import { ProfilePage } from "./profile-page";
import { SettingsPage } from "./settings-page";
import { LoginPage, type AuthMode } from "./login-page";
import { ThreadPage } from "./thread-page";
import { AdminPage } from "./admin-page";
import { FeedbackPage } from "./feedback-page";
import { AuthProvider } from "./lib/auth";

type TransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> };
};

type TransitionStyle = "thread-enter" | "thread-return";

function runTransition(update: () => void, style?: TransitionStyle) {
  const transitionDocument = document as TransitionDocument;
  if (!transitionDocument.startViewTransition) {
    update();
    return;
  }

  if (style) document.documentElement.dataset.transition = style;
  const transition = transitionDocument.startViewTransition(update);
  if (style) {
    void transition.finished.finally(() => {
      delete document.documentElement.dataset.transition;
    });
  }
}

const DETAIL_PATTERN = /^\/d\/(\d+)$/;

function RootAppInner({ pathname }: { pathname: string }) {
  const [activePath, setActivePath] = useState(pathname);
  const [discussionView, setDiscussionView] = useState<View>("latest");
  const [transitionTitle, setTransitionTitle] = useState<{ id: number; title: string } | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const changePage = (
      nextPath: string,
      nextUrl?: string,
      nextView?: View,
      style?: TransitionStyle,
      sharedTitle?: { id: number; title: string } | null,
    ) => {
      const update = () => {
        flushSync(() => {
          if (nextView) setDiscussionView(nextView);
          setTransitionTitle(sharedTitle ?? null);
          setActivePath(nextPath);
        });
        if (nextUrl) window.history.pushState({}, "", nextUrl);
        window.scrollTo({ top: 0 });
      };

      const authPaths = ["/login", "/register"];
      if (authPaths.includes(activePath) && authPaths.includes(nextPath)) update();
      else runTransition(update, style);
    };

    const navigate = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target || anchor.hasAttribute("download")) return;

      const destination = new URL(anchor.href, window.location.href);
      const requestedView = anchor.dataset.view;
      const nextView: View | undefined = requestedView === "latest" || requestedView === "followed" || requestedView === "boards" ? requestedView : undefined;
      if (destination.origin !== window.location.origin) return;
      // 同路径无视图意图（如点 wordmark 回首页）直接跳过；带 data-view 放行
      // （移动端汉堡菜单在首页切 Latest/Followed/Boards 就是这个场景）。
      if (destination.pathname === activePath && !nextView) return;
      const isDetail = DETAIL_PATTERN.test(destination.pathname);
      const isApp = destination.pathname === "/" || destination.pathname === "/post" || destination.pathname === "/profile" || destination.pathname === "/settings" || destination.pathname === "/admin" || destination.pathname === "/feedback";
      if (!isDetail && !isApp && !["/login", "/register"].includes(destination.pathname)) return;
      event.preventDefault();
      // 保留 search（如 /?board=study），供 DiscussionApp 挂载时读板块初始化筛选。
      const currentIsDetail = DETAIL_PATTERN.test(activePath);
      const style = isDetail && !currentIsDetail
        ? "thread-enter"
        : currentIsDetail && destination.pathname === "/"
          ? "thread-return"
          : undefined;
      const detailId = isDetail ? Number(destination.pathname.match(DETAIL_PATTERN)?.[1]) : null;
      const sourceTitle = isDetail ? anchor.querySelector<HTMLElement>(".thread-title") : null;
      const sharedTitle = detailId && sourceTitle?.textContent
        ? { id: detailId, title: sourceTitle.textContent }
        : null;
      if (sharedTitle) sourceTitle!.style.viewTransitionName = "thread-title";
      changePage(destination.pathname, destination.pathname + destination.search, nextView, style, sharedTitle);
    };

    const restoreHistory = () => changePage(window.location.pathname);

    document.addEventListener("click", navigate);
    window.addEventListener("popstate", restoreHistory);
    return () => {
      document.removeEventListener("click", navigate);
      window.removeEventListener("popstate", restoreHistory);
    };
  }, [activePath]);

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
  }, []);

  const goToThread = (id: number) => {
    const path = `/d/${id}`;
    runTransition(() => {
      flushSync(() => setActivePath(path));
      window.history.pushState({}, "", path);
      window.scrollTo({ top: 0 });
    });
  };

  const signIn = () => {
    runTransition(() => {
      flushSync(() => setActivePath("/"));
      window.history.pushState({}, "", "/");
      window.scrollTo({ top: 0 });
    });
  };

  const showToast = () => {
    setToastVisible(true);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastVisible(false), 2000);
  };

  const authModes: Partial<Record<string, AuthMode>> = { "/login": "login", "/register": "register" };
  const authMode = authModes[activePath];
  if (authMode) return <LoginPage mode={authMode} onSignedIn={signIn} />;
  const detailMatch = activePath.match(DETAIL_PATTERN);
  if (detailMatch) {
    const id = Number(detailMatch[1]);
    return <ThreadPage id={id} initialTitle={transitionTitle?.id === id ? transitionTitle.title : undefined} />;
  }
  if (activePath === "/post") return <PostPage onPublished={(id) => { goToThread(id); showToast(); }} />;
  if (activePath === "/profile") return <ProfilePage />;
  if (activePath === "/settings") return <SettingsPage />;
  if (activePath === "/admin") return <AdminPage />;
  if (activePath === "/feedback") return <FeedbackPage />;
  return (
    <>
      <DiscussionApp initialView={discussionView} onViewChange={setDiscussionView} />
      {toastVisible && <div className="publish-toast" role="status" aria-live="polite">Published</div>}
    </>
  );
}

export function RootApp({ pathname }: { pathname: string }) {
  return (
    <AuthProvider>
      <RootAppInner pathname={pathname} />
    </AuthProvider>
  );
}
