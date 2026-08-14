import { describe, expect, it } from "vitest";

import { hmacSha256Hex } from "~/server/crypto.server";
import {
  WebhookSignatureError,
  verifyWebhookSignature,
} from "~/server/services/payment/stripe-client.server";

/**
 * Webhook の署名検証。
 *
 * ★これが決済の正しさの土台。★ ここが緩いと、誰でも「支払われました」と
 * 送りつけて投稿を無料で公開できる。ネットワークを使わずに検査できるよう、
 * 署名の生成もこのファイルの中で行っている。
 */

const SECRET = "whsec_test_only_not_a_real_secret";
const NOW_SECONDS = 1_700_000_000;

async function signPayload(
  payload: string,
  options: { secret?: string; timestamp?: number } = {},
): Promise<string> {
  const timestamp = options.timestamp ?? NOW_SECONDS;
  const signature = await hmacSha256Hex(
    options.secret ?? SECRET,
    `${timestamp}.${payload}`,
  );
  return `t=${timestamp},v1=${signature}`;
}

const VALID_EVENT = JSON.stringify({
  id: "evt_test_1",
  type: "checkout.session.completed",
  created: NOW_SECONDS,
  data: { object: { id: "cs_test_1", amount_total: 110, currency: "jpy" } },
});

describe("Stripe Webhook の署名検証", () => {
  it("正しい署名なら中身を取り出せる", async () => {
    const event = await verifyWebhookSignature({
      payload: VALID_EVENT,
      signatureHeader: await signPayload(VALID_EVENT),
      secret: SECRET,
      nowSeconds: NOW_SECONDS,
    });
    expect(event.id).toBe("evt_test_1");
    expect(event.type).toBe("checkout.session.completed");
  });

  it("★署名が無ければ拒否する★", async () => {
    await expect(
      verifyWebhookSignature({
        payload: VALID_EVENT,
        signatureHeader: null,
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    ).rejects.toThrow(WebhookSignatureError);
  });

  it("★別の鍵で署名されていたら拒否する★", async () => {
    const header = await signPayload(VALID_EVENT, { secret: "whsec_wrong" });
    await expect(
      verifyWebhookSignature({
        payload: VALID_EVENT,
        signatureHeader: header,
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    ).rejects.toThrow(WebhookSignatureError);
  });

  it("★本文が1文字でも変わっていたら拒否する★", async () => {
    const header = await signPayload(VALID_EVENT);
    const tampered = VALID_EVENT.replace('"amount_total":110', '"amount_total":1');
    await expect(
      verifyWebhookSignature({
        payload: tampered,
        signatureHeader: header,
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    ).rejects.toThrow(WebhookSignatureError);
  });

  it("★古い署名を再生できない（時刻のずれを見る）★", async () => {
    const header = await signPayload(VALID_EVENT, {
      timestamp: NOW_SECONDS - 3600,
    });
    await expect(
      verifyWebhookSignature({
        payload: VALID_EVENT,
        signatureHeader: header,
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    ).rejects.toThrow(WebhookSignatureError);
  });

  it("未来へずらした署名も拒否する", async () => {
    const header = await signPayload(VALID_EVENT, {
      timestamp: NOW_SECONDS + 3600,
    });
    await expect(
      verifyWebhookSignature({
        payload: VALID_EVENT,
        signatureHeader: header,
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    ).rejects.toThrow(WebhookSignatureError);
  });

  it("許容範囲（5分）のずれは通す", async () => {
    const header = await signPayload(VALID_EVENT, {
      timestamp: NOW_SECONDS - 200,
    });
    await expect(
      verifyWebhookSignature({
        payload: VALID_EVENT,
        signatureHeader: header,
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    ).resolves.toBeDefined();
  });

  it("鍵の入れ替え中は v1 が複数来る。どれか1つ合えば通す", async () => {
    const good = await hmacSha256Hex(SECRET, `${NOW_SECONDS}.${VALID_EVENT}`);
    const header = `t=${NOW_SECONDS},v1=0000000000000000000000000000000000000000000000000000000000000000,v1=${good}`;
    await expect(
      verifyWebhookSignature({
        payload: VALID_EVENT,
        signatureHeader: header,
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    ).resolves.toBeDefined();
  });

  it("v0（未対応の版）だけの署名は通さない", async () => {
    const header = `t=${NOW_SECONDS},v0=deadbeef`;
    await expect(
      verifyWebhookSignature({
        payload: VALID_EVENT,
        signatureHeader: header,
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    ).rejects.toThrow(WebhookSignatureError);
  });

  it("署名は正しくても JSON として壊れていれば拒否する", async () => {
    const broken = "{ this is not json";
    const header = await signPayload(broken);
    await expect(
      verifyWebhookSignature({
        payload: broken,
        signatureHeader: header,
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    ).rejects.toThrow(WebhookSignatureError);
  });

  it("id / type / data が欠けていれば拒否する", async () => {
    const incomplete = JSON.stringify({ id: "evt_x" });
    const header = await signPayload(incomplete);
    await expect(
      verifyWebhookSignature({
        payload: incomplete,
        signatureHeader: header,
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    ).rejects.toThrow(WebhookSignatureError);
  });

  it("★JSON を組み立て直すと署名が合わなくなる★（生の本文を使うこと）", async () => {
    const header = await signPayload(VALID_EVENT);
    // キーの順序と空白が変わるだけで一致しなくなる、という確認。
    const reserialized = JSON.stringify(JSON.parse(VALID_EVENT), null, 2);
    await expect(
      verifyWebhookSignature({
        payload: reserialized,
        signatureHeader: header,
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    ).rejects.toThrow(WebhookSignatureError);
  });
});
