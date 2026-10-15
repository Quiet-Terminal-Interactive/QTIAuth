---
title: UPSTREAM_ERROR
description: A downstream service returned an unexpected error.
order: 261
nav: false
---

# UPSTREAM_ERROR

## Code

- `https://qtiauth.qtidocs.dev/problems/upstream-error`
- `UPSTREAM_ERROR`
- `502`

## Meaning

A downstream service returned an unexpected error.

## What to do

Retry with exponential backoff. Check downstream service health if the error persists.
