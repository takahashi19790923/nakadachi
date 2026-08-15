import "dotenv/config";
import { sql } from "drizzle-orm";

import { createScriptDb, parseTarget, requireConnectionString } from "./db.ts";

// 一時的な確認用。決済テストの後始末で消す。
const target = parseTarget(process.argv[2] ?? "preview");
const { db, pool } = createScriptDb(requireConnectionString(target));
const listingId = process.argv[3] ?? "01M02Z0CRN3GVJ0VXD6YNY4HMC";

const l = await db.execute(
  sql`select status, published_at, moderation_reason from listings where id = ${listingId}`,
);
console.log("listing:", JSON.stringify(l.rows, null, 2));

const p = await db.execute(
  sql`select id, status, amount_jpy, refunded_amount_jpy from payments where listing_id = ${listingId} order by id`,
);
console.log("payments:", JSON.stringify(p.rows, null, 2));

const w = await db.execute(
  sql`select event_id, event_type, status from payment_webhook_events order by created_at desc limit 6`,
);
console.log("webhooks:", JSON.stringify(w.rows, null, 2));

await pool.end();
