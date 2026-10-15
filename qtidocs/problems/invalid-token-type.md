---
title: INVALID_TOKEN_TYPE
description: The bearer token is not an access token, its `typ` claim is not `at+jwt`.
order: 33
---

# INVALID_TOKEN_TYPE

## Code

- `https://qtiauth.qtidocs.dev/problems/invalid-token-type`
- `INVALID_TOKEN_TYPE`
- `401`

## Meaning

The bearer token is not an access token, its `typ` claim is not `at+jwt`.

## What to do

Use an access token, not an ID token or refresh token, in the `Authorization` header.
