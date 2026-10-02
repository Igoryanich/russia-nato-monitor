import type { Config } from "../config.ts";
import { type Db, json } from "../db.ts";
import { errMsg, log } from "../log.ts";
import { Telegram, TelegramAmbiguous, TelegramRejected } from "../telegram.ts";
import { nowIso, sleep } from "../util.ts";

interface PubRow {
  id: number;
  channel: string;
  event_id: number | null;
  kind: string;
  text: string;
  attempts: number;
  retry_at: string | null;
  extra: string | null;
}

/**
 * Keep exactly one digest pinned: pin the new one silently (the post itself already
 * notified subscribers), then unpin yesterday's. A failed pin never fails delivery.
 */
export async function pinDigest(db: Db, tg: Telegram, channel: string, messageId: number) {
  const key = `pinned_digest:${channel}`;
  const previous = Number(db.kvGet(key) ?? 0);
  try {
    await tg.call("pinChatMessage", { chat_id: channel, message_id: messageId, disable_notification: true });
    db.kvSet(key, String(messageId));
  } catch (e) {
    log.warn("digest pin failed", { err: errMsg(e) });
    return;
  }
  if (previous && previous !== messageId) {
    await tg.call("unpinChatMessage", { chat_id: channel, message_id: previous }).catch((e) => log.warn("digest unpin failed", { err: errMsg(e) }));
  }
}

/**
 * Deliver pending publications. Telegram has no idempotency key, so a send that
 * might have gone through is marked `uncertain` and never blindly retried.
 */
export async function drain(db: Db, cfg: Config, tg: Telegram | null): Promise<{ sent: number; failed: number }> {
  // A crash between "sending" and the commit leaves rows we can't be sure about.
  db.run("UPDATE publications SET status = 'uncertain', error = 'interrupted while sending' WHERE status = 'sending'");
  if (cfg.DRY_RUN || !tg) return { sent: 0, failed: 0 };
  const rows = db.all<PubRow>(
    `SELECT id, channel, event_id, kind, text, attempts, retry_at, extra FROM publications
     WHERE status = 'pending' AND channel != 'dry-run' AND (retry_at IS NULL OR retry_at <= ?)
     ORDER BY kind = 'admin' DESC, priority DESC, id`,
    nowIso(),
  );
  let sent = 0;
  let failed = 0;
  let channelPosts = 0;
  for (const p of rows) {
    if (p.kind !== "admin" && p.kind !== "digest" && channelPosts >= cfg.MAX_POSTS_PER_RUN) continue; // the rest waits for the next cycle
    db.run("UPDATE publications SET status = 'sending', attempts = attempts + 1 WHERE id = ?", p.id);
    try {
      const messageId = await tg.send(p.channel, p.text, json(p.extra, {}));
      db.run("UPDATE publications SET status = 'sent', message_id = ?, sent_at = ?, error = NULL WHERE id = ?", messageId, nowIso(), p.id);
      if (p.kind === "digest") await pinDigest(db, tg, p.channel, messageId);
      if (p.event_id && p.kind !== "admin") {
        channelPosts++;
        db.run(
          "UPDATE events SET status = 'published', published_at = COALESCE(published_at, ?), published_version = published_version + 1 WHERE id = ?",
          nowIso(), p.event_id,
        );
      }
      sent++;
    } catch (e) {
      failed++;
      if (e instanceof TelegramRejected) {
        if (e.code === 429) {
          db.run("UPDATE publications SET status = 'pending', retry_at = ?, error = ? WHERE id = ?",
            new Date(Date.now() + Math.max(60, e.retryAfter) * 1000).toISOString(), errMsg(e), p.id);
          break; // don't hammer the channel after a rate limit
        }
        db.run("UPDATE publications SET status = 'failed', error = ? WHERE id = ?", errMsg(e), p.id);
      } else if (e instanceof TelegramAmbiguous) {
        db.run("UPDATE publications SET status = 'uncertain', error = ? WHERE id = ?", errMsg(e), p.id);
      } else {
        db.run("UPDATE publications SET status = ?, retry_at = ?, error = ? WHERE id = ?",
          p.attempts + 1 >= 5 ? "failed" : "pending", new Date(Date.now() + 15 * 60_000).toISOString(), errMsg(e), p.id);
      }
      log.warn("telegram send failed", { pub: p.id, err: errMsg(e) });
    }
    await sleep(1200);
  }
  // Self-heal: the latest sent digest must be the pinned one (covers a failed pin or an older digest).
  const channel = cfg.TELEGRAM_CHANNEL_ID;
  if (channel) {
    const latest = db.get<{ message_id: number }>(
      "SELECT message_id FROM publications WHERE channel = ? AND kind = 'digest' AND status = 'sent' AND message_id IS NOT NULL ORDER BY sent_at DESC LIMIT 1",
      channel,
    );
    if (latest && db.kvGet(`pinned_digest:${channel}`) !== String(latest.message_id)) await pinDigest(db, tg, channel, latest.message_id);
  }
  return { sent, failed };
}
