const express = require('express');
const { WebClient } = require('@slack/web-api');

const app = express();
app.use(express.json());

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET;
const PORT            = process.env.PORT || 3000;

const slack = new WebClient(SLACK_BOT_TOKEN);

function buildSlackMessage(payload) {
  const { userName, leaveTypeName } = payload;
  const lower = leaveTypeName ? leaveTypeName.toLowerCase() : '';

  // Пропускаме Working Remotely и Business Trip
  if (lower.includes('remotely') || lower.includes('business trip') || lower.includes('командировка')) {
    return null;
  }

  // Болничен
  const isSick = ['болничен', 'болни', 'sick'].some(kw => lower.includes(kw));

  if (isSick) {
    return [
      `:wave: Здравей, *${userName}*!`,
      '',
      'Твоят болничен е одобрен! Моля, изпрати сканиран/сниман болничен лист на tsvetomir.bogdanov@clico.bg',
    ].join('\n');
  } else {
    return [
      `:wave: Здравей, *${userName}*!`,
      '',
      'Твоят отпуск е одобрен! Моля, генерирай официалната си молба оттук: https://kik-info.com/trz/molba-i-zapoved-za-otpusk.php',
      'Попълни я, подпиши и изпрати на tsvetomir.bogdanov@clico.bg',
    ].join('\n');
  }
}

async function findSlackUserId(email) {
  const result = await slack.users.lookupByEmail({ email });
  return result.user?.id;
}

app.post('/webhook', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    console.warn('Невалиден webhook secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body;
  console.log('Получен webhook:', JSON.stringify(payload, null, 2));

  if (payload.eventType !== 'APPROVED') {
    return res.json({ skipped: true });
  }

  const { userEmail, userName } = payload;

  if (!userEmail) {
    console.warn('Липсва userEmail в payload');
    return res.status(400).json({ error: 'Missing userEmail' });
  }

  try {
    const text = buildSlackMessage(payload);

    if (!text) {
      console.log(`⏭️ Пропуснато (${payload.leaveTypeName}) за ${userName}`);
      return res.json({ skipped: true });
    }

    const slackUserId = await findSlackUserId(userEmail);

    if (!slackUserId) {
      console.warn(`Не е намерен Slack потребител за email: ${userEmail}`);
      return res.status(404).json({ error: 'Slack user not found' });
    }

    await slack.chat.postMessage({
      channel: slackUserId,
      text,
      mrkdwn: true,
    });

    console.log(`✅ Изпратено DM до ${userName} (${userEmail})`);
    res.json({ success: true });
  } catch (err) {
    console.error('Грешка при изпращане на Slack съобщение:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`🤖 Vacation reminder bot слуша на порт ${PORT}`);
});
