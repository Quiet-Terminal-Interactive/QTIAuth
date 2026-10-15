# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately. Don't open a public issue.

- Use GitHub's private vulnerability reporting ("Report a vulnerability" on the Security tab), or
- email hello@quietterminal.co.uk.

Include the affected version or commit, the component (gateway, identity, web, …), reproduction steps and the impact you expect. We aim to acknowledge reports within 3 working days, agree a fix timeline within 10, and credit reporters who want it once a fix is released.

## Scope

In scope: everything in this repository, including the default configuration and the Compose stack.
Out of scope: vulnerabilities that need a compromised host, a leaked `.env`, or a deliberately insecure configuration (for example `webhooks.allow_private_targets: true` or `cookies.secure: false` in production).

## Hardening notes for operators

- Keep `.env` out of version control and rotate `KEY_ENCRYPTION_KEY`-wrapped signing keys with `qtiauth keys rotate` if a host is compromised.
- Only `gateway` (or `caddy` with the `edge` profile) should publish ports.
- Set `network.trusted_proxies` to exactly your reverse proxies. `X-Forwarded-For` is never trusted otherwise.
- Every staff permission requires two-step verification by default (`security.require_2fa_for_permissions`).

## Safe Harbor

We will not initiate or pursue legal action against researchers who discover and report security vulnerabilities in accordance with this policy.

We consider security research conducted in accordance with this policy to be authorized, and will not pursue legal action against you for such activities. We will work with you to understand and resolve the issue promptly.

If legal action is initiated by a third party against you for activities conducted in accordance with this policy, we will take steps to make it known that your actions were conducted in compliance with this policy.