#!/usr/bin/env node
'use strict';

/**
 * sync-gmcla-cal.js
 * Fetches the GMCLA chorusconnection.com calendar, extracts World Pride &
 * London Tour events (Jul 31 – Aug 9 2026), and writes the result as
 * gmcla-schedule-data.json next to the HTML page.
 *
 * Run:  node scripts/sync-gmcla-cal.js
 * CI:   see .github/workflows/sync-gmcla-cal.yml
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

/* ─── Configuration ──────────────────────────────────────────────── */

const CAL_URL = 'https://api.chorusconnection.com/my_calendar?key=e78d54eb479e4d8ca33f1a31f07219b4';

/** Tour window (inclusive, YYYYMMDD). */
const TOUR_START = '20260731';
const TOUR_END   = '20260809';

/**
 * Static required-event whitelist.
 * Case-insensitive substring match against the trimmed ICS SUMMARY.
 * If a title here is absent from the calendar on a given run, it simply
 * won't appear — no error, no placeholder.
 *
 * Add / remove entries here to change which events get the ★ badge.
 */
const REQUIRED_TITLES = [
  'Welcome & Reception with Queer Voices Unite',
  'Canal for Parade Viewing',
  'Private Boat Tour of Amsterdam',
  'Public Acapella Singing in Amsterdam with Choruses',
  'Sound Check and Rehearsal at Concertgebouw',
  'Concert at the Concertgebouw',
  'World Pride Opening',
  'Rehearsal at St. Paul\'s Church',
  'London Show #1',
  'London Concert #2',
  'London Concert #3',
  'Closing Dance Party',
];

const OUT_FILE = path.join(__dirname, '..', 'gmcla-schedule-data.json');

/* ─── HTTP helper (follows one redirect) ─────────────────────────── */

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end',  () => resolve(body));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/* ─── ICS parsing helpers ────────────────────────────────────────── */

/**
 * Unfold ICS continuation lines (lines beginning with a single space or tab
 * are continuations of the previous line per RFC 5545 §3.1).
 */
function unfold(text) {
  return text.replace(/\r?\n[ \t]/g, '');
}

/**
 * Parse a single VEVENT block (text between BEGIN:VEVENT and END:VEVENT)
 * into a plain key→value object.  Parameter segments (e.g. DTSTART;TZID=…)
 * are stripped — only the base key and the value after ':' are kept.
 */
function parseVEvent(block) {
  const ev = {};
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).split(';')[0].toUpperCase();
    ev[key] = line.slice(colon + 1);
  }
  return ev;
}

/**
 * Parse an ICS datetime value (20260731T160000 or 20260805 for all-day).
 * Returns { date:'2026-07-31', hour:16, min:0, allDay:false } or null.
 */
function parseDT(val) {
  if (!val) return null;
  val = val.trim();
  // All-day value: bare 8-digit date
  if (/^\d{8}$/.test(val)) {
    return {
      date: `${val.slice(0,4)}-${val.slice(4,6)}-${val.slice(6,8)}`,
      hour: 0, min: 0, allDay: true,
    };
  }
  // Date-time: 20260731T160000[Z]
  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
  if (!m) return null;
  return {
    date: `${m[1]}-${m[2]}-${m[3]}`,
    hour: parseInt(m[4], 10),
    min:  parseInt(m[5], 10),
    allDay: false,
  };
}

/** Format a parsed datetime as 12-hour clock string, e.g. "4:00 PM". */
function fmtTime(dt) {
  if (!dt || dt.allDay) return '';
  const h12  = dt.hour % 12 === 0 ? 12 : dt.hour % 12;
  const ampm = dt.hour < 12 ? 'AM' : 'PM';
  const mm   = dt.min === 0 ? '' : `:${String(dt.min).padStart(2, '0')}`;
  return `${h12}${mm} ${ampm}`;
}

/** Sort key: minutes from midnight. */
function sortMins(dt) {
  if (!dt || dt.allDay) return 0;
  return dt.hour * 60 + dt.min;
}

/** Decode standard ICS text escapes. */
function decodeICS(str) {
  return (str || '')
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

/** True if title (trimmed, lowercased) contains any REQUIRED_TITLES entry. */
function isRequired(title) {
  // Normalize smart/curly quotes to straight apostrophe before comparing
  const t = title.replace(/[\u2018\u2019\u201A\u201B]/g, "'").toLowerCase();
  return REQUIRED_TITLES.some((r) =>
    t.includes(r.replace(/[\u2018\u2019\u201A\u201B]/g, "'").toLowerCase())
  );
}

/* ─── Main ───────────────────────────────────────────────────────── */

async function main() {
  console.log(`Fetching ${CAL_URL} …`);
  const raw = await httpGet(CAL_URL);
  const unfolded = unfold(raw);

  // Extract all VEVENT blocks
  const blocks = unfolded.split('BEGIN:VEVENT').slice(1)
    .map((b) => b.split('END:VEVENT')[0]);

  // Parse and filter to tour window
  const tourEvents = blocks
    .map((b) => {
      const ev    = parseVEvent(b);
      const start = parseDT(ev['DTSTART']);
      if (!start) return null;
      const dateKey = start.date.replace(/-/g, '');
      if (dateKey < TOUR_START || dateKey > TOUR_END) return null;
      return {
        rawTitle: (ev['SUMMARY']  || '').trim(),
        start,
        end:      parseDT(ev['DTEND']),
        location: decodeICS(ev['LOCATION']    || ''),
        desc:     decodeICS(ev['DESCRIPTION'] || ''),
      };
    })
    .filter(Boolean);

  // Separate "Call for …" events from main events
  const callFors  = tourEvents.filter((e) => /^call for\s+/i.test(e.rawTitle));
  const mainEvs   = tourEvents.filter((e) => !/^call for\s+/i.test(e.rawTitle));

  // Annotate main events with call time from companion "Call for …" entry
  for (const call of callFors) {
    // "Call for Optional: X" → companion title is "Optional: X"
    // "Call for X"           → companion title is "X"
    const companionTitle = call.rawTitle.replace(/^call for\s+/i, '').trim();
    const companion = mainEvs.find(
      (e) => e.rawTitle.toLowerCase() === companionTitle.toLowerCase()
    );
    if (companion) {
      companion.callTime = fmtTime(call.start);
    }
  }

  // Build SCHEDULE entries
  const schedule = mainEvs.map((ev) => {
    // Strip "Optional:" prefix from display title
    let title = ev.rawTitle.replace(/^optional:\s+/i, '').trim();

    // Category: whitelist check (stripped title), else optional
    const category = isRequired(title) ? 'required' : 'optional';

    // Description: prepend call time when present
    let desc = ev.desc;
    if (ev.callTime) {
      desc = `Call time: ${ev.callTime}` + (desc ? '\n' + desc : '');
    }

    return {
      day:      ev.start.date,
      sort:     sortMins(ev.start),
      category,
      time:     fmtTime(ev.start),
      timeEnd:  ev.end ? fmtTime(ev.end) : '',
      title,
      desc,
      location: ev.location,
    };
  });

  // Sort by day then time
  schedule.sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    return a.sort - b.sort;
  });

  const syncedAt = new Date().toISOString();
  const output   = { syncedAt, schedule };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2) + '\n', 'utf8');

  // Summary
  console.log(`\nWrote ${schedule.length} events → ${OUT_FILE}`);
  console.log(`Synced at: ${syncedAt}\n`);
  for (const e of schedule) {
    const tag = e.category === 'required' ? '★' : ' ';
    console.log(`  ${tag} ${e.day}  ${(e.time || 'all-day').padEnd(10)}  ${e.title}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
