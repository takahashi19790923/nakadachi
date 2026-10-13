/**
 * 本文を上限まで読み、バイト列で返す。超えたら読むのをやめて null を返す。
 * 本文が無ければ空のバイト列。
 *
 * ★request.text() / formData() は上限を持たない。★ content-length は自己申告で、
 * 付いていない（chunked）本文は事前の足切りを素通りする。未認証の相手から受ける口
 * では、これで読む（監査 DOS-01）。Worker の入口は、状態を変える全ての要求の本文を
 * これで読んでから React Router に渡す（workers/app.ts）。
 */
export async function readBodyBytesWithLimit(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * 本文を上限まで読む。超えたら読むのをやめて null を返す。
 * 返す文字列は request.text() と同じ（UTF-8 として解釈）。
 *
 * 未認証の相手から受ける口（Stripe の Webhook など）では、request.text() ではなく
 * これで読む（監査 DOS-01）。
 */
export async function readBodyWithLimit(request: Request, limit: number): Promise<string | null> {
  const bytes = await readBodyBytesWithLimit(request, limit);
  if (bytes === null) return null;
  return new TextDecoder().decode(bytes);
}

/** 入口で本文を読まない（本文を持たない）メソッド */
const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** 状態を変える要求の既定の上限。フォームも JSON もこれで足りる */
export const DEFAULT_BODY_LIMIT = 64 * 1024;

/**
 * 画像の登録だけ大きい。1枚 5MB（MAX_IMAGE_BYTES）に multipart の枠の分を足した値。
 * 枚数の上限は routes 側で見る。ここは «メモリに読む前の天井» でしかない。
 */
export const IMAGE_UPLOAD_BODY_LIMIT = 6 * 1024 * 1024;

const IMAGE_UPLOAD_PATH = /^\/listings\/[^/]+\/images\/?$/;
const STRIPE_WEBHOOK_PATH = /^\/api\/stripe\/webhook\/?$/;

/**
 * パスごとの本文の上限（バイト）。null は «入口では読まない»。
 *
 * ★Stripe の Webhook は null。★ 署名の検証に本文そのものが要り、自前の上限
 * （readBodyWithLimit・1MB）で読む。入口で 64KB に切ると、大きなイベントが
 * 黙って 413 になる。
 * ★それ以外は既定の 64KB。★ 知らないパスは小さいほうに倒す。
 */
export function bodyLimitFor(pathname: string): number | null {
  if (STRIPE_WEBHOOK_PATH.test(pathname)) return null;
  if (IMAGE_UPLOAD_PATH.test(pathname)) return IMAGE_UPLOAD_BODY_LIMIT;
  return DEFAULT_BODY_LIMIT;
}

/** 入口で本文に上限を掛けるメソッドか（GET/HEAD/OPTIONS 以外） */
export function hasBodyToLimit(method: string): boolean {
  return !BODYLESS_METHODS.has(method.toUpperCase());
}

/**
 * 本文を上限つきで読み、同じ method・headers の Request に本文を詰め直して返す。
 * 超えていれば null（呼び出し側が 413 を返す）。
 *
 * ★読み終えた Request の本文は二度読めない。★ そのまま React Router に渡すと
 * request.formData() が «body used already» で落ちるので、読んだバイト列を
 * 本文にした新しい Request を作る。content-type（multipart の境界を含む）は
 * headers ごと引き継ぐので、formData() はそのまま動く。
 * 本文が空のときは本文なしで作り直す（読み終えた本文を持つ Request から
 * body: null で複製すると、使用済みの本文を引き継いで落ちる）。
 */
export async function limitRequestBody(request: Request, limit: number): Promise<Request | null> {
  // 自己申告が上限を超えていれば、読み始める前に断る。
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) {
    await request.body?.cancel().catch(() => undefined);
    return null;
  }

  const bytes = await readBodyBytesWithLimit(request, limit);
  if (bytes === null) return null;

  if (bytes.byteLength === 0) {
    return new Request(request.url, { method: request.method, headers: request.headers });
  }
  return new Request(request, { body: bytes });
}
