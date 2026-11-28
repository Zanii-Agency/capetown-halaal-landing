import type { MetadataRoute } from "next";

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://cthalaal.co.za").replace(/\/$/, "");

const SECTOR_SLUGS = [
  "food-beverage",
  "fashion-modest-wear",
  "beauty-wellness",
  "health-pharmacy",
  "travel-tourism",
  "home-living",
  "finance-services",
  "business-trade",
  "other",
];

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: "weekly", priority: 1.0 },
    { url: `${SITE_URL}/apply`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${SITE_URL}/faq`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE_URL}/sectors`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
  ];

  const sectorRoutes: MetadataRoute.Sitemap = SECTOR_SLUGS.map((slug) => ({
    url: `${SITE_URL}/sectors/${slug}`,
    lastModified: now,
    changeFrequency: "weekly" as const,
    priority: 0.7,
  }));

  return [...staticRoutes, ...sectorRoutes];
}
