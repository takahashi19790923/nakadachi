import {
  requireSecret,
  turnstileExpectedHosts,
  type AppEnv,
} from "./env.server.ts";
import { AppError } from "./errors.ts";
import type { Logger } from "./logger.server.ts";

/**
 * Cloudflare Turnstile の検証。
 *
 * ★このアカウントは1つのウィジェットを全サービスで共有している。★
 * そのため、あるサービス向けに解かれたトークンが、そのまま別のサービスでも
 * siteverify を通る。siteverify は success: true としか言わない。
 * サービスを分けられるのは ★サーバー側の hostname 照合だけ★ で、
 * Cloudflare 公式もこれを勧めている。
 *
 * ★呼ぶ位置に注意。★ ハンドラのいちばん外側、リクエスト本文を読んだ直後、
 * 入力検証より前に置くこと。入力検証を先に走らせると、形の崩れた入力が
 * bad_request で先に返り、外形上「ボット検査を通っていない」のと
 * 区別がつかなくなる（過去に fail-open と誤診した実例がある）。
 */

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResponse {
  success: boolean;
  hostname?: string;
  "error-codes"?: string[];
  action?: string;
}

export class TurnstileError extends AppError {
  constructor(detail: string) {
    super("turnstile_failed", "確認に失敗しました。もう一度お試しください。", {
      detail,
    });
    this.name = "TurnstileError";
  }
}

export async function verifyTurnstile(options: {
  env: AppEnv;
  token: unknown;
  remoteIp?: string | null;
  logger?: Logger;
}): Promise<void> {
  const { env, token, remoteIp, logger } = options;

  // ★fail-close。★ 鍵が入っていなければ 503 で止める。
  // 「鍵が無ければ検査を飛ばす」と書くと、投入漏れのままボット対策が
  // 外れて動き続け、誰も気づかない。
  const secret = requireSecret(env, "TURNSTILE_SECRET_KEY");

  const allowedHosts = turnstileExpectedHosts(env);
  if (allowedHosts.length === 0) {
    // 照合先が無いのに通すと、共有ウィジェットの意味が消える。
    throw new AppError(
      "configuration",
      "ただいまご利用いただけません。時間をおいてお試しください。",
      { detail: "TURNSTILE_EXPECTED_HOSTS が未設定" },
    );
  }

  if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
    throw new TurnstileError("token missing or malformed");
  }

  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (remoteIp) form.append("remoteip", remoteIp);

  let data: SiteverifyResponse;
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      body: form,
    });
    // ★応答本文を必ず読み切る。★ 読まずに return すると接続が開いたままになり、
    // 同一オリジンへの同時接続を食い潰していく。curl では再現しない。
    data = await response.json<SiteverifyResponse>();
  } catch (error) {
    logger?.warn("turnstile siteverify unreachable");
    throw new TurnstileError(
      `siteverify request failed: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }

  if (!data.success) {
    // 110100 = サイトキー不正 / 110200 = ドメイン未許可。
    // どちらも設定の誤りなので、コードだけはログに残す（秘密ではない）。
    throw new TurnstileError(
      `siteverify rejected: ${(data["error-codes"] ?? []).join(",")}`,
    );
  }

  // ★完全一致で比べる。★ 部分一致や endsWith にすると
  // nakadachi.rewrite-co.com.evil.example が通ってしまう。
  const hostname = String(data.hostname ?? "");
  if (!allowedHosts.includes(hostname)) {
    throw new TurnstileError(
      `hostname mismatch: got=${hostname} allowed=${allowedHosts.join("|")}`,
    );
  }
}

/**
 * 画面へ配るサイトキー。
 * ここが空を返しているなら、動いていてもボット対策は効いていない。
 */
export function turnstileSiteKey(env: AppEnv): string {
  return env.TURNSTILE_SITE_KEY;
}
