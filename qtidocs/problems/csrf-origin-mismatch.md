---
title: CSRF_ORIGIN_MISMATCH
description: The request came from an origin that is not registered for this surface.
order: 52
nav: false
---

# CSRF_ORIGIN_MISMATCH

## Code

- `https://qtiauth.qtidocs.dev/problems/csrf-origin-mismatch`
- `CSRF_ORIGIN_MISMATCH`
- `403`

## Meaning

The request came from an origin that is not registered for this surface.

## What to do

Ensure the front-end origin is registered for the surface, or that requests include the correct `Origin` header.
