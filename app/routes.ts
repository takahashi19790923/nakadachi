import { index, prefix, route, type RouteConfig } from "@react-router/dev/routes";

/**
 * ルート定義。
 *
 * ファイル名からの自動生成ではなく明示列挙にしている。URL は外から見える
 * 約束なので、ファイルを動かしただけで変わってほしくない。
 * noindex にすべき画面がどれかも、ここを見れば一覧できる。
 *
 * 詳細は docs/ROUTES.md。
 */
export default [
  // ── 公開画面（誰でも見られる。検索エンジンにも載る）──────────────
  index("routes/home.tsx"),
  route("categories", "routes/categories.tsx"),
  route("c/:categorySlug", "routes/category-listings.tsx"),
  route("area/:prefectureCode", "routes/area-listings.tsx"),
  route("area/:prefectureCode/:cityCode", "routes/area-city-listings.tsx"),
  route("search", "routes/search.tsx"),
  route("listings/:listingId", "routes/listing-detail.tsx"),
  route("media/:objectKey", "routes/media.tsx"),

  // ── 規約・ご案内（noindex にしない）────────────────────────────
  route("legal/terms", "routes/legal.terms.tsx"),
  route("legal/privacy", "routes/legal.privacy.tsx"),
  route("legal/tokushoho", "routes/legal.tokushoho.tsx"),
  route("legal/prohibited", "routes/legal.prohibited.tsx"),
  route("guide/safety", "routes/guide.safety.tsx"),
  route("contact", "routes/contact.tsx"),

  // ── 認証 ──────────────────────────────────────────────────────
  route("login", "routes/login.tsx"),
  route("login/verify", "routes/login.verify.tsx"),
  route("login/link", "routes/login.link.tsx"),
  route("login/error", "routes/login.error.tsx"),
  route("logout", "routes/logout.tsx"),

  // ── 利用者向け（すべて noindex）────────────────────────────────
  ...prefix("mypage", [
    index("routes/mypage.tsx"),
    route("profile", "routes/mypage.profile.tsx"),
    route("drafts", "routes/mypage.drafts.tsx"),
    route("published", "routes/mypage.published.tsx"),
    route("finished", "routes/mypage.finished.tsx"),
    route("favorites", "routes/mypage.favorites.tsx"),
    route("messages", "routes/mypage.messages.tsx"),
    route("messages/:threadId", "routes/mypage.messages.thread.tsx"),
    route("reports", "routes/mypage.reports.tsx"),
    route("payments", "routes/mypage.payments.tsx"),
    route("delete", "routes/mypage.delete.tsx"),
  ]),

  ...prefix("listings", [
    route("new", "routes/listings.new.tsx"),
    route(":listingId/edit", "routes/listings.edit.tsx"),
    route(":listingId/confirm", "routes/listings.confirm.tsx"),
    route(":listingId/checkout", "routes/listings.checkout.tsx"),
    route(":listingId/pending", "routes/listings.pending.tsx"),
    route(":listingId/close", "routes/listings.close.tsx"),
    route(":listingId/images", "routes/listings.images.tsx"),
    route(":listingId/contact", "routes/listings.contact.tsx"),
    route(":listingId/favorite", "routes/listings.favorite.tsx"),
    route(":listingId/report", "routes/listings.report.tsx"),
  ]),

  route("users/:userId/block", "routes/users.block.tsx"),

  // ── 管理画面（3層目のゲートを通らないと中身に触れない。全 noindex）──
  ...prefix("admin", [
    index("routes/admin._index.tsx"),
    route("gate", "routes/admin.gate.tsx"),
    route("users", "routes/admin.users.tsx"),
    route("listings", "routes/admin.listings.tsx"),
    route("listings/:listingId", "routes/admin.listing-detail.tsx"),
    route("reports", "routes/admin.reports.tsx"),
    route("payments", "routes/admin.payments.tsx"),
    route("audit", "routes/admin.audit.tsx"),
    route("banned-words", "routes/admin.banned-words.tsx"),
    // 発信者情報の取り出し。引いた事実は必ず記録に残る。
    route("disclosure", "routes/admin.disclosure.tsx"),
  ]),

  // ── 機械向け ──────────────────────────────────────────────────
  route("robots.txt", "routes/robots[.]txt.tsx"),
  route("sitemap.xml", "routes/sitemap[.]xml.tsx"),
  route("api/stripe/webhook", "routes/api.stripe.webhook.tsx"),
  route("api/config", "routes/api.config.tsx"),

  // 上のどれにも当たらないパスは 404 にする。
  // ★SPA フォールバックで全パスに 200 を返さない。★ 404 が機能しなくなる。
  route("*", "routes/catch-all.tsx"),
] satisfies RouteConfig;
