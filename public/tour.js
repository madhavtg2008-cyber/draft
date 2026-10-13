// ================= Zoit — the first-time tour =================
// Shown once per person, the first time they sign in (remembered on the server, so it never comes back
// on another device). A spotlight glides between the real controls; Esc or "Skip" ends it.
// It can be replayed from the profile menu.

const first = () => (state.me?.name || '').split(' ')[0];
const isTeam = () => state.me?.role === 'team';

function tourSteps() {
  const s = [
    { title: () => `Welcome to Zoit, ${first()}.`, body: 'A one-minute walk around your new drafting room. Press <kbd>→</kbd> or click Next — <kbd>Esc</kbd> skips.', hello: true },
    { el: '#matterList', title: isTeam() ? 'Your matters' : 'Your matters',
      body: isTeam() ? 'Every case lives here. Each one is private — only your firm, its client and the people you share it with can open it.'
        : 'Everything your lawyer has shared with you. Nobody else can see these.' },
  ];
  if (isTeam()) s.push({ el: '#newToggle', title: 'Open a matter', body: 'Name it, invite the client, start blank or from a template — or drop in a Word or PDF file and it keeps its pages.' });
  s.push(
    { el: '[data-lane="client"]', title: 'I · Client Draft', body: isTeam() ? 'Your client edits here. Everyone writes in their own colour, so you always know who changed what.' : 'Your sheet. Make changes right on the page — they show in your colour and your lawyer confirms them.' },
    { el: '[data-lane="final"]', title: 'II · Clean Draft', body: isTeam() ? 'The final document. No one types in it — it is only ever uploaded from the Team Draft.' : 'The final version from your lawyer. Save it as Word or PDF any time.' },
  );
  if (isTeam()) {
    s.push(
      { el: '[data-lane="team"]', title: 'III · Team Draft', body: 'Lawyers only — clients never see it. Hold a button to send it to the clean draft, or back to the client.' },
      { el: '#shareBtn', title: 'Share the matter', body: 'The client gets a private link — and has to type their full name to get in.' },
      { el: '#teamBtn', title: 'Your team', body: isHead() ? 'Add lawyers by email and choose who may upload or confirm changes.' : 'See who is on your firm’s team.' },
    );
  }
  s.push(
    { el: '.themes', title: 'Make it yours', body: 'Go on — click a theme. Black, White or Navy.', try: true, before: openProfileForTour, after: closeProfile },
    { title: () => 'You’re all set.', body: isTeam() ? 'Open a sheet, start drafting, and let Zoit keep the paper trail.' : 'Open your Client Draft whenever you’re ready.', done: true },
  );
  return s;
}
function openProfileForTour() {
  fillProfile();
  $('#profileMenu').classList.remove('hidden');
  $('#profileBtn').classList.add('on');
}

// ---------- the overlay ----------
const tour = document.createElement('div');
tour.className = 'tour hidden';
tour.innerHTML = `
  <div class="tour-shield"></div>
  <div class="tour-spot"></div>
  <div class="tour-card" role="dialog" aria-live="polite">
    <div class="tour-count"></div>
    <h3 class="tour-title"></h3>
    <p class="tour-body"></p>
    <div class="tour-foot">
      <div class="tour-dots"></div>
      <div class="tour-btns">
        <button class="tour-skip" type="button">Skip</button>
        <button class="tour-back" type="button">Back</button>
        <button class="tour-next" type="button">Next</button>
      </div>
    </div>
  </div>`;
document.body.appendChild(tour);
const spot = $('.tour-spot', tour), card = $('.tour-card', tour);

let steps = [], at = -1;
const visible = (sel) => {
  const el = sel && document.querySelector(sel);
  if (!el || el.closest('.hidden')) return null;
  const r = el.getBoundingClientRect();
  return r.width && r.height ? el : null;
};

function show(i, dir = 1) {
  steps[at]?.after?.();
  // skip stops whose control isn't on screen (e.g. no matter open yet)
  while (steps[i] && steps[i].el && !steps[i].before && !visible(steps[i].el)) i += dir;
  if (i < 0) i = 0;
  if (i >= steps.length) return finish();
  at = i;
  const st = steps[i];
  st.before?.();
  const el = st.el && visible(st.el);
  if (st.el && !el) return show(i + dir, dir);

  tour.classList.toggle('try', !!st.try);
  tour.classList.toggle('centered', !el);
  card.classList.remove('in'); void card.offsetWidth; card.classList.add('in');
  $('.tour-count', tour).textContent = st.hello ? 'Tour' : st.done ? 'Done' : `${i} of ${steps.length - 2}`;
  $('.tour-title', tour).textContent = typeof st.title === 'function' ? st.title() : st.title;
  $('.tour-body', tour).innerHTML = st.body;
  $('.tour-dots', tour).innerHTML = steps.map((_, k) => `<i class="${k === i ? 'on' : k < i ? 'past' : ''}"></i>`).join('');
  $('.tour-back', tour).classList.toggle('hidden', i === 0 || st.done);
  $('.tour-skip', tour).classList.toggle('hidden', !!st.done);
  $('.tour-next', tour).textContent = st.hello ? 'Show me' : st.done ? 'Start drafting' : 'Next';
  place(el);
  if (st.done) burst();
  $('.tour-next', tour).focus({ preventScroll: true });
}

