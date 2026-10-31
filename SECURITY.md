# Security

This project moves SMS one-time passwords between your own devices. Treat the
relay token like a password.

## Deployment rules

- Run the relay on a trusted LAN. Do not expose port 8099 to the public internet.
- For remote access, use a private network such as Tailscale or WireGuard.
- Use a long random `OTP_TOKEN` (at least 16 characters; 48 hex characters is a
  good default).
- Codes are kept in process memory only and expire after `OTP_TTL_SECONDS`
  (default 180 seconds). The server does not write codes to disk.
- Anyone who knows the token can read the latest unexpired code and post new
  codes. Rotate the token if it leaks.

## Browser extension

The extension asks for host permission on all HTTP/HTTPS sites because OTP
fields can appear anywhere. It only looks for verification-code inputs and
fills the code that the relay sends. It does not upload page content or browsing
history.

## Reporting a vulnerability

Please open a private security advisory on GitHub rather than a public issue.
