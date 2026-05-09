// Newsfeed scrape cycle orchestrator (DI-friendly).
//
// Freshness contract: persist freshly-merged posts to disk + DB BEFORE
// invoking the rate-limited tagger. Otherwise a cycle that scrapes one
// fresh post plus several novel-but-untagged posts in the buffer can
// stall the write past the 120s poll interval, because the tagger runs
// at ~24 req/min and serialises through every untagged post in the feed
// before persistence happens.
//
// Tags are nice-to-have. Freshness is the user-facing contract. We
// re-persist after tagging if the tagger added anything.

export async function runScrapeCycle(deps) {
  const {
    cycleStartIso,
    loadExistingPosts,
    scrapePosts,
    mergePosts,
    hydrateLocalImages,
    persistPosts,
    pushMedia,
    upsertPosts,
    hydrateTagsDual,
    recordServiceHealth,
    buildTextTagger,
    buildVisionTagger,
    onNewTags,
    paths,
  } = deps;

  const cycleStart = Date.now();

  const scraped = await scrapePosts();
  const items = scraped?.items ?? [];

  if (items.length === 0) {
    console.info(`[newsfeed] cycle empty ms=${Date.now() - cycleStart}`);
    return { changed: false, count: 0 };
  }

  const existing = await loadExistingPosts(paths.postsFile);
  const { merged, changed } = mergePosts(existing, items);
  const imagesUpdated = await hydrateLocalImages(merged);

  const persistDirs = {
    dataDir: paths.dataDir,
    archiveDir: paths.archiveDir,
    mediaDir: paths.mediaDir,
    postsFile: paths.postsFile,
  };

  let dbWrites = 0;
  let pushedToHetzner = 0;

  // Pass 1 — freshness-first persist + DB upsert. Skip only on a true
  // nochange cycle (no new posts AND no image hydration), since otherwise
  // the dashboard waits behind the tagger.
  if (changed || imagesUpdated) {
    await persistPosts(merged, persistDirs);

    // upsertPosts (DB) and pushMedia (rsync over Tailscale) are
    // independent of each other. Run them in parallel so a degraded
    // Tailscale link can't delay the DB write — routes preferring DB
    // would otherwise see stale data for up to 30s while rsync timed out.
    const upsertTask = (async () => {
      try {
        await upsertPosts(merged);
        dbWrites += 1;
        await recordServiceHealth("newsfeed-scraper", "ok", {
          startedAt: cycleStartIso,
          finishedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.warn(`[newsfeed] db dual-write non-fatal: ${err.message}`);
        try {
          await recordServiceHealth("newsfeed-scraper", "error", {
            startedAt: cycleStartIso,
            finishedAt: new Date().toISOString(),
            error: { message: err.message },
          });
        } catch (_inner) {
          /* health write best-effort */
        }
      }
    })();

    const pushTask = imagesUpdated
      ? (async () => {
          const pushResult = await pushMedia({ local: `${paths.mediaDir}/` });
          if (pushResult?.ok) {
            pushedToHetzner = pushResult.transferred ?? 0;
          } else {
            console.warn(`[newsfeed] media push non-fatal: ${pushResult?.reason ?? "unknown"}`);
          }
        })()
      : Promise.resolve();

    await Promise.all([upsertTask, pushTask]);
  }

  // Pass 2 — slow tag hydration. Runs after the dashboard has already
  // seen the fresh post.
  let tagsUpdated = false;
  let newTagsAdded = 0;
  const textTagger = buildTextTagger();
  const visionTagger = buildVisionTagger();
  if (textTagger || visionTagger) {
    try {
      tagsUpdated = await hydrateTagsDual(merged, {
        textTagger,
        visionTagger,
        onNewTags: async (tags) => {
          const additions = await onNewTags(tags);
          newTagsAdded += additions?.length ?? 0;
        },
      });
    } catch (err) {
      console.warn(`[newsfeed] tag hydration failed: ${err.message}`);
    }
  }

  // Pass 3 — re-persist if tags actually changed. Skipped when the tagger
  // ran but nothing was updated.
  if (tagsUpdated) {
    await persistPosts(merged, persistDirs);
    try {
      await upsertPosts(merged);
      dbWrites += 1;
    } catch (err) {
      console.warn(`[newsfeed] db re-write after tagging non-fatal: ${err.message}`);
    }
  }

  // Heartbeat for nochange cycles so a stale `error` row in service_health
  // doesn't latch the banner red during quiet periods.
  if (!changed && !imagesUpdated && !tagsUpdated) {
    try {
      await recordServiceHealth("newsfeed-scraper", "ok", {
        startedAt: cycleStartIso,
        finishedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.warn(`[newsfeed] heartbeat write failed: ${err.message}`);
    }
    console.info(`[newsfeed] cycle nochange N=${merged.length} ms=${Date.now() - cycleStart}`);
    return { changed: false, count: merged.length };
  }

  console.info(
    `[newsfeed] cycle ok N=${merged.length} changed=${changed} imagesUpdated=${imagesUpdated} pushedToHetzner=${pushedToHetzner} tagsUpdated=${tagsUpdated} newTags=${newTagsAdded} dbWrites=${dbWrites} ms=${Date.now() - cycleStart}`,
  );
  return { changed: true, count: merged.length };
}
