---
title: PROVIDER_ID_TOKEN_INVALID
description: The OAuth provider returned an ID token that failed validation.
order: 254
nav: false
---

# PROVIDER_ID_TOKEN_INVALID

## Code

- `https://qtiauth.qtidocs.dev/problems/provider-id-token-invalid`
- `PROVIDER_ID_TOKEN_INVALID`
- `502`

## Meaning

The OAuth provider returned an ID token that failed validation.

## What to do

Check the provider's JWKS endpoint and client configuration. Report to the provider if the token is malformed.
