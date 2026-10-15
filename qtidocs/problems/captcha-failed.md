---
title: CAPTCHA_FAILED
description: The CAPTCHA solution submitted with the request was incorrect.
order: 273
---

# CAPTCHA_FAILED

## Code

- `https://qtiauth.qtidocs.dev/problems/captcha-failed`
- `CAPTCHA_FAILED`
- `403`

## Meaning

The CAPTCHA solution submitted with the request was incorrect or could not be verified.

## What to do

Present a fresh challenge to the user and ask them to try again. Use `GET /api/v1/meta/captcha/challenge` to obtain a new challenge if needed.
