"use client";

import { useCallback, useEffect, useState } from "react";

export type Profile = {
  username: string | null;
  avatar_url: string | null;
};

export type ProfilePatch = {
  username?: string;
  avatar_url?: string;
};

type UseProfileReturn = {
  profile: Profile | null;
  isLoading: boolean;
  saveProfile: (patch: ProfilePatch) => Promise<void>;
};

// Module-level shared store so every mounted useProfile() reflects the same
// state and a single fetch hydrates all consumers.
let cache: Profile | null = null;
let loaded = false;
let inFlight: Promise<void> | null = null;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

function setCache(next: Profile | null): void {
  cache = next;
  notify();
}

async function loadProfile(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch("/api/profile", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to fetch profile");
      const json = (await res.json()) as Profile;
      cache = { username: json.username ?? null, avatar_url: json.avatar_url ?? null };
    } catch {
      if (!cache) cache = { username: null, avatar_url: null };
    } finally {
      loaded = true;
      inFlight = null;
      notify();
    }
  })();
  return inFlight;
}

export function useProfile(): UseProfileReturn {
  const [, forceRender] = useState(0);
  const [isLoading, setIsLoading] = useState(!loaded);

  useEffect(() => {
    const rerender = () => {
      forceRender((n) => n + 1);
      setIsLoading(!loaded);
    };
    subscribers.add(rerender);
    if (!loaded && !inFlight) void loadProfile();
    else setIsLoading(!loaded);
    return () => {
      subscribers.delete(rerender);
    };
  }, []);

  const saveProfile = useCallback(async (patch: ProfilePatch) => {
    const previous = cache;
    const optimistic: Profile = {
      username: patch.username !== undefined ? patch.username : (previous?.username ?? null),
      avatar_url: patch.avatar_url !== undefined ? patch.avatar_url : (previous?.avatar_url ?? null),
    };
    setCache(optimistic);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("Failed to save profile");
      const saved = (await res.json()) as Profile;
      setCache({ username: saved.username ?? null, avatar_url: saved.avatar_url ?? null });
    } catch (err) {
      setCache(previous);
      throw err;
    }
  }, []);

  return { profile: cache, isLoading, saveProfile };
}
