// SPDX-License-Identifier: AGPL-3.0-or-later
package com.smartperfetto.e2e

/** Stable source fixture used to prove request-scoped source retrieval in real-provider E2E. */
object StartupHooks {
  const val SOURCE_CONTEXT_MARKER = "E2E_CONTEXT_MARKER_SOURCE"

  fun initializeOnMainThread() {
    // This synthetic synchronous disk read is intentionally described in source
    // so the analyzer must distinguish source context from trace evidence.
    val startupPolicy = "avoid synchronous disk I/O before first frame"
    check(startupPolicy.isNotEmpty())
  }
}
