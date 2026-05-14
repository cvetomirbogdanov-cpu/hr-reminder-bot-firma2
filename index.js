const express = require('express');
const { WebClient } = require('@slack/web-api');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const PORT            = process.env.PORT || 3000;

const slack = new WebClient(SLACK_BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function buildSlackMessage(userName, leaveTypeName, reminderId) {
  const lower = leaveTypeName ? leaveTypeName.toLowerCase() : '';
  const isSick = ['болничен', 'болни', 'sick'].some(kw => lower.includes(kw));

  const text = isSick
    ? `Твоят болничен е одобрен! Моля, изпрати сканиран/сниман болничен лист на tsvetomir.bogdanov@clico.bg\n\nСлед като изпратиш документите, натисни бутона ✅ Изпратих по-долу.`
    : `Твоят отпуск е одобрен! Моля, генерирай официалната си молба от тук: https://kik-info.com/trz/molba-i-zapoved-za-otpusk.php\nПопълни я, подпиши и изпрати на tsvetomir.bogdanov@clico.bg\n\nСлед като изпратиш документите, натисни бутона ✅ Изпратих по-долу.`;

  return {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:wave: Здравей, *${userName}*!\n\n${text}`
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "✅ Изпратих" },
            style: "primary",
            action_id: "confirm_sent",
            value: reminderId
          }
        ]
      }
    ]
  };
}

async function findSlackUserId(email) {
  const result = await slack.users.lookupByEmail({ email });
  return result.user?.id;
}

app.post('/webhook', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body;
  console.log('Получен webhook:', JSON.stringify(payload, null, 2));

  if (payload.eventType !== 'APPROVED') {
    return res.json({ skipped: true });
  }

  const { userEmail, userName, leaveTypeName } = payload;
  const lower = leaveTypeName ? leaveTypeName.toLowerCase() : '';

  // Пропускаме Working Remotely и Business Trip
  if (lower.includes('remotely') || lower.includes('business trip') || lower.includes('командировка')) {
    return res.json({ skipped: true });
  }

  if (!userEmail) {
    return res.status(400).json({ error: 'Missing userEmail' });
  }

  try {
    const slackUserId = await findSlackUserId(userEmail);
    if (!slackUserId) {
      return res.status(404).json({ error: 'Slack user not found' });
    }

    const { data, error } = await supabase
      .from('reminders')
      .insert({ user_email: userEmail, user_name: userName, leave_type: leaveTypeName, slack_user_id: slackUserId })
      .select()
      .single();

    if (error) throw error;

    const message = buildSlackMessage(userName, leaveTypeName, data.id);
    await slack.chat.postMessage({
      channel: slackUserId,
      ...message
    });

    console.log(`✅ Изпратено DM до ${userName} (${userEmail})`);
    res.json({ success: true });
  } catch (err) {
    console.error('Грешка:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/slack/actions', express.urlencoded({ extended: true }), async (req, res) => {
  const payload = JSON.parse(req.body.payload);
  const action = payload.actions[0];
  const reminderId = action.value;

  await supabase
    .from('reminders')
    .update({ clicked: true, clicked_at: new Date().toISOString() })
    .eq('id', reminderId);

  await slack.chat.update({
    channel: payload.channel.id,
    ts: payload.message.ts,
    text: "✅ Изпратено.",
    blocks: []
  });

  res.send('');
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`🤖 Vacation reminder bot слуша на порт ${PORT}`);
});

const CHECK_INTERVAL = 60 * 60 * 1000;

async function checkAndRemind() {
  const today = new Date();
  const day = today.getDate();
  const hour = today.getHours();

  if (day === 22 && hour === 9) {
    console.log('🔔 22-ро е! Изпращаме напомняния...');

    const { data: pending } = await supabase
      .from('reminders')
      .select('*')
      .eq('clicked', false);

    for (const reminder of pending) {
      try {
        await slack.chat.postMessage({
          channel: reminder.slack_user_id,
          text: `⚠️ Здравей, *${reminder.user_name}*! Напомняме ти, че все още не сме получили документите за твоя ${reminder.leave_type}. Моля, изпрати ги възможно най-скоро на tsvetomir.bogdanov@clico.bg`
        });
        console.log(`✅ Напомняне изпратено до ${reminder.user_name}`);
      } catch (err) {
        console.error(`Грешка при напомняне до ${reminder.user_name}:`, err);
      }
    }
  }
}

setInterval(checkAndRemind, CHECK_INTERVAL);
