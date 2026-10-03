/**
 * 本文を上限まで読む。超えたら読むのをやめて null を返す。
 * 返す文字列は request.text() と同じ（UTF-8 として解釈）。
 *
 * ★request.text() は上限を持たない。★ content-length は自己申告で、付いていない
 * （chunked）本文は事前の足切りを素通りする。未認証の相手から受ける口
 * （Stripe の Webhook など）では、これで読む（監査 DOS-01）。
 */
export async function readBodyWithLimit(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
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
  return new TextDecoder().decode(bytes);
}
