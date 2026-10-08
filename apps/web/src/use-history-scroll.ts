import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** Follow appended history until the reader scrolls back. Opening a view snaps to its latest entry. */
export function useHistoryScroll(contentVersion: unknown, ready = true) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [atLatest, setAtLatest] = useState(true);
  const scrollToLatest = useCallback(() => {
    const pane = viewport.current;
    if (!pane) return;
    following.current = true;
    pane.scrollTop = pane.scrollHeight;
    setAtLatest(true);
  }, []);
  const onScroll = useCallback(() => {
    const pane = viewport.current;
    if (!pane) return;
    const latest = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
    following.current = latest;
    setAtLatest(latest);
  }, []);

  useLayoutEffect(() => {
    if (!ready) return;
    if (following.current) scrollToLatest();
    const pane = viewport.current;
    const contents = content.current;
    if (!pane || !contents) return;
    const observer = new ResizeObserver(() => {
      if (following.current) scrollToLatest();
    });
    observer.observe(pane);
    observer.observe(contents);
    return () => observer.disconnect();
  }, [contentVersion, ready, scrollToLatest]);

  return { viewport, content, onScroll, atLatest, scrollToLatest };
}