function place(el) {
  const pad = 8, gap = 14, W = innerWidth, H = innerHeight;
  if (!el) {
    Object.assign(spot.style, { left: `${W / 2}px`, top: `${H / 2}px`, width: '0px', height: '0px' });
    Object.assign(card.style, { left: `${Math.max(16, (W - card.offsetWidth) / 2)}px`, top: `${Math.max(16, (H - card.offsetHeight) / 2)}px` });
    return;
  }
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
  const cw = card.offsetWidth, ch = card.offsetHeight;
  // the first side with room: right, left, below, above (else inside the bottom of the target)
  const m = pad + gap, clampTop = (t) => Math.min(Math.max(16, t), H - ch - 16), clampLeft = (l) => Math.min(Math.max(16, l), W - cw - 16);
  const spots = [
    r.right + m + cw <= W - 16 && [r.right + m, clampTop(r.top)],
    r.left - m - cw >= 16 && [r.left - m - cw, clampTop(r.top)],
    r.bottom + m + ch <= H - 16 && [clampLeft(r.left + r.width / 2 - cw / 2), r.bottom + m],
    r.top - m - ch >= 16 && [clampLeft(r.left + r.width / 2 - cw / 2), r.top - m - ch],
  ].filter(Boolean);
  const [left, top] = spots[0] || [clampLeft(r.left + r.width / 2 - cw / 2), clampTop(r.bottom - ch - 16)];
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

// a small celebration of section marks
function burst() {
  const box = document.createElement('div');
  box.className = 'tour-burst';
  const r = card.getBoundingClientRect();
  for (let k = 0; k < 18; k++) {
    const p = document.createElement('span');
    p.textContent = k % 3 ? '§' : '¶';
    const a = (k / 18) * Math.PI * 2, d = 90 + Math.random() * 90;
    p.style.cssText = `left:${r.left + r.width / 2}px;top:${r.top + 30}px;--x:${Math.cos(a) * d}px;--y:${Math.sin(a) * d - 40}px;--r:${Math.random() * 360 - 180}deg;animation-delay:${Math.random() * 120}ms`;
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 1600);
}

function startTour() {
  if (!state.me) return;
  steps = tourSteps();
  at = -1;
  tour.classList.remove('hidden');
  // the first card appears in place instead of sliding in from a corner
  card.style.transition = spot.style.transition = 'none';
  show(0);
  requestAnimationFrame(() => requestAnimationFrame(() => { card.style.transition = spot.style.transition = ''; }));
}
function finish() {
  steps[at]?.after?.();
  tour.classList.add('hidden');
  at = -1;
  if (state.me) { state.me.tourDone = true; api('POST', '/api/me/tour', { done: true }).catch(() => {}); }
}
$('.tour-next', tour).addEventListener('click', () => (steps[at]?.done ? finish() : show(at + 1, 1)));
$('.tour-back', tour).addEventListener('click', () => show(at - 1, -1));
$('.tour-skip', tour).addEventListener('click', finish);
document.addEventListener('keydown', (e) => {
  if (tour.classList.contains('hidden')) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(); }
  else if (e.key === 'ArrowRight' || (e.key === 'Enter' && e.target.tagName !== 'BUTTON')) { e.preventDefault(); $('.tour-next', tour).click(); }
  else if (e.key === 'ArrowLeft' && at > 0) { e.preventDefault(); show(at - 1, -1); }
}, true);
addEventListener('resize', () => { if (at >= 0) place(steps[at].el && visible(steps[at].el)); });

// first sign-in only: start once the app has drawn its matters
new MutationObserver(() => {
  if ($('#app').classList.contains('hidden') || !state.me || state.me.tourDone || at >= 0) return;
  setTimeout(() => { if (state.me && !state.me.tourDone && at < 0 && !$('#app').classList.contains('hidden')) startTour(); }, 1100);
}).observe($('#app'), { attributes: true, attributeFilter: ['class'] });

// replay from the profile menu
$('#pmTour').addEventListener('click', () => { closeProfile(); startTour(); });
