// Bean Catch bot — /start responder (Telegram webhook, Vercel serverless).
// Private chats get a Web App button; groups get a plain URL button
// (Telegram rejects web_app buttons outside private chats).
const GAME_URL = 'https://bean-catch.vercel.app/';
const WELCOME = [
  '☕ Welcome to Bean Catch!',
  '',
  'Catch the falling Classic Beans in your cup, dodge the burnt beans and rocks, and grab the golden beans for big points.',
  '',
  'Tap Play to start!',
].join('\n');

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false }); return; }
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (!process.env.COFFEE_WEBHOOK_SECRET || secret !== process.env.COFFEE_WEBHOOK_SECRET) {
    res.status(403).json({ ok: false }); return;
  }
  let update = req.body;
  if (typeof update === 'string') { try { update = JSON.parse(update); } catch { update = null; } }
  const msg = update && update.message;
  if (!msg || !msg.chat || typeof msg.text !== 'string' || !msg.text.startsWith('/start')) {
    res.status(200).json({ ok: true }); return;
  }
  const isPrivate = msg.chat.type === 'private';
  const button = isPrivate
    ? { text: '▶️ Play Bean Catch', web_app: { url: GAME_URL } }
    : { text: '▶️ Play Bean Catch', url: GAME_URL };
  try {
    const r = await fetch(`https://api.telegram.org/bot${process.env.COFFEE_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        text: WELCOME,
        reply_markup: { inline_keyboard: [[button]] },
      }),
    });
    const j = await r.json().catch(() => null);
    if (!j || !j.ok) console.error('sendMessage failed', j && j.description);
  } catch (e) {
    console.error('sendMessage error', e && e.message);
  }
  res.status(200).json({ ok: true });
}
