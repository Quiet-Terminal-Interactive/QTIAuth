---
title: PAR_REQUIRED
description: This client requires Pushed Authorization Requests; a direct `/authorize` call is not accepted.
order: 15
nav: false
---

# PAR_REQUIRED

## Code

- `https://qtiauth.qtidocs.dev/problems/par-required`
- `PAR_REQUIRED`
- `400`

## Meaning

This client requires Pushed Authorization Requests; a direct `/authorize` call is not accepted.

## What to do

Use the PAR endpoint (`/oauth2/par`) to push the authorization request before redirecting the user.
