import { sql } from "drizzle-orm";

import { sha256Hex } from "./crypto.server.ts";
import type { Db } from "./db.server.ts";
import { rateLimited } from "./errors.ts";

/**
 * レート制限。
 *
 * Cloudflare の Rate limiting rules は Free プランだとゾーン全体で1つしか
 * 持てず、同じゾーンにぶら下がる全サービスで1枠を取り合う。エッジ側は
 * 当てにできないので、★アプリ側で必ず持つ★。
 *
 * 保存先は PostgreSQL。KV や Durable Object のほうが速いが、MVP では
 * 依存を増やさず、統合テストでそのまま検証できることを優先した。
 * 1操作あたり1往復（ON CONFLICT の upsert）で済ませている。
 */

export interface RateLimitPolicy {
  /** 窓の長さ（秒） */
  readonly windowSeconds: number;
  /** 窓の中で許す回数 */
  readonly max: number;
}

/**
 * 名前付きの制限。
 *
 * 認証まわりを厳しくしているのは、6桁 OTP が100万通りしかないため。
 * 総当たりを現実的な時間で成立させないことが目的。
 */
export const RATE_LIMITS = {
  /** ログインメールの送信要求（IP 単位） */
  authRequestByIp: { windowSeconds: 600, max: 10 },
  /**
   * ログインメールの送信要求（IP 単位・1日）。
   *
   * ★10分の窓だけでは1日の総量が抑えられない。★ 600秒10回は待てば
   * 1日1,440通になり、1つの IP だけで Resend の無料枠（1日100通）を
   * 14倍超過させられる。枠が尽きた瞬間、このサイトは合言葉が無い
   * （メールでしかログインできない）ので★全員が締め出される★。
   * 窓を短くすると正規の利用者が困るので、1日の総量を別に持つ。
   */
  authRequestByIpDaily: { windowSeconds: 86_400, max: 50 },
  /** ログインメールの送信要求（アドレス単位）。他人のアドレスへの嫌がらせ送信も抑える */
  authRequestByEmail: { windowSeconds: 600, max: 5 },
  /** ログインメールの送信要求（アドレス単位・1日） */
  authRequestByEmailDaily: { windowSeconds: 86_400, max: 20 },
  /** OTP・リンクの検証（IP 単位） */
  authVerifyByIp: { windowSeconds: 600, max: 20 },
  /** OTP の検証（トークン単位） */
  authVerifyByToken: { windowSeconds: 900, max: 5 },
  /** 投稿の下書き作成 */
  listingCreate: { windowSeconds: 3600, max: 20 },
  /** Checkout Session の作成。決済事業者側の乱用も防ぐ */
  checkoutCreate: { windowSeconds: 3600, max: 20 },
  /** メッセージ送信 */
  messageSend: { windowSeconds: 300, max: 30 },
  /**
   * 会話の開始。
   *
   * ★GET でも行が増える経路がある。★ /listings/:id/contact のローダーは
   * ensureThread を呼ぶので、開いただけで会話が1つできる。同じ投稿への
   * 2回目は増えないが、投稿を変えれば何度でも増やせて、そのたびに
   * 相手の受信箱に並ぶ。読むだけに見える操作に上限が要る。
   */
  threadCreate: { windowSeconds: 3600, max: 30 },
  /** 通報 */
  reportCreate: { windowSeconds: 3600, max: 10 },
  /** 画像アップロード */
  imageUpload: { windowSeconds: 3600, max: 60 },
  /** 問い合わせフォーム */
  contactSend: { windowSeconds: 3600, max: 5 },
  /** 管理画面の第3層 */
  adminGate: { windowSeconds: 900, max: 10 },
  /**
   * ★サービス全体で1日に送るメールの総量。★
   *
   * IP 単位・アドレス単位の制限は「1人あたり」しか見ない。分散した
   * 送信要求（IP を変える、アドレスを変える）は素通りする。送信事業者の
   * 枠が尽きると、ログインコードも決済通知も一切届かなくなる
   * ＝ サービス全停止と同じなので、蛇口そのものにも上限を置く。
   *
   * 運用向けの通知（ops_*）はこの上限の対象外にしてある。
   * 上限に当たったことを知らせる経路まで一緒に止めたら意味がない。
   */
  emailGlobalDaily: { windowSeconds: 86_400, max: 400 },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitName = keyof typeof RATE_LIMITS;

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly count: number;
  readonly remaining: number;
  readonly resetAt: Date;
}

/**
 * 制限の鍵。
 *
 * ★IP やメールアドレスをそのまま鍵にしない。★ そうすると rate_limits 表が
 * そのまま「誰がいつアクセスしたか」の一覧になる。用途と主体を混ぜて
 * ハッシュにしてから使う。
 */
async function buildKey(name: RateLimitName, subject: string): Promise<string> {
  return sha256Hex(`ratelimit:${name}:${subject}`);
}

/**
 * 1回分を数えて、超えているかを返す。
 *
 * 窓が切れていれば同じ UPDATE の中でリセットする。読んでから書くと、
 * 同時アクセスで両方が「まだ余裕がある」と判断してすり抜ける。
 */
export async function consumeRateLimit(
  db: Db,
  name: RateLimitName,
  subject: string,
): Promise<RateLimitResult> {
  const policy = RATE_LIMITS[name];
  const key = await buildKey(name, subject);
  const windowInterval = `${policy.windowSeconds} seconds`;

  const rows = await db.execute<{ count: number; expires_at: Date }>(sql`
    insert into rate_limits (key, count, window_started_at, expires_at)
    values (${key}, 1, now(), now() + ${windowInterval}::interval)
    on conflict (key) do update set
      count = case
        when rate_limits.expires_at <= now() then 1
        else rate_limits.count + 1
      end,
      window_started_at = case
        when rate_limits.expires_at <= now() then now()
        else rate_limits.window_started_at
      end,
      expires_at = case
        when rate_limits.expires_at <= now() then now() + ${windowInterval}::interval
        else rate_limits.expires_at
      end
    returning count, expires_at
  `);

  const row = rows.rows[0];
  const count = Number(row?.count ?? 1);
  const resetAt = row?.expires_at
    ? new Date(row.expires_at)
    : new Date(Date.now() + policy.windowSeconds * 1000);

  return {
    allowed: count <= policy.max,
    count,
    remaining: Math.max(0, policy.max - count),
    resetAt,
  };
}

/** 超えていたら 429 で止める。ハンドラの入口で使う */
export async function enforceRateLimit(
  db: Db,
  name: RateLimitName,
  subject: string,
): Promise<void> {
  const result = await consumeRateLimit(db, name, subject);
  if (!result.allowed) {
    throw rateLimited(
      `rate limit ${name} exceeded (count=${result.count})`,
    );
  }
}

/**
 * 期限切れの行を掃除する。定期処理から呼ぶ。
 * 放っておいても正しさは保たれるが、表が延々と太る。
 */
export async function purgeExpiredRateLimits(db: Db): Promise<number> {
  const result = await db.execute(
    sql`delete from rate_limits where expires_at <= now() - interval '1 day'`,
  );
  return result.rowCount ?? 0;
}
