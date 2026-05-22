const express = require('express');
const { WebClient } = require('@slack/web-api');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const SLACK_BOT_TOKEN    = process.env.SLACK_BOT_TOKEN;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;
const SPREADSHEET_ID     = process.env.SPREADSHEET_ID;
const ADMIN_SLACK_ID     = process.env.ADMIN_SLACK_ID;
const PORT               = process.env.PORT || 3000;

const slack = new WebClient(SLACK_BOT_TOKEN);

function getSheetsClient() {
  const credentials = JSON.parse(GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getAllRows() {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Лист1!A2:H',
  });
  return res.data.values || [];
}

async function markAsNotified(rowIndex) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Лист1!H${rowIndex + 2}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['YES']] },
  });
}

async function findSlackUserId(email) {
  const result = await slack.users.lookupByEmail({ email });
  return result.user?.id;
}

async function notifyAdmin(message) {
  if (!ADMIN_SLACK_ID) return;
  try {
    await slack.chat.postMessage({ channel: ADMIN_SLACK_ID, text: message });
  } catch (err) {
    console.error('Грешка при известие до admin:', err);
  }
}

async function sendSlackMessage(userEmail, userName, leaveType) {
  const slackUserId = await findSlackUserId(userEmail);
  if (!slackUserId) throw new Error(`Slack user not found for email: ${userEmail}`);

  const lower = leaveType ? leaveType.toLowerCase() : '';
  const isSick = ['болничен', 'болни', 'sick', 'sick day'].some(kw => lower.includes(kw));

  const text = isSick
    ? `:wave: Здравей, *${userName}*!\n\nТвоят болничен е одобрен! Моля, изпрати сканиран/сниман болничен лист на tsvetomir.bogdanov@clico.bg`
    : `:wave: Здравей, *${userName}*!\n\nТвоят отпуск е одобрен! Моля, генерирай официалната си молба от тук: https://kik-info.com/trz/molba-i-zapoved-za-otpusk.php\nПопълни я, подпиши и изпрати на tsvetomir.bogdanov@clico.bg`;

  await slack.chat.postMessage({
    channel: slackUserId,
    text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  });
}

function isSkippedLeaveType(leaveType) {
  const lower = leaveType ? leaveType.toLowerCase() : '';
  return (
    lower.includes('вкъщи') ||
    lower.includes('home') ||
    lower.includes('business trip') ||
    lower.includes('working remotely') ||
    lower.includes('remotely') ||
    lower.includes('командировка')
  );
}

async function checkNewRows() {
  console.log('Проверяване за нови редове...');
  try {
    const rows = await getAllRows();
    for (let i = 0; i < rows.length; i++) {
      const [userEmail, userName, leaveType, startDate, endDate, month, year, notified] = rows[i];
      if (notified === 'YES') continue;
      if (!userEmail || !userName) continue;
      if (isSkippedLeaveType(leaveType)) {
        await markAsNotified(i);
        continue;
      }
      try {
        await sendSlackMessage(userEmail, userName, leaveType);
        await markAsNotified(i);
        console.log(`Изпратено DM до ${userName}`);
        await notifyAdmin(`✅ Clico: Изпратено съобщение до ${userName} за ${leaveType}`);
      } catch (err) {
        console.error(`Грешка при изпращане до ${userName}:`, err);
        await notifyAdmin(`❌ Clico: Грешка при изпращане до ${userName} (${userEmail})`);
      }
    }
  } catch (err) {
    console.error('Грешка при четене на Sheets:', err);
  }
}

let lastReminderDate = '';

async function checkAndRemind() {
  const now = new Date();
  const bgTime = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const day = bgTime.getUTCDate();
  const hour = bgTime.getUTCHours();
  const month = bgTime.getUTCMonth() + 1;
  const year = bgTime.getUTCFullYear();
  const todayKey = `${year}-${month}-${day}`;

  if (day === 22 && hour >= 9 && lastReminderDate !== todayKey) {
    console.log('22-ро е! Изпращаме напомняния...');
    lastReminderDate = todayKey;
    try {
      const rows = await getAllRows();
      let count = 0;
      for (const row of rows) {
        const [userEmail, userName, leaveType, startDate] = row;
        if (!userEmail || !userName) continue;
        if (isSkippedLeaveType(leaveType)) continue;
        const leaveMonth = new Date(startDate).getMonth() + 1;
        const leaveYear = new Date(startDate).getFullYear();
        if (leaveMonth !== month || leaveYear !== year) continue;
        try {
          const slackUserId = await findSlackUserId(userEmail);
          if (!slackUserId) continue;
          await slack.chat.postMessage({
            channel: slackUserId,
            text: `Здравей, *${userName}*! Напомняме ти да изпратиш документите за твоя ${leaveType}, ако все още не си го направил. Моля, изпрати ги на tsvetomir.bogdanov@clico.bg`,
          });
          count++;
          console.log(`Напомняне изпратено до ${userName}`);
        } catch (err) {
          console.error(`Грешка при напомняне до ${userName}:`, err);
        }
      }
      await notifyAdmin(`🔔 Clico: Изпратени ${count} напомняния за 22-ро`);
    } catch (err) {
      console.error('Грешка при четене на Sheets:', err);
    }
  }
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`HR Reminder Bot (Clico) слуша на порт ${PORT}`);
  setInterval(checkNewRows, 5 * 60 * 1000);
  setInterval(checkAndRemind, 15 * 60 * 1000);
  checkNewRows();
  checkAndRemind();
});
