---
title: REDIRECT_URI_REQUIRED
description: `redirect_uri` is required but was not provided.
order: 20
---

# REDIRECT_URI_REQUIRED

## Code

- `https://qtiauth.qtidocs.dev/problems/redirect-uri-required`
- `REDIRECT_URI_REQUIRED`
- `400`

## Meaning

`redirect_uri` is required but was not provided. The client has more than one registered URI, so one must be specified.

## What to do

Include the `redirect_uri` parameter in the authorization request.
