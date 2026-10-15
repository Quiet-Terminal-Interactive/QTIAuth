---
title: CAPTCHA_REQUIRED
description: A CAPTCHA must be solved before this request can proceed.
order: 272
nav: false
---

# CAPTCHA_REQUIRED

## Code

- `https://qtiauth.qtidocs.dev/problems/captcha-required`
- `CAPTCHA_REQUIRED`
- `403`

## Meaning

A CAPTCHA challenge must be solved before this request can proceed. The response includes a `captcha` object with the provider details and, for ALTCHA, a `challenge` value.

## What to do

Read `captcha.provider` from the response, present the challenge to the user, then retry the request with the solution in the `captcha` body field or the `X-QTIAuth-Captcha` header.
