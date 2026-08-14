/**
 * 写真の上限値。
 *
 * ★依存を持たない専用ファイルにしている。★ 投稿の写真編集画面
 * （クライアント側）が案内文でこの値を使うため、サービス層に置くと
 * ブラウザ側バンドルへ R2 まわりごと引き込まれ、ビルドが落ちる。
 *
 * ★画面の案内とサーバー側の検査で同じ値を使うこと。★ 別々に書くと
 * 「案内は5MBまでなのに3MBで弾かれる」のような食い違いが生まれる。
 */

/** 1枚あたりの上限。大きくすると Workers のメモリと実行時間を圧迫する */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 投稿1件あたりの枚数上限 */
export const MAX_IMAGES_PER_LISTING = 10;

/** 縦横の上限。極端に大きな画像は復号だけで端末を止める */
export const MAX_IMAGE_DIMENSION = 6000;

/** 小さすぎる画像は誤操作の可能性が高い */
export const MIN_IMAGE_DIMENSION = 100;

/** 論理削除から実体削除までの猶予（日）。誤操作からの復旧余地を残す */
export const IMAGE_PURGE_GRACE_DAYS = 30;

export const MAX_IMAGE_MEGABYTES = Math.floor(MAX_IMAGE_BYTES / 1024 / 1024);
