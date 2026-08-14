import { describe, expect, it } from "vitest";

import {
  detectImageFormat,
  inspectImage,
  stripImageMetadata,
} from "~/domain/image-inspect";

/**
 * 画像の判定とメタデータ除去。
 *
 * ★ネットワークもファイルも使わず、バイト列を組み立てて検査する。★
 * 画像処理は「それらしく動いているが実は落としていない」が起きやすく、
 * 実際のバイト列で確かめないと意味がない。
 */

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 最小限の JPEG。SOI + APP1(Exif) + SOF0 + SOS + EOI */
function makeJpeg(options: { width: number; height: number; exif?: boolean }) {
  const soi = bytes(0xff, 0xd8);
  const exifPayload = new TextEncoder().encode("Exif\0\0GPSLatitude35.7");
  const app1 = options.exif
    ? concat(
        bytes(0xff, 0xe1),
        bytes(((exifPayload.length + 2) >> 8) & 0xff, (exifPayload.length + 2) & 0xff),
        exifPayload,
      )
    : new Uint8Array(0);
  const sof = bytes(
    0xff,
    0xc0,
    0x00,
    0x11, // 長さ 17
    0x08, // 精度
    (options.height >> 8) & 0xff,
    options.height & 0xff,
    (options.width >> 8) & 0xff,
    options.width & 0xff,
    0x03,
    0x01, 0x22, 0x00,
    0x02, 0x11, 0x01,
    0x03, 0x11, 0x01,
  );
  const sos = bytes(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00);
  const data = bytes(0x12, 0x34, 0x56);
  const eoi = bytes(0xff, 0xd9);
  return concat(soi, app1, sof, sos, data, eoi);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const length = bytes(
    (data.length >> 24) & 0xff,
    (data.length >> 16) & 0xff,
    (data.length >> 8) & 0xff,
    data.length & 0xff,
  );
  const typeBytes = new TextEncoder().encode(type);
  const crc = bytes(0, 0, 0, 0); // 検査していないのでダミーでよい
  return concat(length, typeBytes, data, crc);
}

function makePng(options: { width: number; height: number; text?: boolean }) {
  const signature = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const ihdr = pngChunk(
    "IHDR",
    bytes(
      (options.width >> 24) & 0xff,
      (options.width >> 16) & 0xff,
      (options.width >> 8) & 0xff,
      options.width & 0xff,
      (options.height >> 24) & 0xff,
      (options.height >> 16) & 0xff,
      (options.height >> 8) & 0xff,
      options.height & 0xff,
      8, 6, 0, 0, 0,
    ),
  );
  const text = options.text
    ? pngChunk("tEXt", new TextEncoder().encode("Comment\0taken at home"))
    : new Uint8Array(0);
  const exif = options.text
    ? pngChunk("eXIf", new TextEncoder().encode("GPS"))
    : new Uint8Array(0);
  const idat = pngChunk("IDAT", bytes(0x78, 0x9c, 0x01));
  const iend = pngChunk("IEND", new Uint8Array(0));
  return concat(signature, ihdr, text, exif, idat, iend);
}

function makeWebp(options: { width: number; height: number; exif?: boolean }) {
  const vp8x = concat(
    new TextEncoder().encode("VP8X"),
    bytes(10, 0, 0, 0), // サイズ（LE）
    bytes(
      0x08, 0, 0, 0, // フラグ + 予約
      (options.width - 1) & 0xff,
      ((options.width - 1) >> 8) & 0xff,
      ((options.width - 1) >> 16) & 0xff,
      (options.height - 1) & 0xff,
      ((options.height - 1) >> 8) & 0xff,
      ((options.height - 1) >> 16) & 0xff,
    ),
  );
  const exifChunk = options.exif
    ? concat(
        new TextEncoder().encode("EXIF"),
        bytes(4, 0, 0, 0),
        new TextEncoder().encode("GPS!"),
      )
    : new Uint8Array(0);
  const payload = concat(new TextEncoder().encode("WEBP"), vp8x, exifChunk);
  const riffSize = payload.length;
  return concat(
    new TextEncoder().encode("RIFF"),
    bytes(
      riffSize & 0xff,
      (riffSize >> 8) & 0xff,
      (riffSize >> 16) & 0xff,
      (riffSize >> 24) & 0xff,
    ),
    payload,
  );
}

