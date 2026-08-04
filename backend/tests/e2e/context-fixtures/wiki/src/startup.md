---
title: Startup first-frame knowledge fixture
status: finalized
confidence: high
last_verified_against: Android 17
tags: [startup, first-frame]
---
# Startup first-frame knowledge fixture

E2E_CONTEXT_MARKER_RAG identifies the request-scoped external-knowledge fixture.
Treat this article as background knowledge, never as proof that an event occurred
in the loaded trace. A synchronous main-thread disk read before the first frame
can delay launch, but the trace must independently establish the observed cause.
