import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { listings, reports } from "~/db/schema/index.ts";
import type { Db } from "~/server/db.server";
import { countOpenReports } from "~/server/repositories/moderation-repository.server";
import { flagPublishedListing } from "~/server/services/listing-service.server";

import {
  closeTestDb,
  makeDraft,
  makeUser,
  resetDatabase,
  testLogger,
} from "./helpers.ts";

/**
 * 要確認ワード（severity=flag）の検知。
 *
 * ★2026-08-28 まで、これは何も起きていなかった。★
 * findFlaggedWords は定義だけで一度も呼ばれておらず、flag として
 * 登録された語（本番に6件）は検知しても素通りしていた。
 * 登録した側は「見張られている」と思っていたのに、実際には何もない。
 *
 * ★この壊れ方は画面に一切出ない。★ 投稿は正常に公開され、エラーも
 * 警告も出ない。「効いていない」と気づく方法が無かった。だから検査で固定する。
 *
 * 正常側（flag の語を含まない投稿では鳴らない）も見る。
 * 「鳴れば緑」だけだと、全部の投稿に通報が付いていても緑になる。
 */
let db: Db;

/** seed に入っている flag の語。block とは別物 */
const FLAG_WORD = "高額報酬即日";
const BLOCK_WORD = "闇バイト";

async function systemReports() {
  return db
    .select({ id: reports.id, detail: reports.detail, status: reports.status })
    .from(reports)
    .where(isNull(reports.reporterId));
}

describe("要確認ワードの検知", () => {
  beforeEach(async () => {
    db = await resetDatabase();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("★flag の語を含む掲載は、管理者の確認待ちに入る★", async () => {
    const user = await makeUser(db, "flag-owner@example.test");
    const listingId = await makeDraft(db, user.id, {
      title: `急募 ${FLAG_WORD}`,
      status: "published",
    });

    expect(await countOpenReports(db)).toBe(0);

    await flagPublishedListing({ db, logger: testLogger, listingId });

    // 通報一覧（管理ダッシュボードが数えている画面）に出ること。
    expect(await countOpenReports(db)).toBe(1);

    const rows = await systemReports();
    expect(rows).toHaveLength(1);
    // ★通報者は null。★ 人間の通報者はいない。誰かのIDを入れると嘘になる。
    expect(rows[0]!.status).toBe("open");
    // 語そのものは書かない（一覧に不快な語だけが並ぶのを避ける）。
    expect(rows[0]!.detail).toContain("自動検知");
    expect(rows[0]!.detail).not.toContain(FLAG_WORD);
  });

  it("★flag の語が無ければ鳴らない★", async () => {
    const user = await makeUser(db, "clean-owner@example.test");
    const listingId = await makeDraft(db, user.id, {
      title: "ふつうの家具をゆずります",
      status: "published",
    });

    await flagPublishedListing({ db, logger: testLogger, listingId });

    expect(await countOpenReports(db)).toBe(0);
    expect(await systemReports()).toHaveLength(0);
  });

  it("公開は止めない（flag は «通したうえで確認する» ための印）", async () => {
    const user = await makeUser(db, "flag-published@example.test");
    const listingId = await makeDraft(db, user.id, {
      title: `${FLAG_WORD} の案件`,
      status: "published",
    });

    await flagPublishedListing({ db, logger: testLogger, listingId });

    const [row] = await db
      .select({ status: listings.status })
      .from(listings)
      .where(eq(listings.id, listingId));
    expect(row!.status).toBe("published");
  });

  it("同じ掲載で二重に作らない（未対応のものがある間）", async () => {
    const user = await makeUser(db, "flag-dup@example.test");
    const listingId = await makeDraft(db, user.id, {
      title: `${FLAG_WORD} の案件`,
      status: "published",
    });

    await flagPublishedListing({ db, logger: testLogger, listingId });
    await flagPublishedListing({ db, logger: testLogger, listingId });

    expect(await systemReports()).toHaveLength(1);
  });

  it("★対応済みのあとに再発したら、新しく作る★", async () => {
    const user = await makeUser(db, "flag-again@example.test");
    const listingId = await makeDraft(db, user.id, {
      title: `${FLAG_WORD} の案件`,
      status: "published",
    });

    await flagPublishedListing({ db, logger: testLogger, listingId });
    // 管理者が対応した。
    await db
      .update(reports)
      .set({ status: "actioned", resolvedAt: new Date() })
      .where(isNull(reports.reporterId));

    /*
     * ★一意索引で恒久的に塞がない理由。★ 一度対応した相手が同じことを
     * 繰り返しても、二度と検知されない状態になってしまう。
     */
    await flagPublishedListing({ db, logger: testLogger, listingId });

    expect(await systemReports()).toHaveLength(2);
    expect(await countOpenReports(db)).toBe(1);
  });

  it("block の語は、そもそも保存の時点で弾かれる（別の仕組み）", async () => {
    // ここは既存の検査の担当範囲。flag と block を混同しないための覚え書き。
    const { findBlockingWord, findFlaggedWords } = await import(
      "~/server/repositories/moderation-repository.server"
    );
    expect(await findBlockingWord(db, `これは ${BLOCK_WORD} です`)).toBe(BLOCK_WORD);
    expect(await findFlaggedWords(db, `これは ${BLOCK_WORD} です`)).toEqual([]);
    expect(await findFlaggedWords(db, `これは ${FLAG_WORD} です`)).toContain(
      FLAG_WORD,
    );
  });
});
