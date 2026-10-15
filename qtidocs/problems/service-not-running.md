---
title: SERVICE_NOT_RUNNING
description: An internal NATS service is not responding.
order: 266
nav: false
---

# SERVICE_NOT_RUNNING

## Code

- `https://qtiauth.qtidocs.dev/problems/service-not-running`
- `SERVICE_NOT_RUNNING`
- `503`

## Meaning

An internal NATS service is not responding. This is converted to `IDENTITY_UNAVAILABLE` by the gateway before reaching clients.

## What to do

Check internal service health. Retry after a short delay.
