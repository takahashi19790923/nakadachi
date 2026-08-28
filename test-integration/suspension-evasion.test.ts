import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { users } from "~/db/schema/index.ts";
import { emailIndexHmac } from "~/server/crypto.server";
import type { Db } from "~/server/db.server";
import { createUser } from "~/server/repositories/user-repository.server";
import { RATE_LIMITS } from "~/server/rate-limit.server";
import { requestLoginCode } from "~/server/services/auth-service.server";

import { closeTestDb, resetDatabase, testEnv, testLogger } from "./helpers.ts";

/**
 * 利用停止の回避。
 *
 * ★止めた側からは、回避されたことが見えない。★
 * 新しいアカウントは正常に作られ、どこにもエラーが出ない。
 * 詐欺で止めた相手が戻ってきていても、気づく方法が無かった。
 *
 * 2026-08-25 の公開前監査で指摘。正規化が小文字化だけだったので、
 * taro@gmail.com を止めても t.aro@gmail.com で再登録できた。
 */
let db: Db;
const env = testEnv();

function req(): Request {
  return new Request("http://localhost:5273/login", {
    method: "POST",
    headers: { "cf-connecting-ip": "192.0.2.9" },
  });
}

/** ログインコードを求めて、実際にトークンが作られたか（＝通ったか）を返す */
async function requestAccepted(email: string): Promise<boolean> {
  const before = await countTokens();
  await requestLoginCode({ db, env, logger: testLogger, request: req(), email });
  return (await countTokens()) > before;
}

async function countTokens(): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from email_verification_tokens`,
  );
  return Number(rows.rows[0]?.n ?? 0);
}

async function suspend(email: string) {
  const hmac = await emailIndexHmac(env.EMAIL_INDEX_KEY!, email);
  await createUser(db, env, { email, emailHmac: hmac });
  await db.update(users).set({ status: "suspended" }).where(eq(users.emailHmac, hmac));
}

describe("利用停止の回避", () => {
  beforeEach(async () => {
    db = await resetDatabase();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  /*
   * ★1回の it で試す書き方を4つまでにしてある。★
   * アドレス単位の制限が「同じ受信箱で5回まで」なので、6つ並べると
   * 6件目が «停止で弾かれた» のか «回数で弾かれた» のか区別できない。
   * 回数のほうは下の it で別に確かめる。
   */
  it("★点や +タグを足した別アドレスでも、停止した相手は通さない★", async () => {
    await suspend("taro@gmail.com");

    for (const variant of [
      "taro@gmail.com",
      "t.a.r.o@gmail.com",
      "taro+new@gmail.com",
      "TARO@Googlemail.com",
    ]) {
      expect(await requestAccepted(variant), variant).toBe(false);
    }
  });

  it("★無関係な人は巻き込まない★", async () => {
    await suspend("taro@gmail.com");

    for (const other of [
      "jiro@gmail.com",
      "taro@example.com",
      // gmail 以外では点の有無で別人になりうるので、同一視しない。
      "t.aro@example.com",
    ]) {
      expect(await requestAccepted(other), other).toBe(true);
    }
  });

  it("停止していない利用者は、別の書き方でも通る", async () => {
    const hmac = await emailIndexHmac(env.EMAIL_INDEX_KEY!, "active@gmail.com");
    await createUser(db, env, { email: "active@gmail.com", emailHmac: hmac });

    expect(await requestAccepted("active@gmail.com")).toBe(true);
    expect(await requestAccepted("a.ctive+x@gmail.com")).toBe(true);
  });

  /*
   * ★回数も «受信箱» で数える。★
   * 以前はアドレスちょうどで数えていたので、+タグを変えるだけで
   * 何通でも送らせられた。送信事業者の枠を空にされる経路になる。
   */
  it("★+タグを変えても、同じ受信箱として回数に数える★", async () => {
    const max = RATE_LIMITS.authRequestByEmail.max;

    for (let i = 0; i < max; i += 1) {
      expect(await requestAccepted(`hana+${i}@gmail.com`), `${i}`).toBe(true);
    }

    // max を超えた分は弾かれる（別のタグでも同じ箱として数えている）。
    await expect(
      requestLoginCode({
        db,
        env,
        logger: testLogger,
        request: req(),
        email: `hana+over@gmail.com`,
      }),
    ).rejects.toThrow();
  });
});
