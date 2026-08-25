import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { emailDeliveryLogs } from "~/db/schema/index.ts";
import type { Db } from "~/server/db.server";
import { RATE_LIMITS } from "~/server/rate-limit.server";
import {
  sendEmail,
  type EmailTemplateName,
} from "~/server/services/email/email-service.server";

import { closeTestDb, resetDatabase, testEnv, testLogger } from "./helpers.ts";

/**
 * メール送信の門番。
 *
 * ★実際の DB へ当てる。★ ここで守りたいことは2つとも、
 * SQL の書き方（on conflict の where、カウンタの原子性）に依存していて、
 * 模擬した DB では確かめたことにならない。
 *
 * 1. 一度失敗した通知が再送できること
 *    ── 「行がある」を「送れた」と読むと、その日の異常が永久に届かない
 * 2. 1日の総量に上限があること
 *    ── 送信事業者の枠が尽きるとログインできる人が誰もいなくなる
 *
 * RESEND_API_KEY を入れないので、実際の送信は起きない
 * （not_configured で failed の行が残る）。それがそのまま
 * 「一度失敗した状態」の材料になる。
 */
let db: Db;

/**
 * ★送信鍵をわざと外す。★ 外部へ実際に出さないためと、
 * 「一度失敗した行」を副作用なしに作るため。
 * 本番でこの状態になることは無い（isProduction の分岐で先に落ちる）。
 */
const env = { ...testEnv(), RESEND_API_KEY: undefined };

const OPTIONS = {
  to: "budget-test@example.com",
  template: "login_code",
  content: { subject: "s", html: "<p>h</p>", text: "t" },
} as const;

function send(idempotencyKey: string, template: EmailTemplateName = OPTIONS.template) {
  return sendEmail(
    { ...OPTIONS, template, idempotencyKey },
    { db, env, logger: testLogger },
  );
}

async function statusOf(idempotencyKey: string) {
  const rows = await db
    .select({
      status: emailDeliveryLogs.status,
      errorCode: emailDeliveryLogs.errorCode,
    })
    .from(emailDeliveryLogs)
    .where(eq(emailDeliveryLogs.idempotencyKey, idempotencyKey));
  return rows[0];
}

describe("メール送信の門番", () => {
  beforeEach(async () => {
    db = await resetDatabase();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("一度失敗した通知は、同じ冪等キーでも再送を試みる", async () => {
    // 1回目。鍵が無いので failed で終わる。
    const first = await send("retry-me");
    expect(first.sent).toBe(false);
    expect(first.skipped).toBe("not_configured");
    expect((await statusOf("retry-me"))?.status).toBe("failed");

    /*
     * 2回目。★ここが本題。★ 以前は行があるだけで duplicate を返し、
     * 「送った」ことにしていた。failed なら掴み直して再挑戦する。
     */
    const second = await send("retry-me");
    expect(second.skipped).not.toBe("duplicate");
    expect(second.skipped).toBe("not_configured");
  });

  it("送信済み（sent）の行は掴み直さない", async () => {
    await send("already-sent");
    await db
      .update(emailDeliveryLogs)
      .set({ status: "sent", errorCode: null })
      .where(eq(emailDeliveryLogs.idempotencyKey, "already-sent"));

    const again = await send("already-sent");
    expect(again.sent).toBe(false);
    expect(again.skipped).toBe("duplicate");
    // 掴み直していない＝ sent のままであること。
    expect((await statusOf("already-sent"))?.status).toBe("sent");
  });

  it("1日の総量を超えると止まり、over_budget として記録に残る", async () => {
    const max = RATE_LIMITS.emailGlobalDaily.max;

    // 枠を使い切る。
    for (let i = 0; i < max; i += 1) {
      const result = await send(`budget-${i}`);
      expect(result.skipped).toBe("not_configured");
    }

    const overflow = await send("budget-overflow");
    expect(overflow.sent).toBe(false);
    expect(overflow.skipped).toBe("over_budget");

    const row = await statusOf("budget-overflow");
    expect(row?.status).toBe("failed");
    expect(row?.errorCode).toBe("over_budget");
  });

  it("運用向けの通知は総量の上限で止まらない", async () => {
    const max = RATE_LIMITS.emailGlobalDaily.max;
    for (let i = 0; i < max; i += 1) {
      await send(`ops-fill-${i}`);
    }

    // 利用者向けは止まる。
    expect((await send("ops-user-mail")).skipped).toBe("over_budget");

    /*
     * ★運用向けは通る。★ 枠が尽きたことを知らせる経路まで
     * 一緒に止めたら、誰も気づけない。
     */
    const ops = await send("ops-alert", "ops_payment_alert");
    expect(ops.skipped).toBe("not_configured");
    expect(ops.skipped).not.toBe("over_budget");
  });
});
