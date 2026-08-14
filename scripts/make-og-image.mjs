import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

/**
 * OGP 用の画像を作る。
 *
 *   node scripts/make-og-image.mjs
 *
 * ★これは仮の画像。★ 単色に帯を1本引いただけのもの。
 * 本番公開の前に、サービス名の入った 1200×630 の画像へ差し替えること
 * （README の「人間が用意するもの」に記載）。
 *
 * 外部ライブラリを使わずに書いているのは、依存を1つ増やしてまで
 * やる作業ではないため。PNG は「ヘッダ + IDAT(zlib) + IEND」で作れる。
 */

const WIDTH = 1200;
const HEIGHT = 630;

/** 藍（背景）と柿（帯）。app/app.css の配色と合わせている */
const BACKGROUND = [45, 75, 94];
const ACCENT = [217, 100, 45];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

// 各行は「フィルタ種別(0) + RGB の並び」
const raw = Buffer.alloc(HEIGHT * (1 + WIDTH * 3));
let offset = 0;
for (let y = 0; y < HEIGHT; y += 1) {
  raw[offset] = 0;
  offset += 1;
  // 下から 1/6 のあたりに帯を1本
  const inBand = y > HEIGHT * 0.72 && y < HEIGHT * 0.76;
  const color = inBand ? ACCENT : BACKGROUND;
  for (let x = 0; x < WIDTH; x += 1) {
    raw[offset] = color[0];
    raw[offset + 1] = color[1];
    raw[offset + 2] = color[2];
    offset += 3;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(WIDTH, 0);
ihdr.writeUInt32BE(HEIGHT, 4);
ihdr[8] = 8; // ビット深度
ihdr[9] = 2; // カラータイプ: トゥルーカラー
ihdr[10] = 0; // 圧縮方式
ihdr[11] = 0; // フィルタ方式
ihdr[12] = 0; // インターレース無し

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync("public/og-default.png", png);
console.log(`public/og-default.png を作成しました（${WIDTH}x${HEIGHT}、仮の画像）。`);
