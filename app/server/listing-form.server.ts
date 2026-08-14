import { formDataToObject, toFieldErrors } from "~/domain/validation/common";
import {
  assertKindMatchesCategory,
  listingInputSchema,
  type ListingInput,
} from "~/domain/validation/listing";
import type { Db } from "./db.server.ts";
import { getLocation } from "./repositories/location-repository.server.ts";

/**
 * 投稿フォームの受け取り。
 *
 * ★都道府県コードはフォームから受け取らず、市区町村から導く。★
 * 2つを別々に送らせると「東京都 × 大阪市」のような組み合わせを作れてしまう。
 * 送信内容は書き換えられる前提で、サーバー側で確定させる。
 */
export async function parseListingForm(
  db: Db,
  formData: FormData,
): Promise<
  | { ok: true; data: ListingInput }
  | { ok: false; fields: Record<string, string> }
> {
  const raw = formDataToObject(formData);

  const cityCode = typeof raw.cityCode === "string" ? raw.cityCode : "";
  if (!cityCode) {
    return { ok: false, fields: { cityCode: "地域を選択してください" } };
  }

  const city = await getLocation(db, cityCode);
  if (!city || city.kind !== "city" || !city.parentCode) {
    return { ok: false, fields: { cityCode: "地域の指定が不正です" } };
  }
  raw.prefectureCode = city.parentCode;

  const parsed = listingInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, fields: toFieldErrors(parsed.error) };
  }

  // スキーマ側でも絞っているが、カテゴリを増やしたときの取りこぼしに備えて二重化する。
  if (!assertKindMatchesCategory(parsed.data)) {
    return { ok: false, fields: { kind: "選択できない種別です" } };
  }

  return { ok: true, data: parsed.data };
}
