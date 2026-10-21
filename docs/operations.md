# Operations

This guide covers running Keystone as a service behind nginx, keeping it healthy and fixing common problems. The examples use `/opt/keystone` for the checkout, `example` for the service account and `keystone.example.com` for the site. Replace them with your own.

## Create the Homebridge users

Do this in each Homebridge UI that Keystone should read.

1. Open **Users** and choose **Add User**.
2. Set the username to `keystone` and give it a long random password.
3. Leave **Admin User?** off. Keystone only reads, and a non-admin user cannot restart Homebridge, edit the config or see pairings.
4. Do not turn on 2FA for this user. Keystone signs in with only a username and password.

Two Homebridge settings also matter:

- `restrictLogsToAdmins` in the Homebridge UI's own config must stay off. If it is on, non-admin users cannot read the log. The instance's card then says that Homebridge UI refused the log.
- The accessory panel, which shows low batteries, needs Homebridge to run in insecure mode (`-I`). Without it, that panel stays empty and everything else works.

`npm run secrets` asks for each Homebridge user's password during the install.

## Install

```bash
sudo mkdir -p /opt/keystone
sudo chown example /opt/keystone
sudo -u example git clone <repo-url> /opt/keystone
cd /opt/keystone
sudo -u example npm ci
sudo -u example npm run build
```

Write `config.json` from `config.example.json`. It holds no secrets, so a deploy tool such as Ansible can write it. Behind nginx on the same host, set `"trustProxy": true`. Then write the secrets file as the service account:

```bash
sudo -u example npm run secrets
```

It asks for a first Keystone user name and that user's password twice, then for each instance's Homebridge password, and writes `secrets.json` with mode 600. It tells you the rules if a name or password is not accepted. The server refuses to start if the file has any group or other permission.

`npm ci` installs the development tools that the build needs. After the build, `npm prune --omit=dev` removes them again if you want a smaller install.

## Run as a service

On macOS, use a LaunchDaemon such as `/Library/LaunchDaemons/com.example.keystone.plist`. Use the path that `command -v node` prints: Homebrew installs to `/opt/homebrew/bin/node` on Apple silicon and `/usr/local/bin/node` on Intel.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.keystone</string>
  <key>UserName</key><string>example</string>
  <key>WorkingDirectory</key><string>/opt/keystone</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>dist/server/main.js</string>
    <string>--config</string>
    <string>/opt/keystone/config.json</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>/opt/keystone/data/keystone.log</string>
  <key>StandardErrorPath</key><string>/opt/keystone/data/keystone.log</string>