describe("実体の判定", () => {
  it("JPEG / PNG / WebP を見分ける", () => {
    expect(detectImageFormat(makeJpeg({ width: 100, height: 80 }))).toBe("jpeg");
    expect(detectImageFormat(makePng({ width: 100, height: 80 }))).toBe("png");
    expect(detectImageFormat(makeWebp({ width: 100, height: 80 }))).toBe("webp");
  });

  it("★SVG を受け付けない★（script を書けるため）", () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect(detectImageFormat(svg)).toBeNull();
    expect(inspectImage(svg)).toBeNull();
  });

  it("★拡張子や Content-Type を偽っても実体で判定される★", () => {
    // image/jpeg を名乗る HTML
    const html = new TextEncoder().encode("<!doctype html><script>x</script>");
    expect(detectImageFormat(html)).toBeNull();
  });

  it("空・短すぎるデータで例外にならない", () => {
    expect(detectImageFormat(new Uint8Array(0))).toBeNull();
    expect(detectImageFormat(bytes(0xff))).toBeNull();
    expect(inspectImage(bytes(0xff, 0xd8))).toBeNull();
  });
});

describe("寸法の読み取り", () => {
  it("JPEG", () => {
    expect(inspectImage(makeJpeg({ width: 1920, height: 1080 }))).toEqual({
      format: "jpeg",
      width: 1920,
      height: 1080,
    });
  });

  it("PNG", () => {
    expect(inspectImage(makePng({ width: 640, height: 480 }))).toEqual({
      format: "png",
      width: 640,
      height: 480,
    });
  });

  it("WebP（VP8X）", () => {
    expect(inspectImage(makeWebp({ width: 800, height: 600 }))).toEqual({
      format: "webp",
      width: 800,
      height: 600,
    });
  });
});

describe("メタデータの除去", () => {
  it("★JPEG の Exif（GPS を含む）を落とす★", () => {
    const original = makeJpeg({ width: 100, height: 80, exif: true });
    const text = new TextDecoder().decode(original);
    expect(text).toContain("GPSLatitude");

    const stripped = stripImageMetadata(original, "jpeg");
    expect(new TextDecoder().decode(stripped)).not.toContain("GPSLatitude");
    // 画像として壊れていないこと（寸法が読める）
    expect(inspectImage(stripped)).toEqual({
      format: "jpeg",
      width: 100,
      height: 80,
    });
  });

  it("★PNG の tEXt / eXIf を落とす★", () => {
    const original = makePng({ width: 100, height: 80, text: true });
    expect(new TextDecoder().decode(original)).toContain("taken at home");

    const stripped = stripImageMetadata(original, "png");
    const strippedText = new TextDecoder().decode(stripped);
    expect(strippedText).not.toContain("taken at home");
    expect(strippedText).not.toContain("eXIf");
    expect(strippedText).toContain("IDAT");
    expect(inspectImage(stripped)).toEqual({
      format: "png",
      width: 100,
      height: 80,
    });
  });

  it("★WebP の EXIF チャンクを落とし、RIFF のサイズを直す★", () => {
    const original = makeWebp({ width: 100, height: 80, exif: true });
    expect(new TextDecoder().decode(original)).toContain("GPS!");

    const stripped = stripImageMetadata(original, "webp");
    expect(new TextDecoder().decode(stripped)).not.toContain("GPS!");
    // サイズを直していないと、ここで寸法が読めなくなる
    expect(inspectImage(stripped)).toEqual({
      format: "webp",
      width: 100,
      height: 80,
    });
    // RIFF のサイズ欄が実体と一致していること
    const declared =
      stripped[4]! |
      (stripped[5]! << 8) |
      (stripped[6]! << 16) |
      (stripped[7]! << 24);
    expect(declared).toBe(stripped.length - 8);
  });

  it("メタデータが無い画像はそのまま通る", () => {
    const original = makePng({ width: 50, height: 50 });
    const stripped = stripImageMetadata(original, "png");
    expect(stripped.length).toBe(original.length);
  });
});
