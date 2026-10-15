---
title: CSRF_ORIGIN_MISSING
description: A cookie-credentialed request is missing the `Origin` header.
order: 53
nav: false
---

# CSRF_ORIGIN_MISSING

## Code

- `https://qtiauth.qtidocs.dev/problems/csrf-origin-missing`
- `CSRF_ORIGIN_MISSING`
- `403`

## Meaning

A cookie-credentialed request is missing the `Origin` header.

## What to do

Ensure the browser or client sends the `Origin` header on credentialed requests.
