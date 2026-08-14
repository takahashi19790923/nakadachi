import { CATEGORY_SLUGS } from "~/domain/categories";
import { listPublishedForSitemap } from "~/server/repositories/listing-repository.server";
import { listPrefectures } from "~/server/repositories/location-repository.server";
import type { Route } from "./+types/sitemap[.]xml";
import { getApp } from "~/server/app-context";

/**
 * sitemap.xml
 *
 * ★公開中の投稿だけを載せる。★ 下書き・決済待ち・掲載終了は含めない。
 * ★個人情報を含めない。★ URL と更新日時だけ。
 *
 * 件数が増えたらサイトマップインデックスへの分割が要る（1ファイル5万URL・
 * 50MB が上限）。上限に達する前に OPERATIONS.md の手順で分割すること。
 */
const MAX_URLS = 5000;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function loader({ context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const origin = context.env.APP_ORIGIN;
  const db = context.getDb();

  const [listings, prefectures] = await Promise.all([
    listPublishedForSitemap(db, MAX_URLS),
    listPrefectures(db),
  ]);

  const entries: { path: string; lastmod?: string; priority: string }[] = [
    { path: "/", priority: "1.0" },
    { path: "/categories", priority: "0.8" },
    { path: "/legal/terms", priority: "0.3" },
    { path: "/legal/privacy", priority: "0.3" },
    { path: "/legal/tokushoho", priority: "0.3" },
    { path: "/legal/prohibited", priority: "0.5" },
    { path: "/guide/safety", priority: "0.5" },
    { path: "/contact", priority: "0.3" },
  ];

  for (const slug of CATEGORY_SLUGS) {
    entries.push({ path: `/c/${slug}`, priority: "0.8" });
  }
  for (const prefecture of prefectures) {
    entries.push({ path: `/area/${prefecture.code}`, priority: "0.6" });
  }
  for (const listing of listings) {
    entries.push({
      path: `/listings/${listing.id}`,
      lastmod: listing.updatedAt,
      priority: "0.7",
    });
  }

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map((entry) =>
      [
        "  <url>",
        `    <loc>${escapeXml(new URL(entry.path, origin).toString())}</loc>`,
        entry.lastmod ? `    <lastmod>${entry.lastmod}</lastmod>` : "",
        `    <priority>${entry.priority}</priority>`,
        "  </url>",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    "</urlset>",
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
