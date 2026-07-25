'use strict';
/*
 * Live-updating Telegram status message. Instead of one "building…" message
 * followed by silence, this keeps editing a single message as each pipeline
 * step completes, so the user can always see whether it's still running.
 *
 * Plain text only (no parse_mode) — status lines come from pipeline/engine
 * output and may contain characters (like the trailing "_" in an Instagram
 * handle) that break Telegram's Markdown entity parser.
 */

function makeReporter(botToken, chatId) {
  const TG = `https://api.telegram.org/bot${botToken}`;
  let messageId = null;
  let lines = [];

  async function post(method, body) {
    try {
      const res = await fetch(`${TG}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await res.json().catch(() => ({}));
    } catch (e) {
      console.error(`progress ${method} failed:`, e.message);
      return { ok: false };
    }
  }

  function render() {
    // keep it short — Telegram caps messages at 4096 chars, and a long
    // scrollback is noise, not signal
    const shown = lines.length > 14 ? [lines[0], '…', ...lines.slice(-10)] : lines;
    return shown.join('\n');
  }

  /** Start a brand-new status message. */
  async function start(firstLine) {
    lines = [firstLine];
    const j = await post('sendMessage', { chat_id: chatId, text: render() });
    if (j.ok) messageId = j.result.message_id;
    return messageId;
  }

  /** Take over an existing message (e.g. the one with the approve/cancel buttons). */
  function attach(existingMessageId, firstLine) {
    messageId = existingMessageId;
    lines = [firstLine];
  }

  /** Append a line and push the update. Never throws — a reporting glitch must not kill the run. */
  async function update(line) {
    console.log(line);
    lines.push(line);
    if (!messageId) return;
    const j = await post('editMessageText', {
      chat_id: chatId, message_id: messageId, text: render(),
      reply_markup: { inline_keyboard: [] },
    });
    if (!j.ok && j.description && !/message is not modified/i.test(j.description)) {
      console.error('progress edit failed:', j.description);
    }
  }

  /** Replace the message with a final result (success or failure). */
  async function finish(text, extra = {}) {
    console.log(text);
    if (!messageId) { await post('sendMessage', { chat_id: chatId, text, ...extra }); return; }
    await post('editMessageText', {
      chat_id: chatId, message_id: messageId, text,
      reply_markup: { inline_keyboard: [] }, ...extra,
    });
  }

  return { start, attach, update, finish, get messageId() { return messageId; } };
}

module.exports = { makeReporter };
