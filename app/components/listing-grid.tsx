import { Form, Link } from "react-router";

import type { ListingSummary } from "~/domain/listing-types";
import { CATEGORIES, LISTING_KIND_LABEL } from "~/domain/categories";
import type { CategorySlug } from "~/domain/categories";
import { ListingCard } from "./listing-card";
import { EmptyState } from "./ui";

export function ListingGrid({ listings }: { listings: ListingSummary[] }) {
  if (listings.length === 0) {
    return (
      <EmptyState
        title="条件に合う投稿は見つかりませんでした"
        description="地域を広げる、キーワードを短くする、カテゴリを外すなどしてお試しください。"
        actionLabel="条件をリセットして探す"
        actionTo="/search"
      />
    );
  }

  return (
    <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {listings.map((listing) => (
        <li key={listing.id}>
          <ListingCard listing={listing} />
        </li>
      ))}
    </ul>
  );
}

interface FiltersProps {
  action: string;
  prefectures: { code: string; name: string }[];
  cities: { code: string; name: string }[];
  filters: {
    q?: string;
    category?: CategorySlug;
    kind?: string;
    pref?: string;
    city?: string;
    min?: number;
    max?: number;
    sort: string;
  };
  /** パスで固定されている絞り込みは欄を出さない */
  lock?: { category?: boolean; area?: boolean };
}

/**
 * 絞り込みフォーム。
 *
 * GET のフォームにしているので、結果の URL がそのまま共有できる。
 * ★状態を変えないので CSRF トークンは要らない。★
 */
export function SearchFilters({
  action,
  prefectures,
  cities,
  filters,
  lock,
}: FiltersProps) {
  const kinds = filters.category ? CATEGORIES[filters.category].kinds : [];

  return (
    <Form method="get" action={action} className="card mt-4 p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="field-label" htmlFor="filter-q">
            キーワード
          </label>
          <input
            id="filter-q"
            name="q"
            type="search"
            defaultValue={filters.q ?? ""}
            maxLength={100}
            placeholder="例：自転車、電動ドライバー"
            className="field-input"
          />
        </div>

        {!lock?.category ? (
          <div>
            <label className="field-label" htmlFor="filter-category">
              カテゴリ
            </label>
            <select
              id="filter-category"
              name="category"
              defaultValue={filters.category ?? ""}
              className="field-input"
            >
              <option value="">すべて</option>
              {Object.values(CATEGORIES).map((category) => (
                <option key={category.slug} value={category.slug}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {kinds.length > 1 ? (
          <div>
            <label className="field-label" htmlFor="filter-kind">
              {filters.category ? CATEGORIES[filters.category].kindLabel : "種別"}
            </label>
            <select
              id="filter-kind"
              name="kind"
              defaultValue={filters.kind ?? ""}
              className="field-input"
            >
              <option value="">すべて</option>
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {LISTING_KIND_LABEL[kind]}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {!lock?.area ? (
          <>
            <div>
              <label className="field-label" htmlFor="filter-pref">
                都道府県
              </label>
              <select
                id="filter-pref"
                name="pref"
                defaultValue={filters.pref ?? ""}
                className="field-input"
              >
                <option value="">すべて</option>
                {prefectures.map((prefecture) => (
                  <option key={prefecture.code} value={prefecture.code}>
                    {prefecture.name}
                  </option>
                ))}
              </select>
            </div>
            {cities.length > 0 ? (
              <div>
                <label className="field-label" htmlFor="filter-city">
                  市区町村
                </label>
                <select
                  id="filter-city"
                  name="city"
                  defaultValue={filters.city ?? ""}
                  className="field-input"
                >
                  <option value="">すべて</option>
                  {cities.map((city) => (
                    <option key={city.code} value={city.code}>
                      {city.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </>
        ) : null}

        <div>
          <label className="field-label" htmlFor="filter-min">
            価格（下限）
          </label>
          <input
            id="filter-min"
            name="min"
            type="number"
            inputMode="numeric"
            min={0}
            defaultValue={filters.min ?? ""}
            className="field-input"
          />
        </div>
        <div>
          <label className="field-label" htmlFor="filter-max">
            価格（上限）
          </label>
          <input
            id="filter-max"
            name="max"
            type="number"
            inputMode="numeric"
            min={0}
            defaultValue={filters.max ?? ""}
            className="field-input"
          />
        </div>

        <div>
          <label className="field-label" htmlFor="filter-sort">
            並び順
          </label>
          <select
            id="filter-sort"
            name="sort"
            defaultValue={filters.sort}
            className="field-input"
          >
            <option value="newest">新着順</option>
            <option value="price_asc">価格が安い順</option>
            <option value="price_desc">価格が高い順</option>
            <option value="expiring">掲載期限が近い順</option>
          </select>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <button type="submit" className="btn btn-primary">
          この条件で探す
        </button>
        <Link to={action} className="btn btn-secondary">
          条件をリセット
        </Link>
      </div>
    </Form>
  );
}
