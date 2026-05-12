const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Serve the tracker HTML directly — so it runs on https:// not file://
app.use(express.static(path.join(__dirname, 'public')));

// ── FILE PERSISTENCE ──────────────────────────────────
// Saves to disk so data survives Railway restarts
const DATA_FILE = path.join('/tmp', 'tasktracker_data.json');

function loadFromDisk() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data.tasks) tasks = data.tasks;
      if (data.cfg) cfg = { ...cfg, ...data.cfg };
      console.log('Loaded from disk:', tasks.length, 'tasks');
    }
  } catch(e) { console.error('Error loading from disk:', e.message); }
}

function saveToDisk() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ tasks, cfg }), 'utf8');
  } catch(e) { console.error('Error saving to disk:', e.message); }
}

// ── IN-MEMORY STORE ───────────────────────────────────
let tasks = [];
let cfg = {
  email: '',
  pubkey: '',
  service: '',
  template: '',
  digestTime: '08:00',
  name: '',
  timezone: 'Asia/Riyadh',
  adminPin: '',
  editorPin: '',
  backendUrl: ''
};
let overdueTimers = {};
let digestCronJob = null;

// Load persisted data immediately on startup
loadFromDisk();

// ── HELPERS ───────────────────────────────────────────
function dueDateTime(t) {
  if (!t.dueDate) return null;
  return t.dueTime
    ? new Date(`${t.dueDate}T${t.dueTime}`)
    : new Date(`${t.dueDate}T23:59:59`);
}

function getStatus(t) {
  if (t.done) return 'done';
  if (!t.dueDate) return 'pending';
  const diff = dueDateTime(t) - new Date();
  if (diff < 0) return 'overdue';
  if (diff < 86400000) return 'due-today';
  if (diff < 3 * 86400000) return 'due-soon';
  return 'pending';
}

function overdueStr(t) {
  const due = dueDateTime(t);
  if (!due) return '';
  const diff = new Date() - due;
  if (diff <= 0) return '';
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  return `${+h % 12 || 12}:${m} ${+h >= 12 ? 'PM' : 'AM'}`;
}

function emailReady() {
  return !!(cfg.email && cfg.pubkey && cfg.service && cfg.template);
}

// ── EMAIL ─────────────────────────────────────────────
async function sendEmail(subject, message, type) {
  if (!emailReady()) { console.log('Email not configured, skipping.'); return false; }
  try {
    const payload = {
      service_id: cfg.service,
      template_id: cfg.template,
      user_id: cfg.pubkey,
      template_params: { to_email: cfg.email, subject, message }
    };
    const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`${res.status}: ${err}`);
    }
    console.log(`[${type}] Email sent: ${subject}`);
    return true;
  } catch (e) {
    console.error(`[${type}] Email FAILED:`, e.message);
    return false;
  }
}

// ── EMAIL HTML BUILDERS ───────────────────────────────
function statusBadgeHtml(s) {
  const styles = {
    overdue:    'background:#FDF0EE;color:#C1392B;border:1px solid #F4C4BD',
    'due-today':'background:#FDF5E6;color:#B7670A;border:1px solid #F2D48A',
    'due-soon': 'background:#EBF2FB;color:#1A5FA8;border:1px solid #AECBEE',
    pending:    'background:#F0EEE9;color:#6B6960;border:1px solid #ddd',
    done:       'background:#EAF5EE;color:#2A6E3F;border:1px solid #9ED4B2',
  };
  const labels = { overdue:'Overdue','due-today':'Due today','due-soon':'Due soon',pending:'Pending',done:'Done' };
  return `<span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:12px;${styles[s]||styles.pending}">${labels[s]||s}</span>`;
}

