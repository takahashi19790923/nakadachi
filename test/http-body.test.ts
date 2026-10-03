import { describe, expect, it } from "vitest";

import { readBodyWithLimit } from "~/server/http-body.server";

/**
 * 上限つきの本文の読み取り（監査 DOS-01）。
 * ★content-length の無い（chunked）本文でも、上限を超えたら読むのをやめる。★
 */
function chunkedRequest(chunks: string[]): Request {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request("https://example.test/webhook", {
    method: "POST",
    body: stream,
    // @ts-expect-error Node の fetch はストリーム本文に duplex を要求する
    duplex: "half",
  });
}

describe("readBodyWithLimit", () => {
  it("上限以内なら request.text() と同じ文字列を返す（マルチバイトを含む）", async () => {
    const body = '{"type":"checkout.session.completed","name":"なかだち"}';
    expect(await readBodyWithLimit(new Request("https://example.test/", { method: "POST", body }), 1024)).toBe(body);
  });

  it("content-length の無い本文でも、上限を超えたら null を返す", async () => {
    const request = chunkedRequest(["a".repeat(600), "b".repeat(600)]);
    expect(request.headers.get("content-length")).toBeNull();
    expect(await readBodyWithLimit(request, 1000)).toBeNull();
  });

  it("ちょうど上限は通す", async () => {
    expect(await readBodyWithLimit(chunkedRequest(["x".repeat(500), "y".repeat(500)]), 1000)).toBe(
      "x".repeat(500) + "y".repeat(500),
    );
  });

  it("本文が無ければ空文字", async () => {
    expect(await readBodyWithLimit(new Request("https://example.test/", { method: "POST" }), 10)).toBe("");
  });
});
