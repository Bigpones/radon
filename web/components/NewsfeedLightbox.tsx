"use client";

import { useEffect } from "react";
import Image from "next/image";
import { Link as LinkIcon, X } from "lucide-react";
import type { MarketEarPost } from "@/components/DashboardNewsFeed";
import { formatAbsolute, formatRelative, formatTime } from "@/lib/newsfeedTime";

export type NewsfeedLightboxFocus = {
  post: MarketEarPost & { href: string; isoTimestamp: string };
  imageUrl: string;
};

type NewsfeedLightboxProps = {
  focus: NewsfeedLightboxFocus | null;
  onDismiss: () => void;
};

/**
 * NewsfeedLightbox — opens when a user clicks an image in the dashboard
 * news rail. Renders the image at full size on the left and the article
 * copy (title, body, tags, timestamp, source link) on the right so the
 * user can read the context without leaving the workspace. Dismissed by
 * the close button, Escape, or clicking the scrim.
 */
export default function NewsfeedLightbox({ focus, onDismiss }: NewsfeedLightboxProps) {
  useEffect(() => {
    if (!focus) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
      }
    }
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [focus, onDismiss]);

  if (!focus) return null;

  const { post, imageUrl } = focus;
  const tags = Array.isArray(post.tags) ? post.tags : [];
  const relative = formatRelative(post.isoTimestamp);
  const time = formatTime(post.isoTimestamp);
  const absolute = formatAbsolute(post.isoTimestamp);

  return (
    <div
      className="newsfeed-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={post.title}
    >
      <button
        type="button"
        className="newsfeed-lightbox__scrim"
        onClick={onDismiss}
        aria-label="Dismiss lightbox"
        data-testid="newsfeed-lightbox-scrim"
      />
      <div className="newsfeed-lightbox__panel">
        <button
          type="button"
          className="newsfeed-lightbox__close"
          onClick={onDismiss}
          aria-label="Close lightbox"
          data-testid="newsfeed-lightbox-close"
        >
          <X size={16} />
        </button>

        <div className="newsfeed-lightbox__media">
          <Image
            src={imageUrl}
            alt={post.title}
            width={1600}
            height={900}
            sizes="(max-width: 900px) 100vw, 60vw"
            className="newsfeed-lightbox__image"
            priority
          />
        </div>

        <article className="newsfeed-lightbox__copy">
          <header className="newsfeed-lightbox__head">
            <p className="newsfeed-lightbox__kicker">
              Live Market Analysis · {relative}
              {time ? ` at ${time}` : ""}
            </p>
            <h2 className="newsfeed-lightbox__title">{post.title}</h2>
          </header>

          {post.content ? (
            <p className="newsfeed-lightbox__body">{post.content}</p>
          ) : null}

          {tags.length > 0 ? (
            <div className="newsfeed-lightbox__tags">
              {tags.map((tag) => (
                <span key={tag} className="newsfeed-lightbox__tag">
                  {tag}
                </span>
              ))}
            </div>
          ) : null}

          <footer className="newsfeed-lightbox__footer">
            <a
              className="newsfeed-lightbox__source"
              href={post.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              <LinkIcon size={12} />
              <span>Open original</span>
            </a>
            <span className="newsfeed-lightbox__timestamp" title={absolute}>
              {absolute}
            </span>
          </footer>
        </article>
      </div>
    </div>
  );
}
