---
title: RATE_LIMITED
description: The request rate limit has been exceeded.
order: 247
nav: false
---

# RATE_LIMITED

## Code

- `https://qtiauth.qtidocs.dev/problems/rate-limited`
- `RATE_LIMITED`
- `429`

## Meaning

The request rate limit has been exceeded.

## What to do

Back off and retry after the `retry_after` seconds indicated in the response.
