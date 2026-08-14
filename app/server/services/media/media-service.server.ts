import { and, eq, isNull, lte, sql } from "drizzle-orm";

import { listingImages, listings } from "~/db/schema/index.ts";
import {
  CONTENT_TYPE_BY_FORMAT,
  inspectImage,
  stripImageMetadata,
} from "~/domain/image-inspect";
import {
  IMAGE_PURGE_GRACE_DAYS,
  MAX_IMAGES_PER_LISTING,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MIN_IMAGE_DIMENSION,
} from "~/domain/image-limits";
import { ulid } from "~/domain/ulid.ts";
import { sha256Hex } from "../../crypto.server.ts";
import type { Db } from "../../db.server.ts";
import type { AppEnv } from "../../env.server.ts";
import { AppError, notFound } from "../../errors.ts";
import type { Logger } from "../../logger.server.ts";

/**
 * 写真の保存と配信。
 *
 * ★方式は「Workers 経由」。★ 署名付きの直アップロードは、検査を挟めないまま
 * オブジェクトが出来上がる。「アップロード済みだが検査に落ちた」孤立オブジェクトが
 * 必ず生まれ、掃除の仕組みが別に要る。Workers を通せば、検査を通ったものだけが
 * R2 に置かれる。1枚 5MB までなので Workers の制限にも収まる。
 *
 * ★R2 のアクセスキーを発行しない。★ binding 経由でしか触らない。
 * 鍵が無ければ、鍵が漏れることもない。
 */

// 上限値は domain/image-limits.ts。画面の案内文でも同じ値を使うため。

export interface UploadResult {
  readonly imageId: string;
  readonly objectKey: string;
  readonly width: number;
  readonly height: number;
}

function invalidImage(userMessage: string, detail: string): AppError {
  return new AppError("validation_failed", userMessage, {
    detail,
    fields: { image: userMessage },
  });
}

/**
 * 画像を1枚受け取って R2 へ置く。
 * 呼ぶ前に「その投稿がこの利用者のものか」を必ず確かめること。
 */
export async function uploadListingImage(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  listingId: string;
  file: File;
}): Promise<UploadResult> {
  const { db, env, logger, listingId, file } = options;

  if (file.size === 0) {
    throw invalidImage("ファイルが空です。", "empty file");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw invalidImage(
      `1枚あたり${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MBまでです。`,
      `file too large: ${file.size}`,
    );
  }

  const existing = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(listingImages)
    .where(
      and(
        eq(listingImages.listingId, listingId),
        isNull(listingImages.deletedAt),
      ),
    );
  const currentCount = existing[0]?.count ?? 0;
  if (currentCount >= MAX_IMAGES_PER_LISTING) {
    throw invalidImage(
      `写真は1件につき${MAX_IMAGES_PER_LISTING}枚までです。`,
      `image limit reached: ${currentCount}`,
    );
  }

  const original = new Uint8Array(await file.arrayBuffer());

  // ★Content-Type ではなく実体で判定する。★
  const info = inspectImage(original);
  if (!info) {
    throw invalidImage(
      "対応していない画像形式です。JPEG・PNG・WebP をご利用ください。",
      "signature not recognised (svg and others are rejected here)",
    );
  }
  if (
    info.width > MAX_IMAGE_DIMENSION ||
    info.height > MAX_IMAGE_DIMENSION
  ) {
    throw invalidImage(
      `画像の縦横は${MAX_IMAGE_DIMENSION}ピクセルまでです。`,
      `dimensions too large: ${info.width}x${info.height}`,
    );
  }
  if (
    info.width < MIN_IMAGE_DIMENSION ||
    info.height < MIN_IMAGE_DIMENSION
  ) {
    throw invalidImage(
      `画像の縦横は${MIN_IMAGE_DIMENSION}ピクセル以上にしてください。`,
      `dimensions too small: ${info.width}x${info.height}`,
    );
  }

  // ★位置情報を含むメタデータを落とす。★ 自宅で撮った写真の GPS 座標が
  // そのまま公開されるのを防ぐ。
  const sanitized = stripImageMetadata(original, info.format);

  const imageId = ulid();
  // ★利用者が付けたファイル名を使わない。★ 推測困難なキーを自前で作る。
  const objectKey = `listings/${listingId}/${imageId}`;
  const checksum = await sha256Hex(sanitized);

  await env.MEDIA.put(objectKey, sanitized, {
    httpMetadata: {
      contentType: CONTENT_TYPE_BY_FORMAT[info.format],
      // 配信は Worker が制御する。R2 側のキャッシュ指示は控えめにしておく。
      cacheControl: "private, max-age=0",
    },
    customMetadata: {
      listingId,
      // ★元のファイル名を保存しない。★ 氏名が入っていることがある。
      format: info.format,
    },
  });

  await db.insert(listingImages).values({
    id: imageId,
    listingId,
    objectKey,
    contentType: CONTENT_TYPE_BY_FORMAT[info.format],
    byteSize: sanitized.byteLength,
    width: info.width,
    height: info.height,
    checksumSha256: checksum,
    position: currentCount,
  });

  logger.info("listing image stored", {
    listingId,
    format: info.format,
    bytes: sanitized.byteLength,
  });

  return {
    imageId,
    objectKey,
    width: info.width,
    height: info.height,
  };
}

