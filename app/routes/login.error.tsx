import { Link } from "react-router";

import { privatePageMeta } from "~/domain/seo";
import type { Route } from "./+types/login.error";

const REASONS: Record<string, string> = {
  missing_token: "リンクの形式が正しくありません。",
  invalid_token: "リンクの有効期限が切れているか、すでに使用されています。",
  rate_limited: "短い時間に操作が続きました。時間をおいてお試しください。",
};

export function loader({ request }: Route.LoaderArgs) {
  const reason = new URL(request.url).searchParams.get("reason") ?? "";
  return {
    // 未知の値をそのまま画面へ出さない（反射型の文字列注入を避ける）。
    // ★自分のキーだけ。★ 素のオブジェクトを [reason] で引くと prototype まで
    // 辿り、?reason=toString で関数が返って loader の直列化が落ちる（500）。
    message: Object.hasOwn(REASONS, reason)
      ? REASONS[reason]!
      : "ログインを完了できませんでした。",
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("ログインできませんでした");
}

export default function LoginError({ loaderData }: Route.ComponentProps) {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      <h1 className="text-2xl font-bold text-washi-900">
        ログインできませんでした
      </h1>
      <p className="mt-4 text-washi-700">{loaderData.message}</p>
      <p className="mt-2 text-washi-700">
        お手数ですが、もう一度メールアドレスの入力からお試しください。
      </p>
      <Link to="/login" className="btn btn-primary mt-6">
        ログイン画面へ
      </Link>
    </div>
  );
}
