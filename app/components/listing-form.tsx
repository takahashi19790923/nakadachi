import { Form } from "react-router";

import {
  CATEGORIES,
  HANDOVER_METHODS,
  HANDOVER_METHOD_LABEL,
  ITEM_CONDITIONS,
  ITEM_CONDITION_LABEL,
  LISTING_KIND_LABEL,
  PRICE_TYPE_LABEL,
  PRICE_UNIT_LABEL,
  SALARY_UNIT_LABEL,
  type CategorySlug,
} from "~/domain/categories";
import { LISTING_DURATION_DAYS_CHOICES } from "~/domain/pricing";
import type { ListingDetail } from "~/domain/listing-types";
import {
  CheckboxField,
  CsrfInput,
  ErrorSummary,
  RadioGroupField,
  SelectField,
  TextAreaField,
  TextField,
} from "./form";
import { FeeNotice, PrivacyWarning } from "./ui";

interface Props {
  csrfToken: string;
  categorySlug: CategorySlug;
  prefectures: { code: string; name: string }[];
  /** 全都道府県ぶんをまとめて渡す（optgroup で束ねる） */
  cities: { code: string; name: string; parentCode: string }[];
  listing?: ListingDetail | null;
  errors?: Record<string, string> | null;
  message?: string | null;
  submitLabel: string;
  /** 公開済みの編集では掲載期間を変えられない（再課金しないため） */
  lockDuration?: boolean;
}

/**
 * 投稿フォーム。
 *
 * ★出す欄はカテゴリ定義から決める。★ 画面ごとに条件分岐を書くと、
 * カテゴリを増やしたときにどこかが漏れる。
 *
 * 都道府県を選ぶと市区町村を絞り込む必要があるが、★JavaScript が無くても
 * 使えるようにする★ため、都道府県の選択で GET を送り直す形にしている
 * （フォーム内の submit ボタンで再読み込みする）。
 */
