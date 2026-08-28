import { describe, expect, it } from "vitest";

import {
  clearGateCookie,
  GATE_COOKIE,
  hasValidGate,
  issueGateCookie,
} from "~/server/admin-gate.server";
import type { AppEnv } from "~/server/env.server";

/**
 * 管理画面の第3層（通過証）。
 *
 * ★署名鍵に資格情報を使わない。★
 *
 * 以前は HMAC の鍵を `admin-gate:${user}:${pass}` から作っていた。
 * Cookie を1つ手に入れた相手は「期限（平文）＋署名」の対を持つので、
 * ★手元で候補のパスワードを片っ端から試せた★。通信もいらない。
 * しかもこの資格情報は全プロジェクト共通で、1つ割れると全部割れる。
 *
 * いまは鍵が SESSION_SECRET（48バイトの乱数）。資格情報はメッセージ側に
 * ハッシュで混ぜるので、「値を変えれば発行済みが全部無効」は変わらない。
 */

const BASE = {
  ENVIRONMENT: "development",
  APP_ORIGIN: "http://localhost:5273",
  SESSION_SECRET: "test-session-secret-not-a-real-value-0123456789",
  ADMIN_BASIC_AUTH_USER: "admin-user",
  ADMIN_BASIC_AUTH_PASS: "admin-pass-example",
} as unknown as AppEnv;

function withCookie(setCookie: string): Request {
  const value = setCookie.split(";")[0]!;
  return new Request("http://localhost:5273/admin", {
    headers: { cookie: value },
  });
}

describe("管理ゲートの通過証", () => {
  it("発行した通過証は通る", async () => {
    const req = withCookie(await issueGateCookie(BASE));
    expect(await hasValidGate(req, BASE)).toBe(true);
  });

  it("期限が切れていれば通らない", async () => {
    const setCookie = await issueGateCookie(BASE, Date.now() - 13 * 60 * 60 * 1000);
    expect(await hasValidGate(withCookie(setCookie), BASE)).toBe(false);
  });

  it("★資格情報を変えると、発行済みが全部無効になる★", async () => {
    const req = withCookie(await issueGateCookie(BASE));
    const rotated = { ...BASE, ADMIN_BASIC_AUTH_PASS: "changed" } as AppEnv;
    expect(await hasValidGate(req, rotated)).toBe(false);
  });

  it("★SESSION_SECRET を変えても、発行済みが無効になる★", async () => {
    const req = withCookie(await issueGateCookie(BASE));
    const rotated = { ...BASE, SESSION_SECRET: "another-secret-value-x" } as AppEnv;
    expect(await hasValidGate(req, rotated)).toBe(false);
  });

  it("★署名は資格情報だけからは作れない★（SESSION_SECRET が要る）", async () => {
    /*
     * 攻撃者の立場：Cookie（期限＋署名）と、候補のパスワードを持っている。
     * 鍵が資格情報から作られていたら、これで正解かどうか判定できてしまう。
     * SESSION_SECRET を知らなければ判定できないこと＝オフラインで
     * 総当たりできないこと、を確かめる。
     */
    const setCookie = await issueGateCookie(BASE);
    const req = withCookie(setCookie);

    // 正しい資格情報を «知っていても»、鍵が違えば検証は通らない。
    const attacker = {
      ...BASE,
      SESSION_SECRET: "attacker-does-not-know-this",
    } as AppEnv;
    expect(await hasValidGate(req, attacker)).toBe(false);
  });

  it("SESSION_SECRET が無ければ、誰も通さない（fail-close）", async () => {
    const setCookie = await issueGateCookie(BASE);
    const broken = { ...BASE, SESSION_SECRET: "" } as AppEnv;
    expect(await hasValidGate(withCookie(setCookie), broken)).toBe(false);
    await expect(issueGateCookie(broken)).rejects.toThrow();
  });

  it("資格情報が未設定なら、誰も通さない", async () => {
    const setCookie = await issueGateCookie(BASE);
    for (const key of ["ADMIN_BASIC_AUTH_USER", "ADMIN_BASIC_AUTH_PASS"]) {
      const broken = { ...BASE, [key]: "" } as AppEnv;
      expect(await hasValidGate(withCookie(setCookie), broken), key).toBe(false);
    }
  });

  it("★Cookie に資格情報そのものが入っていない★", async () => {
    const setCookie = await issueGateCookie(BASE);
    expect(setCookie).not.toContain("admin-pass-example");
    expect(setCookie).not.toContain("admin-user");
    expect(setCookie).not.toContain(BASE.SESSION_SECRET!);
  });

  it("Cookie の属性（__Host- / HttpOnly / SameSite=Strict）", async () => {
    const setCookie = await issueGateCookie(BASE);
    expect(setCookie.startsWith(`${GATE_COOKIE}=`)).toBe(true);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    // 消すほうも同じ属性で出す（属性が違うとブラウザが消してくれない）。
    const cleared = clearGateCookie(BASE);
    expect(cleared).toContain("SameSite=Strict");
    expect(cleared).toContain("Path=/");
  });
});
