const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── DATABASE ──────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  console.log('Database ready');
}

async function dbGet(key) {
  try {
    const res = await pool.query('SELECT value FROM store WHERE key = $1', [key]);
    return res.rows.length ? JSON.parse(res.rows[0].value) : null;
  } catch(e) { console.error('dbGet error:', e.message); return null; }
}

async function dbSet(key, value) {
  try {
    await pool.query(
      'INSERT INTO store (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, JSON.stringify(value)]
    );
  } catch(e) { console.error('dbSet error:', e.message); }
}

// ── STATE ─────────────────────────────────────────────
let tasks = [];
let cfg = {
  email:'', pubkey:'', service:'', template:'',
  digestTime:'08:00', name:'', backendUrl:'',
  timezone:'Asia/Riyadh', adminPin:'', editorPin:'', managerPin:'', cc:'',
  smtpUser:'', smtpPass:'', privateKey:'', resendKey:''
};
let overdueTimers = {};
let digestCronJob = null;

async function loadFromDB() {
  const savedTasks = await dbGet('tasks');
  const savedCfg   = await dbGet('config');
  if (savedTasks) tasks = savedTasks;
  if (savedCfg)   cfg   = { ...cfg, ...savedCfg };
  console.log(`Loaded: ${tasks.length} tasks, email: ${cfg.email}, digest: ${cfg.digestTime}`);
}

// ── HELPERS ───────────────────────────────────────────
function dueDateTime(t) {
  if (!t.dueDate) return null;
  return t.dueTime ? new Date(`${t.dueDate}T${t.dueTime}`) : new Date(`${t.dueDate}T23:59:59`);
}
function getStatus(t) {
  if (t.done) return 'done';
  if (!t.dueDate) return 'pending';
  const diff = dueDateTime(t) - new Date();
  if (diff < 0) return 'overdue';
  if (diff < 86400000) return 'due-today';
  if (diff < 3*86400000) return 'due-soon';
  return 'pending';
}
function overdueStr(t) {
  const due = dueDateTime(t); if (!due) return '';
  const diff = new Date() - due; if (diff <= 0) return '';
  const d=Math.floor(diff/86400000), h=Math.floor((diff%86400000)/3600000), m=Math.floor((diff%3600000)/60000);
  return d>0?`${d}d ${h}h ${m}m`:h>0?`${h}h ${m}m`:`${m}m`;
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d+'T00:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
}
function fmtTime(t) {
  if (!t) return '';
  const [h,m]=t.split(':');
  return `${+h%12||12}:${m} ${+h>=12?'PM':'AM'}`;
}
// ── EMAIL via Resend API ──────────────────────────────
function emailReady() { return !!(cfg.email && cfg.resendKey); }

async function sendEmail(subject, message, type) {
  if (!emailReady()) { console.log('Email not configured — need email + resendKey'); return false; }
  try {
    const payload = {
      from: 'Task Tracker <onboarding@resend.dev>',
      to: [cfg.email],
      cc: cfg.cc ? [cfg.cc] : undefined,
      subject: subject,
      html: message
    };
    console.log(`[${type}] Sending via Resend to ${cfg.email}...`);
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.resendKey}`
      },
      body: JSON.stringify(payload)
    });
    const responseText = await res.text();
    console.log(`[${type}] Resend response: ${res.status} — ${responseText}`);
    if (!res.ok) throw new Error(`${res.status}: ${responseText}`);
    console.log(`[${type}] Email sent OK: ${subject}`);
    return true;
  } catch(e) {
    console.error(`[${type}] Email FAILED:`, e.message);
    return false;
  }
}

// ── HTML BUILDERS ─────────────────────────────────────
function statusBadgeHtml(s) {
  const styles = {
    overdue:'background:#FDF0EE;color:#C1392B;border:1px solid #F4C4BD',
    'due-today':'background:#FDF5E6;color:#B7670A;border:1px solid #F2D48A',
    'due-soon':'background:#EBF2FB;color:#1A5FA8;border:1px solid #AECBEE',
    pending:'background:#F0EEE9;color:#6B6960;border:1px solid #ddd',
    done:'background:#EAF5EE;color:#2A6E3F;border:1px solid #9ED4B2',
  };
  const labels={overdue:'Overdue','due-today':'Due today','due-soon':'Due soon',pending:'Pending',done:'Done'};
  return `<span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:12px;${styles[s]||styles.pending}">${labels[s]||s}</span>`;
}

