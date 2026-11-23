import type { Metadata } from "next";

// Mirror of SECTOR_MAP in ./page.tsx. Kept inline to avoid forcing the
// client page to export a shared constant.
const SECTOR_META: Record<string, { title: string; description: string }> = {
  "food-beverage": {
    title: "Food & Beverage",
    description: "Halal restaurants, catering, food products and ingredients exhibiting at Young at Heart Festival 2026 in Cape Town.",
  },
  "fashion-modest-wear": {
    title: "Fashion & Modest Wear",
    description: "Modest fashion, clothing, accessories and hijabs at Young at Heart Festival 2026 in Cape Town.",
  },
  "beauty-wellness": {
    title: "Beauty & Wellness",
    description: "Halal cosmetics, skincare and wellness brands at Young at Heart Festival 2026 in Cape Town.",
  },
  "health-pharmacy": {
    title: "Health & Pharmacy",
    description: "Supplements, medicine and health products at Young at Heart Festival 2026 in Cape Town.",
  },
  "travel-tourism": {
    title: "Travel & Tourism",
    description: "Travel agencies, halal-friendly destinations and experiences at Young at Heart Festival 2026 in Cape Town.",
  },
  "home-living": {
    title: "Home & Living",
    description: "Furniture, decor and home essentials at Young at Heart Festival 2026 in Cape Town.",
  },
  "finance-services": {
    title: "Finance & Services",
    description: "Islamic banking, takaful and Shariah-compliant financial services at Young at Heart Festival 2026 in Cape Town.",
  },
  "business-trade": {
    title: "Business & Trade",
    description: "B2B services, suppliers and trade opportunities at Young at Heart Festival 2026 in Cape Town.",
  },
  other: {
    title: "More Exhibitors",
    description: "Crafts, gifts, education, community organisations and more at Young at Heart Festival 2026 in Cape Town.",
  },
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const sector = SECTOR_META[slug];

  if (!sector) {
    return {
      title: "Sector not found",
      description: "This sector does not exist at Young at Heart Festival 2026.",
      alternates: { canonical: `/sectors/${slug}` },
      robots: { index: false, follow: true },
    };
  }

  const title = sector.title;
  const description = sector.description;
  const url = `/sectors/${slug}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: `${title} | Young at Heart Festival 2026`,
      description,
      url,
      type: "website",
      locale: "en_ZA",
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | Young at Heart Festival 2026`,
      description,
    },
  };
}

export default function SectorSlugLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
