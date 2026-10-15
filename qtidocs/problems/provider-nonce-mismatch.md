---
title: PROVIDER_NONCE_MISMATCH
description: The `nonce` in the OIDC provider's ID token does not match the nonce stored for this flow.
order: 18
---

# PROVIDER_NONCE_MISMATCH

## Code

- `https://qtiauth.qtidocs.dev/problems/provider-nonce-mismatch`
- `PROVIDER_NONCE_MISMATCH`
- `400`

## Meaning

The `nonce` in the OIDC provider's ID token does not match the nonce stored for this flow.

## What to do

This may indicate a replay attack or stale state. Restart the authorization flow.
