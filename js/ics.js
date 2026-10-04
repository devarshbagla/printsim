// Calendar reminders for a running print, with no server: an .ics file for
// Apple Calendar / Outlook, and a Google Calendar "add event" link (the Google
// Calendar Android app can't import .ics files, so it needs its own path).
//
// Each export gets fresh UIDs on purpose: iOS silently ignores a re-imported
// event that reuses a UID ("Add All" does nothing), so after a resync the user
// gets new events and deletes the old ones, instead of nothing happening.

const pad = (n) => String(n).padStart(2, '0');

// 20260929T051500Z
export function icsDate(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

// RFC 5545 TEXT escaping
export function icsText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// RFC 5545 line folding: at most 75 octets per line, continuation lines start with a space.
// Never splits a UTF-8 character.
export function foldLine(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '', bytes = 0, limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      out.push(cur);
      cur = ' ';
      bytes = 1;
      limit = 75;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

const cleanName = (name) => String(name || 'your print').replace(/\.(b?gcode|gcode\.3mf)$/i, '');

/**
 * What to put on the calendar, in wall-clock time.
 * @param {object} o
 * @param {number} o.nowMs     wall clock now (ms)
 * @param {number} o.simNow    sim seconds now
 * @param {number} o.total     sim seconds at the end of the print
 * @param {{t:number,type:string}[]} o.pauses  timeline pauses (filament swaps, file pauses)
 * @param {string} o.name      file name
 * @param {string} [o.printer] printer name
 * @param {string} [o.url]     link back to printsim
 * @param {string} [o.finishUrl] link that opens the "when did it finish?" prompt
 */
export function planEvents({ nowMs, simNow, total, pauses = [], name, printer = '', url = '', finishUrl = '' }) {
  const label = cleanName(name);
  const ahead = pauses.filter((p) => p.t > simNow + 0.01).sort((a, b) => a.t - b.t);
  const at = (t) => nowMs + Math.max(0, t - simNow) * 1000;
  const tail = [printer && `Printer: ${printer}`, url && `Open printsim: ${url}`].filter(Boolean).join('\n');
  const events = ahead.map((p, i) => ({
    kind: p.type,
    title: p.type === 'filament' ? `Filament swap: ${label}`
      : p.type === 'runout' ? `Filament runs out: ${label}`
      : `Print pauses: ${label}`,
    start: at(p.t),
    end: at(p.t) + 10 * 60e3,
    alarms: [5, 0],
    description: [
      p.type === 'filament'
        ? 'The printer stops here for a filament change. Swap it, then tap Resume in printsim.'
        : p.type === 'runout'
          ? 'printsim predicts the spool runs out here. The printer pauses and unloads. Load a new spool, then tap Resume in printsim.'
          : 'The file pauses the printer here. Tap Resume in printsim when it carries on.',
      i > 0 ? 'Time assumes the earlier stop was instant, so it may run a little late.' : '',
      tail,
    ].filter(Boolean).join('\n\n'),
  }));
  const finish = at(total);
  events.push({
    kind: 'finish',
    title: `Print done: ${label}`,
    start: finish,
    end: finish + 15 * 60e3,
    alarms: [10, 0],
    description: [
      `printsim predicts ${label} finishes around now.`,
      ahead.length ? `Plus however long the ${ahead.length > 1 ? `${ahead.length} stops take` : 'stop takes'} (filament swap or pause).` : '',
      'Resynced or changed the speed? Add it to your calendar again and delete this one.',
      finishUrl ? `Finished? Tell printsim when, so it learns how fast this printer really is: ${finishUrl}` : '',
      printer ? `Printer: ${printer}` : '',
      finishUrl ? '' : tail,
    ].filter(Boolean).join('\n\n'),
  });
  return events;
}

/** Build the .ics text (CRLF line endings, folded, escaped). */
export function buildIcs(events, { nowMs = Date.now(), uidSeed = nowMs } = {}) {
  const L = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//printsim//print reminders//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  events.forEach((e, i) => {
    L.push(
      'BEGIN:VEVENT',
      `UID:${uidSeed}-${i}-${e.kind}@printsim`,
      `DTSTAMP:${icsDate(nowMs)}`,
      `DTSTART:${icsDate(e.start)}`,
      `DTEND:${icsDate(e.end)}`,
      `SUMMARY:${icsText(e.title)}`,
      `DESCRIPTION:${icsText(e.description)}`,
      'TRANSP:TRANSPARENT',
    );
    for (const m of e.alarms) {
      L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(e.title)}`, `TRIGGER:${m ? `-PT${m}M` : 'PT0M'}`, 'END:VALARM');
    }
    L.push('END:VEVENT');
  });
  L.push('END:VCALENDAR');
  return L.map(foldLine).join('\r\n') + '\r\n';
}

/** Google Calendar "add event" link for one event (Google applies the user's default reminders). */
export function googleCalendarUrl(e) {
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: e.title,
    dates: `${icsDate(e.start)}/${icsDate(e.end)}`,
    details: e.description,
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}