function buildEmployeeTableHtml(name, taskList) {
  const rows = taskList.map(t => {
    const s=getStatus(t), ov=overdueStr(t);
    const bg=s==='overdue'?'#FFF8F8':s==='due-today'?'#FFFBF2':'#FFFFFF';
    return `<tr style="background:${bg}">
      <td style="padding:10px 12px;border-bottom:1px solid #EEEBE4;font-size:13px;color:#1A1916;line-height:1.4">${t.details}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #EEEBE4;font-size:13px;color:#6B6960;white-space:nowrap">${t.assignedBy||'—'}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #EEEBE4;font-size:13px;color:#6B6960;white-space:nowrap">${fmtDate(t.assignedDate)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #EEEBE4;font-size:13px;color:#6B6960;white-space:nowrap">${fmtDate(t.dueDate)}${t.dueTime?'<br><span style="font-size:11px">'+fmtTime(t.dueTime)+'</span>':''}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #EEEBE4;text-align:center">${statusBadgeHtml(s)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #EEEBE4;font-size:12px;color:#C1392B;font-weight:600;white-space:nowrap;font-family:monospace">${ov||'—'}</td>
    </tr>`;
  }).join('');
  return `<div style="margin-bottom:28px">
  <div style="background:#1A1916;color:#fff;padding:10px 16px;border-radius:8px 8px 0 0;font-size:14px;font-weight:600;font-family:Arial,sans-serif">
    ${name} <span style="font-weight:400;font-size:12px;opacity:0.7;margin-left:8px">${taskList.length} task${taskList.length>1?'s':''}</span>
  </div>
  <table style="width:100%;border-collapse:collapse;border:1px solid #EEEBE4;border-top:none;font-family:Arial,sans-serif">
    <thead><tr style="background:#F7F6F2">
      <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;color:#9E9B93;border-bottom:1px solid #EEEBE4">Task</th>
      <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;color:#9E9B93;border-bottom:1px solid #EEEBE4;white-space:nowrap">Assigned by</th>
      <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;color:#9E9B93;border-bottom:1px solid #EEEBE4;white-space:nowrap">Assigned date</th>
      <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;color:#9E9B93;border-bottom:1px solid #EEEBE4;white-space:nowrap">Due</th>
      <th style="padding:8px 12px;text-align:center;font-size:11px;font-weight:600;text-transform:uppercase;color:#9E9B93;border-bottom:1px solid #EEEBE4">Status</th>
      <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;color:#9E9B93;border-bottom:1px solid #EEEBE4;white-space:nowrap">Overdue by</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

function buildDigestHtml(overdue, dueToday) {
  const dateStr = new Date().toLocaleDateString('en-GB',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});
  const allTasks = [...overdue,...dueToday];
  const byEmployee = {};
  allTasks.forEach(t => {
    const n=t.assignedTo||'Unassigned';
    if(!byEmployee[n]) byEmployee[n]=[];
    byEmployee[n].push(t);
  });
  const ord={overdue:0,'due-today':1,'due-soon':2,pending:3,done:4};
  Object.keys(byEmployee).forEach(n => byEmployee[n].sort((a,b)=>(ord[getStatus(a)]||3)-(ord[getStatus(b)]||3)));
  const tables = Object.keys(byEmployee).sort().map(n=>buildEmployeeTableHtml(n,byEmployee[n])).join('');
  return `<div style="font-family:Arial,sans-serif;max-width:720px;margin:0 auto;color:#1A1916">
  <div style="margin-bottom:24px">
    <h2 style="font-size:18px;font-weight:600;margin:0 0 4px">Daily Task Digest</h2>
    <p style="font-size:13px;color:#6B6960;margin:0">${dateStr} &nbsp;·&nbsp; ${overdue.length} overdue &nbsp;·&nbsp; ${dueToday.length} due today</p>
  </div>
  <p style="font-size:14px;margin-bottom:20px">Hi ${cfg.name||'there'}, here is your morning summary. Tasks are grouped by employee — copy each table to follow up individually.</p>
  ${tables}
  <p style="font-size:12px;color:#9E9B93;margin-top:16px;border-top:1px solid #EEEBE4;padding-top:12px">Sent by Task Tracker &nbsp;·&nbsp; ${new Date().toLocaleString('en-GB')}</p>
</div>`;
}

function buildInstantHtml(t) {
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1A1916">
  <p style="font-size:14px;margin-bottom:20px">Hi ${cfg.name||'there'}, the following task just passed its due time:</p>
  ${buildEmployeeTableHtml(t.assignedTo||'Unassigned',[t])}
  <p style="font-size:13px;color:#6B6960;margin-top:8px">Please follow up with <strong>${t.assignedTo||'the assignee'}</strong> to understand the delay.</p>
  <p style="font-size:12px;color:#9E9B93;margin-top:16px;border-top:1px solid #EEEBE4;padding-top:12px">Sent by Task Tracker &nbsp;·&nbsp; ${new Date().toLocaleString('en-GB')}</p>
</div>`;
}

// ── SCHEDULER ─────────────────────────────────────────
function clearAllOverdueTimers() { Object.values(overdueTimers).forEach(clearTimeout); overdueTimers={}; }

