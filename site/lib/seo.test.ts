import { describe, expect, it } from "vitest";
import manifest from "../app/manifest";
import robots from "../app/robots";
import sitemap from "../app/sitemap";
import {
  DEFAULT_SITE_URL,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TITLE,
  siteMetadata,
  siteStructuredData,
  siteUrl,
  siteViewport,
} from "./seo";

describe("site SEO contract", () => {
  it("publishes canonical and social metadata", () => {
    expect(siteUrl).toBe(DEFAULT_SITE_URL);
    expect(siteMetadata.title).toBe(SITE_TITLE);
    expect(siteMetadata.description).toBe(SITE_DESCRIPTION);
    expect(siteMetadata.alternates?.canonical).toBe("/");
    expect(siteMetadata.openGraph).toMatchObject({
      type: "website",
      url: "/",
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
      siteName: SITE_NAME,
    });
    expect(siteMetadata.twitter).toMatchObject({
      card: "summary_large_image",
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
    });
    expect(siteViewport.themeColor).toBe("#0a0f14");
  });

  it("publishes structured data for website, organization, and software", () => {
    const types = siteStructuredData.map((item) => item["@type"]);
    expect(types).toEqual(["WebSite", "Organization", "SoftwareApplication"]);
    expect(siteStructuredData[0]).toMatchObject({
      "@context": "https://schema.org",
      "@type": "WebSite",
      url: siteUrl,
    });
  });

  it("publishes crawl routes and manifest metadata", () => {
    expect(robots()).toEqual({
      rules: {
        userAgent: "*",
        allow: "/",
      },
      sitemap: `${siteUrl}/sitemap.xml`,
      host: siteUrl,
    });

    const routes = sitemap();
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      url: siteUrl,
      changeFrequency: "weekly",
      priority: 1,
    });
    // lastModified is stamped at build time (new Date()), not a frozen literal.
    expect(routes[0].lastModified).toBeInstanceOf(Date);
    expect(Number.isNaN(new Date(routes[0].lastModified!).getTime())).toBe(false);

    expect(manifest()).toMatchObject({
      name: SITE_NAME,
      short_name: "Radon",
      description: SITE_DESCRIPTION,
      start_url: "/",
      display: "standalone",
    });
  });
});
