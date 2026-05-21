import path from "path";
import fs from "fs-extra";
import https from "node:https";
import axios from "axios";

const BASE_URL = new URL("https://themarketear.com");

// Single source of truth for the public media host. Posts written to disk,
// to Turso, and rendered by the dashboard ALL carry absolute URLs rooted
// here. The Hetzner peer has no /media/<file> static route — only Caddy at
// media.radon.run serves these — so a relative path produces a 400 from
// Next.js's image optimiser on app.radon.run.
export const MEDIA_ORIGIN = "https://media.radon.run";

// Idempotent rewrite: filenames, relative `/media/<f>`, and already-absolute
// `https://media.radon.run/<f>` all collapse to a single absolute form.
// Foreign absolute URLs (e.g. third-party CDN images we haven't downloaded
// yet) pass through unchanged so the contract stays additive.
export function absolutizeMediaUrl(src) {
  if (typeof src !== "string" || src.length === 0) return src;
  if (src.startsWith(`${MEDIA_ORIGIN}/`)) return src;
  if (src.startsWith("/media/")) return `${MEDIA_ORIGIN}/${src.slice("/media/".length)}`;
  if (src.startsWith("https://") || src.startsWith("http://")) return src;
  return src;
}

// Force IPv4 — themarketear.com's CDN advertises AAAA but those routes are
// frequently unreachable from residential IPv6, causing EHOSTUNREACH timeouts
// while curl-style IPv4 succeeds.
const ipv4Agent = new https.Agent({ family: 4, keepAlive: true });

const defaultClient = axios.create({
  timeout: 20000,
  responseType: "arraybuffer",
  maxRedirects: 5,
  httpsAgent: ipv4Agent,
});

function slugify(value) {
  return (
    value
      .toString()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "post"
  );
}

export function createImageDownloader({ mediaDir, client = defaultClient, getCookieHeader } = {}) {
  if (!mediaDir) throw new Error("createImageDownloader requires mediaDir");
  const cache = new Map();

  async function resolveCookieHeader() {
    if (typeof getCookieHeader !== "function") return null;
    try {
      const value = await getCookieHeader();
      return typeof value === "string" && value.length > 0 ? value : null;
    } catch (err) {
      console.warn(`[newsfeed] cookie lookup failed: ${err.message}`);
      return null;
    }
  }

  async function download(postId, urls) {
    if (!Array.isArray(urls) || urls.length === 0) return [];

    const cookieHeader = await resolveCookieHeader();
    const requestOptions = cookieHeader ? { headers: { Cookie: cookieHeader } } : undefined;

    const tasks = urls.map(async (remoteUrl, index) => {
      const absoluteUrl = new URL(remoteUrl, BASE_URL).toString();
      if (cache.has(absoluteUrl)) return cache.get(absoluteUrl);

      const urlObj = new URL(absoluteUrl);
      const rawName = path.basename(urlObj.pathname) || `${slugify(postId)}-${index}`;
      const [, maybeExt] = rawName.split(/(?=\.[^.]+$)/);
      const ext = maybeExt && maybeExt.length <= 6 ? maybeExt : ".png";
      const filename = `${slugify(postId)}-${String(index + 1).padStart(2, "0")}${ext}`;
      const destPath = path.join(mediaDir, filename);
      // Absolute URL — see MEDIA_ORIGIN above. The dashboard never gets a
      // chance to optimise `/media/<f>` because that path 404s on Hetzner.
      const publicPath = `${MEDIA_ORIGIN}/${filename}`;

      if (!(await fs.pathExists(destPath))) {
        try {
          const response = await client.get(absoluteUrl, requestOptions);
          await fs.writeFile(destPath, response.data);
        } catch (err) {
          console.warn(`[newsfeed] image download failed ${absoluteUrl}: ${err.message}`);
          return null;
        }
      }

      cache.set(absoluteUrl, publicPath);
      return publicPath;
    });

    const results = await Promise.all(tasks);
    return results.filter(Boolean);
  }

  return { download };
}

export async function hydrateLocalImages(posts, downloader) {
  let updated = false;
  for (const post of posts) {
    const rawImages = Array.isArray(post.rawImages) ? post.rawImages : [];

    // Scraped state is the source of truth. If a post previously had an
    // image but the latest scrape returns no <img>, the persisted `images`
    // array MUST drop the stale entry — never preserve it from a prior
    // cycle. The earlier short-circuit (skip when rawImages is empty) left
    // stale attributions in place forever, which is how four text-only
    // themarketear posts ended up sharing the same EMB chart on 2026-05-21.
    if (rawImages.length === 0) {
      const existing = Array.isArray(post.images) ? post.images : [];
      if (existing.length > 0) {
        post.images = [];
        updated = true;
      }
      continue;
    }

    const localImages = await downloader.download(post.id, rawImages);
    if (JSON.stringify(localImages) !== JSON.stringify(post.images || [])) {
      post.images = localImages;
      updated = true;
    }
  }
  return updated;
}
