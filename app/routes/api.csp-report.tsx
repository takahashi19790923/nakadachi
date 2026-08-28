import { getApp } from "~/server/app-context";
import type { Route } from "./+types/api.csp-report";

/**
 * CSP 違反の受け口。
 *
 * ★これが無いと、方針が何かを止めた瞬間が一度も観測できない。★
 * 注入の試みも、うっかり壊した設定も、同じく「静かに効く」。
 * 利用者からは「ボタンが反応しない」としか見えず、報告も来ない。
 *
 * ★誰でも叩ける口である前提で作る。★
 *  - 本文は 8KB で切る（それ以上は読まずに捨てる）
 *  - ★DB には一切書かない。★ 件数を決めるのは攻撃者なので、
 *    永久に残る表へ書くと保管費用が攻撃手段になる
 *  - 残すのは「どの規則が」「どのホストを」止めたかだけ。
 *    URL の全体は残さない（利用者の閲覧履歴になる）
 *  - 常に 204 を返す。中身の妥当性で応答を変えない
 *    （何が受理されたかを外から測らせない）
 *
 * 荒らされたときは、security-headers.server.ts から report-uri を
 * 外せば止まる（アプリの動作には影響しない）。
 */

const MAX_BYTES = 8 * 1024;

/** 常にこれを返す。理由は上のとおり */
const ACCEPTED = new Response(null, { status: 204 });

export async function action({ request, context: rawContext }: Route.ActionArgs) {
  const context = getApp(rawContext);

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) return ACCEPTED;

  try {
    const text = await request.text();
    if (text.length > MAX_BYTES) return ACCEPTED;

    const parsed = JSON.parse(text) as {
      "csp-report"?: Record<string, unknown>;
    };
    const report = parsed["csp-report"] ?? {};

    /*
     * ★文字列以外は捨てる。★ 本文は誰でも作れるので、
     * `{"blocked-uri": {...}}` のような形で来る。素の String() に
     * かけると "[object Object]" がログに並ぶだけになる。
     */
    const text_ = (value: unknown, max: number): string =>
      typeof value === "string" ? value.slice(0, max) : "";

    const directive = text_(report["violated-directive"], 80) || "unknown";
    const blocked = text_(report["blocked-uri"], 200);
    const documentUri = text_(report["document-uri"], 500);

    /*
     * ★ホストだけを残す。★ 完全な URL を残すと、どの投稿を見ていたかが
     * ログに溜まる（利用者の閲覧履歴になる）。どこで起きたかは
     * パスの1段目まであれば足りる。
     */
    let where = "";
    try {
      const url = new URL(documentUri);
      where = `${url.pathname.split("/").slice(0, 2).join("/")}`;
    } catch {
      where = "";
    }

    let blockedHost = blocked;
    try {
      blockedHost = new URL(blocked).host || blocked;
    } catch {
      // inline / eval / data: などはそのまま（すでに短い語）
    }

    context.logger.warn("csp violation", {
      directive,
      blocked: blockedHost.slice(0, 120),
      where: where.slice(0, 60),
    });
  } catch {
    // 壊れた本文。数えない、返さない、落ちない。
  }

  return ACCEPTED;
}

/** GET で来ても何も返さない（探索の的にしない） */
export function loader() {
  return new Response(null, { status: 405 });
}
