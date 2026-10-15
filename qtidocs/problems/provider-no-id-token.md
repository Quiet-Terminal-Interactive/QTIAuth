---
title: PROVIDER_NO_ID_TOKEN
description: The OAuth provider did not include an ID token in the response.
order: 255
---

# PROVIDER_NO_ID_TOKEN

## Code

- `https://qtiauth.qtidocs.dev/problems/provider-no-id-token`
- `PROVIDER_NO_ID_TOKEN`
- `502`

## Meaning

The OAuth provider did not include an ID token in the response.

## What to do

Ensure the `openid` scope is requested and that the provider supports ID token issuance.
