---
title: SERVICE_TIMEOUT
description: An internal service call via NATS timed out.
order: 271
nav: false
---

# SERVICE_TIMEOUT

## Code

- `https://qtiauth.qtidocs.dev/problems/service-timeout`
- `SERVICE_TIMEOUT`
- `504`

## Meaning

An internal service call via NATS timed out.

## What to do

Retry after a short delay. If timeouts persist, check internal service health and load.
