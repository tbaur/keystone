# Architecture

Keystone is one Node.js process with one runtime dependency, `socket.io-client`. It talks to each Homebridge UI the same way the UI's own browser page does, stores what it reads in SQLite, and serves a small page that gets updates over server-sent events.

This document explains the design and the reasons for it. Exact limits and timings are named constants at the top of the file that uses them, and the tests in `test/` pin the behaviour. When this document and the code disagree, the code and its tests are right.

```mermaid
flowchart LR
  subgraph each Homebridge instance
    UI[Homebridge UI API]
  end
  UI -- "socket.io /log" --> LS[LogStream]
  UI -- "REST, polled" --> IM[InstanceMonitor]
  LS --> P[LogPipeline] --> DB[(SQLite)]
  P --> HUB[StreamHub]
  IM --> HUB
  DB --> APP[HTTP app]
  HUB -- "server-sent events" --> B[Browser]
  APP -- "JSON pages" --> B
```

## Source layout

| Path | Holds |
|---|---|
| `src/server/main.ts` | Command line, config loading, signals and exit codes |
| `src/server/dashboard-server.ts` | Wires the parts together, runs maintenance, and starts and stops the server |
| `src/server/dashboard.ts` | The overview and the health answer, built from the instance monitors |
| `src/server/config.ts`, `secrets.ts` | Reading and checking `config.json` and the secrets file |
| `src/server/logger.ts`, `json.ts`, `errors.ts` | Structured logging, safe reading of untyped JSON, and reading thrown values and JSON files |
| `src/server/homebridge/` | The Homebridge side: API client, log stream, pollers, backoff, and the mappers that pick fields out of API answers |
| `src/server/logs/` | Splitting lines, reading timestamps, dropping replayed lines, batching writes |
| `src/server/store/` | SQLite schema, migrations, queries and the search text |
| `src/server/auth/` | Password hashing, sessions and login throttling |
| `src/server/http/` | Routes, the event stream, static files and security headers |
| `src/server/cli/` | `npm run secrets` |
| `src/shared/types.ts` | The JSON shapes that server and browser share |
| `src/web/` | The page: plain TypeScript and CSS with no framework and no bundler. `validate.ts` checks the server's JSON field by field before the page uses it |
| `test/` | Unit tests named after the module they cover, plus integration tests against the fake Homebridge UI in `test/helpers/` |
| `test/web/` | Tests of the page (log view, cards, live stream, theme switch) against a small fake DOM, with their own tsconfig so that the DOM types stay out of the server checks |

## Reading from Homebridge

Each instance gets one `HomebridgeApi`, shared by its pollers and its log stream. It logs in with the non-admin user and reuses the token. Calls that start together share one login, and the token is renewed shortly before it expires. A 401 causes one fresh login and one retry. Every request has a timeout, and redirects are refused, because a redirect would carry the login body to wherever it points.

When Homebridge UI rejects the login, the client stops trying until `AUTH_RETRY_MS` has passed, for every caller at once. Homebridge UI locks a user after repeated failures within a few minutes, and this wait is long enough that a wrong password can never cause that lock.

`InstanceMonitor` runs three pollers per instance: status (with child bridges and host stats) often, accessories less often, and plugins and versions rarely. `DEFAULT_INTERVALS` in `instance-monitor.ts` has the numbers. Each poller waits its interval after a run finishes, so slow answers never pile up. After a failure the wait grows with jitter, up to a few intervals, and it returns to the interval after the next success. A rejected login waits `AUTH_RETRY_MS`.

A failed poll keeps the last good data. The card shows how old the status is while Homebridge UI is unreachable, and it shows plugin or accessory errors next to the data that they affect. A connection keeps the time that its state began while only its error text changes, so the age on the card counts from the start of the outage. A failure is logged as a warning once, when the state changes; a failed read of the optional network stats is logged at debug level. If Homebridge is not in insecure mode, the accessories call answers 400. Keystone logs that once and leaves the panel empty, without showing an error.

`/api/accessories` lists services, several per accessory. The mappers count an accessory once per bridge and accessory id, so a sensor with a battery service counts as one accessory and appears once in the low battery list.

The mappers in `mappers.ts` copy fields one by one into Keystone's own types. Fields that are not copied never reach the browser. This matters because the same API answers include the HomeKit setup PIN and pairing IDs.

## The log stream

