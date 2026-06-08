"use client";

import { useCallback, useEffect, useState } from "react";

export type Bookmark = {
  id: string;
  post_id: string;
  snapshot: unknown;
  saved_at: string;
};

type UseBookmarksReturn = {
  bookmarks: Bookmark[];
  isLoading: boolean;
  isBookmarked: (postId: string) => boolean;
  toggleBookmark: (post: { id: string; snapshot?: unknown }) => Promise<void>;
};

// Module-level shared store: one fetch hydrates every consumer.
let cache: Bookmark[] = [];
let loaded = false;
let inFlight: Promise<void> | null = null;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

function setCache(next: Bookmark[]): void {
  cache = next;
  notify();
}

async function loadBookmarks(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch("/api/bookmarks", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to fetch bookmarks");
      const json = (await res.json()) as { bookmarks: Bookmark[] };
      cache = Array.isArray(json.bookmarks) ? json.bookmarks : [];
    } catch {
      // keep whatever we had
    } finally {
      loaded = true;
      inFlight = null;
      notify();
    }
  })();
  return inFlight;
}

export function useBookmarks(): UseBookmarksReturn {
  const [, forceRender] = useState(0);
  const [isLoading, setIsLoading] = useState(!loaded);

  useEffect(() => {
    const rerender = () => {
      forceRender((n) => n + 1);
      setIsLoading(!loaded);
    };
    subscribers.add(rerender);
    if (!loaded && !inFlight) void loadBookmarks();
    else setIsLoading(!loaded);
    return () => {
      subscribers.delete(rerender);
    };
  }, []);

  const isBookmarked = useCallback((postId: string) => {
    return cache.some((b) => b.post_id === postId);
  }, []);

  const toggleBookmark = useCallback(async (post: { id: string; snapshot?: unknown }) => {
    const previous = cache;
    const already = cache.some((b) => b.post_id === post.id);

    if (already) {
      setCache(cache.filter((b) => b.post_id !== post.id));
      try {
        const res = await fetch(`/api/bookmarks/${encodeURIComponent(post.id)}`, {
          method: "DELETE",
          cache: "no-store",
        });
        if (!res.ok) throw new Error("Failed to remove bookmark");
      } catch (err) {
        setCache(previous);
        throw err;
      }
      return;
    }

    const optimistic: Bookmark = {
      id: `optimistic-${post.id}`,
      post_id: post.id,
      snapshot: post.snapshot ?? null,
      saved_at: new Date().toISOString(),
    };
    setCache([optimistic, ...cache]);
    try {
      const res = await fetch("/api/bookmarks", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ post_id: post.id, snapshot: post.snapshot }),
      });
      if (!res.ok) throw new Error("Failed to save bookmark");
      await loadBookmarks();
    } catch (err) {
      setCache(previous);
      throw err;
    }
  }, []);

  return { bookmarks: cache, isLoading, isBookmarked, toggleBookmark };
}
