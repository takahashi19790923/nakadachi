import { hasSecret } from "~/server/env.server";
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
 */
export function loader({ context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const env = context.env;

  const body = JSON.stringify({
    environment: env.ENVIRONMENT,
    appOrigin: env.APP_ORIGIN,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
    turnstileExpectedHosts: env.TURNSTILE_EXPECTED_HOSTS,
    expectedCurrency: env.EXPECTED_CURRENCY,
    // 値は出さない。投入されているかどうかだけ。
    secretsConfigured: {
      database: hasSecret(env, "DATABASE_URL"),
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