`LogStream` opens the UI's socket.io `/log` namespace and sends `tail-log`, as the UI's log page does. Homebridge UI then sends a short banner, replays the end of the log file, and streams new lines as they are written. If the socket connects but sends nothing at all, the stream gives up after its connect timeout and tries again.

Before each connection, `LogStream` asks Homebridge UI for the host's time zone. Homebridge stamps each line with `toLocaleString()`, in the host's locale and local time, so the time zone is needed to turn a stamp into an instant. Node knows thousands of locales but only a few dozen shapes of stamp, so `logs/timestamp.ts` reads them all with one general reader rather than a pattern per locale:

- A stamp is six numbers in brackets: a date with a four-digit year first or last, and a time of hour, minute and second, in either order. Short words may sit around them, such as `klo`, `г.,` or a word for the half of the day (`PM`, `오후`, `μ.μ.` and every other one that Node's locales use). A word for the half of the day only counts on its own, so the zone `MDT` is not Albanian `md`. Digits of other scripts, such as Arabic-Indic, count as digits.
- A year far from the arrival time is read in the Buddhist or Persian calendar, the two other calendars that Node's locales use. A stamp whose year no calendar can place still starts a new entry, and gets its arrival time.
- When a date reads two ways (day and month, or year-month-day and year-day-month), the stream uses the order that an earlier line of the same log proved. Before any line has, it takes year-month-day, or the reading closer to the arrival time.
- When clocks go back, an hour of wall times happens twice. The reading closer to the arrival time wins.
- Plugins that write their own lines may use ISO 8601, or JavaScript's `toUTCString()` (`Wed, 21 Oct 2026 18:05:09 GMT`) or `toString()`. A stamp that ends in `GMT`, `UTC`, `Z` or an offset such as `-0600` is read at that offset; one without, or with a zone name such as `MDT`, is read in the host's zone. Any other text in brackets, such as `[Camera 2]`, is not a time, and it stays in the message.

A stamp that is impossible for the arrival time is replaced by the arrival time. `test/line-parser.test.ts` checks one locale of each shape in several time zones.

`LineSplitter` turns the chunks into lines and cuts a runaway line at `MAX_LINE`. Blank lines are dropped. `parseLine` reads the timestamp, plugin and level of each line and keeps the ANSI colours for display. The level comes from the colour that Homebridge gives the message: red is an error, yellow is a warning, dim is debug. A line without a timestamp, such as a stack trace, takes the plugin and time of the line above it, and its level too unless it starts with a colour of its own.

### Dropping the replay

Every connection starts with a replay, so a reconnect would store the same lines twice. `replayStart` in `logs/replay.ts` finds where the replay overlaps what is already stored:

1. It takes the last stored line for the instance and looks for it in the replay.
2. For each place where it appears, it counts how many lines before it also match the stored lines.
3. The place with the longest match wins. On a tie, a match that used every stored line it could compare beats one that stopped at a different line. Otherwise the later place wins, because repeated lines are common at the end of a log. A match needs a few lines, unless it reaches the start of the replay.
4. Lines after that place are new and get stored.

If nothing overlaps, for example because the log file was rotated or Keystone was away for a long time, the replay is stored from its first timestamped line, and the server logs that it found no overlap. The lines before that are the tail of a cut-off line or stack trace. The comparison uses the text without colours, so a change in colour output does not break it. `test/replay.test.ts` holds the cases.

The replay ends once the stream has been quiet for a moment, or after a time limit, whichever comes first. Both are counted from the data itself, not from the connection, so a slow host does not end the replay before it has started.

The stream only counts as connected when the first data arrives, so a rejected token never shows as connected. When it drops, a system line "Log stream lost" goes into the log at warn level. After the replay, "Log stream reconnected" is written at info level. You can see the gap in the same place where you read the log. While the stream stays down, its tries keep the failed state, so the card shows how long it has been down, and only the first failure, or a new error, is logged as a warning.

## Storage

SQLite runs in WAL mode through Node's built-in `node:sqlite`. There are two tables:

- `logs` holds the raw text of each line with its colours, and a `search` column: the plugin name and the message without colours, in lower case. A trigram full-text index on `search` answers text searches. It stores no positions, which keeps it close to the size of the text. Other indexes match the filters, each in page order.
- `sessions` holds the SHA-256 of each session token, never the token, with its user and a fingerprint of that user's password hash.

`LogPipeline` collects lines for a short time and writes them in one transaction, so a replay becomes a few writes. A burst larger than it holds in that time is dropped and counted. When writes fail, it logs the error at most once a minute with the number of lines lost, and `/healthz` reports the store as failing until a write succeeds. The overview carries the same state, so the page shows a banner meanwhile. A failure while sending those stored lines to open browsers is logged on its own. The lines are already stored, so the store stays ok.

The log streams run in the server from start to stop, so collection does not depend on an open browser. At start and then every hour, maintenance removes lines that arrived more than `retentionDays` ago. Then, whatever the retention, it keeps only the newest `MAX_STORED_LINES` ids (the ceiling in `dashboard-server.ts`), so a runaway plugin cannot fill the disk. Ids only grow, so the oldest id to keep is one index lookup, worked out once per run; counting the rows would read the whole table. Maintenance never deletes the newest line, even past retention: SQLite numbers a new row one past the highest id left, so an empty table would start again at 1, and open pages and reconnecting streams, which go by the newest id they have, would miss the new lines. It deletes in small batches and lets other work run between them, so a large prune never stalls the server. Then it deletes expired sessions and lets SQLite refresh its query statistics. Retention counts from arrival, so a replay of old lines is kept for the full period. The 24-hour error counts use the log time.

Migrations are numbered by SQLite's `user_version`. A new version adds a step to the list in `database.ts`. Old steps never change. A database from a newer Keystone is refused at start. `test/database.test.ts` migrates an old database and checks that the indexes are used.

## Serving the browser

The page loads one page of lines from `GET /api/logs` with the current filters, then opens `GET /api/stream` with the id of the newest line it has. A filter in the URL that names an instance which no longer exists is dropped first. If the server refuses the filters anyway, the page says so until the filters change, and shows every line. Any other failure is tried again with a growing wait, so the page recovers once the server answers; meanwhile the list starts empty and shows the live lines that match the new filters, not the rows of the old ones. A stream event that the page cannot read reloads it at most once a minute. The stream is plain server-sent events:

| Event | Data |
|---|---|
| `overview` | Status and host stats for every instance, the 24-hour error and warning counts, and whether log lines are being stored. Bursts of changes are sent once. |
| `logs` | New lines. The event id is the id of the last line. |
| `reset` | The browser fell too far behind and should reload the page. |

EventSource reconnects by itself and sends `Last-Event-ID`, so the server sends exactly the lines that the browser missed. A comment goes out regularly to keep proxies from closing the connection. A browser that stops reading is dropped once too much data waits for it. Each stream checks its session again with every keep-alive, and a sign-out ends that session's streams at once. Once the server starts to stop, a browser that reconnects gets `503` and a closed connection, so it cannot hold the shutdown open.

The stream never renews the session, because it cannot send a cookie once it has started. So the page asks for the overview every few hours, which renews the session like any other request, and a display left open keeps working until the session's fixed end.

A text search that the trigram index can answer, with three or more characters and not too many matches, gets its page from the matching ids. Any other search reads lines one by one in page order. Queries run on the event loop, so such a page reads at most `SCAN_BUDGET` lines (in `log-store.ts`). When that budget runs out before a page is full, the answer says where to go on in `nextBefore`, and the page loads on from there while the reader is near the top.

In the browser, `LogView` keeps lines in log order, by time and then id. Live lines usually go at the end. A line that arrives late, for example from an instance whose replay came later, goes into its place, which the view finds by halving the list rather than walking it. A line that the view already has, such as one that both a new page and the stream bring, is shown once. Lines that arrive while a page reloads wait and follow the page; if more arrive than the view holds, it starts over at the newest lines rather than leave a gap. While the reader follows the log, the view keeps a bounded number of rows. While the reader is scrolled up, new lines are held and counted instead of drawn. Any scroll up stops following at once, so a slow scroll is not pulled back down by the next batch of lines. The view stops following on the first wheel, swipe, key or scrollbar press that moves up, as well as on scroll events, because the browser reports a scroll in a later event and a batch of lines drawn before it would undo the scroll. Jumping to the latest reloads the page of lines when too many arrived in the meantime. Older rows load again by scrolling up. When they load, the view moves by however far the old first row moved, so the same line stays in place whether or not the browser's scroll anchoring has already moved it. Anchoring stays on, because it also keeps the reader's place when rows above change height, for example when wrapping is turned on or off. The browser skips drawing rows that are off screen and counts each as one line tall until it draws them. Without wrapping that count is exact, because a message never holds a line break. With wrapping on, rows can be any height, so every row is drawn. Otherwise rows would change height as they came into view, and the view would jump. `src/web/styles.css` holds these rules. `test/web/log-view.test.ts` holds the cases.

The server filters pages and history. The browser filters live lines with `matches()` in `filters.ts`, so live lines need no extra request. Both search the plugin name and the message without colours, ignoring case and spaces at either end. The plugin filter `[core]` picks the lines from Homebridge itself, which have no plugin; a plugin name cannot hold `]`, so no plugin can have that name. A test in `test/web.test.ts` checks that the two agree, and that the browser cuts a URL's search and plugin to the lengths that the server accepts.

## Security model

Keystone is a read-only window on Homebridge for a few trusted people. The design assumes that the network can see the traffic, and that the browser holds no Homebridge credentials.

- **Homebridge credentials stay on the server.** They live in the secrets file, apart from `config.json`, so a deploy tool can manage the settings without ever handling a password. The secrets file must have no group or other permissions, and the server refuses to start otherwise. It also refuses a `config.json` that holds a password, and an `apiUrl` with credentials in it. The Homebridge user is not an admin, so it cannot restart Homebridge, change the config or read pairings. Keystone warns at start when an `apiUrl` uses plain HTTP to another host, because the password would cross the network unencrypted.
- **A non-admin Homebridge user can still read the setup PIN and change accessories.** Keystone never forwards a write. Each answer is copied into Keystone's own types by hand, so the PIN and setup code are left out. A test checks that neither reaches the overview that the browser gets.
- **A password per user, hashed with scrypt** and compared in constant time. An unknown user name is checked against a dummy hash, so it takes as long as a wrong password and gets the same answer.
- **Login throttling** counts failures per client address, with IPv6 counted per /64, and per user name from any address. Every valid name counts, whether or not it exists, so a lock does not tell which names are real. Past a few free failures, a lock starts at a minute and doubles with each further failure, up to a ceiling. A try is reserved before the password is checked, so parallel tries cannot slip past the limit, and only a couple of checks run at once. A cap on failures per minute from everywhere together slows a distributed attack. Locks by user name and the cap could let a guesser lock the real user out, so an address that signed in as a user within the last 30 days is held back only by its own address's lock, not by that user's lock or the cap. `test/auth.test.ts` has the exact rules.
- **Sessions** are 32 random bytes in an `HttpOnly`, `SameSite=Strict` cookie, which is also `Secure` when `cookieSecure` is on. A session renews while it is used, but ends a fixed time after sign-in however often it is used. It stops working once its user is no longer in the secrets file or that user's password changes. Signing out deletes the session on the server and ends its streams.
- **Requests that change state** (`POST /api/login`, `POST /api/logout`) are refused when the browser's `Sec-Fetch-Site` says they came from another site. A request without that header, or with `none`, is allowed: it comes from a tool such as `curl`, or from the address bar, not from a page on another site, and every browser that Keystone supports sends the header. Bodies are JSON only and small.
- **The host name** in each request must be in `allowedHosts`, or a loopback name, when that setting is used. Otherwise a page on another site could point its own name at Keystone's address (DNS rebinding) and, since the browser would then treat it as same-origin, guess passwords from the reader's browser or read `/healthz`. Keystone answers such a request with `421`, and warns at start while `allowedHosts` is not set.
- **The client address** is the socket address. With `trustProxy` on, a request from loopback may name the real client in `X-Real-IP`, and only a valid IP address is accepted there.
- **The page** is served with a strict Content Security Policy that allows only same-origin scripts and styles and no framing. `X-Content-Type-Options`, `Referrer-Policy: no-referrer` and HSTS (when `cookieSecure` is on) are also set. Log text is only ever added to the page as text nodes, never as HTML.
- **Health** is public, but only a signed-in user sees the instance names and states. Anyone else gets the overall status.
- **Errors** go to the server log with a request id. The browser only sees a generic message and that id.

## What it does not do

These are left out on purpose, to keep Keystone small:

- No control of Homebridge: no restarts, no config edits, no accessory changes. Use the Homebridge UI for those, which Keystone links to.
- No roles and no user admin page. Every user sees everything, and users are managed with `npm run secrets`.
- No alerting. `/healthz` is there for an uptime monitor to watch.
- No metrics history or charts. The host numbers are the current values only.
