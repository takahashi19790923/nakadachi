import { useEffect, useId, useRef } from "react";

import { CSRF_TOKEN_FIELD } from "~/domain/form-fields";

/**
 * フォーム部品。
 *
 * ★id を自分で採番しないこと。★ モジュール変数のカウンターや Math.random で
 * 採番すると、サーバー側とブラウザ側で違う値になり、ハイドレーションが壊れる。
 * React error #418 が出るが★画面は動いて見える★ので、コンソールを見ない限り
 * 気づけない。useId を使う。
 */

interface FieldWrapperProps {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}

function FieldWrapper({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: FieldWrapperProps) {
  return (
    <div className="mt-4">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
        {required ? (
          <span className="ml-1 text-red-700" aria-hidden="true">
            *
          </span>
        ) : (
          <span className="ml-2 text-xs font-normal text-washi-500">任意</span>
        )}
      </label>
      {children}
      {hint ? (
        <p className="field-hint" id={`${htmlFor}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${htmlFor}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface BaseProps {
  name: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  defaultValue?: string | number | null;
}

export function TextField({
  name,
  label,
  hint,
  error,
  required,
  defaultValue,
  type = "text",
  inputMode,
  maxLength,
  placeholder,
  autoComplete,
}: BaseProps & {
  type?: string;
  inputMode?: "text" | "numeric" | "email" | "tel";
  maxLength?: number;
  placeholder?: string;
  autoComplete?: string;
}) {
  const id = useId();
  return (
    <FieldWrapper
      label={label}
      htmlFor={id}
      hint={hint}
      error={error}
      required={required}
    >
      <input
        id={id}
        name={name}
        type={type}
        inputMode={inputMode}
        maxLength={maxLength}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        defaultValue={defaultValue ?? undefined}
        className="field-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={
          [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
            .filter(Boolean)
            .join(" ") || undefined
        }
      />
    </FieldWrapper>
  );
}

export function TextAreaField({
  name,
  label,
  hint,
  error,
  required,
  defaultValue,
  rows = 6,
  maxLength,
}: BaseProps & { rows?: number; maxLength?: number }) {
  const id = useId();
  return (
    <FieldWrapper
      label={label}
      htmlFor={id}
      hint={hint}
      error={error}
      required={required}
    >
      <textarea
        id={id}
        name={name}
        rows={rows}
        maxLength={maxLength}
        required={required}
        defaultValue={defaultValue ?? undefined}
        className="field-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={
          [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
            .filter(Boolean)
            .join(" ") || undefined
        }
      />
    </FieldWrapper>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function SelectField({
  name,
  label,
  hint,
  error,
  required,
  defaultValue,
  options,
  placeholder,
}: BaseProps & { options: readonly Option[]; placeholder?: string }) {
  const id = useId();
  return (
    <FieldWrapper
      label={label}
      htmlFor={id}
      hint={hint}
      error={error}
      required={required}
    >
      <select
        id={id}
        name={name}
        required={required}
        defaultValue={defaultValue ?? ""}
        className="field-input"
        aria-invalid={error ? true : undefined}
        // TextField と同じ結び付け。無いと補足とエラーの文が読み上げに乗らない
        // （id は FieldWrapper が出しているのに、どこからも参照されていなかった）。
        aria-describedby={
          [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
            .filter(Boolean)
            .join(" ") || undefined
        }
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldWrapper>
  );
}

export function RadioGroupField({
  name,
  label,
  hint,
  error,
  required,
  defaultValue,
  options,
}: BaseProps & { options: readonly Option[] }) {
  const groupId = useId();
  return (
    <fieldset
      className="mt-4"
      aria-describedby={
        [hint ? `${groupId}-hint` : null, error ? `${groupId}-error` : null]
          .filter(Boolean)
          .join(" ") || undefined
      }
    >
      <legend className="field-label">
        {label}
        {required ? (
          <span className="ml-1 text-red-700" aria-hidden="true">
            *
          </span>
        ) : null}
      </legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((option, index) => {
          const id = `${groupId}-${index}`;
          return (
            <div key={option.value}>
              <input
                type="radio"
                id={id}
                name={name}
                value={option.value}
                defaultChecked={String(defaultValue ?? "") === option.value}
                className="peer sr-only"
              />
              <label
                htmlFor={id}
                className="inline-block cursor-pointer rounded-lg border border-washi-300 bg-white px-4 py-2.5 text-sm
                  peer-checked:border-ai-600 peer-checked:bg-ai-50 peer-checked:font-semibold peer-checked:text-ai-900
                  peer-focus-visible:outline peer-focus-visible:outline-3 peer-focus-visible:outline-kaki-500"
              >
                {option.label}
              </label>
            </div>
          );
        })}
      </div>
      {hint ? (
        <p id={`${groupId}-hint`} className="field-hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${groupId}-error`} className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export function CheckboxField({
  name,
  label,
  hint,
  defaultChecked,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultChecked?: boolean;
}) {
  const id = useId();
  return (
    <div className="mt-4">
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          id={id}
          name={name}
          defaultChecked={defaultChecked}
          className="mt-1.5 h-5 w-5 rounded border-washi-400"
        />
        <label htmlFor={id} className="text-base text-washi-800">
          {label}
        </label>
      </div>
      {hint ? <p className="field-hint ml-7">{hint}</p> : null}
    </div>
  );
}

/**
 * CSRF トークン。★状態を変えるフォームには必ず入れる。★
 * 入れ忘れるとアクション側の assertCsrf で落ちるので、本番で気づかない
 * ということは起きない（落ちてくれるほうがよい）。
 */
export function CsrfInput({ token }: { token: string }) {
  return <input type="hidden" name={CSRF_TOKEN_FIELD} value={token} />;
}

/** 入力エラーの要約。フォーム先頭に置き、読み上げにも届くようにする */
export function ErrorSummary({
  message,
  fields,
}: {
  message?: string | null;
  fields?: Record<string, string> | null;
}) {
  const entries = Object.entries(fields ?? {});
  const ref = useRef<HTMLDivElement>(null);
  const hasContent = Boolean(message) || entries.length > 0;

  /*
   * ★出た瞬間にフォーカスを移す。★ 長いフォームで送信して失敗すると、
   * エラーの要約は上に出るのにフォーカスは下の送信ボタンに残る。キーボードの
   * 人は Shift+Tab で全項目をさかのぼらないと何が起きたか分からない。
   * tabIndex={-1} は前からあったが、focus() する場所が無く効いていなかった。
   */
  useEffect(() => {
    if (hasContent) ref.current?.focus();
  }, [hasContent, message, entries.length]);

  if (!hasContent) return null;

  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4"
    >
      <p className="font-semibold text-red-800">
        {message ?? "入力内容をご確認ください。"}
      </p>
      {entries.length > 0 ? (
        <ul className="mt-2 list-inside list-disc text-sm text-red-800">
          {entries.map(([key, value]) => (
            <li key={key}>{value}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * 処理が成功したことの知らせ。
 *
 * ★成功を ErrorSummary で出さない。★ 赤い枠に「返金を依頼しました」と
 * 出ていた（2026-08-16、管理画面の決済状況）。押した本人が成功したのか
 * 失敗したのか判断できない。とくに決済まわりは、読み違えると
 * 同じ操作を繰り返してしまう。
 *
 * role="status" にしているのは、読み上げで割り込ませないため
 * （エラーは role="alert" で割り込ませる）。
 */
export function NoticeSummary({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div
      role="status"
      className="mt-4 rounded-lg border border-ai-300 bg-ai-50 p-4"
    >
      <p className="font-semibold text-ai-900">{message}</p>
    </div>
  );
}