function buildEmployeeTableHtml(employeeName, taskList) {
  const rows = taskList.map(t => {
    const s = getStatus(t);
    const ov = overdueStr(t);
    const rowBg = s === 'overdue' ? '#FFF8F8' : s === 'due-today' ? '#FFFBF2' : '#FFFFFF';
    return `<tr style="background:${rowBg}">
      <td style="padding:10px 12px;border-bottom:1px solid #EEEBE4;font-size:13px;color:#1A1916;line-height:1.4">${t.details}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #EEEBE4;font-size:13px;color:#6B6960;white-space:nowrap">${t.assignedBy || '—'}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #EEEBE4;font-size:13px;color:#6B6960;white-space:nowrap">${fmtDate(t.assignedDate)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #EEEBE4;font-size:13px;color:#6B6960;white-space:nowrap">${fmtDate(t.dueDate)}${t.dueTime ? '<br><span style="font-size:11px">' + fmtTime(t.dueTime) + '</span>' : ''}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #EEEBE4;text-align:center">${statusBadgeHtml(s)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #EEEBE4;font-size:12px;color:#C1392B;font-weight:600;white-space:nowrap;font-family:monospace">${ov || '—'}</td>
    </tr>`;
  }).join('');

  return `
<div style="margin-bottom:28px">
  <div style="background:#1A1916;color:#fff;padding:10px 16px;border-radius:8px 8px 0 0;font-size:14px;font-weight:600;font-family:Arial,sans-serif">
    ${employeeName}
    <span style="font-weight:400;font-size:12px;opacity:0.7;margin-left:8px">${taskList.length} task${taskList.length > 1 ? 's' : ''}</span>
  </div>
  <table style="width:100%;border-collapse:collapse;border:1px solid #EEEBE4;border-top:none;font-family:Arial,sans-serif">
    <thead>
      <tr style="background:#F7F6F2">
        <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;color:#9E9B93;border-bottom:1px solid #EEEBE4">Task</th>
        <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;color:#9E9B93;border-bottom:1px solid #EEEBE4;white-space:nowrap">Assigned by</th>
        <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;color:#9E9B93;border-bottom:1px solid #EEEBE4;white-space:nowrap">Assigned date</th>
        <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;color:#9E9B93;border-bottom:1px solid #EEEBE4;white-space:nowrap">Due</th>
        <th style="padding:8px 12px;text-align:center;font-size:11px;font-weight:600;text-transform:uppercase;color:#9E9B93;border-bottom:1px solid #EEEBE4">Status</th>
        <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;color:#9E9B93;border-bottom:1px solid #EEEBE4;white-space:nowrap">Overdue by</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

function buildDigestHtml(overdue, dueToday) {
  const dateStr = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
  });
  const allTasks = [...overdue, ...dueToday];
  const byEmployee = {};
  allTasks.forEach(t => {
    const name = t.assignedTo || 'Unassigned';
    if (!byEmployee[name]) byEmployee[name] = [];
    byEmployee[name].push(t);
  });
  const ord = { overdue: 0, 'due-today': 1, 'due-soon': 2, pending: 3, done: 4 };
  Object.keys(byEmployee).forEach(name => {
    byEmployee[name].sort((a, b) => (ord[getStatus(a)] || 3) - (ord[getStatus(b)] || 3));
  });
  const employeeTables = Object.keys(byEmployee).sort()
    .map(name => buildEmployeeTableHtml(name, byEmployee[name])).join('');

  return `<div style="font-family:Arial,sans-serif;max-width:720px;margin:0 auto;color:#1A1916">
  <div style="margin-bottom:24px">
    <h2 style="font-size:18px;font-weight:600;margin:0 0 4px">Daily Task Digest</h2>
    <p style="font-size:13px;color:#6B6960;margin:0">${dateStr} &nbsp;·&nbsp; ${overdue.length} overdue &nbsp;·&nbsp; ${dueToday.length} due today</p>
  </div>
  <p style="font-size:14px;margin-bottom:20px">Hi ${cfg.name || 'there'}, here is your morning summary. Tasks are grouped by employee — copy each table to follow up individually.</p>
  ${employeeTables}
  <p style="font-size:12px;color:#9E9B93;margin-top:16px;border-top:1px solid #EEEBE4;padding-top:12px">Sent by Task Tracker &nbsp;·&nbsp; ${new Date().toLocaleString('en-GB')}</p>
</div>`;
}

function buildInstantHtml(t) {
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1A1916">
  <p style="font-size:14px;margin-bottom:20px">Hi ${cfg.name || 'there'}, the following task just passed its due time:</p>
  ${buildEmployeeTableHtml(t.assignedTo || 'Unassigned', [t])}
  <p style="font-size:13px;color:#6B6960;margin-top:8px">Please follow up with <strong>${t.assignedTo || 'the assignee'}</strong> to understand the delay.</p>
  <p style="font-size:12px;color:#9E9B93;margin-top:16px;border-top:1px solid #EEEBE4;padding-top:12px">Sent by Task Tracker &nbsp;·&nbsp; ${new Date().toLocaleString('en-GB')}</p>
</div>`;
}

