# OTP Relay

Forward SMS verification codes from an iPhone to a Chromium browser on your own
LAN. No third-party cloud, no account, no data leaving your network.

[中文说明](README.md)

```
iPhone SMS
   │  Shortcuts → Message automation (run immediately)
   ▼
POST http://your-host:8099/api/code
   │  otp-relay: in-memory only, 180 s TTL
   ▼
SSE push to the Chrome/Edge extension
   │
   ▼
The code is filled into the verification-code field of the active tab
```

If no input field is found, the extension shows a click-to-copy toast instead.

## Features

- Self-hosted relay with a single dependency-free `server.js` (runs on Bun).
- Docker Compose project for UGREEN UGOS Pro, Synology, QNAP, Unraid, or plain Docker.
- Chrome / Edge extension with OTP-field detection, single-input and split-digit support.
- Codes stay in memory, expire after 180 seconds, and are never written to disk.
- Works with English (`code`, `OTP`, `passcode`) and Chinese (`验证码`, `校验码`, `动态码`) SMS.

## Requirements

- iPhone with iOS 26/27 and the Shortcuts app.
- An always-on host for the relay: NAS, home server, or a desktop.
- Bun 1.0+ or Docker.
- Chrome or Edge (Chromium) on the computer where you want autofill.

## Quick start

### 1. Generate a token

```bash
openssl rand -hex 24
```

Keep it secret. It is the only credential protecting the relay.

### 2. Run the relay

#### Docker Compose (recommended)

Put `server.js` and `docker-compose.yml` in the same directory, set
`OTP_TOKEN` in the compose file, then:

```bash
docker compose up -d
```

The container uses the official Bun image and mounts `server.js` read-only, so
there is no build step. On UGREEN UGOS Pro, create a Docker **Project**, paste
the compose file, upload `server.js` to the project folder, and deploy.

If Docker Hub is unreachable, configure a registry mirror or build the image
from the included `Dockerfile`.

#### Bun

```bash
OTP_TOKEN="your-token" PORT=8099 bun server.js
```

Check it:

```bash
curl http://127.0.0.1:8099/health
# {"ok":true}
```

### 3. Load the browser extension

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.
4. Open the extension popup and set:
   - Relay URL: `http://your-host:8099`
   - Token: the value from step 1
5. Click **Save & connect**. The status should become **Connected**.

The extension requests access to all HTTP/HTTPS sites because verification
fields can appear anywhere. It only fills OTP fields and never uploads page
content.

### 4. Create the iPhone Shortcut

1. Open **Shortcuts** → **Automation** → **+** → **Message**.
2. Set the condition to **Message contains** `code`.
   - For Chinese SMS, create another automation with `验证码`.
3. Turn off **Confirm Before Run**.
   - iOS 27: tap the trigger arrow, then **ⓘ → Privacy → Allow Running When Locked**.
   - iOS 26: choose **Run Immediately**.
4. Tap **Next** → **New Blank Shortcut**.
5. Add one action: **Get Contents of URL**.
   - URL: `http://your-host:8099/api/code`
   - Method: `POST`
   - Header: `X-Token` = your token
   - Request Body: **JSON**
     - `text` = **Shortcut Input**
6. Save. On the first run, allow **Local Network** access.

The relay extracts the first 4–8 digit code near a verification keyword. You can
also post `{"code":"123456"}` directly if your shortcut already extracts digits.

### 5. Test

With a login page open in the browser, send a test code:

```bash
curl -X POST http://your-host:8099/api/code \
  -H "X-Token: your-token" \
  -H "Content-Type: application/json" \
  -d '{"code":"123456"}'
```

The field should fill within a second. If the page has no recognizable field,
the extension shows a click-to-copy toast.

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/code` | Accept `{"code":"123456"}` or `{"text":"full SMS"}` |
| `GET` | `/api/events` | Server-Sent Events stream (token required) |
| `GET` | `/api/latest` | Latest unexpired code (token required) |
| `GET` | `/health` | Health check |

Authentication: `X-Token` header, `Authorization: Bearer`, or `?token=` query
parameter.

## Security

- Run the relay on a trusted LAN. Never expose port 8099 to the public internet.
- Use Tailscale/WireGuard for remote access.
- The token is a password: anyone with it can read the latest code.
- Codes are in memory only and expire after `OTP_TTL_SECONDS` (default 180).
- The extension needs broad host permissions; review `extension/content.js` if
  you want to verify what it does.

See [SECURITY.md](SECURITY.md) for details.

## Limitations

- The iPhone automation cannot run when the phone is off or has no signal.
- By default only 4–8 digit numeric codes are recognized.
- Chromium browsers only. Firefox needs adaptation.
- Some sites use shadow DOM, canvas, or anti-bot inputs; the copy toast is the
  fallback.

## License

MIT
