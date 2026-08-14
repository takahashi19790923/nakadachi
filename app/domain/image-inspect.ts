/**
 * 画像の実体判定・寸法読み取り・メタデータ除去。
 *
 * ★ファイル名も Content-Type も信用しない。★ どちらも送信側が自由に決められる。
 * 先頭バイトの並び（シグネチャ）で実体を判定する。
 *
 * ★SVG は受け付けない。★ SVG は XML で、script や外部参照を書ける。
 * 画像として配信すると、同一オリジンでのスクリプト実行につながる。
 *
 * バイト列だけを扱う純粋な処理なので、DB もネットワークも要らずに
 * 単体テストできる（test/image-inspect.test.ts）。
 */

export type ImageFormat = "jpeg" | "png" | "webp";

export const ALLOWED_IMAGE_FORMATS: readonly ImageFormat[] = [
  "jpeg",
  "png",
  "webp",
];

export const CONTENT_TYPE_BY_FORMAT: Readonly<Record<ImageFormat, string>> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export interface ImageInfo {
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

/** 先頭バイトから実体を判定する。判定できなければ null */
export function detectImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "png";
  }
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && // "RIFF"
    bytes.length >= 12 &&
    bytes[8] === 0x57 && // "W"
    bytes[9] === 0x45 && // "E"
    bytes[10] === 0x42 && // "B"
    bytes[11] === 0x50 // "P"
  ) {
    return "webp";
  }
  return null;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) >>> 0) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) +
    ((bytes[offset + 1] ?? 0) << 8) +
    ((bytes[offset + 2] ?? 0) << 16) +
    (((bytes[offset + 3] ?? 0) << 24) >>> 0)
  );
}

// ── JPEG ──────────────────────────────────────────────────────────

/** 寸法が書かれているマーカー。SOF0〜SOF15（DHT/JPG/DAC を除く） */
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function readJpegDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  let offset = 2; // SOI をとばす
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1; // 詰め物。1バイトずつ進めて次のマーカーを探す
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    // スタンドアロンのマーカー（長さを持たない）
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // 画像データに入った
    const length = readUint16BE(bytes, offset + 2);
    if (length < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      // セグメント: 長さ(2) 精度(1) 高さ(2) 幅(2)
      return {
        height: readUint16BE(bytes, offset + 5),
        width: readUint16BE(bytes, offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * JPEG から APPn と COM を落とす。
 * Exif（APP1）に入っている ★GPS 座標・撮影日時・端末名★ がここで消える。
 * ICC プロファイル（APP2）も落ちるので、色味がわずかに変わることがある。
 * 位置情報が残るリスクのほうが大きいので、まとめて落とす。
 */
function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [bytes.subarray(0, 2)]; // SOI
  let offset = 2;

  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      // 想定外の並び。ここから先はそのまま通す（壊すより残す）。
      chunks.push(bytes.subarray(offset));
      return concat(chunks);
    }
    const marker = bytes[offset + 1] ?? 0;

    if (marker === 0xda) {
      // SOS 以降はエントロピー符号化データ。最後までそのまま。
      chunks.push(bytes.subarray(offset));
      return concat(chunks);
    }
    if (marker === 0xd9) {
      chunks.push(bytes.subarray(offset, offset + 2));
      return concat(chunks);
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      chunks.push(bytes.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }

    const length = readUint16BE(bytes, offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) {
      chunks.push(bytes.subarray(offset));
      return concat(chunks);
    }

    const isAppSegment = marker >= 0xe0 && marker <= 0xef;
    const isComment = marker === 0xfe;
    if (!isAppSegment && !isComment) {
      chunks.push(bytes.subarray(offset, offset + 2 + length));
    }
    offset += 2 + length;
  }

  return concat(chunks);
}

// ── PNG ───────────────────────────────────────────────────────────

/** 落とすチャンク。テキスト・時刻・Exif */
const PNG_STRIP_CHUNKS = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);

function readPngDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  // 署名(8) + 長さ(4) + "IHDR"(4) のあとに 幅(4) 高さ(4)
  if (bytes.length < 24) return null;
  return {
    width: readUint32BE(bytes, 16),
    height: readUint32BE(bytes, 20),
  };
}

function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [bytes.subarray(0, 8)]; // 署名
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = readUint32BE(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    );
    const total = 12 + length; // 長さ(4) + 種別(4) + データ + CRC(4)
    if (offset + total > bytes.length) break;

    if (!PNG_STRIP_CHUNKS.has(type)) {
      chunks.push(bytes.subarray(offset, offset + total));
    }
    offset += total;
    if (type === "IEND") break;
  }

  return concat(chunks);
}

