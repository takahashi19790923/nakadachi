import { hasSecret } from "~/server/env.server";
import { requireAdminGate } from "~/server/guards.server";
import type { Route } from "./+types/api.config";
import { getApp } from "~/server/app-context";

/**
 * 設定の確認用。
 *
 * ★「直したがデプロイし忘れた」をここで捕まえる。★ 本番が実際に配っている
 * サイトキーが分かる。turnstileSiteKey が空なら、動いていてもボット対策は
 * 効いていない。
 *
 * ★秘密の値そのものは返さない。★ 入っているかどうかの真偽だけ。
 * サイトキーは公開情報（HTML に埋まる）なので、そのまま返してよい。
 *
 * ★3層すべてを通す。★ 以前は誰でも叩けた。値そのものは出ないが、
 * secretsConfigured は「いま、どの守りが効いていないか」の一覧そのもの。
 * turnstile:false と読めば、ボット対策が外れている隙をそのまま狙える。
 * turnstileExpectedHosts は、1つの共有ウィジェットを全サービスで
 * 使い回している以上、他サービス向けのトークンを弾く唯一の材料でもある。
 * 「入れ忘れの検出」は運用者のためのものなので、運用者だけが見ればよい。
 */
export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  await requireAdminGate({ request, context });
  const env = context.env;

  const body = JSON.stringify({
    environment: env.ENVIRONMENT,
    appOrigin: env.APP_ORIGIN,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
    turnstileExpectedHosts: env.TURNSTILE_EXPECTED_HOSTS,
    expectedCurrency: env.EXPECTED_CURRENCY,
    // 値は出さない。投入されているかどうかだけ。
    secretsConfigured: {
      /*
       * ★Hyperdrive の binding を先に見る。★ 本番は Hyperdrive 経由で
       * 繋いでいて DATABASE_URL を持たない。ここで false と出ると、
       * 「DB が未設定」という嘘の警告が常時出続けることになり、
       * 確認の道具そのものが信用されなくなる。
       */
      database: Boolean(env.HYPERDRIVE) || hasSecret(env, "DATABASE_URL"),
      hyperdrive: Boolean(env.HYPERDRIVE),
      session: hasSecret(env, "SESSION_SECRET"),
      emailEncryption: hasSecret(env, "EMAIL_ENCRYPTION_KEY"),
      emailIndex: hasSecret(env, "EMAIL_INDEX_KEY"),
      resend: hasSecret(env, "RESEND_API_KEY"),
      stripe: hasSecret(env, "STRIPE_SECRET_KEY"),
      stripeWebhook: hasSecret(env, "STRIPE_WEBHOOK_SECRET"),
      turnstile: hasSecret(env, "TURNSTILE_SECRET_KEY"),
      adminGate:
        hasSecret(env, "ADMIN_BASIC_AUTH_USER") &&
        hasSecret(env, "ADMIN_BASIC_AUTH_PASS"),
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
