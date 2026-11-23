import type { Metadata } from "next";
import Link from "next/link";

const SECTORS: { slug: string; title: string; description: string }[] = [
  { slug: "food-beverage", title: "Food & Beverage", description: "Restaurants, catering, food products and ingredients" },
  { slug: "fashion-modest-wear", title: "Fashion & Modest Wear", description: "Clothing, accessories, hijabs and modest fashion" },
  { slug: "beauty-wellness", title: "Beauty & Wellness", description: "Cosmetics, skincare and wellness products" },
  { slug: "health-pharmacy", title: "Health & Pharmacy", description: "Supplements, medicine and health products" },
  { slug: "travel-tourism", title: "Travel & Tourism", description: "Travel agencies, destinations and experiences" },
  { slug: "home-living", title: "Home & Living", description: "Furniture, decor and home essentials" },
  { slug: "finance-services", title: "Finance & Services", description: "Islamic banking, takaful and financial services" },
  { slug: "business-trade", title: "Business & Trade", description: "B2B services, suppliers and trade opportunities" },
  { slug: "other", title: "More Exhibitors", description: "Crafts, gifts, education, community organisations and more" },
];

export const metadata: Metadata = {
  title: "Sectors",
  description: "Browse the eight sectors at Young at Heart Festival 2026, the Cape Town halal lifestyle exhibition. Food, fashion, beauty, health, travel, home, finance and business and trade.",
  alternates: { canonical: "/sectors" },
  openGraph: {
    title: "Sectors | Young at Heart Festival 2026",
    description: "Browse the eight sectors at the Cape Town halal lifestyle exhibition.",
    url: "/sectors",
    type: "website",
    locale: "en_ZA",
  },
  twitter: {
    card: "summary_large_image",
    title: "Sectors | Young at Heart Festival 2026",
    description: "Browse the eight sectors at the Cape Town halal lifestyle exhibition.",
  },
};

export default function SectorsIndexPage() {
  return (
    <div className="min-h-screen bg-neutral-50">
      <main className="container mx-auto px-4 py-16">
        <div className="max-w-4xl mx-auto">
          <header className="mb-12 text-center">
            <h1 className="text-3xl md:text-4xl font-bold text-neutral-900 mb-3">Sectors</h1>
            <p className="text-neutral-600 text-lg">
              Eight sectors at Young at Heart Festival 2026. 11 to 13 December 2026, Youngsfield Military Base, Cape Town.
            </p>
          </header>

          <ul className="grid gap-3 md:grid-cols-2">
            {SECTORS.map((s) => (
              <li key={s.slug}>
                <Link
                  href={`/sectors/${s.slug}`}
                  className="block rounded-xl border border-neutral-200 bg-white p-5 hover:border-neutral-300 hover:shadow-sm transition"
                >
                  <h2 className="text-lg font-semibold text-neutral-900">{s.title}</h2>
                  <p className="text-sm text-neutral-600 mt-1">{s.description}</p>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </main>
    </div>
  );
}