function scheduleInstantAlert(t) {
  if (overdueTimers[t.id]) clearTimeout(overdueTimers[t.id]);
  if (t.done||!t.dueDate) return;
  const due=dueDateTime(t), diff=due-new Date();
  if (diff<=0) return;
  console.log(`Alert scheduled: "${t.details.slice(0,40)}" in ${Math.round(diff/60000)}min`);
  overdueTimers[t.id] = setTimeout(async()=>{
    await sendEmail(`⚠ Task now overdue — ${t.assignedTo||'Unassigned'}: ${t.details.slice(0,50)}`, buildInstantHtml(t), 'instant');
  }, diff);
}

function scheduleAllInstantAlerts() { clearAllOverdueTimers(); tasks.forEach(t=>scheduleInstantAlert(t)); }

function startDigestCron() {
  if (digestCronJob) digestCronJob.stop();
  if (!cfg.email||!cfg.resendKey) { console.log('Email not configured — cron paused'); return; }
  const [h,m]=(cfg.digestTime||'08:00').split(':');
  const cronExpr=`${parseInt(m)} ${parseInt(h)} * * *`;
  const tz=cfg.timezone||'Asia/Riyadh';
  console.log(`Digest cron: ${cfg.digestTime} (${cronExpr}) tz:${tz}`);
  digestCronJob = cron.schedule(cronExpr, async()=>{
    console.log('Morning digest firing...');
    const overdue  = tasks.filter(t=>!t.done&&t.dueDate&&getStatus(t)==='overdue');
    const dueToday = tasks.filter(t=>!t.done&&t.dueDate&&getStatus(t)==='due-today');
    console.log(`Digest: ${overdue.length} overdue, ${dueToday.length} due today`);
    if (!overdue.length&&!dueToday.length) { console.log('Nothing to report.'); return; }
    await sendEmail(`📋 Daily digest — ${overdue.length} overdue, ${dueToday.length} due today`, buildDigestHtml(overdue,dueToday), 'digest');
  }, { timezone: tz });
}

// ── ROUTES ────────────────────────────────────────────
app.get('/health', (req,res) => {
  res.json({ status:'ok', tasks:tasks.length, emailConfigured:emailReady(), digestTime:cfg.digestTime, timezone:cfg.timezone, email:cfg.email, smtpConfigured:!!(cfg.smtpUser&&cfg.smtpPass) });
});

app.get('/tasks', (req,res) => res.json({ tasks }));

app.post('/tasks', async(req,res) => {
  tasks = req.body.tasks||[];
  await dbSet('tasks', tasks);
  console.log(`Tasks saved: ${tasks.length}`);
  scheduleAllInstantAlerts();
  res.json({ ok:true, count:tasks.length });
});

app.get('/config', (req,res) => {
  res.json({ digestTime:cfg.digestTime, timezone:cfg.timezone, name:cfg.name,
    adminPin:cfg.adminPin, editorPin:cfg.editorPin, managerPin:cfg.managerPin, backendUrl:cfg.backendUrl,
    email:cfg.email, pubkey:cfg.pubkey, service:cfg.service, template:cfg.template, cc:cfg.cc,
    smtpUser:cfg.smtpUser, smtpPass:cfg.smtpPass, privateKey:cfg.privateKey, resendKey:cfg.resendKey });
});

app.post('/config', async(req,res) => {
  cfg = { ...cfg, ...req.body };
  await dbSet('config', cfg);
  console.log(`Config saved: digest:${cfg.digestTime} email:${cfg.email}`);
  startDigestCron();
  scheduleAllInstantAlerts();
  res.json({ ok:true });
});

// Manual test — sends digest email right now with current tasks
app.get('/test-digest', async(req,res) => {
  console.log('Manual test-digest triggered');
  const overdue  = tasks.filter(t=>!t.done&&t.dueDate&&getStatus(t)==='overdue');
  const dueToday = tasks.filter(t=>!t.done&&t.dueDate&&getStatus(t)==='due-today');
  console.log(`Test digest: ${overdue.length} overdue, ${dueToday.length} due today, email:${cfg.email}`);
  const ok = await sendEmail(
    `✅ Test digest — ${overdue.length} overdue, ${dueToday.length} due today`,
    buildDigestHtml(overdue, dueToday), 'test'
  );
  res.json({ ok, overdue:overdue.length, dueToday:dueToday.length, email:cfg.email });
});

app.use((req,res) => {
  console.log('404:', req.method, req.url);
  res.status(404).json({ error:'Not found', path:req.url });
});

// ── START ─────────────────────────────────────────────
const PORT = process.env.PORT||3000;
async function start() {
  await initDB();
  await loadFromDB();
  startDigestCron();
  scheduleAllInstantAlerts();
  app.listen(PORT, () => {
    console.log(`Task Tracker backend on port ${PORT}`);
    // Self-ping every 14 minutes to prevent Render free tier sleep
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    setInterval(async () => {
      try {
        await fetch(url + '/health');
        console.log('Keep-alive ping sent');
      } catch(e) {
        console.log('Keep-alive ping failed:', e.message);
      }
    }, 14 * 60 * 1000);
  });
}
start().catch(console.error);
