-- 監査ログのうち、認証の記録（auth.* / authz.*）で保持期間を過ぎたものだけを消す関数。
--
-- ★なぜ関数にするか。★
-- db:harden（scripts/harden-db.ts）で、アプリ用ロールから audit_logs の
-- DELETE を取り上げてある。乗っ取った相手が自分の足跡を消せないようにするため。
-- 一方で、ログイン失敗の記録は量を相手が決められるので 180 日で消す決まりにした。
-- 2つが打ち消し合い、日次の掃除が 2026-08-28 から毎日権限エラーで落ちていた。
--
-- 権限を戻すのではなく、«auth 系で 180 日を過ぎたものだけ» を消す関数を
-- 所有者の権限で動かし、アプリにはその実行権だけを渡す。
-- アプリが乗っ取られても、消せるのはどのみち掃除で消える古い認証記録だけ。
--
-- ★下限 180 日は関数の中で固定する。★ 引数で短くできると、相手が
-- retention_days => 0 で直近の記録を消せてしまう。
CREATE OR REPLACE FUNCTION public.purge_auth_audit_logs(retention_days integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  deleted integer;
BEGIN
  IF retention_days IS NULL OR retention_days < 180 THEN
    RAISE EXCEPTION 'retention_days must be at least 180 (got %)', retention_days;
  END IF;

  DELETE FROM public.audit_logs
   WHERE (action LIKE 'auth.%' OR action LIKE 'authz.%')
     AND created_at <= now() - make_interval(days => retention_days);

  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END
$$;
--> statement-breakpoint

-- ★既定では PUBLIC に実行権が付く。★ 外す。
REVOKE ALL ON FUNCTION public.purge_auth_audit_logs(integer) FROM PUBLIC;
--> statement-breakpoint

-- ★Supabase は public スキーマの関数を anon / authenticated / service_role に
-- 既定で開放する（ALTER DEFAULT PRIVILEGES）。★ REST の /rpc から誰でも
-- 呼べる状態にしない。ロールが無い環境（手元・preview の Neon・検査）では何もしない。
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.purge_auth_audit_logs(integer) FROM %I', r);
    END IF;
  END LOOP;

  -- アプリ用ロールへ実行権を渡す。PUBLIC から外したので、ここで渡さないと
  -- その環境の日次の掃除が «permission denied for function» で落ちる。
  -- 本番（Supabase）は _production、preview（Neon）は _preview で繋いでいる。
  FOREACH r IN ARRAY ARRAY['nakadachi_app_production', 'nakadachi_app_preview'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.purge_auth_audit_logs(integer) TO %I', r);
    END IF;
  END LOOP;
END
$$;