// ── SCHEDULER ─────────────────────────────────────────
function clearAllOverdueTimers() {
  Object.values(overdueTimers).forEach(clearTimeout);
  overdueTimers = {};
}

function scheduleInstantAlert(t) {
  if (overdueTimers[t.id]) clearTimeout(overdueTimers[t.id]);
  if (t.done || !t.dueDate) return;
  const due = dueDateTime(t);
  const diff = due - new Date();
  if (diff <= 0) return;
  console.log(`Scheduling instant alert for "${t.details.slice(0, 40)}" in ${Math.round(diff / 60000)} minutes`);
  overdueTimers[t.id] = setTimeout(async () => {
    const subject = `⚠ Task now overdue — ${t.assignedTo || 'Unassigned'}: ${t.details.slice(0, 50)}`;
    await sendEmail(subject, buildInstantHtml(t), 'instant');
  }, diff);
}

function scheduleAllInstantAlerts() {
  clearAllOverdueTimers();
  tasks.forEach(t => scheduleInstantAlert(t));
}

function startDigestCron() {
  if (digestCronJob) digestCronJob.stop();
  const [h, m] = (cfg.digestTime || '08:00').split(':');
  // cron format: minute hour * * *
  const cronExpr = `${parseInt(m)} ${parseInt(h)} * * *`;
  console.log(`Scheduling daily digest at ${cfg.digestTime} (cron: ${cronExpr})`);
  digestCronJob = cron.schedule(cronExpr, async () => {
    console.log('Running morning digest...');
    const overdue  = tasks.filter(t => !t.done && t.dueDate && getStatus(t) === 'overdue');
    const dueToday = tasks.filter(t => !t.done && t.dueDate && getStatus(t) === 'due-today');
    if (!overdue.length && !dueToday.length) {
      console.log('No overdue or due-today tasks — digest skipped.');
      return;
    }
    const subject = `📋 Daily digest — ${overdue.length} overdue, ${dueToday.length} due today`;
    await sendEmail(subject, buildDigestHtml(overdue, dueToday), 'digest');
  }, { timezone: cfg.timezone || 'Asia/Riyadh' });
}

// ── API ROUTES ────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    tasks: tasks.length,
    emailConfigured: emailReady(),
    digestTime: cfg.digestTime,
    timezone: cfg.timezone
  });
});

// Tracker pushes tasks here whenever they change
app.post('/tasks', (req, res) => {
  tasks = req.body.tasks || [];
  console.log(`Tasks updated: ${tasks.length} tasks received`);
  saveToDisk();
  scheduleAllInstantAlerts();
  res.json({ ok: true, count: tasks.length });
});

// Tracker pushes config here when settings are saved
app.post('/config', (req, res) => {
  cfg = { ...cfg, ...req.body };
  console.log(`Config updated: digest at ${cfg.digestTime}, email: ${cfg.email}`);
  saveToDisk();
  startDigestCron();
  scheduleAllInstantAlerts();
  res.json({ ok: true });
});

// Tracker fetches tasks on load (so tasks survive server restarts if you re-open tracker)
app.get('/tasks', (req, res) => {
  res.json({ tasks });
});

// Return full cfg needed by clients (pins, digest time, timezone, name — NOT emailjs keys)
app.get('/config', (req, res) => {
  res.json({
    digestTime: cfg.digestTime,
    timezone: cfg.timezone,
    name: cfg.name,
    adminPin: cfg.adminPin,
    editorPin: cfg.editorPin,
    backendUrl: cfg.backendUrl
  });
});

// Manual trigger for testing
app.post('/test-digest', async (req, res) => {
  const overdue  = tasks.filter(t => !t.done && t.dueDate && getStatus(t) === 'overdue');
  const dueToday = tasks.filter(t => !t.done && t.dueDate && getStatus(t) === 'due-today');
  const subject = `✅ Test digest — ${overdue.length} overdue, ${dueToday.length} due today`;
  const ok = await sendEmail(subject, buildDigestHtml(overdue, dueToday), 'digest');
  res.json({ ok });
});

// Catch-all for unknown routes — helps debug 404s
app.use((req, res) => {
  console.log('404 Not Found:', req.method, req.url);
  res.status(404).json({ error: 'Not found', path: req.url });
});

// ── START ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Task Tracker backend running on port ${PORT}`);
  startDigestCron();
});