</dict>
</plist>
```

```bash
sudo launchctl bootstrap system /Library/LaunchDaemons/com.example.keystone.plist
sudo launchctl kickstart -k system/com.example.keystone   # restart
```

With `SuccessfulExit` set to false, launchd restarts Keystone after a failure but not after a clean stop, and `ThrottleInterval` spaces the restarts out. launchd cannot tell a bad config from a crash, so check the log when Keystone keeps restarting.

launchd does not rotate that log file. Add a `newsyslog` entry such as `/etc/newsyslog.d/keystone.conf`:

```text
# logfile                        owner:group   mode count size(KB) when  flags
/opt/keystone/data/keystone.log  example:staff 640  7     10240    *     JN
```

On Linux, use a systemd unit. journald keeps and rotates the output, so there is no log file to manage. Exit code 78 means the config or the install is wrong, and restarting will not fix it, so systemd should stop trying:

```ini
[Service]
User=example
WorkingDirectory=/opt/keystone
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning dist/server/main.js --config /opt/keystone/config.json
Restart=on-failure
RestartPreventExitStatus=78
```

The process stops cleanly on `SIGTERM` or `SIGINT`. It stores the lines it has in memory, closes the streams, and waits a few seconds for open requests to finish. A second signal stops it at once.

| Exit code | Meaning |
|---|---|
| 0 | Stopped by a signal. |
| 1 | A crash, a failed shutdown, a second signal, or a start-up failure such as a port already in use. |
| 64 | A wrong command line. |
| 78 | A bad config or secrets file, missing web files (run `npm run build`), or a database from a newer Keystone. |

## Put nginx in front

Keystone listens on loopback and expects a TLS proxy in front. The log stream is a long-lived response, so nginx must pass it through without buffering:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name keystone.example.com;

    ssl_certificate     /etc/nginx/certs/keystone.example.com.pem;
    ssl_certificate_key /etc/nginx/certs/keystone.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:8590;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Connection "";
    }

    location = /api/stream {
        proxy_pass http://127.0.0.1:8590;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

Keystone sends `X-Accel-Buffering: no` on the stream as well, and regular keep-alive comments. Set `trustProxy` to `true`, so that login throttling and the logs use the address from `X-Real-IP` and not the proxy's. Leave it off when nothing in front of Keystone sets that header, because any local process could then choose its own address.

## Health checks

`GET /healthz` needs no login. It answers 200 when every instance's API and log stream are connected and log lines are being stored, and 503 otherwise. Without a session, it gives only the status:

```json
{"status":"ok"}
```

A signed-in browser also sees each part:

```json
{"status":"degraded","store":"ok","instances":{"example-1":{"api":"connected","logs":"connected"},"example-2":{"api":"unreachable","logs":"unreachable"}}}
```

Point an uptime monitor at it. When it says 503, the page shows the reason on that instance's card, and the server log has the error. `HEAD /healthz` works too.

## Logs

The server writes one JSON object per line to stdout, with `time`, `level` and `msg` first, then fields such as `instance` or `requestId`. Errors carry their cause, such as `ECONNREFUSED`. Only problems found before logging starts, such as a bad config, go to stderr as plain text. Passwords, tokens and cookies are never logged. These messages are the ones you are most likely to look for:

| Message | Meaning |
|---|---|
| `Homebridge UI unavailable` | Polling an instance failed. The card shows the same error. |
| `log stream unavailable` | The log stream to an instance failed. `retryInMs` says when it tries again. |
| `plugins poll failed`, `accessories poll failed` | One kind of data could not be read. The card keeps the last data and shows the error. |
| `log replay did not overlap the stored lines` | After a reconnect, none of the replayed lines matched what was stored, so all of them were stored. This is normal after a log rotation or a long outage. |
| `could not store log lines` | Writing to the database failed. `lost` counts the lines lost since the first failure. `log lines stored again` follows when it recovers. |
| `log lines dropped; more arrived at once than the pipeline holds` | A burst larger than the write buffer arrived at once. |
| `login failed` | A wrong user name or password, with the client address. `user` is set only when the name is a real user, because people sometimes type a password into the name field. |
| `apiUrl uses plain http to another host` | The Homebridge password crosses the network unencrypted. Use HTTPS for that `apiUrl`. |
| `request failed` | An unexpected server error. The browser showed the same `requestId`. |

Set `KEYSTONE_LOG_LEVEL=debug` for more detail.

## Troubleshooting

| What you see | Likely cause and fix |
|---|---|
| The server exits at start with `Invalid config` or `Invalid secrets` | The message lists every problem, including misspelt keys. Fix them and start again. |
| `the file is missing` | The secrets file does not exist yet. Run `npm run secrets` as the service account. |
| `mode is 644; run chmod 600 on it` | The secrets file has group or other permissions. Run `chmod 600` on it. |
| A card says **Sign-in failed** | The Homebridge user or password is wrong, or 2FA is on for it. Keystone waits between tries so that it never locks the account in Homebridge UI. Run `npm run secrets` with the right password, then restart for an immediate retry. |
| A card says **Unreachable** | `apiUrl` is wrong, or that Homebridge UI is down. The card shows the last known data and how old it is. |
| A card says **Homebridge UI refused the log** | `restrictLogsToAdmins` is on in that Homebridge UI. Turn it off. Keystone tries again on its own. |
| No batteries or accessory count | Homebridge is not running with `-I`. |
| Log times are off by some hours | Keystone reads the host's time zone from Homebridge UI before each connection. Check the time zone of the Homebridge host. The `reading log times in the Homebridge host time zone` message shows the zone it uses. |
| The login page returns to itself | The cookie is `Secure` and the page was loaded over plain HTTP. Use HTTPS, or set `cookieSecure: false` on a trusted LAN only. |
| **Too many attempts** at login | Repeated failed sign-ins lock the address, and the lock grows with each further failure. Wait, or restart the service. |
| The top bar keeps saying **Reconnecting…** | The proxy is buffering or closing the stream. Check the `/api/stream` block above. |

## Upgrades

```bash
cd /opt/keystone
sudo -u example git pull
sudo -u example npm ci
sudo -u example npm run build
sudo launchctl kickstart -k system/com.example.keystone
```

This follows `main`. To run a release instead, use `git fetch --tags` and `git checkout vX.Y.Z` in place of `git pull`.

Database migrations run at start. Some upgrades end every session, and [CHANGELOG.md](../CHANGELOG.md) lists those under breaking changes. Read it before upgrading across a version that has any. Going back to an older version after a migration is refused, so back up the data directory first if you may need to.

## Users, passwords and sessions

Run these as the service account, then restart Keystone:

```bash
npm run secrets -- --user <name>          # add a user, or change that user's password
npm run secrets -- --remove-user <name>   # remove a user; the last one cannot be removed
```

User names are short, lowercase letters, digits, dots, dashes and underscores, and sign-in ignores their case. Changing a user's password ends that user's sessions after the restart. A removed user's sessions end at the restart too. Sessions renew while they are used, and end some time after sign-in in any case.

To sign out every browser, delete the sessions while the service is stopped:

```bash
sqlite3 /opt/keystone/data/dashboard.sqlite 'DELETE FROM sessions'
```

To change a Homebridge user's password, change it in that Homebridge UI first, then run `npm run secrets` and restart.

## Data and backups

Everything lives in `dataDir`: `dashboard.sqlite` plus its `-wal` and `-shm` files. Keystone makes the directory private to the service account. It holds the log lines for `retentionDays` and the session hashes. It never holds a Homebridge password.

The stored log goes back further than each Homebridge UI keeps, and only Keystone has that older part. If you want to keep it, back up the database with SQLite's own backup, which is safe while Keystone runs:

```bash
sqlite3 /opt/keystone/data/dashboard.sqlite ".backup /path/to/keystone-backup.sqlite"
```

Keep the secrets file in your usual secret store. You can write it again with `npm run secrets` at any time.

To start over, stop the service, delete the three database files and start it again. Keystone fills the log again from each Homebridge UI's replay, and every browser has to sign in again.

The database file does not shrink when lines are removed. SQLite reuses the free space for new lines. After lowering `retentionDays` a lot, you can stop the service and run `sqlite3 /opt/keystone/data/dashboard.sqlite VACUUM` to give the space back.
