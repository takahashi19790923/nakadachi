import { describe, expect, it } from "vitest";

import { action as cspReportAction } from "~/routes/api.csp-report";
import {
  bodyLimitFor,
  DEFAULT_BODY_LIMIT,
  hasBodyToLimit,
  IMAGE_UPLOAD_BODY_LIMIT,
  limitRequestBody,
  readBodyBytesWithLimit,
  readBodyWithLimit,
} from "~/server/http-body.server";

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

  it("上限を超えたら、文字列版も null を返す", async () => {
    expect(await readBodyWithLimit(chunkedRequest(["a".repeat(11)]), 10)).toBeNull();
  });
});

describe("readBodyBytesWithLimit", () => {
  it("上限以内ならそのバイト列を返す（マルチバイトは UTF-8 のバイト数で数える）", async () => {
    const body = "なかだち"; // UTF-8 で 12 バイト
    const bytes = await readBodyBytesWithLimit(
      new Request("https://example.test/", { method: "POST", body }),
      1024,
    );
    expect(bytes).not.toBeNull();
    expect(bytes!.byteLength).toBe(12);
    expect(new TextDecoder().decode(bytes!)).toBe(body);
  });

  it("ちょうど上限は通す（複数のかたまりをつなぐ）", async () => {
    const bytes = await readBodyBytesWithLimit(chunkedRequest(["x".repeat(500), "y".repeat(500)]), 1000);
    expect(bytes?.byteLength).toBe(1000);
    expect(new TextDecoder().decode(bytes!)).toBe("x".repeat(500) + "y".repeat(500));
  });

  it("1バイトでも超えたら null（content-length の無い本文でも）", async () => {
    const request = chunkedRequest(["x".repeat(500), "y".repeat(501)]);
    expect(request.headers.get("content-length")).toBeNull();
    expect(await readBodyBytesWithLimit(request, 1000)).toBeNull();
  });

  it("本文が無ければ空のバイト列（null ではない）", async () => {
    const bytes = await readBodyBytesWithLimit(new Request("https://example.test/", { method: "POST" }), 10);
    expect(bytes).not.toBeNull();
    expect(bytes!.byteLength).toBe(0);
  });
});

describe("bodyLimitFor（パス → 入口の本文の上限）", () => {
  it("画像の登録だけ大きい（枚数の上限 × 1枚の上限 ＋ 1MB）", () => {
    expect(IMAGE_UPLOAD_BODY_LIMIT).toBe(10 * 5 * 1024 * 1024 + 1024 * 1024);
    expect(bodyLimitFor("/listings/01ABC/images")).toBe(IMAGE_UPLOAD_BODY_LIMIT);
    expect(bodyLimitFor("/listings/01ABC/images/")).toBe(IMAGE_UPLOAD_BODY_LIMIT);
  });

  it("★JS が動いているときの送信先（.data・/_.data）も画像の上限★", () => {
    // react-router の single fetch はフォームの送信先に .data を付ける。
    // 素のパスだけ見ると、ふつうの利用者の写真が 64KB に当たって 413 になる。
    expect(bodyLimitFor("/listings/01ABC/images.data")).toBe(IMAGE_UPLOAD_BODY_LIMIT);
    expect(bodyLimitFor("/listings/01ABC/images/_.data")).toBe(IMAGE_UPLOAD_BODY_LIMIT);
    // .data を付けても別のパスは借りられない。
    expect(bodyLimitFor("/listings/01ABC/images/extra.data")).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimitFor("/listings/01ABC/images.data/x")).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimitFor("/listings/01ABC/imagesx.data")).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimitFor("/listings/01ABC/edit.data")).toBe(DEFAULT_BODY_LIMIT);
  });

  it("Stripe の Webhook は入口では読まない（null）", () => {
    expect(bodyLimitFor("/api/stripe/webhook")).toBeNull();
  });

  it("それ以外は 64KB（知らないパスも）", () => {
    expect(bodyLimitFor("/login")).toBe(64 * 1024);
    expect(bodyLimitFor("/login")).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimitFor("/api/csp-report")).toBe(64 * 1024);
    expect(bodyLimitFor("/anything/else")).toBe(64 * 1024);
  });

  it("★画像の口に似たパスで画像の上限を借りられない★", () => {
    // 末尾に別の段が付く・id の段が空・別の語で終わる、は 64KB のまま。
    expect(bodyLimitFor("/listings/01ABC/images/extra")).toBe(64 * 1024);
    expect(bodyLimitFor("/listings//images")).toBe(64 * 1024);
    expect(bodyLimitFor("/listings/01ABC/edit")).toBe(64 * 1024);
    expect(bodyLimitFor("/x/listings/01ABC/images")).toBe(64 * 1024);
    expect(bodyLimitFor("/api/stripe/webhook/extra")).toBe(64 * 1024);
  });
});

