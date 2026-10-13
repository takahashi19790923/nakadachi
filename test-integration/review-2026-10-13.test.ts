import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { conversationThreads, reports, users } from "~/db/schema/index.ts";
import { appContext, type AppContext } from "~/server/app-context";
import { csrfCookieName, issueCsrfToken } from "~/server/csrf.server";
import type { Db } from "~/server/db.server";
import { addBannedWord } from "~/server/repositories/moderation-repository.server";
import { setUserStatus } from "~/server/repositories/user-repository.server";
import { RATE_LIMITS } from "~/server/rate-limit.server";
import { createSession } from "~/server/session.server";
import { closeTestDb, makeDraft, makeUser, resetDatabase, testEnv, testLogger } from "./helpers.ts";

import { action as rawContactAction } from "~/routes/listings.contact";
import { action as rawEditAction } from "~/routes/listings.edit";

/**
 * ★2026-10-13 のレビューで直した3件を、挙動で固定する。★
 *
 * どれも «画面には何も出ない» 壊れ方だった。直した後の見た目は直す前と同じなので、
 * 目で見ても気づけない。だから「直す前のコードなら赤になる」形で書く。
 *   1. 公開中の編集が、要確認の語の照合を通っていなかった。
 *   2. POST /listings/:id/contact に回数の上限が無かった（GET の loader だけにあった）。
 *   3. 退会済みの利用者に、管理者の «復帰» が効いて active に戻っていた。
 */

type RouteFn = (args: {
  request: Request;
  context: RouterContextProvider;
  params: Record<string, string>;
}) => Promise<unknown>;

let db: Db;
const env = testEnv();

beforeEach(async () => {
  db = await resetDatabase();
});

afterAll(async () => {
  await closeTestDb();
});

async function signIn(userId: string): Promise<string> {
  const { setCookie } = await createSession({
    db,
    env,
    userId,
    request: new Request(env.APP_ORIGIN),
  });
  return setCookie.slice(0, setCookie.indexOf(";"));
}

function makeContext(): RouterContextProvider {
  const context = new RouterContextProvider();
  const app: AppContext = {
    env,
    ctx: {} as ExecutionContext,
    defer: () => undefined,
    getDb: () => db,
    logger: testLogger,
    nonce: "test-nonce",
    requestId: "test-request",
    setCookie: () => undefined,
    csrfToken: "",
  };
  context.set(appContext, app);
  return context;
}

/** write-limits.test.ts と同じ形。ルートの action を直接呼ぶ。3xx の Response は成功（message: null）として扱う */
async function post(
  fn: RouteFn,
  path: string,
  cookies: string,
  params: Record<string, string>,
  form: Record<string, string>,
): Promise<{ message?: string | null }> {
  const { token, cookieValue } = await issueCsrfToken(env);
  const request = new Request(new URL(path, env.APP_ORIGIN), {
    method: "POST",
    headers: {
      origin: env.APP_ORIGIN,
      "content-type": "application/x-www-form-urlencoded",
      cookie: `${cookies}; ${csrfCookieName(env)}=${cookieValue}`,
    },
    body: new URLSearchParams({ ...form, _csrf: token }),
  });
  const asResult = (value: unknown): { message?: string | null } => {
    // action が redirect() を return する形（listings.edit・listings.contact）。3xx だけを成功とする。
    // ★404 などは飲み込まない。★ 飲み込むと、正常に通っていない送信まで «通った» に数える。
    if (value instanceof Response) {
      if (value.status >= 300 && value.status < 400) return { message: null };
      throw new Error(`想定外の応答 ${value.status}`, { cause: value });
    }
    return value as { message?: string | null };
  };
  try {
    return asResult(await fn({ request, context: makeContext(), params }));
  } catch (thrown) {
    // redirect を throw する形にも備える。
    if (thrown instanceof Response) return asResult(thrown);
    if (typeof thrown === "object" && thrown !== null && "init" in thrown) {
      return { message: (thrown as { data?: { message?: string } }).data?.message ?? null };
    }
    throw thrown;
  }
}

const LIMITED = "操作が続けて";

/** 公開中の投稿にする上書き */
function published() {
  return {
    status: "published" as const,
    publishedAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
  };
}

/** 売ります・譲りますの編集フォーム（listing-intake.test.ts の sellForm と同じ中身） */
function editForm(body: string): Record<string, string> {
  return {
    categorySlug: "sell-buy",
    kind: "sell",
    title: "テスト用の投稿",
    body,
    priceType: "fixed",
    priceJpy: "1000",
    priceUnit: "once",
    itemCondition: "good",
    handoverMethod: "either",
    prefectureCode: "13",
    cityCode: "13107",
    durationDays: "30",
  };
}

