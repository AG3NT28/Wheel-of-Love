# Wheel of Love — Café du L'Amour

A spin-to-win experience for today's event, plus an admin dashboard so your
team can edit what's on the wheel and how likely each prize is — no code
required after setup.

- **Guest page** (`/`) — the romantic, mobile-friendly spin wheel guests use.
- **Admin dashboard** (`/admin.html`) — password-protected page to edit
  segments, probabilities, and review/export today's spins.

The wheel visually shows equal slices, but which prize a guest actually wins
is decided by the server using the **weight** you set for each privilege —
so the odds are never visible or guessable from the outside, and can't be
tampered with from a guest's phone.

---

## 1. Requirements

- [Node.js](https://nodejs.org) version 18 or newer.

Check your version:
```bash
node -v
```

## 2. Install & run

```bash
cd wheel-of-love
npm install
npm start
```

Then open:
- Guest wheel: **http://localhost:3000**
- Admin dashboard: **http://localhost:3000/admin.html**

The default admin password is:
```
lamour2026
```
**Change this before the event** — see Configuration below.

## 3. Configuration

The server reads three optional environment variables. You can set them
however your host normally handles environment variables, or export them
in your shell before starting:

```bash
export ADMIN_PASSWORD="a-new-password"
export SESSION_SECRET="a-long-random-string"
export PORT=3000
npm start
```

An `.env.example` file is included as a reference for what to set. If
you're on Node 20.6+, you can save your own copy as `.env` and run:
```bash
node --env-file=.env server.js
```

| Variable         | Default        | What it does                                   |
|------------------|----------------|-------------------------------------------------|
| `ADMIN_PASSWORD` | `lamour2026`   | Password to open the admin dashboard             |
| `SESSION_SECRET` | (built-in)     | Used to sign the admin login session — change for real use |
| `PORT`           | `3000`         | Port the server listens on                       |

## 4. Using the admin dashboard

Go to `/admin.html` and enter the admin password.

**Wheel Segments tab**
- Each card is one prize on the wheel: its name, wheel label, colour, badge
  icon, today's reward text, next-visit reward text, validity window, and
  **weight**.
- The **weight** controls probability, not the visual size of the slice —
  every guest sees equal slices no matter the odds. A segment with weight
  `40` is roughly twice as likely to be picked as one with weight `20`.
  Weights don't need to add up to 100; the bar at the top of the panel
  always shows the live percentage breakdown.
- Turn a prize off with the **Active** switch instead of deleting it if you
  might want it back later — inactive segments never appear on the wheel
  and are excluded from the odds.
- Reorder segments with the ▲ ▼ buttons; this is the order they appear on
  the wheel going clockwise from the top.
- **Save changes** writes to the wheel immediately — guests spinning right
  now will see the update on their next spin.
- **Reset to today's defaults** restores the five L'Amour Privileges
  (Bronze → Diamond) exactly as configured for today's launch.

**Spin Log tab**
- Every spin is recorded with a timestamp, guest name/phone (if given), the
  prize won, and a redemption code like `LOVE-7F3K9X`.
- Ask guests to show their result screen (with the code) to redeem —
  cross-check it against this list if needed.
- **Export CSV** downloads the full log for your records.
- **Clear history** wipes the log — handy right before the event starts if
  you did any test spins.

## 5. How a spin works, technically

1. The guest's browser asks the server which prizes are currently active
   (`GET /api/segments`) — this response never includes weights or reward
   text, so the odds and prizes stay a surprise.
2. On spin, the browser calls `POST /api/spin`. The **server** — not the
   browser — rolls the weighted random pick, logs it, generates the
   redemption code, and only then tells the browser which segment won.
3. The browser animates the wheel to land on that segment and reveals the
   reward.

This keeps the outcome fair and tamper-proof: nothing about the odds is
ever sent to or computed in the guest's browser.

## 6. Project structure

```
wheel-of-love/
├── server.js                # Express server + API
├── package.json
├── .env.example
├── data/
│   ├── segments.json         # Live wheel configuration (edited by admin)
│   ├── segments.default.json # "Reset to today's defaults" restores this
│   └── spins.json            # Spin log
└── public/
    ├── index.html             # Guest-facing wheel
    ├── admin.html              # Admin dashboard
    ├── css/style.css           # Guest page styling
    ├── css/admin.css           # Admin dashboard styling
    ├── js/wheel.js             # Wheel drawing + spin logic
    ├── js/admin.js             # Admin dashboard logic
    └── assets/                 # Logo + favicon
```

All data lives in the two JSON files under `data/` — back them up if you
want a record beyond the CSV export, and note they reset if you deploy to
a host with an ephemeral filesystem (see below).

## 7. Deploying for the event

Any host that can run a small Node.js app works (Render, Railway, a VPS,
your own laptop on the café Wi-Fi, etc.):

```bash
npm install
ADMIN_PASSWORD="your-password" SESSION_SECRET="something-random" npm start
```

Point guests at the server's address (a QR code to that URL works great on
table tents). If your host wipes the filesystem between deploys, remember
that `data/segments.json` and `data/spins.json` will reset too — export
your spin log before redeploying.

## 8. Notes

- One browser session per device: there's no login for guests, so if the
  wheel is on a shared tablet at the counter, have a staff member hand it
  over per guest and reset the form between spins (this is automatic —
  "Continue" on the result card resets the name field).
- Redemption codes are generated per spin and are not single-use-enforced
  automatically — cross-reference the Spin Log if you want to guard
  against a code being reused.
