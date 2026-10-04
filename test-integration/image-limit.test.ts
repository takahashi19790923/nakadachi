import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { listingImages } from "~/db/schema/index.ts";
import { MAX_IMAGES_PER_LISTING } from "~/domain/image-limits";
import type { Db } from "~/server/db.server";
import { uploadListingImage } from "~/server/services/media/media-service.server";
import { closeTestDb, makeDraft, makeUser, resetDatabase, testEnv, testLogger } from "./helpers.ts";

/**
 * 写真の枚数の上限（監査 SEC-04 の一部）。
 *
 * 枚数の確認と保存は、投稿の行を FOR UPDATE で押さえた1つのトランザクションの中で行う。
 * ★ここで確かめるのは «上限が効くこと» と «その経路が動くこと» まで。★
 * 同時に送られた2枚が上限をすり抜ける競合そのものは、検査用の PGlite が問い合わせを
 * 1本ずつしか処理しないので再現できない（行の押さえで防ぐのは PostgreSQL の通常の挙動）。
 */

let db: Db;
const stored: string[] = [];
const env = {
  ...testEnv(),
  MEDIA: {
    put: (key: string) => {
      stored.push(key);
      return Promise.resolve({});
    },
  } as unknown as R2Bucket,
};

beforeEach(async () => {
  db = await resetDatabase();
  stored.length = 0;
});

afterAll(async () => {
  await closeTestDb();
});

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const length = bytes(
    (data.length >> 24) & 0xff,
    (data.length >> 16) & 0xff,
    (data.length >> 8) & 0xff,
    data.length & 0xff,
  );
  // CRC は検査していないのでダミーでよい（test/image-inspect.test.ts と同じ）。
  return concat(length, new TextEncoder().encode(type), data, bytes(0, 0, 0, 0));
}

/** 100×100 の PNG（形の検査を通る最小限） */
function png(): File {
  const ihdr = pngChunk("IHDR", bytes(0, 0, 0, 100, 0, 0, 0, 100, 8, 6, 0, 0, 0));
  const body = concat(
    bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    ihdr,
    pngChunk("IDAT", bytes(0x78, 0x9c, 0x01)),
    pngChunk("IEND", new Uint8Array(0)),
  );
  // slice() で ArrayBuffer を持つ写しにする（File は SharedArrayBuffer を受け取らない型）。
  return new File([body.slice()], "photo.png", { type: "image/png" });
}

async function liveCount(listingId: string): Promise<number> {
  const rows = await db
    .select({ id: listingImages.id })
    .from(listingImages)
    .where(and(eq(listingImages.listingId, listingId), isNull(listingImages.deletedAt)));
  return rows.length;
}

describe("写真の枚数の上限", () => {
  it(`${MAX_IMAGES_PER_LISTING}枚までは置け、次の1枚は断られて保存もされない`, async () => {
    const owner = await makeUser(db, "photo@example.test");
    const listingId = await makeDraft(db, owner.id);

    for (let i = 0; i < MAX_IMAGES_PER_LISTING; i += 1) {
      const result = await uploadListingImage({ db, env, logger: testLogger, listingId, file: png() });
      expect(result.width).toBe(100);
    }
    expect(await liveCount(listingId)).toBe(MAX_IMAGES_PER_LISTING);
    expect(stored).toHaveLength(MAX_IMAGES_PER_LISTING);

    await expect(
      uploadListingImage({ db, env, logger: testLogger, listingId, file: png() }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(await liveCount(listingId)).toBe(MAX_IMAGES_PER_LISTING);
    expect(stored).toHaveLength(MAX_IMAGES_PER_LISTING);
  });

  it("R2 に置けなかったら、行も足さない", async () => {
    const owner = await makeUser(db, "putfail@example.test");
    const listingId = await makeDraft(db, owner.id);
    const failing = {
      ...env,
      MEDIA: { put: () => Promise.reject(new Error("r2 down")) } as unknown as R2Bucket,
    };
    await expect(
      uploadListingImage({ db, env: failing, logger: testLogger, listingId, file: png() }),
    ).rejects.toThrow("r2 down");
    expect(await liveCount(listingId)).toBe(0);
  });

  it("★投稿が無ければ、R2 に置く前に止める★（DB から辿れない物を残さない）", async () => {
    // 退会や保持期間の掃除で投稿が消えた直後に届いた写真を想定する。
    const missingListingId = "01JQZZZZZZZZZZZZZZZZZZZZZZ";
    let thrown: unknown;
    try {
      await uploadListingImage({ db, env, logger: testLogger, listingId: missingListingId, file: png() });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
    expect(stored).toHaveLength(0);
  });

  it("並び順は置いた順に 0 から振られる", async () => {
    const owner = await makeUser(db, "order@example.test");
    const listingId = await makeDraft(db, owner.id);
    for (let i = 0; i < 3; i += 1) {
      await uploadListingImage({ db, env, logger: testLogger, listingId, file: png() });
    }
    const rows = await db
      .select({ position: listingImages.position })
      .from(listingImages)
      .where(eq(listingImages.listingId, listingId));
    expect(rows.map((row) => row.position).sort()).toEqual([0, 1, 2]);
  });
});
