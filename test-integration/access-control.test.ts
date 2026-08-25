import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { listingImages, listings, users } from "~/db/schema/index.ts";
import { ulid } from "~/domain/ulid";
import type { Db } from "~/server/db.server";
import { assertOwner } from "~/server/guards.server";
import {
  getPublishedListing,
  searchListings,
} from "~/server/repositories/listing-repository.server";
import { resolveMediaAccess } from "~/server/services/media/media-service.server";
import {
  ensureThread,
  getThreadMessages,
  sendMessage,
} from "~/server/services/message-service.server";
import { transitionListing } from "~/server/services/listing-service.server";
import {
  listFavorites,
  setBlock,
  toggleFavorite,
} from "~/server/services/engagement-service.server";
import { closeTestDb, makeDraft, makeUser, resetDatabase } from "./helpers.ts";

/**
 * 権限まわり。
 *
 * ★「画面にボタンが無い」は防御ではない。★ ここではサービス層を
 * 直接叩いて、他人のデータへ到達できないことを確かめる。
 */
let db: Db;
let owner: { id: string };
let stranger: { id: string };
let admin: { id: string };

beforeEach(async () => {
  db = await resetDatabase();
  owner = await makeUser(db, "owner@example.test");
  stranger = await makeUser(db, "stranger@example.test");
  admin = await makeUser(db, "admin@example.test", "admin");
});

afterAll(async () => {
  await closeTestDb();
});