describe("★公開中の編集も、要確認の語の照合を通る★", () => {
  /*
   * 以前は支払いの成立のときだけ flagPublishedListing を呼んでいた。無難な内容で公開してから
   * 編集で書き換えると、確認待ち（通報）に入らず、そのまま公開が続いた。
   * flagPublishedListing 自体の検査は moderation-flag.test.ts。ここは «編集のルートが呼ぶか»。
   */
  const FLAG_WORD = "テスト用要確認語";

  it("要確認の語を入れて保存すると、その投稿に通報が1件できる（公開は止めない）", async () => {
    const admin = await makeUser(db, "flag-admin@example.test", "admin");
    await addBannedWord(db, { word: FLAG_WORD, severity: "flag", createdBy: admin.id });

    const owner = await makeUser(db, "edit-flag-owner@example.test");
    const listingId = await makeDraft(db, owner.id, published());
    const cookies = await signIn(owner.id);

    // 編集の前は通報が無い（公開しただけでは鳴らない）。
    expect(await db.select().from(reports)).toHaveLength(0);

    const result = await post(
      rawEditAction as unknown as RouteFn,
      `/listings/${listingId}/edit`,
      cookies,
      { listingId },
      editForm(`これは説明文です。${FLAG_WORD}を含みます。十分な長さがあります。`),
    );
    // 保存は通っている（検証で落ちて 0 件になっていないことの確認）。
    expect(result.message ?? null).toBeNull();

    const rows = await db.select().from(reports);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetListingId).toBe(listingId);
  });

  it("要確認の語が無い編集では、通報は増えない", async () => {
    const admin = await makeUser(db, "flag-admin2@example.test", "admin");
    await addBannedWord(db, { word: FLAG_WORD, severity: "flag", createdBy: admin.id });

    const owner = await makeUser(db, "edit-clean-owner@example.test");
    const listingId = await makeDraft(db, owner.id, published());
    const cookies = await signIn(owner.id);

    const result = await post(
      rawEditAction as unknown as RouteFn,
      `/listings/${listingId}/edit`,
      cookies,
      { listingId },
      editForm("ふつうの説明文です。十分な長さがあります。"),
    );
    expect(result.message ?? null).toBeNull();

    // 「鳴れば緑」だけだと、全部の編集に通報が付いていても緑になる。
    expect(await db.select().from(reports)).toHaveLength(0);
  });
});

describe("★問い合わせの POST にも回数の上限がある★", () => {
  /*
   * 以前は GET（loader）だけに上限があり、POST を繰り返せば会話（相手の受信箱の行）を
   * 上限なしに作れた。投稿を変えながら送れば、1つのアカウントから好きなだけ積める。
   */
  it("threadCreate の上限を超えた回は «操作が続けて行われました» で止まり、会話は増えない", async () => {
    const owner = await makeUser(db, "contact-owner@example.test");
    const inquirer = await makeUser(db, "contact-inquirer@example.test");
    const max = RATE_LIMITS.threadCreate.max;

    // 投稿は max+1 件。同じ投稿への問い合わせは «同じ1本» に戻るだけなので、上限の検査には投稿ごとに送る。
    const listingIds: string[] = [];
    for (let i = 0; i < max + 1; i += 1) {
      listingIds.push(await makeDraft(db, owner.id, { ...published(), title: `問い合わせ用の投稿 ${i + 1}` }));
    }
    const cookies = await signIn(inquirer.id);

    const send = (listingId: string) =>
      post(rawContactAction as unknown as RouteFn, `/listings/${listingId}/contact`, cookies, { listingId }, {});

    for (let i = 0; i < max; i += 1) {
      const result = await send(listingIds[i]!);
      // 上限の下では成功（redirect → message: null）。
      expect(result.message ?? null, `${i + 1}回目`).toBeNull();
    }
    const over = await send(listingIds[max]!);
    expect(over.message ?? "", "上限を超えた回").toContain(LIMITED);

    // 止まった回は会話を作っていない。
    const threads = await db
      .select({ listingId: conversationThreads.listingId })
      .from(conversationThreads)
      .where(eq(conversationThreads.initiatorId, inquirer.id));
    expect(threads).toHaveLength(max);
    expect(threads.map((row) => row.listingId)).not.toContain(listingIds[max]);
  });
});

describe("★退会済みの利用者には、停止・復帰が効かない★", () => {
  /*
   * 以前は WHERE が id だけだった。退会済みの ID に «復帰» を送ると active に戻り、
   * 退会したはずの人が生き返った上に、監査ログには «復帰» だけが残った。
   */
  it("退会済みには false を返し、行は変わらない", async () => {
    const user = await makeUser(db, "deleted-user@example.test");
    await db
      .update(users)
      .set({ status: "deleted", deletedAt: new Date() })
      .where(eq(users.id, user.id));

    const restored = await setUserStatus(db, { userId: user.id, status: "active", reason: null });
    expect(restored).toBe(false);
    const suspended = await setUserStatus(db, { userId: user.id, status: "suspended", reason: "テスト" });
    expect(suspended).toBe(false);

    const [row] = await db
      .select({ status: users.status, deletedAt: users.deletedAt, suspendedReason: users.suspendedReason })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row!.status).toBe("deleted");
    expect(row!.deletedAt).not.toBeNull();
    expect(row!.suspendedReason).toBeNull();
  });

  it("対照: 普通の利用者には効く（停止 → 復帰）", async () => {
    const user = await makeUser(db, "normal-user@example.test");

    expect(await setUserStatus(db, { userId: user.id, status: "suspended", reason: "テスト" })).toBe(true);
    const [suspended] = await db.select({ status: users.status }).from(users).where(eq(users.id, user.id));
    expect(suspended!.status).toBe("suspended");

    expect(await setUserStatus(db, { userId: user.id, status: "active", reason: null })).toBe(true);
    const [active] = await db.select({ status: users.status }).from(users).where(eq(users.id, user.id));
    expect(active!.status).toBe("active");
  });
});