export function ListingForm({
  csrfToken,
  categorySlug,
  prefectures,
  cities,
  listing,
  errors,
  message,
  submitLabel,
  lockDuration,
}: Props) {
  const category = CATEGORIES[categorySlug];
  const details = listing?.details ?? null;

  return (
    <>
      <ErrorSummary message={message} fields={errors} />
      <FeeNotice />
      <PrivacyWarning />

      <Form method="post" className="mt-6">
        <CsrfInput token={csrfToken} />
        <input type="hidden" name="categorySlug" value={categorySlug} />

        <RadioGroupField
          name="kind"
          label={category.kindLabel}
          required
          defaultValue={listing?.kind}
          error={errors?.kind}
          options={category.kinds.map((kind) => ({
            value: kind,
            label: LISTING_KIND_LABEL[kind],
          }))}
        />

        <TextField
          name="title"
          label="タイトル"
          required
          maxLength={80}
          defaultValue={listing?.title}
          error={errors?.title}
          hint="何を、どうしたいのかが一目で分かる書き方にしてください。"
        />

        <TextAreaField
          name="body"
          label={categorySlug === "job" ? "仕事内容" : "説明"}
          required
          rows={8}
          maxLength={4000}
          defaultValue={listing?.body}
          error={errors?.body}
          hint="状態・使用期間・受け渡しの条件など。電話番号やメールアドレスは書かないでください。"
        />

        {/* ── 価格 ─────────────────────────────────────────── */}
        {category.priceTypes.length > 1 ? (
          <RadioGroupField
            name="priceType"
            label="価格の種別"
            required
            defaultValue={listing?.priceType ?? category.priceTypes[0]}
            error={errors?.priceType}
            options={category.priceTypes.map((priceType) => ({
              value: priceType,
              label: PRICE_TYPE_LABEL[priceType],
            }))}
          />
        ) : (
          <input type="hidden" name="priceType" value={category.priceTypes[0]} />
        )}

        <TextField
          name="priceJpy"
          label={`${category.priceLabel}（円・税込）`}
          inputMode="numeric"
          maxLength={10}
          defaultValue={listing?.priceJpy ?? ""}
          error={errors?.priceJpy}
          hint={
            categorySlug === "job"
              ? "給与の下限を入力してください。"
              : "「無料」「相談」を選んだ場合は空欄で構いません。"
          }
        />

        {categorySlug === "job" ? (
          <TextField
            name="salaryMaxJpy"
            label="給与の上限（円・税込）"
            inputMode="numeric"
            maxLength={10}
            defaultValue={details?.salaryMaxJpy ?? ""}
            error={errors?.salaryMaxJpy}
            hint="幅がない場合は空欄で構いません。"
          />
        ) : null}

        {category.priceUnits.length > 1 ? (
          <SelectField
            name="priceUnit"
            label={categorySlug === "job" ? "給与の単位" : "料金の単位"}
            required
            defaultValue={listing?.priceUnit}
            error={errors?.priceUnit}
            options={category.priceUnits.map((unit) => ({
              value: unit,
              label:
                categorySlug === "job"
                  ? (SALARY_UNIT_LABEL[unit] ?? PRICE_UNIT_LABEL[unit])
                  : PRICE_UNIT_LABEL[unit],
            }))}
          />
        ) : (
          <input type="hidden" name="priceUnit" value={category.priceUnits[0]} />
        )}

        {/* ── カテゴリ固有 ─────────────────────────────────── */}
        {category.usesItemCondition ? (
          <SelectField
            name="itemCondition"
            label={categorySlug === "rental" ? "対象物の状態" : "商品の状態"}
            required
            placeholder="選択してください"
            defaultValue={details?.itemCondition ?? ""}
            error={errors?.itemCondition}
            options={ITEM_CONDITIONS.map((condition) => ({
              value: condition,
              label: ITEM_CONDITION_LABEL[condition],
            }))}
          />
        ) : null}

        {category.usesHandover ? (
          <SelectField
            name="handoverMethod"
            label="受け渡し方法"
            required
            placeholder="選択してください"
            defaultValue={details?.handoverMethod ?? ""}
            error={errors?.handoverMethod}
            options={HANDOVER_METHODS.map((method) => ({
              value: method,
              label: HANDOVER_METHOD_LABEL[method],
            }))}
          />
        ) : null}

        {categorySlug === "rental" ? (
          <>
            <CheckboxField
              name="depositRequired"
              label="デポジット（保証金）を求める"
              defaultChecked={details?.depositRequired ?? false}
              hint="当サービスは預かり金を扱いません。金額と返却条件は当事者間で取り決めてください。"
            />
            <TextField
              name="depositNote"
              label="デポジットの条件"
              maxLength={200}
              defaultValue={details?.depositNote ?? ""}
              error={errors?.depositNote}
              hint="例：5,000円を対面で預かり、返却時に全額返金します。"
            />
            <TextField
              name="availableFrom"
              label="貸出可能期間（開始）"
              type="date"
              defaultValue={details?.availableFrom ?? ""}
              error={errors?.availableFrom}
            />
            <TextField
              name="availableTo"
              label="貸出可能期間（終了）"
              type="date"
              defaultValue={details?.availableTo ?? ""}
              error={errors?.availableTo}
            />
            <TextAreaField
              name="rentalTerms"
              label="貸出条件"
              rows={4}
              maxLength={500}
              defaultValue={details?.rentalTerms ?? ""}
              error={errors?.rentalTerms}
              hint="返却方法、破損時の扱い、使用上の注意など。"
            />
          </>
        ) : null}

        {categorySlug === "help" ? (
          <>
            <TextAreaField
              name="serviceContent"
              label="提供内容"
              required
              rows={4}
              maxLength={500}
              defaultValue={details?.serviceContent ?? ""}
              error={errors?.serviceContent}
              hint="何を、どこまでお手伝いできるか。"
            />
            <TextField
              name="availabilityNote"
              label="対応可能日時"
              maxLength={200}
              defaultValue={details?.availabilityNote ?? ""}
              error={errors?.availabilityNote}
              hint="例：平日夜と土日の午前"
            />
          </>
        ) : null}

        {categorySlug === "job" ? (
          <>
            <TextField
              name="companyName"
              label="会社名または事業者名"
              required
              maxLength={80}
              defaultValue={details?.companyName ?? ""}
              error={errors?.companyName}
            />
            <TextField
              name="workLocationNote"
              label="勤務地の補足"
              maxLength={120}
              defaultValue={details?.workLocationNote ?? ""}
              error={errors?.workLocationNote}
              hint="最寄り駅や「〇〇店」など。番地は書かないでください。"
            />
            <TextField
              name="workHours"
              label="勤務時間"
              required
              maxLength={200}
              defaultValue={details?.workHours ?? ""}
              error={errors?.workHours}
              hint="例：9:00〜18:00（休憩60分）、週3日から"
            />
            <TextAreaField
              name="qualifications"
              label="応募資格"
              rows={3}
              maxLength={500}
              defaultValue={details?.qualifications ?? ""}
              error={errors?.qualifications}
              hint="性別・年齢・国籍による制限は、法令で認められる場合を除き記載できません。"
            />
            <TextAreaField
              name="benefits"
              label="福利厚生"
              rows={3}
              maxLength={500}
              defaultValue={details?.benefits ?? ""}
              error={errors?.benefits}
            />
          </>
        ) : null}

        {/* ── 地域 ─────────────────────────────────────────── */}
        {/*
          都道府県と市区町村を1つの選択欄にまとめている。
          ★段階的な絞り込みにしない理由★
           - JavaScript 無しでは2度目の送信が要り、入力途中の本文が URL に載る
           - 2つの欄に分けると「都道府県と市区町村が食い違う」組み合わせを
             送れてしまう。1つなら、その状態が構造的に作れない
          都道府県コードはサーバー側で市区町村から導く（送信内容を信用しない）。
        */}
        <AreaSelect
          prefectures={prefectures}
          cities={cities}
          defaultValue={listing?.cityCode ?? ""}
          error={errors?.cityCode ?? errors?.prefectureCode}
        />

        <TextField
          name="areaNote"
          label="最寄り駅・受け渡し場所"
          maxLength={60}
          defaultValue={listing?.areaNote ?? ""}
          error={errors?.areaNote}
          hint="例：〇〇駅の近く。★番地・部屋番号は書かないでください。★"
        />

        {/* ── 掲載期間 ─────────────────────────────────────── */}
        {lockDuration ? (
          <p className="field-hint mt-4">
            公開中の投稿では掲載期間を変更できません。編集による追加の料金はかかりません。
          </p>
        ) : (
          <SelectField
            name="durationDays"
            label="掲載期間"
            required
            defaultValue="30"
            error={errors?.durationDays}
            options={LISTING_DURATION_DAYS_CHOICES.map((days) => ({
              value: String(days),
              label: `${days}日間`,
            }))}
            hint="期間が終わると自動的に掲載終了になります。自動更新・自動課金はありません。"
          />
        )}

        <div className="mt-8 flex flex-wrap gap-3">
          <button type="submit" name="intent" value="save" className="btn btn-primary">
            {submitLabel}
          </button>
        </div>
      </Form>
    </>
  );
}