describe("下書きの閲覧", () => {
  it("★他人の下書きは公開ページから見えない★", async () => {
    const listingId = await makeDraft(db, owner.id);
    expect(await getPublishedListing(db, listingId)).toBeNull();
  });

  it("★決済待ちの投稿も公開ページから見えない★", async () => {
    const listingId = await makeDraft(db, owner.id, { status: "payment_pending" });
    expect(await getPublishedListing(db, listingId)).toBeNull();
  });

  it("★非公開にされた投稿は見えない★", async () => {
    const listingId = await makeDraft(db, owner.id, { status: "suspended" });
    expect(await getPublishedListing(db, listingId)).toBeNull();
  });

  it("★期限切れの投稿は、状態が published のままでも見えない★", async () => {
    const listingId = await makeDraft(db, owner.id, {
      status: "published",
      publishedAt: new Date(Date.now() - 100_000),
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await getPublishedListing(db, listingId)).toBeNull();

    // 検索結果にも出ない
    const result = await searchListings(db, { sort: "newest", page: 1, perPage: 20 });
    expect(result.items.map((item) => item.id)).not.toContain(listingId);
  });
});

describe("所有者の確認", () => {
  it("★他人の投稿には 404 を返す（存在すら知らせない）★", () => {
    let thrown: unknown;
    try {
      assertOwner(owner.id, {
        id: stranger.id,
        role: "user",
        status: "active",
        sessionId: "x",
      });
    } catch (error) {
      thrown = error;
    }

    // ★Response であること自体が要件。★ Error を投げると React Router が
    // 一律 500 にしてしまい、掲載終了・不存在・他人の下書きがすべて
    // 「サーバー障害」として索引に残る。
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
    // 理由を本文に載せない（所有者IDが漏れる）
    expect((thrown as Response).body).toBeNull();
  });

  it("本人なら通る", () => {
    expect(() =>
      assertOwner(owner.id, {
        id: owner.id,
        role: "user",
        status: "active",
        sessionId: "x",
      }),
    ).not.toThrow();
  });

  /*
   * ★管理者も «所有者» としては通さない。★
   *
   * この検査は 2026-08-25 の公開前監査で**期待する側を逆にした**。
   * それまでは「管理者は通る」ことを確かめていて、実装にも
   * `if (user.role === "admin") return;` があった。
   *
   * assertOwner の呼び出し元はすべて /listings/* の利用者向け画面で、
   * 第1層（メールログイン）しか通っていない。つまり★管理者のメールボックスを
   * 取れば、第2層（管理者の再認証）も第3層（共通の資格情報）も通らずに、
   * 他人の下書き・写真を読み、他人の掲載を書き換え・終了できた。★
   * しかも admin_actions に何も残らないので、後から誰が触ったか分からない。
   *
   * 管理者が他人のものに触る経路は /admin/* に寄せてある。あちらは
   * 3層すべてを通り、理由の入力を必須にして writeAdminAction で記録する。
   */
  it("★管理者でも、他人の «所有者» としては通さない★", () => {
    let thrown: unknown;
    try {
      assertOwner(owner.id, {
        id: admin.id,
        role: "admin",
        status: "active",
        sessionId: "x",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });
});

describe("画像の配信権限", () => {
  async function addImage(listingId: string): Promise<string> {
    const id = ulid();
    const objectKey = `listings/${listingId}/${id}`;
    await db.insert(listingImages).values({
      id,
      listingId,
      objectKey,
      contentType: "image/jpeg",
      byteSize: 1000,
      width: 800,
      height: 600,
      checksumSha256: "0".repeat(64),
      position: 0,
    });
    return objectKey;
  }

  it("公開中の投稿の画像は誰でも見られる", async () => {
    const listingId = await makeDraft(db, owner.id, {
      status: "published",
      publishedAt: new Date(),
    });
    const key = await addImage(listingId);

    const access = await resolveMediaAccess({ db, objectKey: key, viewer: null });
    expect(access.allowed).toBe(true);
    expect(access.cacheable).toBe(true);
  });

  it("★下書きの画像は他人から見えない★", async () => {
    const listingId = await makeDraft(db, owner.id);
    const key = await addImage(listingId);

    await expect(
      resolveMediaAccess({ db, objectKey: key, viewer: null }),
    ).rejects.toThrow();
    await expect(
      resolveMediaAccess({
        db,
        objectKey: key,
        viewer: { id: stranger.id, role: "user" },
      }),
    ).rejects.toThrow();
  });

  it("下書きの画像は所有者と管理者だけが見られる", async () => {
    const listingId = await makeDraft(db, owner.id);
    const key = await addImage(listingId);

    const asOwner = await resolveMediaAccess({
      db,
      objectKey: key,
      viewer: { id: owner.id, role: "user" },
    });
    expect(asOwner.allowed).toBe(true);
    // 共有キャッシュに残さない
    expect(asOwner.cacheable).toBe(false);

    const asAdmin = await resolveMediaAccess({
      db,
      objectKey: key,
      viewer: { id: admin.id, role: "admin" },
    });
    expect(asAdmin.allowed).toBe(true);
  });

  it("存在しないキーは 404", async () => {
    await expect(
      resolveMediaAccess({ db, objectKey: "listings/x/y", viewer: null }),
    ).rejects.toThrow();
  });
});

describe("メッセージの当事者制限", () => {
  async function publishedListing(): Promise<string> {
    return makeDraft(db, owner.id, {
      status: "published",
      publishedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
  }

  it("問い合わせるとスレッドが1本できる", async () => {
    const listingId = await publishedListing();
    const first = await ensureThread({ db, listingId, inquirerId: stranger.id });
    const second = await ensureThread({ db, listingId, inquirerId: stranger.id });
    expect(first.threadId).toBe(second.threadId);
  });

  it("自分の投稿には問い合わせできない", async () => {
    const listingId = await publishedListing();
    await expect(
      ensureThread({ db, listingId, inquirerId: owner.id }),
    ).rejects.toThrow();
  });

  it("公開されていない投稿には問い合わせできない", async () => {
    const listingId = await makeDraft(db, owner.id);
    await expect(
      ensureThread({ db, listingId, inquirerId: stranger.id }),
    ).rejects.toThrow();
  });

  it("★当事者以外は会話を読めない★", async () => {
    const listingId = await publishedListing();
    const { threadId } = await ensureThread({
      db,
      listingId,
      inquirerId: stranger.id,
    });
    const outsider = await makeUser(db, "outsider@example.test");

    await expect(
      getThreadMessages({
        db,
        threadId,
        viewerId: outsider.id,
        viewerRole: "user",
      }),
    ).rejects.toThrow();
  });

  it("★当事者以外は送信できない★", async () => {
    const listingId = await publishedListing();
    const { threadId } = await ensureThread({
      db,
      listingId,
      inquirerId: stranger.id,
    });
    const outsider = await makeUser(db, "outsider2@example.test");

    await expect(
      sendMessage({ db, threadId, senderId: outsider.id, body: "こんにちは" }),
    ).rejects.toThrow();
  });

  it("当事者どうしはやり取りできる", async () => {
    const listingId = await publishedListing();
    const { threadId } = await ensureThread({
      db,
      listingId,
      inquirerId: stranger.id,
    });

    await sendMessage({
      db,
      threadId,
      senderId: stranger.id,
      body: "まだ残っていますか？",
    });
    await sendMessage({
      db,
      threadId,
      senderId: owner.id,
      body: "はい、あります。",
    });

    const thread = await getThreadMessages({
      db,
      threadId,
      viewerId: owner.id,
      viewerRole: "user",
    });
    expect(thread.messages).toHaveLength(2);
  });

  it("★ブロックしている相手とは会話を開けない★", async () => {
    const listingId = await publishedListing();
    await setBlock({
      db,
      blockerId: owner.id,
      blockedId: stranger.id,
      intent: "block",
    });

    await expect(
      ensureThread({ db, listingId, inquirerId: stranger.id }),
    ).rejects.toThrow();
  });

  it("ブロック後は送信もできない", async () => {
    const listingId = await publishedListing();
    const { threadId } = await ensureThread({
      db,
      listingId,
      inquirerId: stranger.id,
    });
    await setBlock({
      db,
      blockerId: owner.id,
      blockedId: stranger.id,
      intent: "block",
    });

    await expect(
      sendMessage({ db, threadId, senderId: stranger.id, body: "しつこく連絡" }),
    ).rejects.toThrow();
  });

  it("禁止ワードを含むメッセージは送れない", async () => {
    const listingId = await publishedListing();
    const { threadId } = await ensureThread({
      db,
      listingId,
      inquirerId: stranger.id,
    });

    await expect(
      sendMessage({
        db,
        threadId,
        senderId: stranger.id,
        body: "口座売ります。連絡ください",
      }),
    ).rejects.toThrow();
  });
});

describe("状態遷移の強制", () => {
  it("★下書きから直接公開できない★", async () => {
    const listingId = await makeDraft(db, owner.id);
    await expect(
      transitionListing(db, { listingId, to: "published", actor: "owner" }),
    ).rejects.toThrow();
    const rows = await db
      .select({ status: listings.status })
      .from(listings)
      .where(eq(listings.id, listingId));
    expect(rows[0]!.status).toBe("draft");
  });

  it("★掲載終了から公開へ戻せない★", async () => {
    const listingId = await makeDraft(db, owner.id, { status: "closed" });
    await expect(
      transitionListing(db, { listingId, to: "published", actor: "admin" }),
    ).rejects.toThrow();
  });

  it("expectedFrom を指定すると、状態が違えば何もしない", async () => {
    const listingId = await makeDraft(db, owner.id, { status: "draft" });
    const result = await transitionListing(db, {
      listingId,
      to: "published",
      actor: "system",
      expectedFrom: "payment_pending",
    });
    expect(result.changed).toBe(false);
  });
});

describe("管理者の権限", () => {
  it("管理者だけが投稿を非公開にできる", async () => {
    const listingId = await makeDraft(db, owner.id, {
      status: "published",
      publishedAt: new Date(),
    });

    await expect(
      transitionListing(db, {
        listingId,
        to: "suspended",
        actor: "owner",
        moderationReason: "本人が止めようとした",
      }),
    ).rejects.toThrow();

    await transitionListing(db, {
      listingId,
      to: "suspended",
      actor: "admin",
      moderationReason: "規約違反のため",
    });

    const rows = await db
      .select({ status: listings.status, reason: listings.moderationReason })
      .from(listings)
      .where(eq(listings.id, listingId));
    expect(rows[0]!.status).toBe("suspended");
    expect(rows[0]!.reason).toBe("規約違反のため");
  });

  it("役割は DB 上のロールで決まる", async () => {
    const rows = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, admin.id));
    expect(rows[0]!.role).toBe("admin");
  });
});

/**
 * 自分の下書きを消せること。
 *
 * ★UI に入口が無かった。★ 一覧には「確認して公開する／編集／写真」しか
 * なく、作ってしまった投稿を利用者が自分で片づけられなかった。
 * 下書きは掲載終了と違って保持期間の対象外なので、置きっぱなしのまま
 * 永久に残る（2026-08-17 に利用者の指摘で発覚）。
 */
describe("★自分の下書きを削除できる★", () => {
  it("下書きは本人が削除できる", async () => {
    const db = await resetDatabase();
    const owner = await makeUser(db, "draft-owner@example.test");
    const listingId = await makeDraft(db, owner.id, { status: "draft" });

    const result = await transitionListing(db, {
      listingId,
      to: "deleted",
      actor: "owner",
    });
    expect(result.changed).toBe(true);
  });

  it("決済待ちも本人が削除できる（まだ払っていない）", async () => {
    const db = await resetDatabase();
    const owner = await makeUser(db, "pending-owner@example.test");
    const listingId = await makeDraft(db, owner.id, { status: "payment_pending" });

    const result = await transitionListing(db, {
      listingId,
      to: "deleted",
      actor: "owner",
    });
    expect(result.changed).toBe(true);
  });

  it("★決済の確認中は本人でも削除できない★", async () => {
    /*
     * 支払いが成立するかもしれない状態。ここで消せると、
     * 「支払い成立の通知が来たのに投稿が無い」が起きる。
     * 画面ではボタンを出さず、理由を書いている。
     */
    const db = await resetDatabase();
    const owner = await makeUser(db, "processing-owner@example.test");
    const listingId = await makeDraft(db, owner.id, {
      status: "payment_processing",
    });

    await expect(
      transitionListing(db, { listingId, to: "deleted", actor: "owner" }),
    ).rejects.toThrow();
  });
});

describe("★お気に入りの一覧は ID で引く★", () => {
  it("新着から外れた古い掲載でも、公開中なら出る", async () => {
    /*
     * 以前は「新着200件を取ってから JS で突き合わせる」だった。
     * サイト全体で200件を超えると、古めの掲載をお気に入りにした人には
     * 公開中なのに「掲載が終了したため表示していません」と出た。
     */
    const db = await resetDatabase();
    const seller = await makeUser(db, "seller-old@example.test");
    const fan = await makeUser(db, "fan@example.test");

    // 古い掲載を1件、そのあとに新しい掲載を多数。
    const old = await makeDraft(db, seller.id, {
      status: "published",
      publishedAt: new Date(Date.now() - 100 * 86_400_000),
      expiresAt: new Date(Date.now() + 10 * 86_400_000),
    });
    for (let i = 0; i < 5; i++) {
      await makeDraft(db, seller.id, {
        status: "published",
        publishedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      });
    }
    // 公開中にお気に入りへ入れたあとで掲載終了したものも1件（件数に出る側）。
    const closed = await makeDraft(db, seller.id, {
      status: "published",
      publishedAt: new Date(Date.now() - 50 * 86_400_000),
      expiresAt: new Date(Date.now() + 5 * 86_400_000),
    });

    await toggleFavorite({ db, userId: fan.id, listingId: old, desired: "add" });
    await toggleFavorite({ db, userId: fan.id, listingId: closed, desired: "add" });
    await transitionListing(db, { listingId: closed, to: "closed", actor: "owner" });

    const ids = (await listFavorites(db, fan.id)).map((f) => f.listingId);
    // 「新着N件」に頼らず、ID で絞ったときだけ古い掲載が出る。
    const result = await searchListings(db, {
      ids,
      sort: "newest",
      page: 1,
      perPage: 3, // 新着だけ見る実装なら old は落ちる件数
    });
    expect(result.items.map((item) => item.id)).toEqual([old]);
    // 掲載終了したものは公開中でないので出ない。
    expect(result.total).toBe(1);
  });

  it("お気に入りが空なら何も一致させない", async () => {
    const db = await resetDatabase();
    const seller = await makeUser(db, "seller-empty@example.test");
    await makeDraft(db, seller.id, {
      status: "published",
      publishedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    const result = await searchListings(db, { ids: [], sort: "newest", page: 1, perPage: 10 });
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});
