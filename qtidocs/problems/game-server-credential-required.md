---
title: GAME_SERVER_CREDENTIAL_REQUIRED
description: The route requires game-server credentials.
order: 27
---

# GAME_SERVER_CREDENTIAL_REQUIRED

## Code

- `https://qtiauth.qtidocs.dev/problems/game-server-credential-required`
- `GAME_SERVER_CREDENTIAL_REQUIRED`
- `401`, `403`

## Meaning

The route requires game-server credentials. A player token or user session was presented instead.

## What to do

Use game-server credentials (not a player token) when calling this endpoint.
