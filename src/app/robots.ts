import type { MetadataRoute } from "next";

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://cthalaal.co.za").replace(/\/$/, "");

const PRIVATE_PATHS = ["/admin", "/admin/", "/exhibitor", "/exhibitor/", "/api", "/api/"];

// Crawlers that surface the festival to a human somewhere downstream: AI
// search assistants and their fetchers. We keep these. Someone asking an
// assistant for halaal events in Cape Town should find us. They get a
// crawl delay instead of a ban, because the uncapped default is what let
// one crawler move 4GB in four hours on 2026-06-25.
const DISCOVERY_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
];

// Bulk scrapers and SEO/backlink miners. These send no visitors and cite
// nothing, so the bandwidth buys us zero. Full disallow.
const EXTRACTIVE_CRAWLERS = [
  "CCBot",
  "Bytespider",
  "DataForSeoBot",
  "AhrefsBot",
  "SemrushBot",
  "MJ12bot",
  "DotBot",
  "ImagesiftBot",
  "PetalBot",
  "Scrapy",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: PRIVATE_PATHS,
      },
      {
        userAgent: DISCOVERY_CRAWLERS,
        allow: "/",
        // Also fence off the image optimizer. It was 71% of egress, and a
        // crawler has no use for six widths of the same photo.
        disallow: [...PRIVATE_PATHS, "/_next/image"],
        crawlDelay: 10,
      },
      {
        userAgent: EXTRACTIVE_CRAWLERS,
        disallow: "/",
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
