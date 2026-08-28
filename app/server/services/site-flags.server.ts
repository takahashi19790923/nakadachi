import { eq } from "drizzle-orm";

import { siteFlags } from "~/db/schema/index.ts";
import type { Db } from "../db.server.ts";
import { AppError } from "../errors.ts";

/**
 * 運用の切り替えスイッチ。
 *
 * ★事故のときに「止める」手段が、再デプロイしかなかった。★
 * 「掲載の受付だけ止めたい」「登録だけ止めたい」ができず、手順書にも
 * 「Workers のルートを外す」（＝全部止まる）としか書いていなかった。
 *
 * ★担当するのは「サイトは動いているが、ある機能だけ止めたい」。★
 * DB ごと落ちているときの全停止は Cloudflare 側（ルートを外す）で行う。
 * ここは DB を読むので、DB が死んでいれば当然使えない。
 *
 * ★リクエストごとに DB を読まない。★ Worker のアイソレートは複数の
 * リクエストにまたがって生きるので、短い時間だけ手元に持つ。
 * 30秒あれば、事故に気づいて止めてから反映されるまでの体感は変わらず、
 * 平常時の問い合わせはほぼ消える。
 */

const CACHE_TTL_MS = 30_000;
const ROW_ID = "singleton";

export interface SiteFlags {
  readonly signupsPaused: boolean;
  readonly listingsPaused: boolean;
  readonly messagesPaused: boolean;
  readonly notice: string | null;
}

/** 何も止まっていない状態。行が無いときはこれ */
const ALL_RUNNING: SiteFlags = {
  signupsPaused: false,
  listingsPaused: false,
  messagesPaused: false,
  notice: null,
};

let cached: { value: SiteFlags; at: number } | null = null;

/**
 * いまの状態。
 *
 * ★読めなければ「全部動いている」とみなす（fail-open）。★
 * ここを fail-close にすると、表を作り忘れた環境や移行の途中で
 * サイトが真っ白になる。止めるのは人が明示的に止めたときだけ。
 */
export async function getSiteFlags(db: Db, now = Date.now()): Promise<SiteFlags> {
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  try {
    const rows = await db
      .select({
        signupsPaused: siteFlags.signupsPaused,
        listingsPaused: siteFlags.listingsPaused,
        messagesPaused: siteFlags.messagesPaused,
        notice: siteFlags.notice,
      })
      .from(siteFlags)
      .where(eq(siteFlags.id, ROW_ID))
      .limit(1);

    const value = rows[0] ?? ALL_RUNNING;
    cached = { value, at: now };
    return value;
  } catch {
    // 表がまだ無い・DB が読めない。止めない。
    return ALL_RUNNING;
  }
}

/** 管理画面から切り替える。反映は最大30秒（キャッシュのぶん）遅れる */
export async function setSiteFlags(
  db: Db,
  adminId: string,
  next: Partial<SiteFlags>,
): Promise<SiteFlags> {
  const values = {
    id: ROW_ID,
    signupsPaused: next.signupsPaused ?? false,
    listingsPaused: next.listingsPaused ?? false,
    messagesPaused: next.messagesPaused ?? false,
    notice: next.notice?.slice(0, 300) || null,
    updatedBy: adminId,
    updatedAt: new Date(),
  };

  await db
    .insert(siteFlags)
    .values(values)
    .onConflictDoUpdate({ target: siteFlags.id, set: values });

  // 切り替えた本人にはすぐ反映されてほしい。
  cached = null;
  return values;
}

/** 検査から手元の記憶を捨てる */
export function clearSiteFlagsCache(): void {
  cached = null;
}

/**
 * 止まっている機能を使おうとしたときの断り。
 *
 * ★利用者に「何が起きているか」を伝える。★ 素の 500 や、何も言わずに
 * 失敗する画面にしない。案内文があればそれを出す。
 */
export function pausedError(kind: "signup" | "listing" | "message", notice: string | null): AppError {
  const fallback =
    kind === "signup"
      ? "ただいま新規のご登録を一時的に停止しています。"
      : kind === "listing"
        ? "ただいま新しい投稿の受付を一時的に停止しています。"
        : "ただいまメッセージの送信を一時的に停止しています。";

  return new AppError("conflict", notice?.trim() || fallback, {
    detail: `paused: ${kind}`,
  });
}