// ── WebP ──────────────────────────────────────────────────────────

const WEBP_STRIP_CHUNKS = new Set(["EXIF", "XMP "]);

function readWebpDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  let offset = 12; // "RIFF"(4) + サイズ(4) + "WEBP"(4)
  while (offset + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(
      bytes[offset] ?? 0,
      bytes[offset + 1] ?? 0,
      bytes[offset + 2] ?? 0,
      bytes[offset + 3] ?? 0,
    );
    const size = readUint32LE(bytes, offset + 4);
    const dataStart = offset + 8;

    if (fourcc === "VP8X" && dataStart + 10 <= bytes.length) {
      // フラグ(1) + 予約(3) + 幅-1(3, LE) + 高さ-1(3, LE)
      const width =
        1 +
        ((bytes[dataStart + 4] ?? 0) |
          ((bytes[dataStart + 5] ?? 0) << 8) |
          ((bytes[dataStart + 6] ?? 0) << 16));
      const height =
        1 +
        ((bytes[dataStart + 7] ?? 0) |
          ((bytes[dataStart + 8] ?? 0) << 8) |
          ((bytes[dataStart + 9] ?? 0) << 16));
      return { width, height };
    }
    if (fourcc === "VP8 " && dataStart + 10 <= bytes.length) {
      // フレームタグ(3) + 開始コード 9d 01 2a(3) のあとに 幅(2) 高さ(2)
      const width = readUint16LE(bytes, dataStart + 6) & 0x3fff;
      const height = readUint16LE(bytes, dataStart + 8) & 0x3fff;
      return { width, height };
    }
    if (fourcc === "VP8L" && dataStart + 5 <= bytes.length) {
      // 署名(1) のあと 14ビットずつ（幅-1・高さ-1）が詰まっている
      const b1 = bytes[dataStart + 1] ?? 0;
      const b2 = bytes[dataStart + 2] ?? 0;
      const b3 = bytes[dataStart + 3] ?? 0;
      const b4 = bytes[dataStart + 4] ?? 0;
      const width = 1 + (((b2 & 0x3f) << 8) | b1);
      const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
      return { width, height };
    }

    offset = dataStart + size + (size % 2); // チャンクは偶数境界に揃う
  }
  return null;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function stripWebpMetadata(bytes: Uint8Array): Uint8Array {
  const kept: Uint8Array[] = [];
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(
      bytes[offset] ?? 0,
      bytes[offset + 1] ?? 0,
      bytes[offset + 2] ?? 0,
      bytes[offset + 3] ?? 0,
    );
    const size = readUint32LE(bytes, offset + 4);
    const total = 8 + size + (size % 2);
    if (offset + total > bytes.length) break;

    if (!WEBP_STRIP_CHUNKS.has(fourcc)) {
      kept.push(bytes.subarray(offset, offset + total));
    }
    offset += total;
  }

  const payloadLength = kept.reduce((sum, chunk) => sum + chunk.length, 0);
  // "WEBP"(4) + 残したチャンク。RIFF のサイズを書き直さないと壊れる。
  const out = new Uint8Array(12 + payloadLength);
  out.set(bytes.subarray(0, 12), 0);
  writeUint32LE(out, 4, 4 + payloadLength);
  let cursor = 12;
  for (const chunk of kept) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >> 24) & 0xff;
}

// ── 共通 ──────────────────────────────────────────────────────────

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** 実体と寸法をまとめて調べる。判定できなければ null */
export function inspectImage(bytes: Uint8Array): ImageInfo | null {
  const format = detectImageFormat(bytes);
  if (!format) return null;

  const dimensions =
    format === "jpeg"
      ? readJpegDimensions(bytes)
      : format === "png"
        ? readPngDimensions(bytes)
        : readWebpDimensions(bytes);

  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    return null;
  }
  return { format, ...dimensions };
}

/**
 * 位置情報を含むメタデータを可能な範囲で落とす。
 *
 * ★「可能な範囲で」と書いているのは、完全な除去を保証できないため。★
 * 未知の拡張チャンクや、画像データ自体に埋め込まれた情報は残りうる。
 * 利用者への注意表示と併用する前提。
 */
export function stripImageMetadata(
  bytes: Uint8Array,
  format: ImageFormat,
): Uint8Array {
  switch (format) {
    case "jpeg":
      return stripJpegMetadata(bytes);
    case "png":
      return stripPngMetadata(bytes);
    case "webp":
      return stripWebpMetadata(bytes);
  }
}