/** 写真を外す。実体は猶予期間の後にまとめて消す */
export async function removeListingImage(options: {
  db: Db;
  imageId: string;
  listingId: string;
}): Promise<void> {
  const now = new Date();
  await options.db
    .update(listingImages)
    .set({
      deletedAt: now,
      purgeAfter: new Date(
        now.getTime() + IMAGE_PURGE_GRACE_DAYS * 24 * 60 * 60 * 1000,
      ),
    })
    .where(
      and(
        eq(listingImages.id, options.imageId),
        eq(listingImages.listingId, options.listingId),
      ),
    );
}

export interface MediaAccess {
  readonly allowed: boolean;
  readonly objectKey: string;
  readonly contentType: string;
  /** 公開中の投稿の画像だけ長くキャッシュしてよい */
  readonly cacheable: boolean;
}

/**
 * 配信してよいかを判断する。
 *
 * ★下書き・決済待ちの画像は所有者と管理者だけ。★ 投稿が公開される前に
 * 画像 URL だけが漏れると、公開前の内容が読めてしまう。
 */
export async function resolveMediaAccess(options: {
  db: Db;
  objectKey: string;
  viewer: { id: string; role: "user" | "admin" } | null;
}): Promise<MediaAccess> {
  const rows = await options.db
    .select({
      objectKey: listingImages.objectKey,
      contentType: listingImages.contentType,
      listingStatus: listings.status,
      ownerId: listings.ownerId,
      deletedAt: listingImages.deletedAt,
    })
    .from(listingImages)
    .innerJoin(listings, eq(listings.id, listingImages.listingId))
    .where(eq(listingImages.objectKey, options.objectKey))
    .limit(1);

  const row = rows[0];
  if (!row || row.deletedAt) {
    throw notFound(`media not found: ${options.objectKey}`);
  }

  const isPublic = row.listingStatus === "published";
  if (isPublic) {
    return {
      allowed: true,
      objectKey: row.objectKey,
      contentType: row.contentType,
      cacheable: true,
    };
  }

  const viewer = options.viewer;
  const canSee =
    viewer !== null && (viewer.role === "admin" || viewer.id === row.ownerId);

  if (!canSee) {
    // 存在も知らせない。
    throw notFound(`media access denied: ${options.objectKey}`);
  }

  return {
    allowed: true,
    objectKey: row.objectKey,
    contentType: row.contentType,
    cacheable: false,
  };
}

/**
 * 猶予を過ぎた画像を R2 から実際に消す。定期処理から呼ぶ。
 *
 * ★DB の行を消す前に R2 を消す。★ 逆にすると、DB から辿れないのに実体が
 * 残る「誰も知らないオブジェクト」が生まれ、二度と回収できない。
 */
export async function purgeDeletedImages(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  limit?: number;
}): Promise<number> {
  const { db, env, logger } = options;

  const due = await db
    .select({ id: listingImages.id, objectKey: listingImages.objectKey })
    .from(listingImages)
    .where(lte(listingImages.purgeAfter, new Date()))
    .limit(options.limit ?? 200);

  let purged = 0;
  for (const row of due) {
    try {
      await env.MEDIA.delete(row.objectKey);
      await db.delete(listingImages).where(eq(listingImages.id, row.id));
      purged += 1;
    } catch (error) {
      // ★キーをログへ出さない。★ 件数だけを残す。
      logger.error("failed to purge media object", error);
    }
  }
  return purged;
}
