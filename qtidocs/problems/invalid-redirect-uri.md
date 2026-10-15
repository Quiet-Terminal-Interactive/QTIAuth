---
title: INVALID_REDIRECT_URI
description: The OAuth redirect URI format is invalid.
order: 208
nav: false
---

# INVALID_REDIRECT_URI

## Code

- `https://qtiauth.qtidocs.dev/problems/invalid-redirect-uri`
- `INVALID_REDIRECT_URI`
- `422`

## Meaning

The OAuth redirect URI format is invalid. It may contain a fragment, or must use HTTPS or a loopback address.

## What to do

Provide a valid HTTPS or loopback redirect URI without a fragment component.