describe("hasBodyToLimit（GET/HEAD/OPTIONS 以外が対象）", () => {
  it("本文を持たないメソッドは対象外", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect(hasBodyToLimit(method), method).toBe(false);
  });

  it("状態を変えるメソッドは対象", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(hasBodyToLimit(method), method).toBe(true);
  });
});

describe("limitRequestBody（入口で読んで詰め直す）", () => {
  it("超えていれば null（chunked でも）", async () => {
    expect(await limitRequestBody(chunkedRequest(["a".repeat(70 * 1024)]), 64 * 1024)).toBeNull();
  });

  it("content-length の自己申告が上限を超えていれば、読まずに null", async () => {
    const request = new Request("https://example.test/login", {
      method: "POST",
      headers: { "content-length": String(90 * 1024 * 1024) },
      body: "x",
    });
    expect(await limitRequestBody(request, 64 * 1024)).toBeNull();
  });

  it("上限内なら、同じ method・headers で本文を読み直せる Request を返す", async () => {
    const request = new Request("https://example.test/login?next=%2F", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-test": "1" },
      body: "email=a%40example.test&password=secret",
    });
    const limited = await limitRequestBody(request, 64 * 1024);
    expect(limited).not.toBeNull();
    expect(limited!.method).toBe("POST");
    expect(limited!.url).toBe("https://example.test/login?next=%2F");
    expect(limited!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(limited!.headers.get("x-test")).toBe("1");
    const form = await limited!.formData();
    expect(form.get("email")).toBe("a@example.test");
    expect(form.get("password")).toBe("secret");
  });

  it("★multipart も formData() で読める（境界つきの content-type を保つ）★", async () => {
    const form = new FormData();
    form.set("title", "なかだち");
    form.set("file", new File(["PNGDATA"], "a.png", { type: "image/png" }));
    const request = new Request("https://example.test/listings/01ABC/images", { method: "POST", body: form });
    expect(request.headers.get("content-type")).toContain("multipart/form-data; boundary=");

    const limited = await limitRequestBody(request, IMAGE_UPLOAD_BODY_LIMIT);
    expect(limited).not.toBeNull();
    const parsed = await limited!.formData();
    expect(parsed.get("title")).toBe("なかだち");
    const file = parsed.get("file") as File;
    expect(file.name).toBe("a.png");
    expect(file.size).toBe(7);
    expect(await file.text()).toBe("PNGDATA");
  });

  it("ちょうど上限は通し、1バイト超えたら null", async () => {
    const post = (size: number) =>
      new Request("https://example.test/login", { method: "POST", body: "z".repeat(size) });
    expect(await limitRequestBody(post(1000), 1000)).not.toBeNull();
    expect(await limitRequestBody(post(1001), 1000)).toBeNull();
  });

  it("本文が空でも落ちない（本文なしの Request を返す）", async () => {
    for (const request of [
      new Request("https://example.test/logout", { method: "POST" }),
      new Request("https://example.test/logout", { method: "POST", body: "" }),
    ]) {
      const limited = await limitRequestBody(request, 1024);
      expect(limited).not.toBeNull();
      expect(limited!.method).toBe("POST");
      expect(await limited!.text()).toBe("");
    }
  });
});

describe("CSP 違反の受け口の本文の上限", () => {
  const ctx = {
    get: () => ({ logger: { warn: () => undefined, info: () => undefined, error: () => undefined } }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (request: Request) => cspReportAction({ request, context: ctx } as any);

  it("★content-length の無い（chunked）8KB 超の本文は 413★", async () => {
    const request = chunkedRequest(["a".repeat(5000), "b".repeat(5000)]);
    expect(request.headers.get("content-length")).toBeNull();
    const res = await call(request);
    expect(res.status).toBe(413);
  });

  it("8KB ちょうどは通る（204）", async () => {
    const res = await call(chunkedRequest(["{".padEnd(8 * 1024, " ")]));
    expect(res.status).toBe(204);
  });

  it("content-length が 8KB 超なら、読まずに 204 で捨てる", async () => {
    const res = await call(
      new Request("https://example.test/api/csp-report", {
        method: "POST",
        headers: { "content-length": "20000" },
        body: "x",
      }),
    );
    expect(res.status).toBe(204);
  });
});