/**
 * 地域の選択欄。都道府県ごとに optgroup でまとめる。
 * 選ぶのは市区町村1つだけで、都道府県はサーバー側で導く。
 */
function AreaSelect({
  prefectures,
  cities,
  defaultValue,
  error,
}: {
  prefectures: { code: string; name: string }[];
  cities: { code: string; name: string; parentCode: string }[];
  defaultValue: string;
  error?: string;
}) {
  const byPrefecture = new Map<string, { code: string; name: string }[]>();
  for (const city of cities) {
    const list = byPrefecture.get(city.parentCode) ?? [];
    list.push({ code: city.code, name: city.name });
    byPrefecture.set(city.parentCode, list);
  }

  return (
    <div className="mt-4">
      <label className="field-label" htmlFor="listing-area">
        地域（市区町村）
        <span className="ml-1 text-red-700" aria-hidden="true">
          *
        </span>
      </label>
      <select
        id="listing-area"
        name="cityCode"
        required
        defaultValue={defaultValue}
        className="field-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "listing-area-error" : "listing-area-hint"}
      >
        <option value="">選択してください</option>
        {prefectures.map((prefecture) => {
          const list = byPrefecture.get(prefecture.code) ?? [];
          if (list.length === 0) return null;
          return (
            <optgroup key={prefecture.code} label={prefecture.name}>
              {list.map((city) => (
                <option key={city.code} value={city.code}>
                  {prefecture.name} {city.name}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
      <p className="field-hint" id="listing-area-hint">
        公開されるのは市区町村までです。番地は表示されません。
      </p>
      {error ? (
        <p className="field-error" id="listing-area-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
